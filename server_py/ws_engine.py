"""
Backend OKX WebSocket Engine — connects to OKX via `websockets` library.

Mirrors server/wsEngine.ts architecture:
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
from typing import Any, Callable, Coroutine, Dict, List, Optional

import httpx
import websockets
from websockets.exceptions import ConnectionClosed

from .models import OptionData, WsStatus

WS_URL_PAPER = "wss://wspap.okx.com:8443/ws/v5/public"
WS_URL_REAL = "wss://ws.okx.com:8443/ws/v5/public"
HEARTBEAT_INTERVAL = 25  # seconds
THROTTLE_INTERVAL = 0.5  # 500ms
MAX_RECONNECT_DELAY = 30  # seconds
STALE_DATA_THRESHOLD = 60  # 60s without data
STALE_CHECK_INTERVAL = 30  # check every 30s


# ─── Instrument parser ────────────────────────────────────────────────────────

def _parse_okx_instrument(
    inst_id: str,
) -> Optional[dict]:
    """Parse e.g. 'BTC-USD-260404-60000-C' → {expiration, strike, type}."""
    parts = inst_id.split("-")
    if len(parts) < 5:
        return None
    expiry_raw = parts[2]
    strike_str = parts[3]
    type_char = parts[4]
    if len(expiry_raw) != 6:
        return None
    year = f"20{expiry_raw[:2]}"
    month = expiry_raw[2:4]
    day = expiry_raw[4:6]
    expiration = f"{year}/{month}/{day}"
    try:
        strike = float(strike_str)
    except ValueError:
        return None
    opt_type = "C" if type_char == "C" else "P"
    return {"expiration": expiration, "strike": strike, "type": opt_type}


class WsEngine:
    def __init__(
        self,
        on_update: Callable[[List[OptionData]], None],
        on_instant_update: Optional[Callable[[List[OptionData]], None]] = None,
        on_status_change: Optional[Callable[[WsStatus], None]] = None,
        paper: bool = True,
    ):
        self._paper = paper
        self._ws_url = WS_URL_PAPER if paper else WS_URL_REAL
        self._on_update = on_update
        self._on_instant_update = on_instant_update
        self._on_status_change = on_status_change

        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._ticker_map: Dict[str, Any] = {}
        self._spot_price: float = 0
        self._dirty: bool = False
        self._last_flush: float = 0
        self._last_message_time: float = 0
        self._status: WsStatus = "disconnected"
        self._reconnect_attempts: int = 0
        self._destroyed: bool = False

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

    async def _connection_loop(self) -> None:
        while not self._destroyed:
            try:
                await self._create_connection()
            except Exception as e:
                print(f"[WS-ENGINE] Connection error: {e}")
                self._set_status("error")
            if self._destroyed:
                break
            # Exponential backoff
            delay = min(2 ** self._reconnect_attempts, MAX_RECONNECT_DELAY)
            self._reconnect_attempts += 1
            self._ticker_map.clear()
            self._dirty = False
            print(f"[WS-ENGINE] Reconnecting in {delay}s (attempt {self._reconnect_attempts})")
            self._set_status("disconnected")
            await asyncio.sleep(delay)

    async def _create_connection(self) -> None:
        try:
            async with websockets.connect(self._ws_url, ping_interval=None, open_timeout=60) as ws:
                self._ws = ws
                print("[WS-ENGINE] Connected to OKX")
                self._reconnect_attempts = 0
                self._set_status("connected")

                await self._subscribe(ws)
                self._start_heartbeat(ws)
                self._start_staleness_check()

                async for raw_msg in ws:
                    if self._destroyed:
                        break
                    self._handle_message(str(raw_msg))
        except ConnectionClosed as e:
            print(f"[WS-ENGINE] Closed: {e.code} {e.reason}")
        except Exception as e:
            print(f"[WS-ENGINE] Error: {e}")
        finally:
            self._stop_heartbeat()
            self._ws = None

    async def _subscribe(self, ws) -> None:
        """Fetch all tradable BTC-USD option instrument IDs and subscribe."""
        print("[WS-ENGINE] Fetching instrument list for subscription...")
        inst_ids: List[str] = []
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                res = await client.get(
                    "https://www.okx.com/api/v5/public/instruments?instType=OPTION&uly=BTC-USD"  # instruments API is same for paper trading
                )
                data = res.json()
            if data.get("code") == "0" and data.get("data"):
                inst_ids = [i["instId"] for i in data["data"]]
        except Exception as e:
            print(f"[WS-ENGINE] Failed to fetch instruments: {e}")

        if not inst_ids:
            print("[WS-ENGINE] No instruments found — falling back to instType subscription")
            await ws.send(
                json.dumps(
                    {
                        "op": "subscribe",
                        "args": [
                            {
                                "channel": "tickers",
                                "instType": "OPTION",
                                "instFamily": "BTC-USD",
                            }
                        ],
                    }
                )
            )
            return

        BATCH_SIZE = 100
        for i in range(0, len(inst_ids), BATCH_SIZE):
            batch = inst_ids[i : i + BATCH_SIZE]
            msg = json.dumps(
                {
                    "op": "subscribe",
                    "args": [{"channel": "tickers", "instId": iid} for iid in batch],
                }
            )
            await ws.send(msg)
        print(
            f"[WS-ENGINE] Subscribed to {len(inst_ids)} option tickers "
            f"(in {-(-len(inst_ids) // BATCH_SIZE)} batches)"
        )

    def _handle_message(self, raw: str) -> None:
        if raw == "pong":
            return
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return

        if msg.get("event") == "subscribe":
            print(f"[WS-ENGINE] Subscription confirmed: {msg.get('arg')}")
            return
        if msg.get("event") == "error":
            print(f"[WS-ENGINE] Server error: {msg.get('code')} {msg.get('msg')}")
            return

        arg = msg.get("arg", {})
        if arg.get("channel") == "tickers" and msg.get("data"):
            self._last_message_time = time.time()
            for item in msg["data"]:
                self._ticker_map[item["instId"]] = item

            # Instant callback — pass ticker count only (no array rebuild!)
            # Full array rebuild happens only in throttled flush
            if self._on_instant_update:
                self._on_instant_update(len(self._ticker_map))

            self._dirty = True
            self._schedule_flush()

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
        for item in self._ticker_map.values():
            parsed = _parse_okx_instrument(item.get("instId", ""))
            if not parsed:
                continue
            try:
                raw_bid = float(item.get("bidPx", "0"))
                raw_ask = float(item.get("askPx", "0"))
            except (ValueError, TypeError):
                continue
            if not raw_bid or not raw_ask:
                continue
            bid = raw_bid * sp if sp > 0 else raw_bid
            ask = raw_ask * sp if sp > 0 else raw_ask
            spread_pct = ((ask - bid) / ask) * 100 if ask > 0 else 0

            results.append(
                OptionData(
                    instrument_name=item["instId"],
                    strike=parsed["strike"],
                    expiration=parsed["expiration"],
                    type=parsed["type"],
                    bid=bid,
                    ask=ask,
                    volume=float(item.get("vol24h", "0") or "0"),
                    underlying_price=sp,
                    spread_pct=spread_pct,
                    exchange="okx",
                    bidSize=float(item.get("bidSz", "0") or "0"),
                    askSize=float(item.get("askSz", "0") or "0"),
                )
            )
        return results

    # ─── Spot price ───────────────────────────────────────────────────────

    async def _fetch_spot_loop(self) -> None:
        self._http_client = httpx.AsyncClient(timeout=30)
        try:
            while not self._destroyed:
                fetched = False
                # Try Deribit first (reliable on cloud servers where OKX is blocked)
                try:
                    res = await self._http_client.get(
                        "https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL"
                    )
                    data = res.json()
                    price = data.get("result", {}).get("last_price", 0)
                    if price and price > 0:
                        self._spot_price = price
                        fetched = True
                except Exception as e:
                    print(f"[WS-ENGINE] Deribit spot failed: {type(e).__name__}: {e}")
                # Fallback to OKX if Deribit failed
                if not fetched:
                    try:
                        res = await self._http_client.get(
                            "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"
                        )
                        if res.status_code == 200:
                            data = res.json()
                            self._spot_price = float(
                                data.get("data", [{}])[0].get("last", "0") or "0"
                            )
                        else:
                            print(f"[WS-ENGINE] OKX spot returned {res.status_code}")
                    except Exception as e:
                        print(f"[WS-ENGINE] Spot price fetch failed: {type(e).__name__}: {e}")
                await asyncio.sleep(10)
        finally:
            await self._http_client.aclose()
            self._http_client = None

    # ─── Heartbeat & staleness ────────────────────────────────────────────

    def _start_heartbeat(self, ws) -> None:
        self._heartbeat_task = asyncio.ensure_future(self._heartbeat_loop(ws))

    async def _heartbeat_loop(self, ws) -> None:
        try:
            while not self._destroyed:
                if ws.open:
                    await ws.send("ping")
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
                        f"[WS-ENGINE] ⚠ Data stale for {stale_s}s — forcing reconnect"
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
