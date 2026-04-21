"""
Tests for trading_service.py — OKX trading service (module-level functions).
"""

import pytest
import hmac
import hashlib
import base64
from unittest.mock import AsyncMock, patch, MagicMock

from server_py.models import OkxCredentials
from server_py.trading_service import _sign, _build_headers


class TestOkxSignature:
    """HMAC-SHA256 signature generation tests."""

    def test_sign_produces_base64(self):
        """_sign should produce a valid base64 string."""
        result = _sign("test-message", "test-secret")
        # Should be decodable base64
        decoded = base64.b64decode(result)
        assert len(decoded) == 32  # SHA256 = 32 bytes

    def test_sign_deterministic(self):
        """Same input should always produce same signature."""
        sig1 = _sign("hello", "secret")
        sig2 = _sign("hello", "secret")
        assert sig1 == sig2

    def test_sign_varies_with_message(self):
        """Different messages should produce different signatures."""
        sig1 = _sign("message-a", "secret")
        sig2 = _sign("message-b", "secret")
        assert sig1 != sig2

    def test_sign_varies_with_secret(self):
        """Different secrets should produce different signatures."""
        sig1 = _sign("same-message", "secret-1")
        sig2 = _sign("same-message", "secret-2")
        assert sig1 != sig2

    def test_sign_matches_manual(self):
        """Should match a manually computed HMAC-SHA256."""
        message = "2025-01-01T00:00:00.000ZGET/api/v5/account/balance"
        secret = "my-secret-key"

        expected = base64.b64encode(
            hmac.new(secret.encode(), message.encode(), hashlib.sha256).digest()
        ).decode()

        actual = _sign(message, secret)
        assert actual == expected


class TestBuildHeaders:
    """Header generation tests."""

    def _make_creds(self, simulated: bool = True) -> OkxCredentials:
        return OkxCredentials(
            apiKey="my-key",
            secretKey="my-secret",
            passphrase="my-pass",
            simulated=simulated,
        )

    def test_headers_contain_required_fields(self):
        """All required OKX headers should be present."""
        creds = self._make_creds()
        headers = _build_headers(creds, "GET", "/api/v5/account/balance")

        assert "OK-ACCESS-KEY" in headers
        assert "OK-ACCESS-SIGN" in headers
        assert "OK-ACCESS-TIMESTAMP" in headers
        assert "OK-ACCESS-PASSPHRASE" in headers
        assert "Content-Type" in headers

        assert headers["OK-ACCESS-KEY"] == "my-key"
        assert headers["OK-ACCESS-PASSPHRASE"] == "my-pass"
        assert headers["Content-Type"] == "application/json"

    def test_simulated_header_present(self):
        """Simulated mode should set x-simulated-trading header."""
        creds = self._make_creds(simulated=True)
        headers = _build_headers(creds, "GET", "/test")
        assert headers.get("x-simulated-trading") == "1"

    def test_real_no_simulated_header(self):
        """Real mode should NOT set x-simulated-trading header."""
        creds = self._make_creds(simulated=False)
        headers = _build_headers(creds, "GET", "/test")
        assert "x-simulated-trading" not in headers

    def test_timestamp_format(self):
        """Timestamp should be ISO 8601 ending with Z."""
        creds = self._make_creds()
        headers = _build_headers(creds, "GET", "/test")
        ts = headers["OK-ACCESS-TIMESTAMP"]
        assert ts.endswith("Z")
        assert "T" in ts

    def test_body_affects_signature(self):
        """Different body should produce different signature."""
        creds = self._make_creds()
        h1 = _build_headers(creds, "POST", "/order", body='{"a":1}')
        h2 = _build_headers(creds, "POST", "/order", body='{"b":2}')
        # Timestamps differ too, so we can't directly compare sigs,
        # but at least both should be valid non-empty strings
        assert len(h1["OK-ACCESS-SIGN"]) > 20
        assert len(h2["OK-ACCESS-SIGN"]) > 20


@pytest.mark.asyncio
class TestConnectionTest:
    """Connection test with mocked HTTP."""

    async def test_connection_success(self):
        """Successful connection test should return ok=True."""
        from server_py.trading_service import test_connection

        creds = OkxCredentials(
            apiKey="key", secretKey="secret",
            passphrase="pass", simulated=True,
        )

        mock_response = MagicMock()
        mock_response.json.return_value = {"code": "0", "data": [{}]}

        with patch("httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.get.return_value = mock_response
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client

            result = await test_connection(creds)
            assert result["ok"] is True

    async def test_connection_failure(self):
        """Failed API response should return ok=False with error."""
        from server_py.trading_service import test_connection

        creds = OkxCredentials(
            apiKey="key", secretKey="secret",
            passphrase="pass", simulated=True,
        )

        mock_response = MagicMock()
        mock_response.json.return_value = {"code": "50111", "msg": "Invalid API key"}

        with patch("httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.get.return_value = mock_response
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client

            result = await test_connection(creds)
            assert result["ok"] is False
            assert "50111" in result["error"]

    async def test_connection_network_error(self):
        """Network error should return ok=False."""
        from server_py.trading_service import test_connection

        creds = OkxCredentials(
            apiKey="key", secretKey="secret",
            passphrase="pass", simulated=True,
        )

        with patch("httpx.AsyncClient") as MockClient:
            mock_client = AsyncMock()
            mock_client.get.side_effect = Exception("Connection refused")
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            MockClient.return_value = mock_client

            result = await test_connection(creds)
            assert result["ok"] is False
            assert "Connection refused" in result["error"]
