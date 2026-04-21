"""
Backend Deribit Trading Service — authenticates and places orders via Deribit REST API.

Uses OAuth 2.0 Bearer Token authentication (client_credentials grant).
Direct translation of server/deribitTradingService.ts.
"""

from __future__ import annotations
import time
from typing import Optional, Set
from urllib.parse import urlencode

import httpx

from .models import (
    DeribitCredentials,
    OrderRequest,
    OrderResult,
    PlaceOrdersResult,
    AccountBalance,
)


def _base_url(testnet: bool) -> str:
    return "https://test.deribit.com" if testnet else "https://www.deribit.com"


# ─── Authentication ───────────────────────────────────────────────────────────

_cached_token: dict | None = None  # {token, expires_at, key}


async def _authenticate(
    creds: DeribitCredentials,
) -> dict:
    """Returns {"ok": True, "token": "..."} or {"ok": False, "error": "..."}."""
    global _cached_token
    cache_key = f"{creds.clientId}:{creds.testnet}"
    if (
        _cached_token
        and _cached_token["key"] == cache_key
        and time.time() < _cached_token["expires_at"] - 60
    ):
        return {"ok": True, "token": _cached_token["token"]}

    base = _base_url(creds.testnet)
    url = (
        f"{base}/api/v2/public/auth"
        f"?grant_type=client_credentials"
        f"&client_id={creds.clientId}"
        f"&client_secret={creds.clientSecret}"
    )
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(url)
            data = res.json()
        if data.get("error"):
            err = data["error"]
            return {"ok": False, "error": f"[{err.get('code')}] {err.get('message')}"}

        result = data["result"]
        _cached_token = {
            "token": result["access_token"],
            "expires_at": time.time() + result["expires_in"],
            "key": cache_key,
        }
        return {"ok": True, "token": result["access_token"]}
    except Exception as e:
        return {"ok": False, "error": str(e) or "Network error"}


async def _authed_fetch(
    creds: DeribitCredentials,
    path: str,
    params: Optional[dict[str, str]] = None,
) -> dict:
    auth = await _authenticate(creds)
    if not auth["ok"]:
        raise RuntimeError(auth["error"])

    base = _base_url(creds.testnet)
    qs = "?" + urlencode(params) if params else ""
    url = f"{base}{path}{qs}"

    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.get(url, headers={"Authorization": f"Bearer {auth['token']}"})
        data = res.json()

    if data.get("error"):
        err = data["error"]
        raise RuntimeError(f"[{err.get('code')}] {err.get('message')}")
    return data["result"]


# ─── Connection test ──────────────────────────────────────────────────────────

async def test_connection(creds: DeribitCredentials) -> dict:
    auth = await _authenticate(creds)
    if not auth["ok"]:
        return {"ok": False, "error": auth["error"]}
    return {"ok": True}


# ─── Account balance ─────────────────────────────────────────────────────────

async def fetch_account_balance(
    creds: DeribitCredentials,
) -> Optional[AccountBalance]:
    try:
        result = await _authed_fetch(
            creds, "/api/v2/private/get_account_summary", {"currency": "BTC"}
        )
        equity = result.get("equity", 0)
        avail_bal = result.get("available_funds") or result.get(
            "available_withdrawal_funds", 0
        )

        spot_price = 0.0
        try:
            base = _base_url(creds.testnet)
            async with httpx.AsyncClient(timeout=10) as client:
                ticker_res = await client.get(
                    f"{base}/api/v2/public/ticker?instrument_name=BTC-PERPETUAL"
                )
                ticker_data = ticker_res.json()
            spot_price = ticker_data.get("result", {}).get("last_price", 0)
        except Exception:
            pass

        return AccountBalance(
            totalEq=equity,
            availBal=avail_bal,
            availUsd=avail_bal * spot_price if spot_price > 0 else equity * 30000,
        )
    except Exception as e:
        print(f"[DERIBIT] fetchAccountBalance error: {e}")
        return None


# ─── Tradable instruments ─────────────────────────────────────────────────────

async def fetch_tradable_inst_ids(testnet: bool) -> Set[str]:
    try:
        base = _base_url(testnet)
        url = f"{base}/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false"
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(url)
            data = res.json()
        if data.get("error") or not data.get("result"):
            return set()
        return {i["instrument_name"] for i in data["result"]}
    except Exception:
        return set()


# ─── Place orders (one at a time — Deribit has no batch endpoint) ─────────────

async def _place_single_order(
    creds: DeribitCredentials,
    order: OrderRequest,
) -> OrderResult:
    endpoint = "/api/v2/private/buy" if order.side == "buy" else "/api/v2/private/sell"
    try:
        result = await _authed_fetch(
            creds,
            endpoint,
            {
                "instrument_name": order.instId,
                "amount": order.sz,
                "type": "limit",
                "price": order.px,
                "time_in_force": "immediate_or_cancel",
            },
        )
        o = result.get("order", {})
        return OrderResult(
            instId=order.instId,
            clOrdId=o.get("label", ""),
            ordId=o.get("order_id", ""),
            sCode="0",
            sMsg="ok",
        )
    except Exception as e:
        return OrderResult(
            instId=order.instId,
            clOrdId="",
            ordId="",
            sCode="ERR",
            sMsg=str(e) or "Failed",
        )


async def place_arbitrage_orders(
    creds: DeribitCredentials,
    orders: list[OrderRequest],
) -> PlaceOrdersResult:
    print(f"[DERIBIT] Placing orders: {[o.model_dump() for o in orders]}")

    results: list[OrderResult] = []
    for order in orders:
        result = await _place_single_order(creds, order)
        results.append(result)

    succeeded = sum(1 for r in results if r.sCode == "0")
    all_ok = succeeded == len(results)
    any_ok = succeeded > 0

    print(f"[DERIBIT] Results: {succeeded}/{len(results)} succeeded")

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


# ─── Order status ─────────────────────────────────────────────────────────────

async def fetch_order_status(
    creds: DeribitCredentials,
    order_id: str,
) -> Optional[dict]:
    """Returns dict with {ordId, instId, side, sz, px, fillSz, state} or None."""
    try:
        result = await _authed_fetch(
            creds,
            "/api/v2/private/get_order_state",
            {"order_id": order_id},
        )
        return {
            "ordId": result.get("order_id"),
            "instId": result.get("instrument_name"),
            "side": result.get("direction"),
            "sz": str(result.get("amount", "")),
            "px": str(result.get("price", "")),
            "fillSz": str(result.get("filled_amount", 0)),
            "state": result.get("order_state"),
        }
    except Exception:
        return None


# ─── Clear cached token ──────────────────────────────────────────────────────

def clear_token_cache() -> None:
    global _cached_token
    _cached_token = None
