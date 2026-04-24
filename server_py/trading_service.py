"""
Backend OKX Trading Service — signs and sends orders to OKX REST API.

Uses Python's hmac module for HMAC-SHA256 signing.
Direct translation of server/tradingService.ts.
"""

from __future__ import annotations
import asyncio
import base64
import hashlib
import hmac
from datetime import datetime, timezone
from typing import Optional, Set

import httpx

from .models import (
    OkxCredentials,
    OrderRequest,
    OrderResult,
    PlaceOrdersResult,
    AccountBalance,
)

BASE = "https://www.okx.com"

# ─── Persistent HTTP client (connection pooling for Docker environments) ──────
_http_client: Optional[httpx.AsyncClient] = None
_HTTP_TIMEOUT = httpx.Timeout(30.0, connect=15.0)  # generous timeouts for Docker DNS
_MAX_RETRIES = 2


def _get_client() -> httpx.AsyncClient:
    """Get or create a persistent HTTP client with connection pooling."""
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=_HTTP_TIMEOUT,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=5),
        )
    return _http_client


# ─── HMAC-SHA256 signing ─────────────────────────────────────────────────────

def _sign(message: str, secret: str) -> str:
    mac = hmac.new(secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256)
    return base64.b64encode(mac.digest()).decode("utf-8")


def _build_headers(
    creds: OkxCredentials,
    method: str,
    path: str,
    body: str = "",
) -> dict[str, str]:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    pre_hash = timestamp + method + path + body
    signature = _sign(pre_hash, creds.secretKey)

    headers = {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": creds.apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": creds.passphrase,
    }
    if creds.simulated:
        headers["x-simulated-trading"] = "1"

    return headers


# ─── Connection test ──────────────────────────────────────────────────────────

async def test_connection(
    creds: OkxCredentials,
) -> dict:
    """Returns {"ok": True} or {"ok": False, "error": "..."}."""
    path = "/api/v5/account/config"
    try:
        headers = _build_headers(creds, "GET", path)
        client = _get_client()
        res = await client.get(BASE + path, headers=headers)
        data = res.json()
        if data.get("code") == "0":
            return {"ok": True}
        return {"ok": False, "error": f"{data.get('code')}: {data.get('msg')}"}
    except Exception as e:
        return {"ok": False, "error": str(e) or "Network error"}


# ─── Tradable instruments ─────────────────────────────────────────────────────

async def fetch_tradable_inst_ids(simulated: bool = False) -> Set[str]:
    try:
        url = "https://www.okx.com/api/v5/public/instruments?instType=OPTION&uly=BTC-USD"
        headers: dict[str, str] = {}
        if simulated:
            headers["x-simulated-trading"] = "1"
        client = _get_client()
        res = await client.get(url, headers=headers)
        data = res.json()
        if data.get("code") != "0":
            return set()
        return {item["instId"] for item in (data.get("data") or [])}
    except Exception:
        return set()


# ─── Account balance ──────────────────────────────────────────────────────────

async def fetch_account_balance(
    creds: OkxCredentials,
) -> Optional[AccountBalance]:
    path = "/api/v5/account/balance"
    try:
        headers = _build_headers(creds, "GET", path)
        client = _get_client()
        res = await client.get(BASE + path, headers=headers)
        data = res.json()
        if data.get("code") != "0" or not data.get("data", [None])[0]:
            return None

        account = data["data"][0]
        total_eq = float(account.get("totalEq", 0) or 0)
        btc_detail = next(
            (d for d in (account.get("details") or []) if d.get("ccy") == "BTC"),
            None,
        )
        avail_bal = float(btc_detail["availBal"]) if btc_detail else 0.0

        # Get spot price for USD conversion
        spot_price = 0.0
        try:
            spot_res = await client.get(
                "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"
            )
            spot_data = spot_res.json()
            spot_price = float(spot_data.get("data", [{}])[0].get("last", "0"))
        except Exception:
            pass

        return AccountBalance(
            totalEq=total_eq,
            availBal=avail_bal,
            availUsd=avail_bal * spot_price if spot_price > 0 else total_eq,
        )
    except Exception:
        return None


# ─── Place batch orders ──────────────────────────────────────────────────────

async def place_arbitrage_orders(
    creds: OkxCredentials,
    orders: list[OrderRequest],
) -> PlaceOrdersResult:
    import json as _json

    path = "/api/v5/trade/batch-orders"
    payload = [
        {
            "instId": o.instId,
            "tdMode": "isolated",
            "side": o.side,
            "ordType": "ioc",
            "sz": o.sz,
            "px": o.px,
        }
        for o in orders
    ]

    body = _json.dumps(payload)
    headers = _build_headers(creds, "POST", path, body)

    print(f"[TRADING] Placing batch orders: {payload}")

    try:
        for attempt in range(_MAX_RETRIES + 1):
            try:
                client = _get_client()
                res = await client.post(BASE + path, headers=headers, content=body)
                data = res.json()
                break  # success
            except Exception as e:
                if attempt < _MAX_RETRIES:
                    wait = 1.0 * (attempt + 1)
                    print(f"[TRADING] OKX attempt {attempt + 1} failed: {e}, retrying in {wait}s...")
                    await asyncio.sleep(wait)
                    # Reset client on connection errors
                    global _http_client
                    if _http_client and not _http_client.is_closed:
                        await _http_client.aclose()
                    _http_client = None
                else:
                    raise

        print(f"[TRADING] Response (HTTP {res.status_code}): {_json.dumps(data, indent=2)}")

        code = data.get("code", "")
        if code not in ("0", "1", "2"):
            err_msg = f"[{code}] {data.get('msg', '')}".strip()
            return PlaceOrdersResult(
                success=False, partialSuccess=False, results=[], error=err_msg
            )

        results = [OrderResult(**r) for r in (data.get("data") or [])]
        # OKX batch response doesn't include instId — backfill from request
        for i, r in enumerate(results):
            if not r.instId and i < len(orders):
                r.instId = orders[i].instId
        succeeded = sum(1 for r in results if r.sCode == "0")
        all_ok = succeeded == len(results)
        any_ok = succeeded > 0

        return PlaceOrdersResult(
            success=all_ok,
            partialSuccess=not all_ok and any_ok,
            results=results,
            error=(
                "; ".join(f"{r.sCode}: {r.sMsg}" for r in results if r.sCode != "0")
                if not all_ok
                else None
            ),
        )
    except Exception as e:
        print(f"[TRADING] Network error: {e}")
        return PlaceOrdersResult(
            success=False,
            partialSuccess=False,
            results=[],
            error=f"NETWORK: {e}",
        )


# ─── Order status ─────────────────────────────────────────────────────────────

async def fetch_order_status(
    creds: OkxCredentials,
    inst_id: str,
    ord_id: str,
) -> Optional[dict]:
    """Returns dict with {ordId, instId, side, sz, px, fillSz, state} or None."""
    from urllib.parse import quote

    path = f"/api/v5/trade/order?instId={quote(inst_id)}&ordId={quote(ord_id)}"
    try:
        headers = _build_headers(creds, "GET", path)
        client = _get_client()
        res = await client.get(BASE + path, headers=headers)
        data = res.json()
        if data.get("code") != "0" or not data.get("data", [None])[0]:
            return None
        return data["data"][0]
    except Exception:
        return None
