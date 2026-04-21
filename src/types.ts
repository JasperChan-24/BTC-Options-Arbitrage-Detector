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
  exchange: 'deribit' | 'okx';
  bidSize: number;
  askSize: number;
}

export type Exchange = 'deribit' | 'okx';
export type Environment = 'real' | 'testnet';
export type MarketId = 'okx' | 'okx_paper' | 'deribit' | 'deribit_test';

export interface ArbitrageResult {
  feasible: boolean;
  profit: number;
  portfolio: {
    instId: string;
    strike: number;
    type: 'C' | 'P';
    action: 'buy' | 'sell';
    amount: number;
    price: number;    // USD (for display)
    rawPrice: number; // native currency (BTC for OKX) — used for order placement
    maxDepth: number; // order book depth available for this leg
  }[];
}

export interface OkxCredentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
  simulated: boolean; // true = demo/paper account (adds x-simulated-trading: 1)
}

export interface DeribitCredentials {
  clientId: string;
  clientSecret: string;
  testnet: boolean; // true = test.deribit.com
}

export type OrderStatus = 'idle' | 'sending' | 'success' | 'error';

export interface SubmittedOrder {
  localId: string;           // client-side UUID
  instId: string;
  side: 'buy' | 'sell';
  type: 'C' | 'P';
  strike: number;
  sz: string;                // number of contracts
  px: string;                // limit price (USD)
  ordId?: string;            // OKX assigned order ID
  fillStatus: 'pending' | 'live' | 'filled' | 'partially_filled' | 'cancelled' | 'failed';
  failureCode?: string;      // OKX sCode if rejected
  failureMsg?: string;       // OKX sMsg if rejected (raw, stripped of Chinese)
  submittedAt: string;       // ISO timestamp
}

export interface ArbitrageExecution {
  execId: string;
  exchange?: Exchange;
  environment?: Environment;
  market?: MarketId;
  timestamp: string;
  expectedProfit: number;
  orders: SubmittedOrder[];
  overallStatus: 'pending' | 'partial' | 'complete' | 'failed' | 'detected';
}
