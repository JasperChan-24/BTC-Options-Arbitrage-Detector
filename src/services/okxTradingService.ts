import { OkxCredentials } from '../types';

// ---------- HMAC-SHA256 signing via Web Crypto API ----------
async function sign(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  // Convert ArrayBuffer to Base64
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

// OKX requires: timestamp (ISO), method (uppercase), path, body
async function buildHeaders(
  creds: OkxCredentials,
  method: 'GET' | 'POST',
  path: string,
  body: string = '',
  isSimulated: boolean = false
): Promise<HeadersInit> {
  const timestamp = new Date().toISOString(); // e.g. "2024-03-31T22:00:00.000Z"
  const preHash = timestamp + method + path + body;
  const signature = await sign(preHash, creds.secretKey);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': creds.apiKey,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': creds.passphrase,
  };

  if (isSimulated) {
    // Paper trading header for OKX demo/sandbox account
    headers['x-simulated-trading'] = '1';
  }

  return headers;
}

// ---------- Connection test (read-only, no orders placed) ----------

/**
 * Calls GET /api/v5/account/config to verify credentials without placing any order.
 * Returns { ok: true } on success, or { ok: false, error: string } on failure.
 */
export async function testConnection(
  creds: OkxCredentials
): Promise<{ ok: boolean; error?: string }> {
  const BASE = 'https://www.okx.com';
  const path = '/api/v5/account/config';
  try {
    const headers = await buildHeaders(creds, 'GET', path, '', creds.simulated);
    const res = await fetch(BASE + path, { method: 'GET', headers });
    const data = await res.json();
    if (data.code === '0') {
      return { ok: true };
    }
    return { ok: false, error: `${data.code}: ${data.msg}` };
  } catch (err: any) {
    return { ok: false, error: err.message ?? 'Network error' };
  }
}

/**
 * Fetch the set of currently listed (tradeable) OKX BTC-USD option instrument IDs.
 * Used to pre-validate portfolio legs before submission (avoids error 51881).
 * This endpoint is public and requires no authentication.
 */
export async function fetchTradableInstIds(simulated: boolean = false): Promise<Set<string>> {
  try {
    const url = 'https://www.okx.com/api/v5/public/instruments?instType=OPTION&uly=BTC-USD';
    const headers: Record<string, string> = {};
    if (simulated) headers['x-simulated-trading'] = '1';
    const res = await fetch(url, { headers });
    const data = await res.json();
    if (data.code !== '0') {
      console.warn('[OKX] fetchTradableInstIds failed:', data.code, data.msg);
      return new Set();
    }
    const ids = new Set<string>((data.data ?? []).map((i: { instId: string }) => i.instId));
    console.log(`[OKX] Tradable instruments fetched: ${ids.size} total`);
    return ids;
  } catch (err) {
    console.warn('[OKX] fetchTradableInstIds network error:', err);
    return new Set();
  }
}

// ---------- Account balance ----------

export interface AccountBalance {
  totalEq: number;   // total equity in USD
  availBal: number;  // available balance in BTC (for trading)
  availUsd: number;  // available balance converted to USD
}

/**
 * Fetch account balance via /api/v5/account/balance.
 * Returns available BTC balance and USD equivalent.
 */
export async function fetchAccountBalance(
  creds: OkxCredentials
): Promise<AccountBalance | null> {
  const BASE = 'https://www.okx.com';
  const path = '/api/v5/account/balance';
  try {
    const headers = await buildHeaders(creds, 'GET', path, '', creds.simulated);
    const res = await fetch(BASE + path, { method: 'GET', headers });
    const data = await res.json();

    if (data.code !== '0' || !data.data?.[0]) {
      console.warn('[OKX] fetchAccountBalance failed:', data.code, data.msg);
      return null;
    }

    const account = data.data[0];
    const totalEq = parseFloat(account.totalEq) || 0;

    // Find BTC details in the asset list
    const btcDetail = account.details?.find((d: any) => d.ccy === 'BTC');
    const availBal = btcDetail ? (parseFloat(btcDetail.availBal) || 0) : 0;

    // Get spot price for USD conversion
    let spotPrice = 0;
    try {
      const spotRes = await fetch('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT');
      const spotData = await spotRes.json();
      spotPrice = parseFloat(spotData.data?.[0]?.last ?? '0');
    } catch { /* non-fatal */ }

    return {
      totalEq,
      availBal,
      availUsd: spotPrice > 0 ? availBal * spotPrice : totalEq,
    };
  } catch (err: any) {
    console.warn('[OKX] fetchAccountBalance error:', err.message);
    return null;
  }
}

export interface OrderRequest {
  instId: string;   // OKX instrument ID, e.g. "BTC-USD-250331-90000-C"
  side: 'buy' | 'sell';
  sz: string;       // size as string (number of contracts)
  px: string;       // price as string (limit price)
}

export interface OrderResult {
  instId: string;
  clOrdId: string;
  ordId: string;
  sCode: string;    // '0' means success
  sMsg: string;     // human-readable OKX error message
}

/**
/**
 * Place multiple IOC orders simultaneously via OKX batch-orders endpoint.
 * Uses 'optimal_limit_ioc' which fills at the best available price and
 * auto-cancels any unfilled portion — ideal for arbitrage execution.
 */
export async function placeArbitrageOrders(
  creds: OkxCredentials,
  orders: OrderRequest[]
): Promise<{ success: boolean; partialSuccess: boolean; results: OrderResult[]; error?: string }> {
  const BASE = 'https://www.okx.com';
  const path = '/api/v5/trade/batch-orders';

  const payload = orders.map(o => ({
    instId: o.instId,
    tdMode: 'isolated',      // isolated = 逐仓，允许独立多头/空头期权持仓
    side: o.side,
    // 'limit' is the only order type universally supported for OKX BTC options.
    // ioc/optimal_limit_ioc are NOT supported for options buy orders (OKX error 51881).
    ordType: 'ioc',
    sz: o.sz,
    px: o.px,
  }));

  const body = JSON.stringify(payload);
  const headers = await buildHeaders(creds, 'POST', path, body, creds.simulated);

  console.log('[OKX] Placing batch orders:', payload);
  console.log('[OKX] Headers (no secret):', { ...headers as Record<string,string>, 'OK-ACCESS-SIGN': '***' });

  try {
    const res = await fetch(BASE + path, { method: 'POST', headers, body });
    const data = await res.json();

    console.log('[OKX] Batch order response (HTTP', res.status, '):', JSON.stringify(data, null, 2));

    // OKX batch-order codes:
    //   "0" = all orders succeeded
    //   "1" = some orders failed   (data[] still has per-order sCode/sMsg)
    //   "2" = partial success
    // Any other code = whole batch rejected at API level (data[] is empty)
    if (data.code !== '0' && data.code !== '1' && data.code !== '2') {
      const errMsg = `[${data.code}] ${data.msg ?? ''}`.trim();
      console.error('[OKX] Batch order rejected:', errMsg);
      return { success: false, partialSuccess: false, results: [], error: errMsg };
    }

    const results: OrderResult[] = data.data ?? [];
    const succeeded = results.filter(r => r.sCode === '0').length;
    const allOk = succeeded === results.length;
    const anyOk = succeeded > 0;

    return {
      success: allOk,
      partialSuccess: !allOk && anyOk,
      results,
      error: !allOk ? `${results.filter(r => r.sCode !== '0').map(r => r.sCode).join(', ')}` : undefined,
    };
  } catch (err: any) {
    // A "Failed to fetch" or "NetworkError" here usually means a CORS block
    // on OKX's trading endpoint when called from a browser.
    console.error('[OKX] Network/CORS error placing batch orders:', err);
    return { success: false, partialSuccess: false, results: [], error: `NETWORK: ${err.message ?? 'Failed to fetch'}` };
  }
}

// ---------- Order status polling ----------

export interface OkxOrderDetail {
  ordId: string;
  instId: string;
  side: string;
  sz: string;
  px: string;
  fillSz: string;  // filled quantity
  state: 'live' | 'partially_filled' | 'filled' | 'cancelled';
}

/**
 * Fetch the current status of specific orders by ordId.
 * Used to poll order fill status after submission.
 */
export async function fetchOrderStatus(
  creds: OkxCredentials,
  instId: string,
  ordId: string
): Promise<OkxOrderDetail | null> {
  const BASE = 'https://www.okx.com';
  const path = `/api/v5/trade/order?instId=${encodeURIComponent(instId)}&ordId=${encodeURIComponent(ordId)}`;
  try {
    const headers = await buildHeaders(creds, 'GET', path, '', creds.simulated);
    const res = await fetch(BASE + path, { method: 'GET', headers });
    const data = await res.json();
    if (data.code !== '0' || !data.data?.[0]) return null;
    return data.data[0] as OkxOrderDetail;
  } catch {
    return null;
  }
}

// ---------- Credential helpers (localStorage) ----------

const STORAGE_KEY = 'okx_credentials';

export function saveCredentials(creds: OkxCredentials): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}

export function loadCredentials(): OkxCredentials | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as OkxCredentials; } catch { return null; }
}

export function clearCredentials(): void {
  localStorage.removeItem(STORAGE_KEY);
}

