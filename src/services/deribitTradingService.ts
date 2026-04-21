/**
 * Frontend Deribit Trading Service — browser-side mirror of the backend service.
 * Used as fallback when backend is not available.
 */

import { DeribitCredentials } from '../types';

function getBaseUrl(testnet: boolean): string {
  return testnet ? 'https://test.deribit.com' : 'https://www.deribit.com';
}

// ─── Authentication ──────────────────────────────────────────────────────────

let cachedToken: { token: string; expiresAt: number; key: string } | null = null;

async function authenticate(creds: DeribitCredentials): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const cacheKey = `${creds.clientId}:${creds.testnet}`;
  if (cachedToken && cachedToken.key === cacheKey && Date.now() < cachedToken.expiresAt - 60_000) {
    return { ok: true, token: cachedToken.token };
  }

  const base = getBaseUrl(creds.testnet);
  const url = `${base}/api/v2/public/auth?grant_type=client_credentials&client_id=${encodeURIComponent(creds.clientId)}&client_secret=${encodeURIComponent(creds.clientSecret)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      return { ok: false, error: `[${data.error.code}] ${data.error.message}` };
    }

    cachedToken = {
      token: data.result.access_token,
      expiresAt: Date.now() + data.result.expires_in * 1000,
      key: cacheKey,
    };

    return { ok: true, token: data.result.access_token };
  } catch (err: any) {
    return { ok: false, error: err.message ?? 'Network error' };
  }
}

// ─── Connection test ─────────────────────────────────────────────────────────

export async function testConnection(creds: DeribitCredentials): Promise<{ ok: boolean; error?: string }> {
  const auth = await authenticate(creds);
  if (auth.ok === false) return { ok: false, error: auth.error };
  return { ok: true };
}

// ─── Tradable instruments ────────────────────────────────────────────────────

export async function fetchTradableInstIds(testnet: boolean): Promise<Set<string>> {
  try {
    const base = getBaseUrl(testnet);
    const res = await fetch(`${base}/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false`);
    const data = await res.json();
    if (data.error || !data.result) return new Set();
    return new Set(data.result.map((i: any) => i.instrument_name as string));
  } catch {
    return new Set();
  }
}

// ─── Account balance ─────────────────────────────────────────────────────────

export interface AccountBalance {
  totalEq: number;
  availBal: number;
  availUsd: number;
}

export async function fetchAccountBalance(creds: DeribitCredentials): Promise<AccountBalance | null> {
  const auth = await authenticate(creds);
  if (!auth.ok) return null;

  const base = getBaseUrl(creds.testnet);
  try {
    const res = await fetch(`${base}/api/v2/private/get_account_summary?currency=BTC`, {
      headers: { 'Authorization': `Bearer ${auth.token}` },
    });
    const data = await res.json();
    if (data.error) return null;

    const result = data.result;
    const equity = result.equity ?? 0;
    const availBal = result.available_funds ?? 0;

    let spotPrice = 0;
    try {
      const tickerRes = await fetch(`${base}/api/v2/public/ticker?instrument_name=BTC-PERPETUAL`);
      const tickerData = await tickerRes.json();
      spotPrice = tickerData.result?.last_price ?? 0;
    } catch { /* non-fatal */ }

    return {
      totalEq: equity,
      availBal,
      availUsd: spotPrice > 0 ? availBal * spotPrice : equity * 30000,
    };
  } catch {
    return null;
  }
}

// ─── Place orders ────────────────────────────────────────────────────────────

export interface OrderRequest {
  instId: string;
  side: 'buy' | 'sell';
  sz: string;
  px: string;
}

export interface OrderResult {
  instId: string;
  clOrdId: string;
  ordId: string;
  sCode: string;
  sMsg: string;
}

export async function placeArbitrageOrders(
  creds: DeribitCredentials,
  orders: OrderRequest[]
): Promise<{ success: boolean; partialSuccess: boolean; results: OrderResult[]; error?: string }> {
  const auth = await authenticate(creds);
  if (auth.ok === false) {
    return { success: false, partialSuccess: false, results: [], error: auth.error };
  }

  const base = getBaseUrl(creds.testnet);
  const results: OrderResult[] = [];

  for (const order of orders) {
    const endpoint = order.side === 'buy' ? '/api/v2/private/buy' : '/api/v2/private/sell';
    const params = new URLSearchParams({
      instrument_name: order.instId,
      amount: order.sz,
      type: 'limit',
      price: order.px,
      time_in_force: 'immediate_or_cancel',
    });

    try {
      const res = await fetch(`${base}${endpoint}?${params}`, {
        headers: { 'Authorization': `Bearer ${auth.token}` },
      });
      const data = await res.json();

      if (data.error) {
        results.push({
          instId: order.instId,
          clOrdId: '',
          ordId: '',
          sCode: String(data.error.code),
          sMsg: data.error.message,
        });
      } else {
        const o = data.result.order;
        results.push({
          instId: order.instId,
          clOrdId: o?.label ?? '',
          ordId: o?.order_id ?? '',
          sCode: '0',
          sMsg: 'ok',
        });
      }
    } catch (err: any) {
      results.push({
        instId: order.instId,
        clOrdId: '',
        ordId: '',
        sCode: 'NETWORK',
        sMsg: err.message ?? 'Failed',
      });
    }
  }

  const succeeded = results.filter(r => r.sCode === '0').length;
  return {
    success: succeeded === results.length,
    partialSuccess: succeeded > 0 && succeeded < results.length,
    results,
    error: succeeded < results.length
      ? results.filter(r => r.sCode !== '0').map(r => `${r.sCode}: ${r.sMsg}`).join('; ')
      : undefined,
  };
}

// ─── Credential helpers ──────────────────────────────────────────────────────

const STORAGE_KEY = 'deribit_credentials';

export function saveCredentials(creds: DeribitCredentials): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}

export function loadCredentials(): DeribitCredentials | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as DeribitCredentials; } catch { return null; }
}

export function clearCredentials(): void {
  localStorage.removeItem(STORAGE_KEY);
}
