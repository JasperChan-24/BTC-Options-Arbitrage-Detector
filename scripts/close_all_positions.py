"""
Close all positions on OKX (paper trading) and Deribit (testnet).
Also cancels all pending orders.

Usage:
    cd /Users/chenyanyu/Downloads/BTC-Options-Arbitrage-Detector
    /opt/anaconda3/envs/btc-arb/bin/python scripts/close_all_positions.py
"""

import asyncio
import os
import sys

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv()

import httpx
import json
import hmac
import hashlib
import base64
from datetime import datetime, timezone


# ─── OKX ──────────────────────────────────────────────────────────────────────

OKX_API_KEY = os.getenv("OKX_API_KEY", "")
OKX_SECRET_KEY = os.getenv("OKX_SECRET_KEY", "")
OKX_PASSPHRASE = os.getenv("OKX_PASSPHRASE", "")
OKX_SIMULATED = os.getenv("OKX_SIMULATED", "true") == "true"
OKX_BASE = "https://www.okx.com"


def _okx_headers(method: str, path: str, body: str = "") -> dict:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    sign_str = ts + method.upper() + path + body
    mac = hmac.new(OKX_SECRET_KEY.encode(), sign_str.encode(), hashlib.sha256)
    signature = base64.b64encode(mac.digest()).decode()
    headers = {
        "OK-ACCESS-KEY": OKX_API_KEY,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": ts,
        "OK-ACCESS-PASSPHRASE": OKX_PASSPHRASE,
        "Content-Type": "application/json",
    }
    if OKX_SIMULATED:
        headers["x-simulated-trading"] = "1"
    return headers


async def okx_close_all():
    print("\n═══ OKX (Paper Trading) ═══")
    async with httpx.AsyncClient(timeout=15) as client:
        # 1. Cancel all pending orders
        print("  Fetching pending orders...")
        path = "/api/v5/trade/orders-pending?instType=OPTION"
        headers = _okx_headers("GET", path)
        res = await client.get(OKX_BASE + path, headers=headers)
        data = res.json()
        pending = data.get("data", [])
        print(f"  Found {len(pending)} pending orders")

        for order in pending:
            cancel_path = "/api/v5/trade/cancel-order"
            cancel_body = json.dumps({
                "instId": order["instId"],
                "ordId": order["ordId"]
            })
            cancel_headers = _okx_headers("POST", cancel_path, cancel_body)
            cancel_res = await client.post(
                OKX_BASE + cancel_path, headers=cancel_headers, content=cancel_body
            )
            print(f"    Cancel {order['instId']} {order['ordId']}: {cancel_res.json().get('code')}")

        # 2. Get all positions
        print("  Fetching positions...")
        path = "/api/v5/account/positions?instType=OPTION"
        headers = _okx_headers("GET", path)
        res = await client.get(OKX_BASE + path, headers=headers)
        data = res.json()
        positions = data.get("data", [])
        open_positions = [p for p in positions if float(p.get("pos", 0)) != 0]
        print(f"  Found {len(open_positions)} positions to close")

        # Close each position with a limit order at best price
        for pos in open_positions:
            inst_id = pos["instId"]
            pos_amt = float(pos.get("pos", 0))
            if pos_amt == 0:
                continue

            # Determine close direction and get market price
            close_side = "sell" if pos_amt > 0 else "buy"
            close_sz = str(int(abs(pos_amt)))

            # Fetch current ticker for limit price
            try:
                ticker_path = f"/api/v5/market/ticker?instId={inst_id}"
                ticker_headers = _okx_headers("GET", ticker_path)
                ticker_res = await client.get(OKX_BASE + ticker_path, headers=ticker_headers)
                ticker_data = ticker_res.json()
                tick = ticker_data.get("data", [{}])[0]
                # Use aggressive price: sell at bid, buy at ask
                if close_side == "sell":
                    px = tick.get("bidPx", tick.get("last", "0.0001"))
                else:
                    px = tick.get("askPx", tick.get("last", "0.0001"))
                if not px or float(px) <= 0:
                    px = tick.get("last", "0.0001")
            except Exception:
                px = "0.0001"

            # Place limit order to close
            order_path = "/api/v5/trade/order"
            order_body = json.dumps({
                "instId": inst_id,
                "tdMode": "isolated",
                "side": close_side,
                "ordType": "limit",
                "sz": close_sz,
                "px": str(px),
                "reduceOnly": True,
            })
            order_headers = _okx_headers("POST", order_path, order_body)
            order_res = await client.post(
                OKX_BASE + order_path, headers=order_headers, content=order_body
            )
            result = order_res.json()
            code = result.get("code", "?")
            order_data = result.get("data", [{}])[0]
            msg = order_data.get("sMsg", result.get("msg", ""))
            ord_id = order_data.get("ordId", "")
            status = "✅" if code == "0" else "❌"
            print(f"    {status} {inst_id} ({pos_amt:+.0f} → {close_side} {close_sz} @ {px}): "
                  f"code={code} {msg} {ord_id}")

    print("  ✅ OKX done")


# ─── Deribit ──────────────────────────────────────────────────────────────────

DERIBIT_CLIENT_ID = os.getenv("DERIBIT_CLIENT_ID", "")
DERIBIT_CLIENT_SECRET = os.getenv("DERIBIT_CLIENT_SECRET", "")
DERIBIT_TESTNET = os.getenv("DERIBIT_TESTNET", "true") == "true"
DERIBIT_BASE = "https://test.deribit.com" if DERIBIT_TESTNET else "https://www.deribit.com"


async def _deribit_auth(client: httpx.AsyncClient) -> str:
    """Authenticate and return access token."""
    res = await client.get(
        f"{DERIBIT_BASE}/api/v2/public/auth",
        params={
            "client_id": DERIBIT_CLIENT_ID,
            "client_secret": DERIBIT_CLIENT_SECRET,
            "grant_type": "client_credentials",
        }
    )
    data = res.json()
    return data["result"]["access_token"]


async def deribit_close_all():
    print("\n═══ Deribit (Testnet) ═══")
    async with httpx.AsyncClient(timeout=15) as client:
        token = await _deribit_auth(client)
        auth_headers = {"Authorization": f"Bearer {token}"}

        # 1. Cancel all orders
        print("  Cancelling all orders...")
        res = await client.get(
            f"{DERIBIT_BASE}/api/v2/private/cancel_all",
            headers=auth_headers,
        )
        data = res.json()
        print(f"    Result: {data.get('result', data.get('error', 'unknown'))}")

        # 2. Get all positions
        print("  Fetching positions...")
        res = await client.get(
            f"{DERIBIT_BASE}/api/v2/private/get_positions",
            params={"currency": "BTC", "kind": "option"},
            headers=auth_headers,
        )
        data = res.json()
        positions = data.get("result", [])
        open_positions = [p for p in positions if abs(p.get("size", 0)) > 0]
        print(f"  Found {len(open_positions)} open positions (out of {len(positions)} total)")

        for pos in open_positions:
            inst = pos["instrument_name"]
            size = pos["size"]
            direction = pos["direction"]

            # Close by market order in opposite direction
            close_side = "sell" if direction == "buy" else "buy"
            close_amount = abs(size)

            res = await client.get(
                f"{DERIBIT_BASE}/api/v2/private/{close_side}",
                params={
                    "instrument_name": inst,
                    "amount": close_amount,
                    "type": "market",
                },
                headers=auth_headers,
            )
            result = res.json()
            if "result" in result:
                order = result["result"].get("order", {})
                print(f"    Close {inst} ({size:+.0f} → {close_side} {close_amount}): "
                      f"{order.get('order_state', 'ok')}")
            else:
                err = result.get("error", {})
                print(f"    Close {inst}: ERROR {err.get('code')} {err.get('message')}")

    print("  ✅ Deribit done")


# ─── Main ─────────────────────────────────────────────────────────────────────

async def main():
    print("🔧 Closing all positions on both exchanges...")
    print(f"   OKX: {'Paper Trading' if OKX_SIMULATED else 'LIVE (!)'}")
    print(f"   Deribit: {'Testnet' if DERIBIT_TESTNET else 'LIVE (!)'}")

    if OKX_API_KEY:
        await okx_close_all()
    else:
        print("\n  ⚠️ OKX: No API key configured, skipping")

    if DERIBIT_CLIENT_ID:
        await deribit_close_all()
    else:
        print("\n  ⚠️ Deribit: No API key configured, skipping")

    print("\n🎉 All done!")

if __name__ == "__main__":
    asyncio.run(main())
