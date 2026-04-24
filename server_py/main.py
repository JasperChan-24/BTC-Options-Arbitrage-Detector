"""
BTC Options Arbitrage Detector — Python Backend Server

Runs independently of the browser.  Connects to OKX and Deribit WebSockets,
detects arbitrage, optionally auto-executes, and pushes data
to the React frontend via SSE.

Supports 4 market environments:
  - OKX Real + Deribit Real  (detect only)
  - OKX Paper + Deribit Testnet (detect + execute)

Usage:
  conda activate btc-arb
  python -m uvicorn server_py.main:app --host 0.0.0.0 --port 3001 --reload
"""

from __future__ import annotations
import os
import signal
import sys
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .models import OkxCredentials, DeribitCredentials, EngineConfig, ENV_MARKETS
from .sse_manager import SseManager
from .execution_store import ExecutionStore
from .email_notifier import EmailNotifier
from .arbitrage_engine import ArbitrageEngine
from .ws_engine import WsEngine
from .deribit_ws_engine import DeribitWsEngine
from .routes import create_routes

# Load .env before anything else
load_dotenv()

PORT = int(os.getenv("SERVER_PORT", "3001"))

# ─── Initialize components (module-level singletons) ──────────────────────────

sse = SseManager()
store = ExecutionStore()
email = EmailNotifier()
engine = ArbitrageEngine(sse, store, email)


# ─── WebSocket Engine callbacks ───────────────────────────────────────────────

# Throttle full options broadcast to every 5s (instead of every 500ms)
import time as _time
_last_options_broadcast: dict[str, float] = {
    "okx": 0, "okx_paper": 0, "deribit": 0, "deribit_test": 0,
}
OPTIONS_BROADCAST_INTERVAL = 5.0  # seconds


def _is_active_market(market_id: str) -> bool:
    """Check if a market belongs to the currently active environment."""
    active = ENV_MARKETS.get(_active_env, [])
    return market_id in active


def _make_okx_on_update(market_id: str, ws_ref):
    """Factory for OKX on_update callbacks, parameterized by market_id."""
    def _on_update(options):
        # Always cache options for instant switch; LP now runs for all envs
        engine._latest_options[market_id] = options  # keep cache warm

        async def _do_work():
            await engine.on_throttled_update(options, "okx", market_id=market_id)

            if _is_active_market(market_id):
                ticker_data: dict = {
                    "count": len(options),
                    "spotPrice": ws_ref().current_spot_price,
                    "wsStatus": ws_ref().status,
                    "market": market_id,
                }

                # Include full options array every 5s for table display
                now = _time.time()
                if now - _last_options_broadcast.get(market_id, 0) >= OPTIONS_BROADCAST_INTERVAL:
                    _last_options_broadcast[market_id] = now
                    ticker_data["options"] = ws_ref().get_options_snapshot_dump()

                sse.broadcast("ticker", ticker_data)
            
        import asyncio
        asyncio.create_task(_do_work())
    return _on_update


def _make_okx_on_status(market_id: str):
    def _on_status(status):
        print(f"[SERVER] OKX ({market_id}) WebSocket status: {status}")
        if _is_active_market(market_id):
            sse.broadcast("ws_status", {"status": status, "market": market_id})
    return _on_status


def _make_deribit_on_update(market_id: str, ws_ref):
    """Factory for Deribit on_update callbacks, parameterized by market_id."""
    def _on_update(options):
        # Always cache options for instant switch; LP now runs for all envs
        engine._latest_options[market_id] = options  # keep cache warm

        async def _do_work():
            await engine.on_throttled_update(options, "deribit", market_id=market_id)

            if _is_active_market(market_id):
                ticker_data: dict = {
                    "count": len(options),
                    "spotPrice": ws_ref().current_spot_price,
                    "wsStatus": ws_ref().status,
                    "market": market_id,
                }

                now = _time.time()
                if now - _last_options_broadcast.get(market_id, 0) >= OPTIONS_BROADCAST_INTERVAL:
                    _last_options_broadcast[market_id] = now
                    ticker_data["options"] = ws_ref().get_options_snapshot_dump()

                sse.broadcast("deribit_ticker", ticker_data)
            
        import asyncio
        asyncio.create_task(_do_work())
    return _on_update


def _make_deribit_on_status(market_id: str):
    def _on_status(status):
        print(f"[SERVER] Deribit ({market_id}) WebSocket status: {status}")
        if _is_active_market(market_id):
            sse.broadcast("deribit_ws_status", {"status": status, "market": market_id})
    return _on_status


# ─── Create 4 WsEngine instances ─────────────────────────────────────────────

# Testnet engines (default active, paper=True)
ws_okx_paper = WsEngine(
    on_update=_make_okx_on_update("okx_paper", lambda: ws_okx_paper),
    on_status_change=_make_okx_on_status("okx_paper"),
    paper=True,
)
ws_deribit_test = DeribitWsEngine(
    on_update=_make_deribit_on_update("deribit_test", lambda: ws_deribit_test),
    on_status_change=_make_deribit_on_status("deribit_test"),
    testnet=True,
)

# Real market engines (lazy — created but not connected on startup)
ws_okx_real = WsEngine(
    on_update=_make_okx_on_update("okx", lambda: ws_okx_real),
    on_status_change=_make_okx_on_status("okx"),
    paper=False,
)
ws_deribit_real = DeribitWsEngine(
    on_update=_make_deribit_on_update("deribit", lambda: ws_deribit_real),
    on_status_change=_make_deribit_on_status("deribit"),
    testnet=False,
)

# Engine map for environment switching
ws_engines: dict[str, dict] = {
    "real": {"okx": ws_okx_real, "deribit": ws_deribit_real},
    "testnet": {"okx": ws_okx_paper, "deribit": ws_deribit_test},
}

# Expose for routes — current active pair
ws_engine = ws_okx_paper          # default OKX engine (testnet)
deribit_ws_engine = ws_deribit_test  # default Deribit engine (testnet)

_active_env = "testnet"


def switch_environment(new_env: str) -> dict:
    """Switch between real/testnet environments.
    All engines run continuously — this only changes which data is displayed.
    """
    global ws_engine, deribit_ws_engine, _active_env

    if new_env not in ("real", "testnet"):
        return {"ok": False, "error": f"Invalid environment: {new_env}"}

    if new_env == _active_env:
        return {"ok": True, "environment": _active_env, "message": "Already active"}

    old_env = _active_env
    new_pair = ws_engines[new_env]

    # Update globals (no disconnect/reconnect — all engines stay alive)
    print(f"[SERVER] Switching environment: {old_env} → {new_env} (engines stay alive)")
    _active_env = new_env
    ws_engine = new_pair["okx"]
    deribit_ws_engine = new_pair["deribit"]
    engine.set_environment(new_env)

    # Broadcast environment change to all SSE clients
    sse.broadcast("environment_change", {
        "environment": new_env,
        "wsStatus": new_pair["okx"].status,
        "deribitWsStatus": new_pair["deribit"].status,
    })

    # Push cached arb data + options for BOTH exchanges in new environment
    active_ex = engine.get_active_exchange()
    other_ex = "deribit" if active_ex == "okx" else "okx"

    for ex in [active_ex, other_ex]:
        # Determine the market_id for the new environment
        if new_env == "testnet":
            mid = "okx_paper" if ex == "okx" else "deribit_test"
        else:
            mid = ex

        # Run LP solver on cached options from new environment
        cached_opts = engine._latest_options.get(mid)
        if cached_opts:
            engine.on_throttled_update(cached_opts, ex, market_id=mid)

        # Push options snapshot
        ws = new_pair[ex]
        options_dump = ws.get_options_snapshot_dump()
        if options_dump:
            event = "ticker" if ex == "okx" else "deribit_ticker"
            sse.broadcast(event, {
                "count": len(options_dump),
                "spotPrice": ws.current_spot_price,
                "wsStatus": ws.status,
                "market": mid,
                "options": options_dump,
            })

    # Reset options broadcast timestamps so next tick sends options immediately
    for mid in ENV_MARKETS.get(new_env, []):
        _last_options_broadcast[mid] = 0

    return {
        "ok": True,
        "environment": new_env,
        "message": f"Switched to {new_env}",
    }


def get_active_okx_engine():
    """Always returns the currently active OKX WsEngine."""
    return ws_engines[_active_env]["okx"]

def get_active_deribit_engine():
    """Always returns the currently active Deribit WsEngine."""
    return ws_engines[_active_env]["deribit"]


# ─── Lifespan (startup / shutdown) ───────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ────────────────────────────────────────────────────────────
    # Load OKX credentials from .env
    env_api_key = os.getenv("OKX_API_KEY")
    env_secret_key = os.getenv("OKX_SECRET_KEY")
    env_passphrase = os.getenv("OKX_PASSPHRASE")
    if env_api_key and env_secret_key and env_passphrase:
        creds = OkxCredentials(
            apiKey=env_api_key,
            secretKey=env_secret_key,
            passphrase=env_passphrase,
            simulated=os.getenv("OKX_SIMULATED", "true") != "false",
        )
        engine.set_credentials("okx", creds)
        print("[SERVER] Loaded OKX credentials from .env")

    # Load Deribit credentials from .env
    deribit_client_id = os.getenv("DERIBIT_CLIENT_ID")
    deribit_client_secret = os.getenv("DERIBIT_CLIENT_SECRET")
    if deribit_client_id and deribit_client_secret:
        creds_d = DeribitCredentials(
            clientId=deribit_client_id,
            clientSecret=deribit_client_secret,
            testnet=os.getenv("DERIBIT_TESTNET", "true") != "false",
        )
        engine.set_credentials("deribit", creds_d)
        print("[SERVER] Loaded Deribit credentials from .env")

    # Load engine config from .env
    env_config: dict = {}
    if os.getenv("MIN_VOLUME"):
        env_config["minVolume"] = int(os.getenv("MIN_VOLUME"))
    if os.getenv("MAX_SPREAD_PCT"):
        env_config["maxSpreadPct"] = int(os.getenv("MAX_SPREAD_PCT"))
    if os.getenv("AUTO_EXECUTE"):
        env_config["autoExecute"] = os.getenv("AUTO_EXECUTE") == "true"
    if os.getenv("INCLUDE_FEE"):
        env_config["includeFee"] = os.getenv("INCLUDE_FEE") != "false"
    if os.getenv("RISK_PCT"):
        env_config["riskPct"] = int(os.getenv("RISK_PCT"))
    if env_config:
        engine.update_config(env_config)

    # Start order polling for pending orders from previous sessions
    engine.start_global_order_polling()

    # Start WebSocket connections (testnet by default)
    print("")
    print("╔══════════════════════════════════════════════════════════╗")
    print("║   BTC Options Arbitrage Detector — Python Backend       ║")
    print(f"║   Listening on http://localhost:{PORT}                    ║")
    print("║                                                          ║")
    print(f"║   Environment: {_active_env:8s}                              ║")
    print(f"║   API:  http://localhost:{PORT}/api/status                ║")
    print(f"║   SSE:  http://localhost:{PORT}/api/events                ║")
    print("╚══════════════════════════════════════════════════════════╝")
    print("")

    # Start ALL WebSocket engines (all 4 run simultaneously)
    print(f"   Starting all 4 WS engines (active env: {_active_env})...")
    for env_name, pair in ws_engines.items():
        pair["okx"].connect()
        pair["deribit"].connect()
        print(f"   ✓ {env_name}: OKX + Deribit connected")

    yield  # ← App is running

    # ── Shutdown ───────────────────────────────────────────────────────────
    print("\n[SERVER] Shutting down...")
    for env_pair in ws_engines.values():
        env_pair["okx"].disconnect()
        env_pair["deribit"].disconnect()


# ─── FastAPI App ──────────────────────────────────────────────────────────────

app = FastAPI(
    title="BTC Options Arbitrage Detector",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount API routes under /api
app.include_router(
    create_routes(sse, engine, get_active_okx_engine, get_active_deribit_engine, store, switch_environment),
    prefix="/api",
)


# Health check (at root level, matching the TS version)
@app.get("/health")
async def health():
    import time
    return {"status": "ok", "uptime": time.time(), "environment": _active_env}


# ─── CLI entry point ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server_py.main:app",
        host="0.0.0.0",
        port=PORT,
        reload=True,
    )
