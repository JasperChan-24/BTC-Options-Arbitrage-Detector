export interface OptionData {
  instrument_name: string;
  strike: number;
  expiration: string;
  type: 'C' | 'P';
  bid: number;
  ask: number;
  volume: number;
  underlying_price: number;
  spread_pct: number;
}

export interface ArbitrageResult {
  feasible: boolean;
  profit: number;
  portfolio: {
    strike: number;
    type: 'C' | 'P';
    action: 'buy' | 'sell';
    amount: number;
    price: number;
  }[];
}
