"""
Pydantic data models — mirrors src/types.ts.

Field names use snake_case internally but serialize to the exact same JSON
keys as the TypeScript version (camelCase where needed via alias).
"""

from __future__ import annotations
from typing import Literal, Optional, List
from pydantic import BaseModel, ConfigDict


# ─── Option Data ──────────────────────────────────────────────────────────────

class OptionData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    instrument_name: str
    strike: float
    expiration: str
    type: Literal["C", "P"]
    bid: float
    ask: float
    volume: float
    underlying_price: float
    spread_pct: float
    exchange: Literal["deribit", "okx"]
    bidSize: float  # keep camelCase to match frontend
    askSize: float


# ─── Arbitrage Result ─────────────────────────────────────────────────────────

class PortfolioPosition(BaseModel):
    instId: str
    strike: float
    type: Literal["C", "P"]
    action: Literal["buy", "sell"]
    amount: float
    price: float       # USD (for display)
    rawPrice: float    # native currency (BTC for OKX)
    maxDepth: float    # order book depth available


class ArbitrageResult(BaseModel):
    feasible: bool
    profit: float
    portfolio: List[PortfolioPosition]


# ─── Credentials ──────────────────────────────────────────────────────────────

class OkxCredentials(BaseModel):
    apiKey: str
    secretKey: str
    passphrase: str
    simulated: bool = True


class DeribitCredentials(BaseModel):
    clientId: str
    clientSecret: str
    testnet: bool = True


# ─── Orders & Executions ─────────────────────────────────────────────────────

class SubmittedOrder(BaseModel):
    localId: str
    instId: str
    side: Literal["buy", "sell"]
    type: Literal["C", "P"]
    strike: float
    sz: str
    px: str
    ordId: Optional[str] = None
    fillStatus: Literal[
        "pending", "live", "filled", "partially_filled", "cancelled", "failed"
    ] = "pending"
    failureCode: Optional[str] = None
    failureMsg: Optional[str] = None
    submittedAt: str = ""


class ArbitrageExecution(BaseModel):
    execId: str
    exchange: Optional[Literal["okx", "deribit"]] = None
    environment: Literal["real", "testnet"] = "testnet"
    market: Optional[str] = None  # MarketId: okx | okx_paper | deribit | deribit_test
    timestamp: str
    expectedProfit: float
    orders: List[SubmittedOrder]
    overallStatus: Literal["pending", "partial", "complete", "failed", "detected"]


# ─── Engine Config ────────────────────────────────────────────────────────────

class EngineConfig(BaseModel):
    minVolume: int = 1
    maxSpreadPct: int = 100
    includeFee: bool = True
    autoExecute: bool = False
    okxRiskPct: int = 25
    okxBudgetBtc: float = 0
    deribitRiskPct: int = 25
    deribitBudgetBtc: float = 0


# ─── Trading Service Types ───────────────────────────────────────────────────

class OrderRequest(BaseModel):
    instId: str
    side: Literal["buy", "sell"]
    sz: str
    px: str


class OrderResult(BaseModel):
    instId: str = ""
    clOrdId: str = ""
    ordId: str = ""
    sCode: str = ""
    sMsg: str = ""


class PlaceOrdersResult(BaseModel):
    success: bool
    partialSuccess: bool
    results: List[OrderResult]
    error: Optional[str] = None


class AccountBalance(BaseModel):
    totalEq: float
    availBal: float
    availUsd: float


# Type aliases
ActiveExchange = Literal["okx", "deribit"]
MarketId = Literal["okx", "okx_paper", "deribit", "deribit_test"]
Environment = Literal["real", "testnet"]
WsStatus = Literal["connecting", "connected", "disconnected", "error"]

# Market metadata
MARKET_EXCHANGE: dict[str, str] = {
    "okx": "okx", "okx_paper": "okx",
    "deribit": "deribit", "deribit_test": "deribit",
}
MARKET_ENV: dict[str, str] = {
    "okx": "real", "okx_paper": "testnet",
    "deribit": "real", "deribit_test": "testnet",
}
REAL_MARKETS = {"okx", "deribit"}
TEST_MARKETS = {"okx_paper", "deribit_test"}
ENV_MARKETS: dict[str, list[str]] = {
    "real": ["okx", "deribit"],
    "testnet": ["okx_paper", "deribit_test"],
}
