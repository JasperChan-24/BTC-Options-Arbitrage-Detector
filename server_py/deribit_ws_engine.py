"""
Backend Deribit WebSocket Engine — connects to Deribit via `websockets` library.

Mirrors the OKX WsEngine architecture:
- Subscribes to all BTC option tickers
- Provides instant + throttled callbacks
- Auto-reconnects with exponential backoff
- Staleness watchdog
"""

from __future__ import annotations
import asyncio
import json
import re
import time
from typing import Any, Callable, Dict, List, Optional

import httpx
import websockets
from websockets.exceptions import ConnectionClosed

from .models import OptionData, WsStatus

HEARTBEAT_INTERVAL = 15  # Deribit recommends 15s
THROTTLE_INTERVAL = 0.5  # 500ms
MAX_RECONNECT_DELAY = 30  # seconds
STALE_DATA_THRESHOLD = 60  # 60s without data
STALE_CHECK_INTERVAL = 30  # check every 30s

MONTHS = {
    "JAN": "01", "FEB": "02", "MAR": "03", "APR": "04",
    "MAY": "05", "JUN": "06", "JUL": "07", "AUG": "08",
    "SEP": "09", "OCT": "10", "NOV": "11", "DEC": "12",
}


# ─── Instrument parser ────────────────────────────────────────────────────────

def _parse_deribit_instrument(
    name: str,
) -> Optional[dict]:
    """Parse e.g. 'BTC-4APR26-60000-C' → {expiration, strike, type}."""
    parts = name.split("-")
    if len(parts) < 4:
        return None
    expiry_raw = parts[1]
    strike_str = parts[2]
    type_char = parts[3]

    match = re.match(r"^(\d{1,2})([A-Z]{3})(\d{2})$", expiry_raw, re.IGNORECASE)
    if not match:
        return None

    day = match.group(1).zfill(2)
    month_str = match.group(2).upper()
    year = match.group(3)
    month = MONTHS.get(month_str)
    if not month:
        return None

    expiration = f"20{year}/{month}/{day}"
    try:
        strike = float(strike_str)
    except ValueError:
        return None
    opt_type = "C" if type_char == "C" else "P"
    return {"expiration": expiration, "strike": strike, "type": opt_type}


class DeribitWsEngine:
    def __init__(
        self,
        on_update: Callable[[List[OptionData]], None],
        on_instant_update: Optional[Callable[[List[OptionData]], None]] = None,
        on_status_change: Optional[Callable[[WsStatus], None]] = None,
        testnet: bool = False,
    ):
        self._on_update = on_update
        self._on_instant_update = on_instant_update
        self._on_status_change = on_status_change
        self._testnet = testnet

        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._ticker_map: Dict[str, Any] = {}
        self._spot_price: float = 0
        self._dirty: bool = False
        self._last_flush: float = 0
        self._last_message_time: float = 0
        self._status: WsStatus = "disconnected"
        self._reconnect_attempts: int = 0
        self._destroyed: bool = False
        self._rpc_id: int = 0

        # Background tasks
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._staleness_task: Optional[asyncio.Task] = None
        self._flush_task: Optional[asyncio.Task] = None
        self._spot_task: Optional[asyncio.Task] = None
        self._conn_task: Optional[asyncio.Task] = None

        # Shared HTTP client (reused across spot price fetches)
        self._http_client: Optional[httpx.AsyncClient] = None

    # ─── Properties ───────────────────────────────────────────────────────

    @property
    def status(self) -> WsStatus:
        return self._status

    @property
    def ticker_count(self) -> int:
        return len(self._ticker_map)

    @property
    def last_data_time(self) -> float:
        return self._last_message_time

    @property
    def current_spot_price(self) -> float:
        return self._spot_price

    # ─── Public API ───────────────────────────────────────────────────────

    def connect(self) -> None:
        if self._destroyed:
            return
        self._set_status("connecting")
        self._spot_task = asyncio.ensure_future(self._fetch_spot_loop())
        self._conn_task = asyncio.ensure_future(self._connection_loop())

    def disconnect(self) -> None:
        self._destroyed = True
        self._cleanup()
        self._set_status("disconnected")

    def get_options_snapshot(self) -> List[OptionData]:
        return self._build_options_array()

    # ─── Connection lifecycle ─────────────────────────────────────────────

    def _set_status(self, s: WsStatus) -> None:
        self._status = s
        if self._on_status_change:
            self._on_status_change(s)

    def _get_ws_url(self) -> str:
        return (
            "wss://test.deribit.com/ws/api/v2"
            if self._testnet
            else "wss://www.deribit.com/ws/api/v2"
        )

    def _next_id(self) -> int:
        self._rpc_id += 1
        return self._rpc_id

    async def _send_rpc(self, ws, method: str, params: dict = None) -> None:
        if params is None:
            params = {}
        msg = json.dumps(
            {"jsonrpc": "2.0", "id": self._next_id(), "method": method, "params": params}
        )
        await ws.send(msg)

    async def _connection_loop(self) -> None:
        while not self._destroyed:
            try:
                await self._create_connection()
            except Exception as e:
                print(f"[DERIBIT-WS] Connection error: {e}")
                self._set_status("error")
            if self._destroyed:
                break
            delay = min(2 ** self._reconnect_attempts, MAX_RECONNECT_DELAY)
            self._reconnect_attempts += 1
            self._ticker_map.clear()
            self._dirty = False
            print(f"[DERIBIT-WS] Reconnecting in {delay}s (attempt {self._reconnect_attempts})")
            self._set_status("disconnected")
            await asyncio.sleep(delay)

    async def _create_connection(self) -> None:
        try:
            async with websockets.connect(self._get_ws_url(), ping_interval=None) as ws:
                self._ws = ws
                print("[DERIBIT-WS] Connected")
                self._reconnect_attempts = 0
                self._set_status("connected")

                await self._setup_heartbeat(ws)
                await self._subscribe_to_tickers(ws)
                self._start_staleness_check()

                async for raw_msg in ws:
                    if self._destroyed:
                        break
                    self._handle_message(str(raw_msg))
        except ConnectionClosed as e:
            print(f"[DERIBIT-WS] Closed: {e.code} {e.reason}")
        except Exception as e:
            print(f"[DERIBIT-WS] Error: {e}")
        finally:
            self._stop_heartbeat()
            self._ws = None

    async def _subscribe_to_tickers(self, ws) -> None:
        """Fetch all BTC option instruments and subscribe to tickers."""
        base_url = (
            "https://test.deribit.com" if self._testnet else "https://www.deribit.com"
        )
        instruments: List[str] = []
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                res = await client.get(
                    f"{base_url}/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false"
                )
                data = res.json()
            if data.get("result"):
                instruments = [i["instrument_name"] for i in data["result"]]
        except Exception as e:
            print(f"[DERIBIT-WS] Failed to fetch instruments: {e}")

        if not instruments:
            print("[DERIBIT-WS] No instruments found")
            return

        BATCH_SIZE = 200
        for i in range(0, len(instruments), BATCH_SIZE):
            batch = instruments[i : i + BATCH_SIZE]
            channels = [f"ticker.{name}.100ms" for name in batch]
            await self._send_rpc(ws, "public/subscribe", {"channels": channels})

        print(f"[DERIBIT-WS] Subscribed to {len(instruments)} option tickers")

    def _handle_message(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return

        # Handle subscription data
        if msg.get("method") == "subscription" and msg.get("params", {}).get("data"):
            data = msg["params"]["data"]
            inst_name = data.get("instrument_name", "")
            if not inst_name or not inst_name.startswith("BTC-"):
                return

            self._last_message_time = time.time()
            self._ticker_map[inst_name] = data

            # Instant callback — pass ticker count only (no array rebuild!)
            # Full array rebuild happens only in throttled flush
            if self._on_instant_update:
                self._on_instant_update(len(self._ticker_map))

            self._dirty = True
            self._schedule_flush()
            return

        # Handle heartbeat test_request
        if (
            msg.get("method") == "heartbeat"
            and msg.get("params", {}).get("type") == "test_request"
        ):
            if self._ws:
                asyncio.ensure_future(self._send_rpc(self._ws, "public/test"))
            return

    # ─── Throttled flush ──────────────────────────────────────────────────

    def _schedule_flush(self) -> None:
        if self._flush_task and not self._flush_task.done():
            return
        elapsed = time.time() - self._last_flush
        delay = max(0, THROTTLE_INTERVAL - elapsed)
        self._flush_task = asyncio.ensure_future(self._do_flush(delay))

    async def _do_flush(self, delay: float) -> None:
        if delay > 0:
            await asyncio.sleep(delay)
        if self._dirty:
            self._dirty = False
            self._last_flush = time.time()
            self._on_update(self._build_options_array())

    # ─── Build options array ──────────────────────────────────────────────

    def _build_options_array(self) -> List[OptionData]:
        results: List[OptionData] = []
        sp = self._spot_price

        for inst_name, data in self._ticker_map.items():
            parsed = _parse_deribit_instrument(inst_name)
            if not parsed:
                continue

            raw_bid = data.get("best_bid_price", 0) or 0
            raw_ask = data.get("best_ask_price", 0) or 0
            if raw_ask <= 0 and raw_bid <= 0:
                continue

            underlying_price = data.get("underlying_price") or sp
            bid = raw_bid * underlying_price
            ask = raw_ask * underlying_price
            spread_pct = ((ask - bid) / ask) * 100 if ask > 0 else 0

            stats_volume = 0
            stats = data.get("stats")
            if isinstance(stats, dict):
                stats_volume = stats.get("volume", 0) or 0

            results.append(
                OptionData(
                    instrument_name=inst_name,
                    strike=parsed["strike"],
                    expiration=parsed["expiration"],
                    type=parsed["type"],
                    bid=bid,
                    ask=ask,
                    volume=stats_volume * 100,  # Convert to OKX-equivalent contracts
                    underlying_price=underlying_price,
                    spread_pct=spread_pct,
                    exchange="deribit",
                    bidSize=data.get("best_bid_amount", 0) or 0,
                    askSize=data.get("best_ask_amount", 0) or 0,
                )
            )
        return results

    # ─── Spot price ───────────────────────────────────────────────────────

    async def _fetch_spot_loop(self) -> None:
        self._http_client = httpx.AsyncClient(timeout=10)
        try:
            while not self._destroyed:
                try:
                    base_url = (
                        "https://test.deribit.com"
                        if self._testnet
                        else "https://www.deribit.com"
                    )
                    res = await self._http_client.get(
                        f"{base_url}/api/v2/public/ticker?instrument_name=BTC-PERPETUAL"
                    )
                    data = res.json()
                    self._spot_price = data.get("result", {}).get("last_price", 0) or 0
                except Exception:
                    print("[DERIBIT-WS] Failed to fetch spot price, will retry")
                await asyncio.sleep(10)
        finally:
            await self._http_client.aclose()
            self._http_client = None

    # ─── Heartbeat & staleness ────────────────────────────────────────────

    async def _setup_heartbeat(self, ws) -> None:
        await self._send_rpc(ws, "public/set_heartbeat", {"interval": 15})
        self._heartbeat_task = asyncio.ensure_future(self._heartbeat_loop(ws))

    async def _heartbeat_loop(self, ws) -> None:
        try:
            while not self._destroyed:
                await self._send_rpc(ws, "public/test")
                await asyncio.sleep(HEARTBEAT_INTERVAL)
        except Exception:
            pass

    def _start_staleness_check(self) -> None:
        self._staleness_task = asyncio.ensure_future(self._staleness_loop())

    async def _staleness_loop(self) -> None:
        try:
            while not self._destroyed:
                await asyncio.sleep(STALE_CHECK_INTERVAL)
                if (
                    self._last_message_time > 0
                    and time.time() - self._last_message_time > STALE_DATA_THRESHOLD
                ):
                    stale_s = int(time.time() - self._last_message_time)
                    print(
                        f"[DERIBIT-WS] ⚠ Data stale for {stale_s}s — forcing reconnect"
                    )
                    if self._ws:
                        await self._ws.close()
                    break
        except Exception:
            pass

    def _stop_heartbeat(self) -> None:
        for task in (self._heartbeat_task, self._staleness_task):
            if task and not task.done():
                task.cancel()
        self._heartbeat_task = None
        self._staleness_task = None

    # ─── Cleanup ──────────────────────────────────────────────────────────

    def _cleanup(self) -> None:
        self._stop_heartbeat()
        for task in (self._flush_task, self._spot_task, self._conn_task):
            if task and not task.done():
                task.cancel()
        self._flush_task = None
        self._spot_task = None
        self._conn_task = None
        self._ws = None
