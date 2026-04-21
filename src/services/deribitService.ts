import { OptionData } from '../types';

function formatExpiration(exp: string): string {
  const match = exp.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/i);
  if (!match) return exp;

  const day = match[1].padStart(2, '0');
  const monthStr = match[2].toUpperCase();
  const year = match[3];

  const months: { [key: string]: string } = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
  };

  const month = months[monthStr];
  if (!month) return exp;

  return `20${year}/${month}/${day}`;
}

export async function fetchDeribitOptions(): Promise<OptionData[]> {
  try {
    const response = await fetch('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option');
    const data = await response.json();

    if (!data.result) return [];

    return data.result
      .map((item: any) => {
        const parts = item.instrument_name.split('-');
        const expiration = formatExpiration(parts[1]);
        const strike = parseFloat(parts[2]);
        const type = parts[3] as 'C' | 'P';

        const bid = item.bid_price * item.underlying_price;
        const ask = item.ask_price * item.underlying_price;
        const spread_pct = ask > 0 ? ((ask - bid) / ask) * 100 : 0;

        return {
          instrument_name: item.instrument_name,
          strike,
          expiration,
          type,
          bid,
          ask,
          // Deribit volume is in BTC (×100 to match OKX contract unit)
          volume: (item.volume ?? 0) * 100,
          underlying_price: item.underlying_price,
          spread_pct,
          exchange: 'deribit' as const,
          bidSize: item.bid_amount ?? 0,
          askSize: item.ask_amount ?? 0,
        };
      })
      .filter((opt: OptionData) => opt.bid > 0 && opt.ask > 0);
  } catch (error) {
    console.error("Failed to fetch Deribit options:", error);
    return [];
  }
}
