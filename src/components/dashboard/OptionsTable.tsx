import React, { useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { OptionData } from '../../types';

interface OptionsTableProps {
  t: Record<string, string>;
}

export default function OptionsTable({ t }: OptionsTableProps) {
  const options = useAppStore((s) => s.options);
  const selectedExpiry = useAppStore((s) => s.selectedExpiry);
  const isDemoMode = useAppStore((s) => s.isDemoMode);
  const appliedModifications = useAppStore((s) => s.appliedModifications);
  const selectedPrices = useAppStore((s) => s.selectedPrices);
  const bestArbResult = useAppStore((s) => s.bestArbResult);
  const { setSelectedPrices } = useAppStore();
  const effectiveMinVolume = useAppStore((s) => s.effectiveMinVolume());
  const effectiveMaxSpreadPct = useAppStore((s) => s.effectiveMaxSpreadPct());

  const filteredOptions = useMemo(() => {
    return options
      .filter((o) => o.expiration === selectedExpiry)
      .filter((o) => o.volume >= effectiveMinVolume)
      .filter((o) => o.spread_pct <= effectiveMaxSpreadPct)
      .map((o) => {
        if (!isDemoMode || Object.keys(appliedModifications).length === 0) return o;
        const bidKey = `${o.strike}-${o.type}-bid`;
        const askKey = `${o.strike}-${o.type}-ask`;
        return {
          ...o,
          bid: appliedModifications[bidKey] ? o.bid * appliedModifications[bidKey] : o.bid,
          ask: appliedModifications[askKey] ? o.ask * appliedModifications[askKey] : o.ask,
        };
      })
      .sort((a, b) => a.strike - b.strike);
  }, [options, selectedExpiry, effectiveMinVolume, effectiveMaxSpreadPct, isDemoMode, appliedModifications]);

  const strikeRows = useMemo(() => {
    const map = new Map<number, { strike: number; call?: OptionData; put?: OptionData }>();
    filteredOptions.forEach((opt) => {
      if (!map.has(opt.strike)) map.set(opt.strike, { strike: opt.strike });
      const row = map.get(opt.strike)!;
      if (opt.type === 'C') row.call = opt;
      else row.put = opt;
    });
    return Array.from(map.values()).sort((a, b) => a.strike - b.strike);
  }, [filteredOptions]);

  const togglePriceSelection = (strike: number, type: 'C' | 'P', side: 'bid' | 'ask') => {
    if (!isDemoMode) return;
    const key = `${strike}-${type}-${side}`;
    setSelectedPrices((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const getCellClass = (
    strike: number, type: 'C' | 'P', side: 'bid' | 'ask',
    action?: 'buy' | 'sell'
  ) => {
    const key = `${strike}-${type}-${side}`;
    const isSelected = selectedPrices.includes(key);
    const mod = appliedModifications[key];

    let baseClass = `px-2 py-2 whitespace-nowrap font-mono text-slate-600 transition-colors `;
    if (isDemoMode) baseClass += 'cursor-pointer hover:bg-indigo-50 ';

    if (isSelected) return baseClass + 'bg-indigo-100 ring-2 ring-inset ring-indigo-500 text-indigo-900 font-bold';
    if (mod) {
      if (mod > 1) return baseClass + 'bg-rose-100 text-rose-900 font-bold';
      return baseClass + 'bg-emerald-100 text-emerald-900 font-bold';
    }

    const isArbTarget = (action === 'buy' && side === 'ask') || (action === 'sell' && side === 'bid');
    if (isArbTarget) return baseClass + 'bg-blue-100 text-blue-900 font-bold ring-1 ring-inset ring-blue-500';

    return baseClass;
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-[600px]">
      <div className="p-4 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
        <h2 className="font-semibold text-slate-800">{t.filteredChain}</h2>
        <span className="text-xs text-slate-500">
          {filteredOptions.length} {t.contracts}
        </span>
      </div>
      <div className="overflow-y-auto overflow-x-hidden flex-1 p-0">
        <table className="min-w-full divide-y divide-slate-200 text-sm table-fixed">
          <thead className="bg-slate-50 sticky top-0 z-10">
            <tr>
              <th className="w-[14%] px-2 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">{t.callVol}</th>
              <th className="w-[14%] px-2 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                {t.callBid} {isDemoMode && <span className="text-indigo-500 ml-1">(Click)</span>}
              </th>
              <th className="w-[14%] px-2 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wider">
                {t.callAsk} {isDemoMode && <span className="text-indigo-500 ml-1">(Click)</span>}
              </th>
              <th className="w-[16%] px-4 py-3 text-center text-xs font-bold text-slate-700 uppercase tracking-wider bg-slate-100">{t.strike}</th>
              <th className="w-[14%] px-2 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                {t.putBid} {isDemoMode && <span className="text-indigo-500 ml-1">(Click)</span>}
              </th>
              <th className="w-[14%] px-2 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">
                {t.putAsk} {isDemoMode && <span className="text-indigo-500 ml-1">(Click)</span>}
              </th>
              <th className="w-[14%] px-2 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">{t.putVol}</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-slate-100">
            {strikeRows.map((row) => {
              const callArbAction = bestArbResult.portfolio.find((p) => p.strike === row.strike && p.type === 'C')?.action;
              const putArbAction = bestArbResult.portfolio.find((p) => p.strike === row.strike && p.type === 'P')?.action;

              return (
                <tr key={row.strike} className="hover:bg-slate-50 border-b border-slate-100">
                  <td className="px-2 py-2 whitespace-nowrap text-right text-slate-500">{row.call?.volume || '-'}</td>
                  <td
                    className={`${getCellClass(row.strike, 'C', 'bid', callArbAction)} text-right`}
                    onClick={() => row.call && togglePriceSelection(row.strike, 'C', 'bid')}
                  >
                    {row.call ? `$${row.call.bid.toFixed(1)}` : '-'}
                  </td>
                  <td
                    className={`${getCellClass(row.strike, 'C', 'ask', callArbAction)} text-right`}
                    onClick={() => row.call && togglePriceSelection(row.strike, 'C', 'ask')}
                  >
                    {row.call ? `$${row.call.ask.toFixed(1)}` : '-'}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-center font-bold font-mono text-slate-900 bg-slate-50">{row.strike}</td>
                  <td
                    className={`${getCellClass(row.strike, 'P', 'bid', putArbAction)} text-left`}
                    onClick={() => row.put && togglePriceSelection(row.strike, 'P', 'bid')}
                  >
                    {row.put ? `$${row.put.bid.toFixed(1)}` : '-'}
                  </td>
                  <td
                    className={`${getCellClass(row.strike, 'P', 'ask', putArbAction)} text-left`}
                    onClick={() => row.put && togglePriceSelection(row.strike, 'P', 'ask')}
                  >
                    {row.put ? `$${row.put.ask.toFixed(1)}` : '-'}
                  </td>
                  <td className="px-2 py-2 whitespace-nowrap text-left text-slate-500">{row.put?.volume || '-'}</td>
                </tr>
              );
            })}
            {strikeRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                  {t.noOptions}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
