import solver from 'javascript-lp-solver';
import { OptionData, ArbitrageResult } from '../types';

/**
 * Detect arbitrage opportunities using a Linear Programming model.
 *
 * Triple-constraint position sizing:
 *  1. Liquidity: each leg bounded by order book depth (bidSize/askSize)
 *  2. Budget: total capital deployed bounded by account balance × risk fraction
 *  3. No-arbitrage payoff constraints (as before)
 *
 * @param options  - filtered option chain data
 * @param feeRate  - exchange fee rate (e.g. 0.0003 for 0.03%)
 * @param budgetBtc - optional capital budget in BTC. If provided, adds a global
 *                    constraint: total premium outflow + margin ≤ budget.
 *                    When undefined/0, falls back to depth-only limits.
 */
export function detectArbitrage(
  options: OptionData[],
  feeRate: number = 0,
  budgetBtc: number = 0
): ArbitrageResult {
  if (options.length < 3) {
    return { feasible: false, profit: 0, portfolio: [] };
  }

  // ─── Contract multiplier: OKX BTC-USD options = 0.01 BTC per contract ───
  const CONTRACT_MULT = 0.01;
  // Conservative margin multiplier for sold options (2× premium)
  const SELL_MARGIN_MULT = 2.0;

  const model: any = {
    optimize: "profit",
    opType: "max",
    constraints: {
      right_slope: { min: 0 },
      payoff_0: { min: 0 }
    },
    variables: {}
  };

  const strikes = Array.from(new Set(options.map(o => o.strike))).sort((a, b) => a - b);
  strikes.forEach(k => {
    model.constraints[`payoff_${k}`] = { min: 0 };
  });

  // Add global budget constraint if budget is provided
  const hasBudget = budgetBtc > 0;
  if (hasBudget) {
    model.constraints['budget'] = { max: budgetBtc };
  }

  options.forEach((opt, i) => {
    // ── Liquidity-aware bounds ─────────────────────────────────────────
    // Buy is limited by ask depth, sell by bid depth.
    // Floor at 0.01 to prevent infeasible zero-bounds.
    const buyLimit = Math.max(0.01, opt.askSize || 1);
    const sellLimit = Math.max(0.01, opt.bidSize || 1);

    model.constraints[`buy_${i}_limit`] = { max: buyLimit };
    model.constraints[`sell_${i}_limit`] = { max: sellLimit };

    const isCall = opt.type === 'C';

    // ── BTC-denominated price for budget constraint ───────────────────
    // If underlying_price is available, rawAsk/rawBid are BTC prices
    const rawAskBtc = opt.underlying_price > 0
      ? opt.ask / opt.underlying_price
      : opt.ask;
    const rawBidBtc = opt.underlying_price > 0
      ? opt.bid / opt.underlying_price
      : opt.bid;

    // Buy variable
    const buyVar: any = {
      profit: -opt.ask * (1 + feeRate),
      right_slope: isCall ? 1 : 0,
      payoff_0: isCall ? 0 : opt.strike,
      [`buy_${i}_limit`]: 1
    };
    // Budget: buying costs premium per contract
    if (hasBudget) {
      buyVar['budget'] = rawAskBtc * CONTRACT_MULT;
    }
    model.variables[`buy_${i}`] = buyVar;

    // Sell variable
    const sellVar: any = {
      profit: opt.bid * (1 - feeRate),
      right_slope: isCall ? -1 : 0,
      payoff_0: isCall ? 0 : -opt.strike,
      [`sell_${i}_limit`]: 1
    };
    // Budget: selling requires margin (conservative estimate)
    // We subtract the premium received but add the margin requirement
    if (hasBudget) {
      const marginPerContract = rawBidBtc * SELL_MARGIN_MULT * CONTRACT_MULT;
      sellVar['budget'] = marginPerContract;
    }
    model.variables[`sell_${i}`] = sellVar;

    strikes.forEach(k => {
      const payoff = isCall ? Math.max(k - opt.strike, 0) : Math.max(opt.strike - k, 0);
      if (payoff > 0) {
        buyVar[`payoff_${k}`] = payoff;
        sellVar[`payoff_${k}`] = -payoff;
      }
    });
  });

  const result = solver.Solve(model) as any;

  if (result.feasible && result.result > 1e-6) {
    const portfolio = [];
    for (let i = 0; i < options.length; i++) {
      const buyAmt = result[`buy_${i}`] || 0;
      const sellAmt = result[`sell_${i}`] || 0;

      if (buyAmt > 1e-6) {
        portfolio.push({
          instId: options[i].instrument_name,
          strike: options[i].strike,
          type: options[i].type,
          action: 'buy' as const,
          amount: buyAmt,
          price: options[i].ask,
          rawPrice: options[i].underlying_price > 0
            ? options[i].ask / options[i].underlying_price
            : options[i].ask,
          maxDepth: options[i].askSize || 0,
        });
      }
      if (sellAmt > 1e-6) {
        portfolio.push({
          instId: options[i].instrument_name,
          strike: options[i].strike,
          type: options[i].type,
          action: 'sell' as const,
          amount: sellAmt,
          price: options[i].bid,
          rawPrice: options[i].underlying_price > 0
            ? options[i].bid / options[i].underlying_price
            : options[i].bid,
          maxDepth: options[i].bidSize || 0,
        });
      }
    }

    return {
      feasible: true,
      profit: result.result,
      portfolio
    };
  }

  return { feasible: false, profit: 0, portfolio: [] };
}
