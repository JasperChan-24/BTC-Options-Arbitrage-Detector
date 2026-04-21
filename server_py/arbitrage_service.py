"""
Arbitrage detection using Linear Programming (scipy.optimize.linprog).

Quad-constraint position sizing:
 1. Liquidity: each leg bounded by order book depth (bidSize/askSize)
 2. Budget: total capital deployed bounded by account balance × risk fraction
 3. No-arbitrage payoff constraints
 4. Min-quantity filter: post-LP removal of fragment legs (qty < threshold)
"""

from __future__ import annotations
from typing import List

import numpy as np
from scipy.optimize import linprog

from .models import OptionData, ArbitrageResult, PortfolioPosition


def _verify_payoff_safety(
    portfolio: List[PortfolioPosition],
    options: List[OptionData],
) -> bool:
    """
    Verify that a portfolio has non-negative payoff at all breakpoints.

    After filtering out fragment legs, we re-check that the remaining
    portfolio still satisfies the no-loss guarantee at every strike price,
    at S_T=0, and the right-slope condition.
    """
    if not portfolio:
        return False

    opt_map = {o.instrument_name: o for o in options}
    strikes = sorted(set(o.strike for o in options))

    # Net position per instrument
    net_positions: dict[str, tuple[float, OptionData]] = {}
    for pos in portfolio:
        opt = opt_map.get(pos.instId)
        if opt is None:
            continue
        sign = 1.0 if pos.action == "buy" else -1.0
        if pos.instId in net_positions:
            old_net, _ = net_positions[pos.instId]
            net_positions[pos.instId] = (old_net + sign * pos.amount, opt)
        else:
            net_positions[pos.instId] = (sign * pos.amount, opt)

    # Check 1: Right-slope (sum of net call positions >= 0)
    right_slope = 0.0
    for net, opt in net_positions.values():
        if opt.type == "C":
            right_slope += net
    if right_slope < -1e-9:
        return False

    # Check 2: Payoff at S_T = 0
    payoff_zero = 0.0
    for net, opt in net_positions.values():
        if opt.type == "P":
            payoff_zero += opt.strike * net
    if payoff_zero < -1e-9:
        return False

    # Check 3: Payoff at each strike
    for k in strikes:
        payoff_k = 0.0
        for net, opt in net_positions.values():
            if opt.type == "C":
                payoff_k += net * max(k - opt.strike, 0)
            else:
                payoff_k += net * max(opt.strike - k, 0)
        if payoff_k < -1e-9:
            return False

    return True


def detect_arbitrage(
    options: List[OptionData],
    fee_rate: float = 0,
    budget_btc: float = 0,
    min_qty: float = 1.0,
) -> ArbitrageResult:
    """
    Detect arbitrage opportunities using LP.

    Parameters
    ----------
    options : list of OptionData
        Filtered option chain data.
    fee_rate : float
        Exchange fee rate (e.g. 0.0003 for 0.03%).
    budget_btc : float
        Optional capital budget in BTC.  If > 0, adds a global constraint on
        total premium outflow + margin.
    min_qty : float
        Minimum quantity per leg.  After LP solving, legs with qty < min_qty
        are removed as "fragments" that are not worth the execution risk.
        The remaining portfolio is re-verified for payoff safety.
        Set to 0 to disable.  Default: 1.0.

    Returns
    -------
    ArbitrageResult
    """
    if len(options) < 3:
        return ArbitrageResult(feasible=False, profit=0, portfolio=[])

    n = len(options)
    CONTRACT_MULT = 0.01
    SELL_MARGIN_MULT = 2.0

    strikes = sorted(set(o.strike for o in options))

    # Decision variables: [buy_0, sell_0, buy_1, sell_1, ..., buy_{n-1}, sell_{n-1}]
    num_vars = 2 * n

    # ─── Objective: maximize profit → minimize -profit ─────────────────────
    c = np.zeros(num_vars)
    for i, opt in enumerate(options):
        c[2 * i]     = opt.ask * (1 + fee_rate)       # buy cost (negative profit)
        c[2 * i + 1] = -opt.bid * (1 - fee_rate)      # sell revenue (positive profit)

    # ─── Inequality constraints: A_ub @ x <= b_ub ──────────────────────────
    num_constraints = 1 + 1 + len(strikes)  # right_slope + payoff_0 + payoff_k's
    has_budget = budget_btc > 0
    if has_budget:
        num_constraints += 1

    A_ub = np.zeros((num_constraints, num_vars))
    b_ub = np.zeros(num_constraints)

    row = 0

    # Constraint: right_slope >= 0  →  -sum(right_slope_contributions) <= 0
    for i, opt in enumerate(options):
        if opt.type == "C":
            A_ub[row, 2 * i]     = -1   # buy call contributes +1 to right_slope
            A_ub[row, 2 * i + 1] = 1    # sell call contributes -1
    b_ub[row] = 0
    row += 1

    # Constraint: payoff_0 >= 0  →  -payoff_0 <= 0
    for i, opt in enumerate(options):
        if opt.type == "P":
            A_ub[row, 2 * i]     = -opt.strike   # buy put contribution
            A_ub[row, 2 * i + 1] = opt.strike    # sell put contribution
    b_ub[row] = 0
    row += 1

    # Constraint: payoff_k >= 0 for each strike k
    for k in strikes:
        for i, opt in enumerate(options):
            is_call = opt.type == "C"
            payoff = max(k - opt.strike, 0) if is_call else max(opt.strike - k, 0)
            if payoff > 0:
                A_ub[row, 2 * i]     = -payoff   # buy contribution
                A_ub[row, 2 * i + 1] = payoff    # sell contribution
        b_ub[row] = 0
        row += 1

    # Budget constraint
    if has_budget:
        for i, opt in enumerate(options):
            raw_ask_btc = (
                opt.ask / opt.underlying_price if opt.underlying_price > 0 else opt.ask
            )
            raw_bid_btc = (
                opt.bid / opt.underlying_price if opt.underlying_price > 0 else opt.bid
            )
            A_ub[row, 2 * i]     = raw_ask_btc * CONTRACT_MULT       # buy cost
            A_ub[row, 2 * i + 1] = raw_bid_btc * SELL_MARGIN_MULT * CONTRACT_MULT  # sell margin
        b_ub[row] = budget_btc
        row += 1

    # ─── Bounds: 0 <= x_i <= depth_limit ──────────────────────────────────
    bounds = []
    for i, opt in enumerate(options):
        buy_limit = max(0.01, opt.askSize or 1)
        sell_limit = max(0.01, opt.bidSize or 1)
        bounds.append((0, buy_limit))   # buy_i
        bounds.append((0, sell_limit))  # sell_i

    # ─── Solve ────────────────────────────────────────────────────────────
    result = linprog(
        c,
        A_ub=A_ub,
        b_ub=b_ub,
        bounds=bounds,
        method="highs",
    )

    if result.success and -result.fun > 1e-6:
        profit = -result.fun
        portfolio: List[PortfolioPosition] = []

        for i, opt in enumerate(options):
            buy_amt = result.x[2 * i]
            sell_amt = result.x[2 * i + 1]

            if buy_amt > 1e-6:
                raw_price = (
                    opt.ask / opt.underlying_price
                    if opt.underlying_price > 0
                    else opt.ask
                )
                portfolio.append(
                    PortfolioPosition(
                        instId=opt.instrument_name,
                        strike=opt.strike,
                        type=opt.type,
                        action="buy",
                        amount=buy_amt,
                        price=opt.ask,
                        rawPrice=raw_price,
                        maxDepth=opt.askSize or 0,
                    )
                )
            if sell_amt > 1e-6:
                raw_price = (
                    opt.bid / opt.underlying_price
                    if opt.underlying_price > 0
                    else opt.bid
                )
                portfolio.append(
                    PortfolioPosition(
                        instId=opt.instrument_name,
                        strike=opt.strike,
                        type=opt.type,
                        action="sell",
                        amount=sell_amt,
                        price=opt.bid,
                        rawPrice=raw_price,
                        maxDepth=opt.bidSize or 0,
                    )
                )

        # ─── Min-quantity filter ──────────────────────────────────────────
        # Remove fragment legs (qty < min_qty) that are not worth executing.
        # Then re-verify that the remaining portfolio is still safe.
        if min_qty > 0:
            filtered = [p for p in portfolio if p.amount >= min_qty]

            if len(filtered) < len(portfolio) and len(filtered) > 0:
                # Some legs were removed — verify safety
                if _verify_payoff_safety(filtered, options):
                    # Recompute profit with remaining legs
                    new_profit = 0.0
                    for pos in filtered:
                        if pos.action == "buy":
                            new_profit -= pos.amount * pos.price * (1 + fee_rate)
                        else:
                            new_profit += pos.amount * pos.price * (1 - fee_rate)

                    if new_profit > 1e-6:
                        return ArbitrageResult(
                            feasible=True, profit=new_profit, portfolio=filtered
                        )
                    # Profit gone after filtering → no arb
                    return ArbitrageResult(feasible=False, profit=0, portfolio=[])

                # Safety check failed → return the FULL portfolio (unfiltered)
                # Better to have more legs than an unsafe portfolio
                return ArbitrageResult(
                    feasible=True, profit=profit, portfolio=portfolio
                )

            elif len(filtered) == 0:
                # All legs were fragments → no viable arb
                return ArbitrageResult(feasible=False, profit=0, portfolio=[])

            # No legs were removed → return as-is

        return ArbitrageResult(feasible=True, profit=profit, portfolio=portfolio)

    return ArbitrageResult(feasible=False, profit=0, portfolio=[])
