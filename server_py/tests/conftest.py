"""
Shared test fixtures for BTC Options Arbitrage Detector.
"""

import pytest
import os
import tempfile
from typing import List, Dict


@pytest.fixture
def sample_options() -> List[Dict]:
    """
    Minimal BTC option chain for testing LP solver.
    3 strikes with calls and puts — enough for butterfly spread detection.
    """
    base_price = 100_000  # BTC underlying price

    return [
        # Strike 90000 — deep ITM call, OTM put
        {
            "instrument_name": "BTC-20250630-90000-C",
            "strike": 90000,
            "expiration": "2025-06-30",
            "type": "C",
            "bid": 10045.0, "ask": 10055.0,
            "volume": 50,
            "underlying_price": base_price,
            "spread_pct": 0.1,
            "exchange": "okx",
            "bidSize": 10, "askSize": 10,
        },
        {
            "instrument_name": "BTC-20250630-90000-P",
            "strike": 90000,
            "expiration": "2025-06-30",
            "type": "P",
            "bid": 45.0, "ask": 55.0,
            "volume": 30,
            "underlying_price": base_price,
            "spread_pct": 18.18,
            "exchange": "okx",
            "bidSize": 5, "askSize": 5,
        },
        # Strike 100000 — ATM
        {
            "instrument_name": "BTC-20250630-100000-C",
            "strike": 100000,
            "expiration": "2025-06-30",
            "type": "C",
            "bid": 2950.0, "ask": 3050.0,
            "volume": 100,
            "underlying_price": base_price,
            "spread_pct": 3.3,
            "exchange": "okx",
            "bidSize": 20, "askSize": 20,
        },
        {
            "instrument_name": "BTC-20250630-100000-P",
            "strike": 100000,
            "expiration": "2025-06-30",
            "type": "P",
            "bid": 2950.0, "ask": 3050.0,
            "volume": 80,
            "underlying_price": base_price,
            "spread_pct": 3.3,
            "exchange": "okx",
            "bidSize": 15, "askSize": 15,
        },
        # Strike 110000 — OTM call, deep ITM put
        {
            "instrument_name": "BTC-20250630-110000-C",
            "strike": 110000,
            "expiration": "2025-06-30",
            "type": "C",
            "bid": 45.0, "ask": 55.0,
            "volume": 60,
            "underlying_price": base_price,
            "spread_pct": 18.18,
            "exchange": "okx",
            "bidSize": 8, "askSize": 8,
        },
        {
            "instrument_name": "BTC-20250630-110000-P",
            "strike": 110000,
            "expiration": "2025-06-30",
            "type": "P",
            "bid": 10045.0, "ask": 10055.0,
            "volume": 40,
            "underlying_price": base_price,
            "spread_pct": 0.1,
            "exchange": "okx",
            "bidSize": 12, "askSize": 12,
        },
    ]


@pytest.fixture
def butterfly_arb_options() -> List[Dict]:
    """
    Option chain with an intentional butterfly arbitrage opportunity.
    The ATM call ask is artificially cheap relative to the wings,
    creating a guaranteed profit from a butterfly spread.
    """
    base_price = 100_000

    return [
        # Strike 90000 Call — fairly priced
        {
            "instrument_name": "BTC-20250630-90000-C",
            "strike": 90000,
            "expiration": "2025-06-30",
            "type": "C",
            "bid": 11500.0, "ask": 11600.0,
            "volume": 50,
            "underlying_price": base_price,
            "spread_pct": 0.87,
            "exchange": "okx",
            "bidSize": 10, "askSize": 10,
        },
        # Strike 100000 Call — CHEAP (arb opportunity)
        {
            "instrument_name": "BTC-20250630-100000-C",
            "strike": 100000,
            "expiration": "2025-06-30",
            "type": "C",
            "bid": 3500.0, "ask": 3600.0,
            "volume": 100,
            "underlying_price": base_price,
            "spread_pct": 2.78,
            "exchange": "okx",
            "bidSize": 20, "askSize": 20,
        },
        # Strike 110000 Call — fairly priced
        {
            "instrument_name": "BTC-20250630-110000-C",
            "strike": 110000,
            "expiration": "2025-06-30",
            "type": "C",
            "bid": 700.0, "ask": 750.0,
            "volume": 60,
            "underlying_price": base_price,
            "spread_pct": 6.67,
            "exchange": "okx",
            "bidSize": 8, "askSize": 8,
        },
        # Puts — needed for the solver to have enough instruments
        {
            "instrument_name": "BTC-20250630-90000-P",
            "strike": 90000,
            "expiration": "2025-06-30",
            "type": "P",
            "bid": 50.0, "ask": 60.0,
            "volume": 30,
            "underlying_price": base_price,
            "spread_pct": 18.18,
            "exchange": "okx",
            "bidSize": 5, "askSize": 5,
        },
        {
            "instrument_name": "BTC-20250630-100000-P",
            "strike": 100000,
            "expiration": "2025-06-30",
            "type": "P",
            "bid": 3500.0, "ask": 3600.0,
            "volume": 80,
            "underlying_price": base_price,
            "spread_pct": 2.78,
            "exchange": "okx",
            "bidSize": 15, "askSize": 15,
        },
        {
            "instrument_name": "BTC-20250630-110000-P",
            "strike": 110000,
            "expiration": "2025-06-30",
            "type": "P",
            "bid": 10500.0, "ask": 10600.0,
            "volume": 40,
            "underlying_price": base_price,
            "spread_pct": 0.94,
            "exchange": "okx",
            "bidSize": 12, "askSize": 12,
        },
    ]


@pytest.fixture
def tmp_data_dir():
    """Temporary directory for JSONL test files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


@pytest.fixture
def mock_okx_creds() -> Dict:
    """Mock OKX credentials for testing."""
    return {
        "apiKey": "test-api-key-123",
        "secretKey": "test-secret-key-456",
        "passphrase": "test-passphrase",
        "simulated": True,
    }
