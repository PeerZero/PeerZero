"""Tests for the SchoolAdapter circuit breaker."""

import time
from unittest.mock import MagicMock, patch

import httpx
import pytest

from peerzero_bot.security import SecurityGateway
from peerzero_bot.adapters.school import (
    SchoolAdapter,
    CircuitBreaker,
    CircuitOpenError,
    _CircuitState,
    _is_circuit_breaker_failure,
)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _make_school() -> SchoolAdapter:
    gw = SecurityGateway()
    adapter = SchoolAdapter(
        school_url="https://school.peerzero.com",
        api_key="test-key",
        gateway=gw,
    )
    return adapter


def _mock_http_status_error(status_code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "https://school.peerzero.com/api/papers")
    response = httpx.Response(status_code, request=request)
    return httpx.HTTPStatusError(
        message=f"Error {status_code}",
        request=request,
        response=response,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# 1. CircuitBreaker unit tests (standalone, no adapter)
# ═══════════════════════════════════════════════════════════════════════════════


class TestCircuitBreakerStandalone:
    """Test CircuitBreaker state machine in isolation."""

    def test_starts_closed(self):
        cb = CircuitBreaker()
        assert cb.state == _CircuitState.CLOSED

    def test_stays_closed_on_successes(self):
        cb = CircuitBreaker(failure_threshold=3)
        for _ in range(10):
            cb.check()  # should not raise
            cb.record_success()
        assert cb.state == _CircuitState.CLOSED

    def test_trips_open_after_threshold(self):
        cb = CircuitBreaker(failure_threshold=3)
        for _ in range(3):
            cb.check()
            cb.record_failure()
        assert cb.state == _CircuitState.OPEN

    def test_open_blocks_requests(self):
        cb = CircuitBreaker(failure_threshold=2, cooldown_seconds=600)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == _CircuitState.OPEN
        with pytest.raises(CircuitOpenError) as exc_info:
            cb.check()
        assert exc_info.value.remaining_seconds > 0

    def test_success_resets_failure_count(self):
        cb = CircuitBreaker(failure_threshold=3)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()  # resets consecutive failures
        cb.record_failure()
        cb.record_failure()
        # Only 2 consecutive failures, not 3
        assert cb.state == _CircuitState.CLOSED

    def test_transitions_to_half_open_after_cooldown(self):
        cb = CircuitBreaker(failure_threshold=2, cooldown_seconds=0.1)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == _CircuitState.OPEN
        time.sleep(0.15)
        # check() should transition to HALF_OPEN and allow the request
        cb.check()  # should not raise
        assert cb.state == _CircuitState.HALF_OPEN

    def test_half_open_success_threshold(self):
        cb = CircuitBreaker(failure_threshold=2, cooldown_seconds=0.05, success_threshold=2)
        cb.record_failure()
        cb.record_failure()
        time.sleep(0.1)
        cb.check()  # transitions to HALF_OPEN
        cb.record_success()
        assert cb.state == _CircuitState.HALF_OPEN  # need 2 successes
        cb.record_success()
        assert cb.state == _CircuitState.CLOSED

    def test_half_open_failure_returns_to_open(self):
        cb = CircuitBreaker(failure_threshold=2, cooldown_seconds=0.05)
        cb.record_failure()
        cb.record_failure()
        time.sleep(0.1)
        cb.check()  # transitions to HALF_OPEN
        cb.record_failure()
        assert cb.state == _CircuitState.OPEN

    def test_reset_returns_to_closed(self):
        cb = CircuitBreaker(failure_threshold=1)
        cb.record_failure()
        assert cb.state == _CircuitState.OPEN
        cb.reset()
        assert cb.state == _CircuitState.CLOSED
        cb.check()  # should not raise


# ═══════════════════════════════════════════════════════════════════════════════
# 2. _is_circuit_breaker_failure classification
# ═══════════════════════════════════════════════════════════════════════════════


class TestIsCircuitBreakerFailure:
    """Only 5xx, connection errors, and timeouts should trip the breaker."""

    def test_5xx_is_failure(self):
        assert _is_circuit_breaker_failure(_mock_http_status_error(500)) is True
        assert _is_circuit_breaker_failure(_mock_http_status_error(502)) is True
        assert _is_circuit_breaker_failure(_mock_http_status_error(503)) is True

    def test_4xx_is_not_failure(self):
        assert _is_circuit_breaker_failure(_mock_http_status_error(400)) is False
        assert _is_circuit_breaker_failure(_mock_http_status_error(404)) is False
        assert _is_circuit_breaker_failure(_mock_http_status_error(409)) is False
        assert _is_circuit_breaker_failure(_mock_http_status_error(422)) is False
        assert _is_circuit_breaker_failure(_mock_http_status_error(429)) is False

    def test_connect_error_is_failure(self):
        assert _is_circuit_breaker_failure(httpx.ConnectError("refused")) is True

    def test_timeout_is_failure(self):
        assert _is_circuit_breaker_failure(httpx.TimeoutException("timed out")) is True
        assert _is_circuit_breaker_failure(httpx.ReadTimeout("read timeout")) is True
        assert _is_circuit_breaker_failure(httpx.ConnectTimeout("connect timeout")) is True

    def test_connection_error_is_failure(self):
        assert _is_circuit_breaker_failure(ConnectionError("refused")) is True
        assert _is_circuit_breaker_failure(TimeoutError("timed out")) is True

    def test_os_error_is_failure(self):
        assert _is_circuit_breaker_failure(OSError("network unreachable")) is True

    def test_value_error_is_not_failure(self):
        assert _is_circuit_breaker_failure(ValueError("bad data")) is False

    def test_json_decode_error_is_not_failure(self):
        import json
        assert _is_circuit_breaker_failure(json.JSONDecodeError("", "", 0)) is False


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Integration with SchoolAdapter._get and _post
# ═══════════════════════════════════════════════════════════════════════════════


class TestCircuitBreakerAdapterIntegration:
    """Circuit breaker integrates with _get/_post without changing signatures."""

    def setup_method(self):
        SchoolAdapter._circuit_breaker.reset()

    def test_get_records_success(self):
        adapter = _make_school()
        adapter._http = MagicMock()
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.json.return_value = {"ok": True}
        adapter._http.get.return_value = mock_resp

        result = adapter._get("/api/papers")
        assert result == {"ok": True}
        assert SchoolAdapter._circuit_breaker.state == _CircuitState.CLOSED

    def test_get_records_5xx_failure(self):
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.get.return_value = MagicMock(
            raise_for_status=MagicMock(side_effect=_mock_http_status_error(500))
        )
        with pytest.raises(httpx.HTTPStatusError):
            adapter._get("/api/papers")
        # Should have recorded a failure
        assert SchoolAdapter._circuit_breaker._consecutive_failures == 1

    def test_get_does_not_record_4xx_failure(self):
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.get.return_value = MagicMock(
            raise_for_status=MagicMock(side_effect=_mock_http_status_error(404))
        )
        with pytest.raises(httpx.HTTPStatusError):
            adapter._get("/api/papers")
        # 4xx should NOT increment the failure counter
        assert SchoolAdapter._circuit_breaker._consecutive_failures == 0

    def test_post_records_connect_error(self):
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.post.side_effect = httpx.ConnectError("Connection refused")
        with pytest.raises(httpx.ConnectError):
            adapter._post("/api/papers", {"title": "test"})
        assert SchoolAdapter._circuit_breaker._consecutive_failures == 1

    def test_breaker_trips_after_threshold_and_blocks_subsequent(self):
        """After 5 consecutive 5xx errors, the breaker opens and blocks."""
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.get.return_value = MagicMock(
            raise_for_status=MagicMock(side_effect=_mock_http_status_error(503))
        )

        for _ in range(5):
            with pytest.raises(httpx.HTTPStatusError):
                adapter._get("/api/papers")

        assert SchoolAdapter._circuit_breaker.state == _CircuitState.OPEN

        # Next request should be blocked without making an HTTP call
        adapter._http.get.reset_mock()
        with pytest.raises(CircuitOpenError):
            adapter._get("/api/papers")
        # No HTTP call was made
        adapter._http.get.assert_not_called()

    def test_4xx_errors_do_not_trip_breaker(self):
        """Even many 4xx errors should not trip the breaker."""
        adapter = _make_school()
        adapter._http = MagicMock()
        adapter._http.post.return_value = MagicMock(
            raise_for_status=MagicMock(side_effect=_mock_http_status_error(422))
        )

        for _ in range(10):
            with pytest.raises(httpx.HTTPStatusError):
                adapter._post("/api/papers", {"bad": "data"})

        # Breaker should still be CLOSED
        assert SchoolAdapter._circuit_breaker.state == _CircuitState.CLOSED

    def test_shared_across_instances(self):
        """All adapter instances share the same breaker."""
        a1 = _make_school()
        a2 = _make_school()
        assert a1._circuit_breaker is a2._circuit_breaker

    def test_success_after_failures_resets_counter(self):
        """A successful request resets the consecutive failure count."""
        adapter = _make_school()
        adapter._http = MagicMock()

        # 4 failures (threshold is 5)
        adapter._http.get.return_value = MagicMock(
            raise_for_status=MagicMock(side_effect=_mock_http_status_error(500))
        )
        for _ in range(4):
            with pytest.raises(httpx.HTTPStatusError):
                adapter._get("/api/papers")
        assert SchoolAdapter._circuit_breaker._consecutive_failures == 4

        # 1 success resets to 0
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.json.return_value = {"ok": True}
        adapter._http.get.return_value = mock_resp
        adapter._get("/api/papers")
        assert SchoolAdapter._circuit_breaker._consecutive_failures == 0


# ═══════════════════════════════════════════════════════════════════════════════
# 4. CircuitOpenError exception
# ═══════════════════════════════════════════════════════════════════════════════


class TestCircuitOpenError:
    """CircuitOpenError carries useful information for callers."""

    def test_has_remaining_seconds(self):
        err = CircuitOpenError(remaining_seconds=42.5)
        assert err.remaining_seconds == 42.5
        assert "42s" in str(err)

    def test_is_catchable_as_exception(self):
        with pytest.raises(Exception):
            raise CircuitOpenError(10.0)

    def test_default_remaining_seconds(self):
        err = CircuitOpenError()
        assert err.remaining_seconds == 0.0
