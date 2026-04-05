"""Tests for security/credential_store.py — credential isolation."""

import pytest

from peerzero_bot.security.credential_store import CredentialStore


class TestCredentialStore:
    def setup_method(self):
        self.store = CredentialStore()

    def test_register_and_get(self):
        self.store.register("moltbook", "secret-key-123")
        result = self.store.get("moltbook", "moltbook")
        assert result == "secret-key-123"

    def test_register_with_custom_id(self):
        self.store.register("moltbook", "key-123", credential_id="moltbook_api")
        result = self.store.get("moltbook_api", "moltbook")
        assert result == "key-123"

    def test_cross_adapter_access_blocked(self):
        """Adapter A cannot access adapter B's credentials."""
        self.store.register("moltbook", "moltbook-key")
        self.store.register("debate", "debate-key")

        # moltbook can access its own
        assert self.store.get("moltbook", "moltbook") == "moltbook-key"

        # moltbook CANNOT access debate's credential
        with pytest.raises(PermissionError, match="moltbook.*cannot access.*debate"):
            self.store.get("debate", "moltbook")

    def test_nonexistent_credential_raises_key_error(self):
        with pytest.raises(KeyError, match="No credential registered"):
            self.store.get("nonexistent", "some_adapter")

    def test_multiple_credentials_per_adapter(self):
        self.store.register("moltbook", "key-1", credential_id="moltbook_read")
        self.store.register("moltbook", "key-2", credential_id="moltbook_write")

        assert self.store.get("moltbook_read", "moltbook") == "key-1"
        assert self.store.get("moltbook_write", "moltbook") == "key-2"

    def test_overwrite_credential(self):
        """Registering same id again overwrites the credential."""
        self.store.register("moltbook", "old-key")
        self.store.register("moltbook", "new-key")
        assert self.store.get("moltbook", "moltbook") == "new-key"

    def test_credential_id_defaults_to_adapter_name(self):
        self.store.register("test_adapter", "the-secret")
        assert self.store.get("test_adapter", "test_adapter") == "the-secret"


class TestCredentialFingerprint:
    def setup_method(self):
        self.store = CredentialStore()

    def test_fingerprint_long_credential(self):
        self.store.register("test", "sk-ant-abcdef1234567890xyz")
        fp = self.store.fingerprint("test")
        assert fp.startswith("sk-ant")
        assert fp.endswith("0xyz")
        assert "..." in fp
        # Must not contain the full key
        assert "abcdef1234567890" not in fp

    def test_fingerprint_short_credential(self):
        self.store.register("test", "short")
        fp = self.store.fingerprint("test")
        assert fp == "***not-set***"

    def test_fingerprint_nonexistent(self):
        fp = self.store.fingerprint("nonexistent")
        assert fp == "***not-set***"

    def test_fingerprint_empty_credential(self):
        self.store.register("test", "")
        fp = self.store.fingerprint("test")
        assert fp == "***not-set***"

    def test_fingerprint_exactly_12_chars(self):
        self.store.register("test", "123456789012")
        fp = self.store.fingerprint("test")
        assert fp == "123456...9012"


class TestCredentialIsolation:
    """Additional isolation tests."""

    def test_adapter_stealing_attempt(self):
        """An adapter registering a credential cannot make it accessible to others."""
        store = CredentialStore()
        store.register("trusted", "super-secret-key")

        # Attacker adapter tries to access trusted's credential
        with pytest.raises(PermissionError):
            store.get("trusted", "attacker")

    def test_empty_adapter_name(self):
        store = CredentialStore()
        store.register("", "key-for-empty")
        assert store.get("", "") == "key-for-empty"

        with pytest.raises(PermissionError):
            store.get("", "other")

    def test_credential_not_in_repr(self):
        """Credentials should not be accidentally exposed in string representations."""
        store = CredentialStore()
        store.register("test", "super-secret-value-12345")
        store_repr = repr(store)
        # The repr shouldn't contain the secret (it's a default __repr__)
        assert "super-secret-value-12345" not in store_repr
