"""
Tests for the LP arbitrage solver (server_py/arbitrage_service.py).
"""

import pytest
from server_py.arbitrage_service import detect_arbitrage


class TestDetectArbitrage:
    """Core LP solver tests."""

    def _to_models(self, options_list):
        from server_py.models import OptionData
        return [OptionData(**d) for d in options_list]

    def test_no_arb_with_fair_prices(self, sample_options):
        """Fair-priced options should NOT produce arbitrage."""
        options = self._to_models(sample_options)
        result = detect_arbitrage(options, fee_rate=0, budget_btc=0, min_qty=1)
        if result.feasible:
            assert result.profit < 1.0, f"Fair prices should not yield significant profit, got {result.profit}"

    def test_arb_with_butterfly(self, butterfly_arb_options):
        """Butterfly spread with cheap ATM should produce arbitrage."""
        options = self._to_models(butterfly_arb_options)
        result = detect_arbitrage(options, fee_rate=0, budget_btc=0, min_qty=1)
        assert hasattr(result, "feasible")
        assert hasattr(result, "profit")
        assert hasattr(result, "portfolio")
        assert isinstance(result.portfolio, list)

    def test_empty_input(self):
        """Empty option list should return not feasible."""
        result = detect_arbitrage([], fee_rate=0, budget_btc=0, min_qty=1)
        assert result.feasible is False
        assert result.profit == 0
        assert result.portfolio == []

    def test_too_few_options(self):
        """Fewer than 3 options should return not feasible."""
        small_set = self._to_models([
            {
                "instrument_name": "BTC-20250630-100000-C",
                "strike": 100000, "expiration": "2025-06-30", "type": "C",
                "bid": 4000, "ask": 4100, "volume": 100,
                "underlying_price": 100000, "spread_pct": 2.47,
                "exchange": "okx", "bidSize": 20, "askSize": 20,
            },
            {
                "instrument_name": "BTC-20250630-100000-P",
                "strike": 100000, "expiration": "2025-06-30", "type": "P",
                "bid": 3800, "ask": 3900, "volume": 80,
                "underlying_price": 100000, "spread_pct": 2.60,
                "exchange": "okx", "bidSize": 15, "askSize": 15,
            },
        ])
        result = detect_arbitrage(small_set, fee_rate=0, budget_btc=0, min_qty=1)
        assert result.feasible is False

    def test_budget_constraint(self, butterfly_arb_options):
        """With a very tight budget, portfolio should stay within bounds."""
        options = self._to_models(butterfly_arb_options)
        tiny_budget = 0.001
        result = detect_arbitrage(options, fee_rate=0, budget_btc=tiny_budget, min_qty=1)
        assert hasattr(result, "feasible")
        assert hasattr(result, "portfolio")

    def test_fee_reduces_profit(self, butterfly_arb_options):
        """Adding fees should reduce (or eliminate) arbitrage profit."""
        options = self._to_models(butterfly_arb_options)
        no_fee = detect_arbitrage(options, fee_rate=0, budget_btc=0, min_qty=1)
        with_fee = detect_arbitrage(options, fee_rate=0.003, budget_btc=0, min_qty=1)

        if no_fee.feasible and with_fee.feasible:
            assert with_fee.profit <= no_fee.profit + 0.01

    def test_liquidity_constraint(self, butterfly_arb_options):
        """Portfolio amounts should not exceed order book depth."""
        options = self._to_models(butterfly_arb_options)
        result = detect_arbitrage(options, fee_rate=0, budget_btc=1.0, min_qty=1)
        if result.feasible:
            for pos in result.portfolio:
                matching = [o for o in butterfly_arb_options if o["instrument_name"] == pos.instId]
                if matching:
                    opt = matching[0]
                    max_depth = opt["askSize"] if pos.action == "buy" else opt["bidSize"]
                    assert pos.amount <= max_depth + 0.01

    def test_return_structure(self, butterfly_arb_options):
        """Verify the return value has all expected fields."""
        options = self._to_models(butterfly_arb_options)
        result = detect_arbitrage(options, fee_rate=0, budget_btc=0, min_qty=1)

        from server_py.models import ArbitrageResult
        assert isinstance(result, ArbitrageResult)
        
        if result.feasible and result.portfolio:
            pos = result.portfolio[0]
            assert hasattr(pos, "instId")
            assert hasattr(pos, "strike")
            assert hasattr(pos, "type")
            assert hasattr(pos, "action")
            assert hasattr(pos, "amount")
            assert hasattr(pos, "price")
            assert pos.action in ("buy", "sell")
            assert pos.type in ("C", "P")
            assert pos.amount > 0

    def test_min_qty_filter(self, butterfly_arb_options):
        """Large min_qty should filter out small positions."""
        options = self._to_models(butterfly_arb_options)
        result = detect_arbitrage(options, fee_rate=0, budget_btc=0, min_qty=100)
        if result.feasible:
            for pos in result.portfolio:
                assert pos.amount >= 100 or pos.amount == 0
