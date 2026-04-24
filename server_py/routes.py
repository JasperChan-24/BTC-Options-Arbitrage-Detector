"""
Backend REST API Routes — exchange-aware.

Direct translation of server/routes.ts.
All endpoints match the TypeScript version 1:1 so that the frontend
(src/services/backendApi.ts) needs zero changes.
"""

from __future__ import annotations
import json
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

from .models import (
    ActiveExchange,
    OkxCredentials,
    DeribitCredentials,
)
from .sse_manager import SseManager
from .arbitrage_engine import ArbitrageEngine
from .ws_engine import WsEngine
from .deribit_ws_engine import DeribitWsEngine
from .execution_store import ExecutionStore
from . import trading_service as okx_trading
from . import deribit_trading_service as deribit_trading


def create_routes(
    sse: SseManager,
    engine: ArbitrageEngine,
    get_okx_ws,
    get_deribit_ws,
    store: ExecutionStore,
    switch_environment_fn=None,
) -> APIRouter:
    router = APIRouter()

    # ─── SSE endpoint ─────────────────────────────────────────────────────

    @router.get("/events")
    async def sse_events(request: Request):
        client_id, generator = sse.add_client()

        # Send current state as 'snapshot'
        _okx = get_okx_ws()
        _drb = get_deribit_ws()
        active_ex = engine.get_active_exchange()

        # Send options for the ACTIVE exchange (not always OKX)
        if active_ex == "okx":
            options_dump = _okx.get_options_snapshot_dump()
            spot = _okx.current_spot_price
        else:
            options_dump = _drb.get_options_snapshot_dump()
            spot = _drb.current_spot_price

        last_arb = engine.get_last_arb()

        sse.send_to(
            client_id,
            "snapshot",
            {
                "options": options_dump,
                "spotPrice": spot,
                "arbitrage": {
                    "result": last_arb["result"].model_dump(),
                    "expiry": last_arb["expiry"],
                },
                "config": engine.get_config(),
                "wsStatus": _okx.status,
                "tickerCount": _okx.ticker_count if active_ex == "okx" else _drb.ticker_count,
                "executions": [e.model_dump() for e in store.get_recent(30)],
                "hasCredentials": engine.get_credentials() is not None,
                "activeExchange": active_ex,
                # Deribit info
                "deribitWsStatus": _drb.status,
                "deribitTickerCount": _drb.ticker_count,
                "hasDeribitCredentials": engine.get_deribit_credentials() is not None,
                "hasOkxCredentials": engine.get_okx_credentials() is not None,
                "environment": engine.get_environment(),
            },
        )

        return EventSourceResponse(generator)

    # ─── Environment ──────────────────────────────────────────────────────

    @router.get("/environment")
    async def get_environment():
        return {"environment": engine.get_environment()}

    @router.post("/environment")
    async def set_environment(request: Request):
        body = await request.json()
        env = body.get("environment")
        if switch_environment_fn:
            result = switch_environment_fn(env)
            return result
        return JSONResponse({"error": "Environment switching not available"}, status_code=500)

    # ─── Active Exchange ──────────────────────────────────────────────────

    @router.post("/exchange")
    async def set_exchange(request: Request):
        body = await request.json()
        exchange = body.get("exchange")
        if exchange not in ("okx", "deribit"):
            return JSONResponse({"error": "Invalid exchange"}, status_code=400)

        engine.set_active_exchange(exchange)

        # Notify all SSE clients of the exchange switch immediately
        sse.broadcast("active_exchange_change", {"activeExchange": exchange})

        # Push cached arb result instantly (no LP recompute needed)
        cached_arb = engine.get_last_arb(exchange)
        sse.broadcast("arbitrage", {
            "result": cached_arb["result"].model_dump(),
            "expiry": cached_arb["expiry"],
            "exchange": exchange,
            "config": engine.get_config(),
        })

        # Push other exchange's arb result
        other_ex = "deribit" if exchange == "okx" else "okx"
        other_arb = engine.get_last_arb(other_ex)
        sse.broadcast("arbitrage_alt", {
            "result": other_arb["result"].model_dump(),
            "expiry": other_arb["expiry"],
            "exchange": other_ex,
            "config": engine.get_config(),
        })

        # Heavy work (options snapshot broadcast) in background
        def _push_options():
            ws = get_okx_ws() if exchange == "okx" else get_deribit_ws()
            options_dump = ws.get_options_snapshot_dump()
            if options_dump:
                event = "ticker" if exchange == "okx" else "deribit_ticker"
                sse.broadcast(event, {
                    "count": len(options_dump),
                    "spotPrice": ws.current_spot_price,
                    "wsStatus": ws.status,
                    "market": exchange,
                    "options": options_dump,
                })

        from starlette.background import BackgroundTask
        return JSONResponse(
            {"ok": True, "exchange": exchange},
            background=BackgroundTask(_push_options),
        )

    # ─── Credentials (exchange-aware) ─────────────────────────────────────

    @router.post("/credentials")
    async def set_credentials(request: Request):
        body = await request.json()
        exchange: ActiveExchange = body.get("exchange", "okx")

        if exchange == "okx":
            api_key = body.get("apiKey")
            secret_key = body.get("secretKey")
            passphrase = body.get("passphrase")
            simulated = body.get("simulated", True)
            if not api_key or not secret_key or not passphrase:
                return JSONResponse(
                    {"error": "Missing required OKX fields"}, status_code=400
                )
            okx_creds = OkxCredentials(
                apiKey=api_key,
                secretKey=secret_key,
                passphrase=passphrase,
                simulated=simulated,
            )
            test = await okx_trading.test_connection(okx_creds)
            if not test["ok"]:
                return JSONResponse({"error": test.get("error")}, status_code=401)
            engine.set_credentials("okx", okx_creds)
            sse.broadcast(
                "credentials_status",
                {"exchange": "okx", "hasCredentials": True, "simulated": simulated},
            )
        else:
            client_id = body.get("clientId")
            client_secret = body.get("clientSecret")
            testnet = body.get("testnet", True)
            if not client_id or not client_secret:
                return JSONResponse(
                    {"error": "Missing required Deribit fields"}, status_code=400
                )
            deribit_creds = DeribitCredentials(
                clientId=client_id, clientSecret=client_secret, testnet=testnet
            )
            test = await deribit_trading.test_connection(deribit_creds)
            if not test["ok"]:
                return JSONResponse({"error": test.get("error")}, status_code=401)
            engine.set_credentials("deribit", deribit_creds)
            sse.broadcast(
                "credentials_status",
                {"exchange": "deribit", "hasCredentials": True, "testnet": testnet},
            )

        return {"ok": True}

    @router.delete("/credentials")
    async def clear_credentials(request: Request):
        exchange = request.query_params.get("exchange") or engine.get_active_exchange()
        engine.set_credentials(exchange, None)
        if exchange == "deribit":
            deribit_trading.clear_token_cache()
        sse.broadcast("credentials_status", {"exchange": exchange, "hasCredentials": False})
        return {"ok": True}

    @router.get("/credentials/status")
    async def credentials_status():
        okx_creds = engine.get_okx_credentials()
        deribit_creds = engine.get_deribit_credentials()
        return {
            "hasCredentials": engine.get_credentials() is not None,
            "simulated": okx_creds.simulated if okx_creds else None,
            "okx": {
                "hasCredentials": okx_creds is not None,
                "simulated": okx_creds.simulated if okx_creds else None,
            },
            "deribit": {
                "hasCredentials": deribit_creds is not None,
                "testnet": deribit_creds.testnet if deribit_creds else None,
            },
            "activeExchange": engine.get_active_exchange(),
        }

    # ─── Test connection ──────────────────────────────────────────────────

    @router.post("/test-connection")
    async def test_connection(request: Request):
        body = await request.json()
        exchange = body.get("exchange", "okx")

        if exchange == "okx":
            api_key = body.get("apiKey")
            secret_key = body.get("secretKey")
            passphrase = body.get("passphrase")
            simulated = body.get("simulated", True)
            if not api_key or not secret_key or not passphrase:
                return JSONResponse(
                    {"ok": False, "error": "Missing fields"}, status_code=400
                )
            result = await okx_trading.test_connection(
                OkxCredentials(
                    apiKey=api_key,
                    secretKey=secret_key,
                    passphrase=passphrase,
                    simulated=simulated,
                )
            )
            return result
        else:
            client_id = body.get("clientId")
            client_secret = body.get("clientSecret")
            testnet = body.get("testnet", True)
            if not client_id or not client_secret:
                return JSONResponse(
                    {"ok": False, "error": "Missing fields"}, status_code=400
                )
            result = await deribit_trading.test_connection(
                DeribitCredentials(
                    clientId=client_id, clientSecret=client_secret, testnet=testnet
                )
            )
            return result

    # ─── Balance ──────────────────────────────────────────────────────────

    @router.get("/balance")
    async def get_balance(request: Request):
        exchange = request.query_params.get("exchange") or engine.get_active_exchange()
        creds = engine.get_credentials(exchange)
        if not creds:
            return JSONResponse({"error": "No credentials"}, status_code=401)

        if exchange == "okx":
            balance = await okx_trading.fetch_account_balance(creds)  # type: ignore
        else:
            balance = await deribit_trading.fetch_account_balance(creds)  # type: ignore

        if not balance:
            return JSONResponse(
                {"error": "Failed to fetch balance"}, status_code=500
            )
        return balance.model_dump()

    # ─── Manual execute ───────────────────────────────────────────────────

    @router.post("/execute")
    async def execute():
        execution = await engine.execute_arbitrage()
        if not execution:
            return JSONResponse(
                {"error": "No feasible arbitrage or missing credentials"},
                status_code=400,
            )
        return execution.model_dump()

    # ─── Execution history (paginated) ───────────────────────────────────

    @router.get("/executions")
    async def get_executions(request: Request):
        offset = int(request.query_params.get("offset", "0"))
        limit = int(request.query_params.get("limit", "30"))
        date = request.query_params.get("date", None)
        tz_offset = request.query_params.get("tzOffset", None)
        result = store.get_paginated(offset=offset, limit=limit, date=date or None, tz_offset=tz_offset)
        return {
            "items": [e.model_dump() for e in result["items"]],
            "total": result["total"],
            "hasMore": result["hasMore"],
        }

    @router.get("/execution-dates")
    async def get_execution_dates(request: Request):
        """Return all unique dates that have execution records."""
        tz_offset = request.query_params.get("tzOffset", None)
        return {"dates": store.get_available_dates(tz_offset=tz_offset)}

    @router.delete("/executions/{exec_id}")
    async def delete_execution(exec_id: str):
        """Delete a single execution record permanently."""
        deleted = store.delete(exec_id)
        return {"ok": deleted, "execId": exec_id}

    # ─── Config ───────────────────────────────────────────────────────────

    @router.get("/config")
    async def get_config():
        return engine.get_config()

    @router.post("/config")
    async def update_config(request: Request):
        body = await request.json()
        engine.update_config(body)
        return engine.get_config()

    # ─── Status ───────────────────────────────────────────────────────────

    @router.get("/status")
    async def get_status():
        _okx = get_okx_ws()
        _drb = get_deribit_ws()
        return {
            "wsStatus": _okx.status,
            "tickerCount": _okx.ticker_count,
            "lastDataTime": _okx.last_data_time,
            "spotPrice": _okx.current_spot_price,
            "sseClients": sse.client_count,
            "hasCredentials": engine.get_credentials() is not None,
            "config": engine.get_config(),
            "activeExchange": engine.get_active_exchange(),
            # Deribit
            "deribitWsStatus": _drb.status,
            "deribitTickerCount": _drb.ticker_count,
            "deribitSpotPrice": _drb.current_spot_price,
        }

    return router
