import solver from 'javascript-lp-solver';
import { OptionData, ArbitrageResult } from '../types';

export function detectArbitrage(options: OptionData[], feeRate: number = 0): ArbitrageResult {
  if (options.length < 3) {
    return { feasible: false, profit: 0, portfolio: [] };
  }

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

  options.forEach((opt, i) => {
    model.constraints[`buy_${i}_limit`] = { max: 1 };
    model.constraints[`sell_${i}_limit`] = { max: 1 };

    const isCall = opt.type === 'C';

    model.variables[`buy_${i}`] = {
      profit: -opt.ask * (1 + feeRate),
      right_slope: isCall ? 1 : 0,
      payoff_0: isCall ? 0 : opt.strike,
      [`buy_${i}_limit`]: 1
    };

    model.variables[`sell_${i}`] = {
      profit: opt.bid * (1 - feeRate),
      right_slope: isCall ? -1 : 0,
      payoff_0: isCall ? 0 : -opt.strike,
      [`sell_${i}_limit`]: 1
    };

    strikes.forEach(k => {
      const payoff = isCall ? Math.max(k - opt.strike, 0) : Math.max(opt.strike - k, 0);
      if (payoff > 0) {
        model.variables[`buy_${i}`][`payoff_${k}`] = payoff;
        model.variables[`sell_${i}`][`payoff_${k}`] = -payoff;
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
          strike: options[i].strike,
          type: options[i].type,
          action: 'buy' as const,
          amount: buyAmt,
          price: options[i].ask
        });
      }
      if (sellAmt > 1e-6) {
        portfolio.push({
          strike: options[i].strike,
          type: options[i].type,
          action: 'sell' as const,
          amount: sellAmt,
          price: options[i].bid
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
