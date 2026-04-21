"""
OKX WebSocket Private Manager (Trading & Account)
Features:
- Auto-Login via HMAC SHA-256 Auth
- Generates Futures for matching WS request-response asynchronously
- Fallback degradation awareness
"""

import asyncio
import json
import base64
import hmac
import time
import uuid
from typing import Optional, Dict

import websockets
from pydantic import BaseModel

from .models import OkxCredentials, OrderRequest, PlaceOrdersResult, OrderResult

class OkxWsTrader:
    def __init__(self, creds: OkxCredentials):
        self.creds = creds
        self.ws_url = "wss://wspap.okx.com:8443/ws/v5/private" if creds.simulated else "wss://ws.okx.com:8443/ws/v5/private"
        self._ws = None
        self._pending_futures: Dict[str, asyncio.Future] = {}
        self._connected = False
        self._auth_success = False
        self._loop_task: Optional[asyncio.Task] = None

    async def connect_and_login(self) -> bool:
        if self._connected and self._auth_success:
            return True
        try:
            self._ws = await websockets.connect(self.ws_url, ping_interval=20, ping_timeout=10)
            self._connected = True
            self._loop_task = asyncio.create_task(self._listen_loop())
            return await self._login()
        except Exception as e:
            print(f"[OKX-WS-TRADER] Connection failed: {e}")
            return False

    def _generate_sign(self, timestamp: str) -> str:
        message = timestamp + "GET" + "/users/self/verify"
        mac = hmac.new(
            bytes(self.creds.secretKey, encoding="utf-8"),
            bytes(message, encoding="utf-8"),
            digestmod="sha256",
        )
        return base64.b64encode(mac.digest()).decode("utf-8")

    async def _login(self) -> bool:
        timestamp = str(time.time())
        sign = self._generate_sign(timestamp)
        args = {
            "apiKey": self.creds.apiKey,
            "passphrase": self.creds.passphrase,
            "timestamp": timestamp,
            "sign": sign,
        }
        
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        self._pending_futures[req_id] = fut

        msg = {
            "id": req_id,
            "op": "login",
            "args": [args]
        }
        await self._ws.send(json.dumps(msg))

        try:
            res = await asyncio.wait_for(fut, timeout=5.0)
            self._auth_success = res.get("code") == "0"
            if self._auth_success:
                # Mock header for simulated env (if required by WS, usually HTTP only)
                print("[OKX-WS-TRADER] Auth success")
            else:
                print(f"[OKX-WS-TRADER] Auth failed: {res}")
            return self._auth_success
        except asyncio.TimeoutError:
            print("[OKX-WS-TRADER] Auth timeout")
            return False

    async def _listen_loop(self):
        try:
            async for raw in self._ws:
                if raw == "pong":
                    continue
                try:
                    data = json.loads(raw)
                    req_id = data.get("id")
                    if req_id and req_id in self._pending_futures:
                        fut = self._pending_futures.pop(req_id)
                        if not fut.done():
                            fut.set_result(data)
                except Exception as e:
                    pass
        except Exception as e:
            print(f"[OKX-WS-TRADER] Disconnected: {e}")
        finally:
            self._connected = False
            self._auth_success = False
            # Cancel all pending
            for fut in self._pending_futures.values():
                if not fut.done():
                    fut.set_exception(Exception("WS Disconnected"))
            self._pending_futures.clear()

    async def place_batch_orders(self, orders: list[OrderRequest]) -> Optional[PlaceOrdersResult]:
        if not self._connected or not self._auth_success:
            return None

        req_id = uuid.uuid4().hex
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

        if self.creds.simulated:
             # Include simulated headers if necessary (usually only for REST, but OKX WS might need it in some environments)
             pass

        msg = {
            "id": req_id,
            "op": "batch-orders",
            "args": payload
        }

        fut = asyncio.get_running_loop().create_future()
        self._pending_futures[req_id] = fut

        try:
            raw_msg = json.dumps(msg)
            print(f"[OKX-WS-TRADER] WS Sent batch orders. ID: {req_id}")
            print(f"[OKX-WS-TRADER] Payload: {raw_msg}")
            await self._ws.send(raw_msg)
            res = await asyncio.wait_for(fut, timeout=10.0)
            print(f"[OKX-WS-TRADER] Response: {json.dumps(res)}")
            
            code = res.get("code", "")
            if code not in ("0", "1", "2"):
                return PlaceOrdersResult(success=False, partialSuccess=False, results=[], error=res.get("msg", "Unknown error"))
            
            results_data = res.get("data", [])
            results = [OrderResult(**r) for r in results_data]
            
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
                error="; ".join(f"{r.sCode}: {r.sMsg}" for r in results if r.sCode != "0") if not all_ok else None,
            )

        except Exception as e:
            print(f"[OKX-WS-TRADER] Order failed: {e}")
            return None
