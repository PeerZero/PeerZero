"""Tests for security/audit.py — append-only audit logging."""

import json
import stat
from pathlib import Path
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone

import pytest

from peerzero_bot.security.audit import AuditLog


class TestAuditLogInit:
    def test_creates_directory(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))
        assert audit_dir.exists()
        assert audit_dir.stat().st_mode & 0o777 == 0o700

    def test_existing_directory_permissions_enforced(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit_dir.mkdir()
        audit_dir.chmod(0o755)  # too permissive
        audit = AuditLog(str(audit_dir))
        assert audit_dir.stat().st_mode & 0o777 == 0o700


class TestAuditLogEntries:
    def setup_method(self, method, tmp_path=None):
        pass  # setup in each test with tmp_path fixture

    def test_basic_log_entry(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))
        audit.log(
            adapter="school",
            action="submit_review",
            destination="https://peerzero.science/api/reviews",
            status=200,
        )

        # Find the log file
        log_files = list(audit_dir.glob("*.jsonl"))
        assert len(log_files) == 1
        entry = json.loads(log_files[0].read_text().strip())
        assert entry["adapter"] == "school"
        assert entry["action"] == "submit_review"
        assert entry["destination"] == "https://peerzero.science/api/reviews"
        assert entry["status"] == 200
        assert "ts" in entry

    def test_content_hash_computed(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))
        audit.log(
            adapter="school",
            action="submit_paper",
            destination="https://peerzero.science/api/papers",
            status=200,
            request_body='{"title": "Test Paper"}',
        )

        log_files = list(audit_dir.glob("*.jsonl"))
        entry = json.loads(log_files[0].read_text().strip())
        assert "content_hash" in entry
        assert entry["content_hash"].startswith("sha256:")

    def test_content_hash_with_bytes(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))
        audit.log(
            adapter="school",
            action="upload",
            destination="https://example.com/upload",
            request_body=b"binary data here",
        )

        log_files = list(audit_dir.glob("*.jsonl"))
        entry = json.loads(log_files[0].read_text().strip())
        assert entry["content_hash"].startswith("sha256:")

    def test_no_content_hash_without_body(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))
        audit.log(
            adapter="school",
            action="get_profile",
            destination="https://peerzero.science/api/agents",
        )

        log_files = list(audit_dir.glob("*.jsonl"))
        entry = json.loads(log_files[0].read_text().strip())
        assert "content_hash" not in entry

    def test_response_preview_truncated(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))
        long_response = "x" * 500
        audit.log(
            adapter="school",
            action="test",
            destination="https://example.com",
            response_preview=long_response,
        )

        log_files = list(audit_dir.glob("*.jsonl"))
        entry = json.loads(log_files[0].read_text().strip())
        assert len(entry["response_preview"]) <= 200

    def test_empty_response_preview_omitted(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))
        audit.log(
            adapter="school",
            action="test",
            destination="https://example.com",
            response_preview="",
        )

        log_files = list(audit_dir.glob("*.jsonl"))
        entry = json.loads(log_files[0].read_text().strip())
        assert "response_preview" not in entry

    def test_multiple_entries_appended(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))

        for i in range(5):
            audit.log(
                adapter="school",
                action=f"action_{i}",
                destination="https://example.com",
                status=200,
            )

        log_files = list(audit_dir.glob("*.jsonl"))
        assert len(log_files) == 1
        lines = log_files[0].read_text().strip().split("\n")
        assert len(lines) == 5
        for i, line in enumerate(lines):
            entry = json.loads(line)
            assert entry["action"] == f"action_{i}"

    def test_log_file_permissions_restricted(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))
        audit.log(
            adapter="school",
            action="test",
            destination="https://example.com",
        )

        log_files = list(audit_dir.glob("*.jsonl"))
        mode = log_files[0].stat().st_mode
        assert mode & stat.S_IRGRP == 0  # no group read
        assert mode & stat.S_IROTH == 0  # no other read

    def test_log_file_named_by_date(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))
        audit.log(
            adapter="school",
            action="test",
            destination="https://example.com",
        )

        log_files = list(audit_dir.glob("*.jsonl"))
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        assert log_files[0].name == f"{today}.jsonl"

    def test_timestamp_is_utc_iso(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))
        audit.log(
            adapter="school",
            action="test",
            destination="https://example.com",
        )

        log_files = list(audit_dir.glob("*.jsonl"))
        entry = json.loads(log_files[0].read_text().strip())
        ts = entry["ts"]
        # Should be parseable as ISO 8601
        parsed = datetime.fromisoformat(ts)
        assert parsed.tzinfo is not None


class TestAuditLogErrorHandling:
    def test_write_failure_does_not_raise(self, tmp_path):
        """Audit log failures should never block the bot."""
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))

        # Make the directory read-only to cause write failure
        audit_dir.chmod(stat.S_IRUSR | stat.S_IXUSR)

        # Should NOT raise
        audit.log(
            adapter="school",
            action="test",
            destination="https://example.com",
        )

        # Restore permissions for cleanup
        audit_dir.chmod(stat.S_IRWXU)

    def test_default_status_is_zero(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))
        audit.log(
            adapter="school",
            action="test",
            destination="https://example.com",
        )

        log_files = list(audit_dir.glob("*.jsonl"))
        entry = json.loads(log_files[0].read_text().strip())
        assert entry["status"] == 0


class TestAuditContentHashVerification:
    """Verify that the content hash is deterministic and verifiable."""

    def test_same_body_same_hash(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))
        body = '{"title": "Reproducible"}'

        audit.log(adapter="a", action="test", destination="x", request_body=body)
        audit.log(adapter="b", action="test", destination="y", request_body=body)

        log_files = list(audit_dir.glob("*.jsonl"))
        lines = log_files[0].read_text().strip().split("\n")
        entry1 = json.loads(lines[0])
        entry2 = json.loads(lines[1])
        assert entry1["content_hash"] == entry2["content_hash"]

    def test_different_body_different_hash(self, tmp_path):
        audit_dir = tmp_path / "audit"
        audit = AuditLog(str(audit_dir))

        audit.log(adapter="a", action="test", destination="x", request_body="body1")
        audit.log(adapter="a", action="test", destination="x", request_body="body2")

        log_files = list(audit_dir.glob("*.jsonl"))
        lines = log_files[0].read_text().strip().split("\n")
        entry1 = json.loads(lines[0])
        entry2 = json.loads(lines[1])
        assert entry1["content_hash"] != entry2["content_hash"]
