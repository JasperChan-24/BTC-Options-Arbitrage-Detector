import { OptionData } from '../types';

// OKX instrument format: BTC-USD-250331-90000-C (or BTC-USDT-250331-90000-C)
// Expiry format: YYMMDD -> we convert to YYYY/MM/DD
function parseOkxInstrument(instId: string): { expiration: string; strike: number; type: 'C' | 'P' } | null {
  // e.g. "BTC-USD-250331-90000-C"
  const parts = instId.split('-');
  if (parts.length < 5) return null;

  const expiryRaw = parts[2]; // e.g. "250331"
  const strikeStr = parts[3]; // e.g. "90000"
  const typeChar = parts[4];  // "C" or "P"

  if (expiryRaw.length !== 6) return null;

  const year  = `20${expiryRaw.slice(0, 2)}`;
  const month = expiryRaw.slice(2, 4);
  const day   = expiryRaw.slice(4, 6);
  const expiration = `${year}/${month}/${day}`;

  const strike = parseFloat(strikeStr);
  if (isNaN(strike)) return null;

  const type = typeChar === 'C' ? 'C' : 'P';
  return { expiration, strike, type };
}

export async function fetchOkxOptions(): Promise<OptionData[]> {
  try {
    // Step 1: get all BTC option tickers (quoted in USD)
    const tickerRes = await fetch(
      'https://www.okx.com/api/v5/market/tickers?instType=OPTION&uly=BTC-USD'
    );
    const tickerData = await tickerRes.json();

    if (!tickerData.data || tickerData.data.length === 0) return [];

    // Step 2: get current BTC spot price (used to normalise sizes, and displayed as underlying)
    let spotPrice = 0;
    try {
      const spotRes = await fetch('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT');
      const spotData = await spotRes.json();
      spotPrice = parseFloat(spotData.data?.[0]?.last ?? '0');
    } catch {
      // non-fatal; we'll just leave underlying as 0
    }

    const results: OptionData[] = [];

    for (const item of tickerData.data) {
      const parsed = parseOkxInstrument(item.instId);
      if (!parsed) continue;

      // OKX BTC-USD options quote prices in BTC (same convention as Deribit).
      // Multiply by spotPrice to convert to USD for consistent display.
      const rawBid = parseFloat(item.bidPx);
      const rawAsk = parseFloat(item.askPx);
      if (!rawBid || !rawAsk || isNaN(rawBid) || isNaN(rawAsk)) continue;
      const bid = spotPrice > 0 ? rawBid * spotPrice : rawBid;
      const ask = spotPrice > 0 ? rawAsk * spotPrice : rawAsk;

      const spread_pct = ask > 0 ? ((ask - bid) / ask) * 100 : 0;
      const volume = parseFloat(item.vol24h) || 0;

      // OKX bid/ask sizes are in the number of contracts
      const bidSize = parseFloat(item.bidSz) || 0;
      const askSize = parseFloat(item.askSz) || 0;

      results.push({
        instrument_name: item.instId,
        strike: parsed.strike,
        expiration: parsed.expiration,
        type: parsed.type,
        bid,
        ask,
        volume,
        underlying_price: spotPrice,
        spread_pct,
        exchange: 'okx',
        bidSize,
        askSize,
      });
    }

    return results;
  } catch (error) {
    console.error('Failed to fetch OKX options:', error);
    return [];
  }
}
