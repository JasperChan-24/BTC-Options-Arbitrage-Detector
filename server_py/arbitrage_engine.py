"""
Backend Arbitrage Engine

Receives real-time data from WsEngine, runs LP arbitrage detection,
and optionally auto-executes via TradingService.

This is the "brain" of the backend — direct translation of
server/arbitrageEngine.ts.
"""

from __future__ import annotations
import asyncio
import time
from typing import Any, Dict, List, Optional

from .models import (
    ActiveExchange,
    ArbitrageResult,
    ArbitrageExecution,
    EngineConfig,
    OptionData,
    OkxCredentials,
    DeribitCredentials,
    OrderRequest,
    PortfolioPosition,
    SubmittedOrder,
    MARKET_EXCHANGE,
    MARKET_ENV,
    REAL_MARKETS,
    TEST_MARKETS,
    ENV_MARKETS,
)
from .arbitrage_service import detect_arbitrage
from . import trading_service as okx_trading
from . import deribit_trading_service as deribit_trading
from .sse_manager import SseManager
from .execution_store import ExecutionStore
from .email_notifier import EmailNotifier
from .okx_ws_trader import OkxWsTrader

COOLDOWN = 30  # 30s between executions per exchange


class ArbitrageEngine:
    def __init__(
        self,
        sse: SseManager,
        store: ExecutionStore,
        email: EmailNotifier,
    ):
        self._sse = sse
        self._store = store
        self._email = email

        self._config = EngineConfig()
        self._okx_credentials: Optional[OkxCredentials] = None
        self._deribit_credentials: Optional[DeribitCredentials] = None
        self._okx_ws_trader: Optional[OkxWsTrader] = None
        self._active_exchange: ActiveExchange = "okx"
        self._active_environment: str = "testnet"  # "real" | "testnet"

        # Per-market independent state (4 markets)
        _all_markets = ["okx", "okx_paper", "deribit", "deribit_test"]
        self._latest_options: Dict[str, List[OptionData]] = {m: [] for m in _all_markets}
        self._last_arb_sig: Dict[str, str] = {m: "" for m in _all_markets}
        self._last_exec_time: Dict[str, float] = {m: 0 for m in _all_markets}
        self._is_executing: Dict[str, bool] = {m: False for m in _all_markets}
        self._pending_instruments: Dict[str, set] = {m: set() for m in _all_markets}
        self._last_best_arb: Dict[str, Dict[str, Any]] = {
            m: {
                "result": ArbitrageResult(feasible=False, profit=0, portfolio=[]),
                "expiry": "",
            }
            for m in _all_markets
        }

        self._global_poll_task: Optional[asyncio.Task] = None

    # ─── Configuration ────────────────────────────────────────────────────

    def update_config(self, partial: dict) -> None:
        current = self._config.model_dump()
        current.update(partial)
        self._config = EngineConfig(**current)
        print(f"[ENGINE] Config updated: {self._config.model_dump()}")
        self._sse.broadcast("config", self._config.model_dump())

    def get_config(self) -> dict:
        return self._config.model_dump()

    def set_active_exchange(self, exchange: ActiveExchange) -> None:
        self._active_exchange = exchange
        print(f"[ENGINE] Active exchange set to: {exchange}")

    def get_active_exchange(self) -> ActiveExchange:
        return self._active_exchange

    def set_environment(self, env: str) -> None:
        if env not in ("real", "testnet"):
            return
        self._active_environment = env
        print(f"[ENGINE] Active environment set to: {env}")

    def get_environment(self) -> str:
        return self._active_environment

    def set_credentials(
        self,
        exchange: ActiveExchange,
        creds: Optional[OkxCredentials | DeribitCredentials],
    ) -> None:
        if exchange == "okx":
            self._okx_credentials = creds  # type: ignore
            sim = creds.simulated if isinstance(creds, OkxCredentials) else None
            print(f"[ENGINE] OKX credentials {'set' if creds else 'cleared'} (simulated: {sim})")
            
            # Spin up OKX Private WebSocket Trader
            if isinstance(creds, OkxCredentials):
                self._okx_ws_trader = OkxWsTrader(creds)
                asyncio.create_task(self._okx_ws_trader.connect_and_login())
            else:
                self._okx_ws_trader = None

        else:
            self._deribit_credentials = creds  # type: ignore
            tn = creds.testnet if isinstance(creds, DeribitCredentials) else None
            print(f"[ENGINE] Deribit credentials {'set' if creds else 'cleared'} (testnet: {tn})")

    def get_credentials(
        self, exchange: Optional[ActiveExchange] = None
    ) -> Optional[OkxCredentials | DeribitCredentials]:
        ex = exchange or self._active_exchange
        return self._okx_credentials if ex == "okx" else self._deribit_credentials

    def get_okx_credentials(self) -> Optional[OkxCredentials]:
        return self._okx_credentials

    def get_deribit_credentials(self) -> Optional[DeribitCredentials]:
        return self._deribit_credentials

    def get_last_arb(
        self, exchange: Optional[ActiveExchange] = None
    ) -> dict:
        ex = exchange or self._active_exchange
        return self._last_best_arb[ex]

    # ─── Called by WsEngine on every tick (lightweight notification) ────────

    def on_instant_update(
        self, ticker_count: int, exchange: ActiveExchange
    ) -> None:
        """Lightweight notification on every tick — NO LP, NO array rebuild.
        
        LP scanning only happens in on_throttled_update (every 500ms).
        This method just records last activity time for staleness detection.
        """
        # Nothing heavy here — all real work is in on_throttled_update
        pass

    # ─── Called by WsEngine on throttled updates (for SSE broadcast) ──────

    async def on_throttled_update(
        self, options: List[OptionData], exchange: ActiveExchange,
        market_id: Optional[str] = None,
    ) -> None:
        # Resolve market_id: if not provided, infer from environment + exchange
        if market_id is None:
            if self._active_environment == "testnet":
                market_id = "okx_paper" if exchange == "okx" else "deribit_test"
            else:
                market_id = exchange  # "okx" or "deribit"

        self._latest_options[market_id] = options  # cache for budget LP re-solve
        
        # Offload CPU-heavy LP solving to a background thread
        scan = await asyncio.to_thread(self._scan_all_expiries, options, exchange, market_id)
        
        result = scan["result"]
        expiry = scan["expiry"]
        self._last_best_arb[market_id] = {"result": result, "expiry": expiry}

        is_real = market_id in REAL_MARKETS

        # ── Real market: detect-only → log as "detected", no execution ────
        if result.feasible and len(result.portfolio) > 0:
            sig = "|".join(f"{p.instId}-{p.action}" for p in result.portfolio)
            if sig != self._last_arb_sig[market_id]:
                self._last_arb_sig[market_id] = sig

                if is_real:
                    # Real market — record detection with full portfolio, no execution
                    import uuid
                    from datetime import datetime, timezone
                    now_iso = datetime.now(timezone.utc).isoformat()
                    detected_orders = [
                        SubmittedOrder(
                            localId=f"det-{uuid.uuid4().hex[:6]}-{i}",
                            instId=pos.instId,
                            side=pos.action,
                            type=pos.type,
                            strike=pos.strike,
                            sz=str(max(1, round(pos.amount))),
                            px=f"{pos.rawPrice:.4f}",
                            fillStatus="pending",  # not executed
                            submittedAt=now_iso,
                        )
                        for i, pos in enumerate(result.portfolio)
                    ]
                    detection = ArbitrageExecution(
                        execId=str(uuid.uuid4())[:8],
                        exchange=exchange,
                        environment="real",
                        market=market_id,
                        timestamp=now_iso,
                        expectedProfit=result.profit,
                        orders=detected_orders,
                        overallStatus="detected",
                    )
                    self._store.add(detection)
                    self._sse.broadcast("execution", detection.model_dump())
                    print(
                        f"[ENGINE] Real market detection on {market_id}: "
                        f"${result.profit:.4f} profit, expiry {expiry}"
                    )
                else:
                    # Testnet — email + auto-execute
                    asyncio.ensure_future(self._email.notify_arbitrage(result, expiry))

                    creds = self.get_credentials(exchange)
                    if self._config.autoExecute and creds:
                        cooldown_ok = time.time() - self._last_exec_time[market_id] >= COOLDOWN
                        if cooldown_ok:
                            print(
                                f"[ENGINE] Auto-executing arb on {market_id}: "
                                f"${result.profit:.4f} profit, expiry {expiry}"
                            )
                            asyncio.ensure_future(
                                self.execute_arbitrage(result, exchange, market_id=market_id)
                            )

        # ── SSE broadcast ─────────────────────────────────────────────────
        # Determine if this market is the currently-viewed one
        active_markets = ENV_MARKETS.get(self._active_environment, [])
        is_active_market = market_id in active_markets
        is_active_exchange = exchange == self._active_exchange

        if is_active_market:
            event_name = "arbitrage" if is_active_exchange else "arbitrage_alt"
        else:
            # Not in active environment — don't broadcast to main SSE
            event_name = None

        broadcast_data: dict = {
            "result": result.model_dump(),
            "expiry": expiry,
            "exchange": exchange,
            "market": market_id,
            "environment": MARKET_ENV.get(market_id, "testnet"),
            "config": self._config.model_dump(),
        }

        if event_name:
            self._sse.broadcast(event_name, broadcast_data)

    # ─── Scan all expiries for best arbitrage ─────────────────────────────

    def _scan_all_expiries(
        self, options: List[OptionData], exchange: ActiveExchange,
        market_id: Optional[str] = None,
    ) -> dict:
        max_spread_pct = self._config.maxSpreadPct
        include_fee = self._config.includeFee
        budget_btc = (
            self._config.okxBudgetBtc
            if exchange == "okx"
            else self._config.deribitBudgetBtc
        )

        # Safety circuit breaker: if spot price failed to load, DO NOT run arbitrage 
        # (Otherwise BTC-denominated prices are treated as USD, causing 42 million dollar fake profits)
        if not options or options[0].underlying_price <= 0:
            return {"result": ArbitrageResult(feasible=False, profit=0.0, portfolio=[]), "expiry": ""}

        # Testnet/paper markets have very low volume — bypass volume filter
        is_testnet = market_id in TEST_MARKETS if market_id else False
        min_volume = 0 if is_testnet else self._config.minVolume

        filtered = [
            o
            for o in options
            if o.volume >= min_volume
            and o.spread_pct <= max_spread_pct
            and o.bid > 0
            and o.ask > 0
            and ((o.bidSize or 0) > 0 or (o.askSize or 0) > 0)
        ]

        expiry_set = set(o.expiration for o in filtered)

        best: dict = {
            "result": ArbitrageResult(feasible=False, profit=0, portfolio=[]),
            "expiry": "",
        }

        for exp in expiry_set:
            group = [o for o in filtered if o.expiration == exp]
            if len(group) < 3:
                continue
            res = detect_arbitrage(
                group, 0.0003 if include_fee else 0, budget_btc
            )
            if res.feasible and res.profit > best["result"].profit:
                best = {"result": res, "expiry": exp}

        return best

    # ─── Execute arbitrage ────────────────────────────────────────────────

    async def execute_arbitrage(
        self,
        arb_result: Optional[ArbitrageResult] = None,
        exchange: Optional[ActiveExchange] = None,
        market_id: Optional[str] = None,
    ) -> Optional[ArbitrageExecution]:
        ex = exchange or self._active_exchange
        # Resolve market_id
        if market_id is None:
            if self._active_environment == "testnet":
                market_id = "okx_paper" if ex == "okx" else "deribit_test"
            else:
                market_id = ex

        # Block execution on real markets
        if market_id in REAL_MARKETS:
            print(f"[ENGINE] Execution blocked on real market {market_id}")
            return None

        result = arb_result or self._last_best_arb[market_id]["result"]

        if not result.feasible or len(result.portfolio) == 0:
            print(f"[ENGINE] No feasible arbitrage to execute on {market_id}")
            return None

        active_creds = self.get_credentials(ex)
        if not active_creds:
            print(f"[ENGINE] No {ex} credentials set — cannot execute")
            return None

        if self._is_executing[market_id]:
            print(f"[ENGINE] Already executing on {market_id} — skipping")
            return None

        self._is_executing[market_id] = True
        self._sse.broadcast("execution_status", {"status": "sending", "exchange": ex, "market": market_id})

        try:
            # Pre-validate instruments
            is_okx = ex == "okx"
            if is_okx:
                tradable = await okx_trading.fetch_tradable_inst_ids(
                    active_creds.simulated  # type: ignore
                )
            else:
                tradable = await deribit_trading.fetch_tradable_inst_ids(
                    active_creds.testnet  # type: ignore
                )

            valid_portfolio = list(result.portfolio)
            if tradable:
                valid_portfolio = [p for p in valid_portfolio if p.instId in tradable]
                print(
                    f"[ENGINE] Portfolio: {len(result.portfolio)} legs → "
                    f"{len(valid_portfolio)} valid"
                )

            # ── Plan A: Real-time balance check → re-solve LP with budget ────
            real_balance = None
            try:
                if is_okx:
                    bal = await okx_trading.fetch_account_balance(active_creds)  # type: ignore
                else:
                    bal = await deribit_trading.fetch_account_balance(active_creds)  # type: ignore
                if bal:
                    real_balance = bal.availBal
                    print(f"[ENGINE] Real-time balance: {real_balance:.6f} BTC")
            except Exception as e:
                print(f"[ENGINE] Failed to fetch balance: {e}")

            if real_balance is not None and real_balance > 0:
                # Re-run LP with strict budget on the valid instruments
                source_options = self._latest_options.get(market_id, [])  # Use market_id, not exchange
                opt_map = {o.instrument_name: o for o in source_options}
                valid_inst_ids = {p.instId for p in valid_portfolio}
                budget_options = [o for name, o in opt_map.items() if name in valid_inst_ids]

                if len(budget_options) >= 3:
                    budget_result = detect_arbitrage(
                        budget_options,
                        fee_rate=0.0003 if self._config.includeFee else 0,
                        budget_btc=real_balance,
                    )
                    if budget_result.feasible and len(budget_result.portfolio) > 0:
                        print(
                            f"[ENGINE] Budget-constrained LP: ${budget_result.profit:.2f} profit, "
                            f"{len(budget_result.portfolio)} legs (budget={real_balance:.6f} BTC)"
                        )
                        result = budget_result
                        valid_portfolio = list(budget_result.portfolio)
                    else:
                        print("[ENGINE] Budget-constrained LP found no arb — using original")
            # ── End Plan A ───────────────────────────────────────────────────

            if not valid_portfolio:
                self._sse.broadcast(
                    "execution_status",
                    {"status": "error", "message": "No valid instruments"},
                )
                return None

            # Self-trade detection
            buy_ids = {p.instId for p in valid_portfolio if p.action == "buy"}
            sell_ids = {p.instId for p in valid_portfolio if p.action == "sell"}
            if buy_ids & sell_ids:
                print("[ENGINE] Self-trade detected — skipping")
                self._sse.broadcast(
                    "execution_status",
                    {"status": "error", "message": "Inverted spread (self-trade)"},
                )
                return None

            # Filter out zero-price legs
            priced_portfolio = [p for p in valid_portfolio if p.rawPrice > 0]
            if not priced_portfolio:
                print("[ENGINE] All legs have zero price — skipping")
                self._sse.broadcast(
                    "execution_status",
                    {"status": "error", "message": "All legs have zero price"},
                )
                return None
            if len(priced_portfolio) < len(valid_portfolio):
                print(
                    f"[ENGINE] Dropped {len(valid_portfolio) - len(priced_portfolio)} "
                    "zero-price legs"
                )

            # Filter out instruments with pending/live orders (avoid order_overlap)
            pending = self._pending_instruments[market_id]
            if pending:
                before = len(priced_portfolio)
                priced_portfolio = [p for p in priced_portfolio if p.instId not in pending]
                if len(priced_portfolio) < before:
                    print(f"[ENGINE] Skipped {before - len(priced_portfolio)} legs with pending orders")
                if not priced_portfolio:
                    print("[ENGINE] All legs have pending orders — skipping")
                    return None

            # Build orders with sanity guards
            MAX_SZ = 1000 if is_okx else 100  # Cap contract size
            MAX_BATCH = 20  # OKX batch limit
            orders: list[OrderRequest] = []
            for pos in priced_portfolio:
                px_str = f"{pos.rawPrice:.4f}"
                if px_str == "0.0000":
                    continue  # Skip legs with effectively zero price
                sz = min(max(1, round(pos.amount)), MAX_SZ)
                orders.append(
                    OrderRequest(
                        instId=pos.instId,
                        side=pos.action,
                        sz=str(sz),
                        px=px_str,
                    )
                )

            # Respect OKX batch order limit (max 20)
            if is_okx and len(orders) > MAX_BATCH:
                print(f"[ENGINE] Truncating {len(orders)} orders to {MAX_BATCH} (OKX limit)")
                orders = orders[:MAX_BATCH]

            exec_result = None
            if is_okx:
                # FORCE REST: OKX simulated WS batch-orders returns 50014 for some instruments
                # TODO: Re-enable WS trading after investigating OKX WS API compatibility
                # if self._okx_ws_trader:
                #     exec_result = await self._okx_ws_trader.place_batch_orders(orders)
                
                # if exec_result is None:
                print("[ENGINE] Using REST API for OKX order placement")
                exec_result = await okx_trading.place_arbitrage_orders(
                    active_creds, orders  # type: ignore
                )
            else:
                exec_result = await deribit_trading.place_arbitrage_orders(
                    active_creds, orders  # type: ignore
                )

            # Build execution record
            batch_rejected = len(exec_result.results) == 0 and not exec_result.success
            now_iso = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())

            submitted_orders: List[SubmittedOrder] = []
            for i, pos in enumerate(priced_portfolio):
                r = exec_result.results[i] if i < len(exec_result.results) else None
                ok = r is not None and r.sCode == "0"
                submitted_orders.append(
                    SubmittedOrder(
                        localId=f"{int(time.time() * 1000)}-{i}",
                        instId=pos.instId,
                        side=pos.action,
                        type=pos.type,
                        strike=pos.strike,
                        sz=str(max(1, round(pos.amount))),
                        px=f"{pos.rawPrice:.4f}",
                        ordId=r.ordId if ok and r else None,
                        fillStatus="live" if ok else "failed",
                        failureCode=(
                            None if ok else (r.sCode if r else ("BATCH" if batch_rejected else None))
                        ),
                        failureMsg=(
                            None
                            if ok
                            else (
                                r.sMsg
                                if r
                                else (exec_result.error if batch_rejected else "Rejected")
                            )
                        ),
                        submittedAt=now_iso,
                    )
                )

            overall = "pending"
            if exec_result.success:
                overall = "pending"
            elif exec_result.partialSuccess:
                overall = "partial"
            else:
                overall = "failed"

            execution = ArbitrageExecution(
                execId=f"exec-{int(time.time() * 1000)}",
                exchange=ex,
                environment=MARKET_ENV.get(market_id, "testnet"),
                market=market_id,
                timestamp=now_iso,
                expectedProfit=result.profit,
                orders=submitted_orders,
                overallStatus=overall,
            )

            # Persist and broadcast
            self._store.add(execution)
            self._sse.broadcast("execution", execution.model_dump())
            self._sse.broadcast(
                "execution_status",
                {
                    "status": "success" if exec_result.success else "error",
                    "message": (
                        f"{len(exec_result.results)}/{len(exec_result.results)} legs filled"
                        if exec_result.success
                        else exec_result.error
                    ),
                },
            )

            # Email notification
            succeeded = sum(1 for r in exec_result.results if r.sCode == "0")
            asyncio.ensure_future(
                self._email.notify_execution(
                    result.profit,
                    len(exec_result.results),
                    succeeded,
                    exec_result.error,
                )
            )

            # Track instruments with live orders to prevent order_overlap
            live_inst_ids = {
                so.instId for so in submitted_orders
                if so.fillStatus in ("live", "filled")
            }
            self._pending_instruments[market_id] |= live_inst_ids
            if live_inst_ids:
                # Auto-clear pending after 60s
                _mid = market_id  # capture for closure
                async def _clear_pending():
                    await asyncio.sleep(60)
                    self._pending_instruments[_mid] -= live_inst_ids
                asyncio.ensure_future(_clear_pending())

            return execution

        finally:
            self._last_exec_time[market_id] = time.time()
            self._is_executing[market_id] = False

    # ─── Global Order Status Polling ──────────────────────────────────────

    def start_global_order_polling(self) -> None:
        if self._global_poll_task and not self._global_poll_task.done():
            return  # already running

        all_execs = self._store.get_all()
        has_pending = any(
            e.overallStatus in ("pending", "partial") for e in all_execs
        )
        if not has_pending:
            print("[POLL] No pending orders — skipping global poll start")
            return

        print("[POLL] Starting global order status polling (every 10s)")
        self._global_poll_task = asyncio.ensure_future(self._poll_loop())

    async def _poll_loop(self) -> None:
        # Immediate first poll
        await self._poll_all_pending_orders()
        while True:
            await asyncio.sleep(10)
            still_pending = any(
                e.overallStatus in ("pending", "partial")
                for e in self._store.get_all()
            )
            if not still_pending:
                print("[POLL] All orders resolved — stopping global poll")
                break
            await self._poll_all_pending_orders()

    async def _poll_all_pending_orders(self) -> None:
        all_execs = self._store.get_all()
        pending_execs = [
            e for e in all_execs if e.overallStatus in ("pending", "partial")
        ]
        if not pending_execs:
            return

        for execution in pending_execs:
            exchange: ActiveExchange = execution.exchange or "okx"
            creds = self.get_credentials(exchange)
            if not creds:
                continue

            pending_orders = [
                o
                for o in execution.orders
                if o.ordId and o.fillStatus in ("live", "pending")
            ]
            if not pending_orders:
                continue

            changed = False

            for order in pending_orders:
                try:
                    if exchange == "okx":
                        detail = await okx_trading.fetch_order_status(
                            creds, order.instId, order.ordId  # type: ignore
                        )
                    else:
                        detail = await deribit_trading.fetch_order_status(
                            creds, order.ordId  # type: ignore
                        )

                    if detail is None:
                        if order.fillStatus != "cancelled":
                            order.fillStatus = "cancelled"
                            changed = True
                            print(
                                f"[POLL] {order.instId} {order.ordId}: "
                                "not found → cancelled (expired/settled)"
                            )
                        continue

                    raw_state = detail.get("state", "")
                    if raw_state == "filled":
                        new_status = "filled"
                    elif raw_state == "partially_filled":
                        new_status = "partially_filled"
                    elif raw_state in ("live", "open"):
                        new_status = "live"
                    elif raw_state in ("cancelled", "canceled", "rejected"):
                        new_status = "cancelled"
                    else:
                        new_status = order.fillStatus

                    if new_status != order.fillStatus:
                        order.fillStatus = new_status
                        changed = True
                        print(
                            f"[POLL] {order.instId} {order.ordId}: "
                            f"{raw_state} → {new_status}"
                        )
                except Exception:
                    pass  # Non-fatal

            if changed:
                all_filled = all(o.fillStatus == "filled" for o in execution.orders)
                any_filled = any(o.fillStatus == "filled" for o in execution.orders)
                all_terminal = all(
                    o.fillStatus in ("filled", "cancelled", "failed")
                    for o in execution.orders
                )

                if all_filled:
                    execution.overallStatus = "complete"
                elif all_terminal and any_filled:
                    execution.overallStatus = "partial"
                elif all_terminal:
                    execution.overallStatus = "failed"

                self._store.update(execution.execId, lambda _: execution)
                self._sse.broadcast("execution_update", execution.model_dump())
                print(
                    f"[POLL] {execution.execId} updated → "
                    f"overall: {execution.overallStatus}"
                )
