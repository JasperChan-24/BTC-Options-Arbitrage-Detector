import React, { useState, useEffect, useMemo } from 'react';
import { OptionData, ArbitrageResult } from '../types';
import { fetchDeribitOptions } from '../services/deribitService';
import { detectArbitrage } from '../services/arbitrageService';
import { RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine
} from 'recharts';
import { translations, Language } from '../i18n';

export default function Dashboard({ lang }: { lang: Language }) {
  const t = translations[lang];
  const [options, setOptions] = useState<OptionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Filters
  const [minVolume, setMinVolume] = useState<number>(10);
  const [maxSpreadPct, setMaxSpreadPct] = useState<number>(20);
  const [selectedExpiry, setSelectedExpiry] = useState<string>('');

  // Demo Mode State
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [selectedPrices, setSelectedPrices] = useState<string[]>([]);
  const [appliedModifications, setAppliedModifications] = useState<Record<string, number>>({});

  const toggleDemoMode = () => {
    setIsDemoMode(!isDemoMode);
    if (isDemoMode) {
      setSelectedPrices([]);
      setAppliedModifications({});
    }
  };

  const togglePriceSelection = (strike: number, type: 'C' | 'P', side: 'bid' | 'ask') => {
    if (!isDemoMode) return;
    const key = `${strike}-${type}-${side}`;
    setSelectedPrices(prev => 
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const applyModification = (multiplier: number) => {
    setAppliedModifications(prev => {
      const next = { ...prev };
      selectedPrices.forEach(key => {
        next[key] = multiplier;
      });
      return next;
    });
    setSelectedPrices([]);
  };

  const clearDiscounts = () => {
    setAppliedModifications({});
    setSelectedPrices([]);
  };

  const loadData = async () => {
    setLoading(true);
    const data = await fetchDeribitOptions();
    setOptions(data);
    setLastUpdated(new Date());
    
    // Set default expiry to the one with most options if none selected
    if (!selectedExpiry && data.length > 0) {
      const expiries = [...new Set(data.map(d => d.expiration))];
      const counts = expiries.map(exp => ({
        exp,
        count: data.filter(d => d.expiration === exp).length
      }));
      counts.sort((a, b) => b.count - a.count);
      setSelectedExpiry(counts[0].exp);
    }
    
    setLoading(false);
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, []);

  const expiries = useMemo(() => {
    return [...new Set(options.map(o => o.expiration))].sort();
  }, [options]);

  const filteredOptions = useMemo(() => {
    return options
      .filter(o => o.expiration === selectedExpiry)
      .filter(o => o.volume >= minVolume)
      .filter(o => o.spread_pct <= maxSpreadPct)
      .map(o => {
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
  }, [options, selectedExpiry, minVolume, maxSpreadPct, isDemoMode, appliedModifications]);

  const strikeRows = useMemo(() => {
    const map = new Map<number, { strike: number; call?: OptionData; put?: OptionData }>();
    filteredOptions.forEach(opt => {
      if (!map.has(opt.strike)) {
        map.set(opt.strike, { strike: opt.strike });
      }
      const row = map.get(opt.strike)!;
      if (opt.type === 'C') row.call = opt;
      else row.put = opt;
    });
    return Array.from(map.values()).sort((a, b) => a.strike - b.strike);
  }, [filteredOptions]);

  const arbResult = useMemo(() => {
    return detectArbitrage(filteredOptions);
  }, [filteredOptions]);

  // Chart Data
  const convexityData = useMemo(() => {
    return strikeRows.map(row => ({
      strike: row.strike,
      callBid: row.call?.bid,
      callAsk: row.call?.ask,
      putBid: row.put?.bid,
      putAsk: row.put?.ask,
    }));
  }, [strikeRows]);

  const payoffData = useMemo(() => {
    if (!arbResult.feasible || arbResult.portfolio.length === 0) return [];
    
    const minStrike = filteredOptions[0]?.strike || 0;
    const maxStrike = filteredOptions[filteredOptions.length - 1]?.strike || 100000;
    const step = (maxStrike - minStrike) / 50;
    
    let initialProfit = 0;
    arbResult.portfolio.forEach(pos => {
      if (pos.action === 'buy') {
        initialProfit -= pos.amount * pos.price;
      } else {
        initialProfit += pos.amount * pos.price;
      }
    });

    const data = [];
    for (let s = minStrike * 0.8; s <= maxStrike * 1.2; s += step) {
      let payoff = 0;
      arbResult.portfolio.forEach(pos => {
        const optionPayoff = pos.type === 'C' ? Math.max(s - pos.strike, 0) : Math.max(pos.strike - s, 0);
        if (pos.action === 'buy') {
          payoff += pos.amount * optionPayoff;
        } else {
          payoff -= pos.amount * optionPayoff;
        }
      });
      data.push({
        underlying: Math.round(s),
        payoff: payoff,
        totalPnL: payoff + initialProfit
      });
    }
    return data;
  }, [arbResult, filteredOptions]);

  return (
    <div className="space-y-6">
      {/* Settings Panel */}
      <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-wrap gap-6 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">{t.expirationDate}</label>
          <select 
            className="block w-48 rounded-md border-slate-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2 border"
            value={selectedExpiry}
            onChange={(e) => setSelectedExpiry(e.target.value)}
          >
            {expiries.map(exp => (
              <option key={exp} value={exp}>{exp}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">{t.minVolume}</label>
          <input 
            type="number" 
            className="block w-32 rounded-md border-slate-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2 border"
            value={minVolume}
            onChange={(e) => setMinVolume(Number(e.target.value))}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">{t.maxSpread}</label>
          <input 
            type="number" 
            className="block w-32 rounded-md border-slate-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2 border"
            value={maxSpreadPct}
            onChange={(e) => setMaxSpreadPct(Number(e.target.value))}
          />
        </div>
        <div className="flex items-center gap-4 ml-auto">
          <label className="flex items-center gap-2 cursor-pointer">
            <input 
              type="checkbox" 
              className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
              checked={isDemoMode}
              onChange={toggleDemoMode}
            />
            <span className="text-sm font-medium text-slate-700">{t.demoMode}</span>
          </label>
          <button 
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 bg-indigo-50 text-indigo-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-indigo-100 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {t.refresh}
          </button>
        </div>
      </div>

      {/* Demo Mode Panel */}
      {isDemoMode && (
        <div className="bg-amber-50 p-4 rounded-xl shadow-sm border border-amber-200 flex flex-wrap gap-4 items-center">
          <div className="text-amber-800 font-medium flex items-center gap-2 text-sm">
            <AlertTriangle className="w-5 h-5" />
            {t.demoModeDesc}
          </div>
          <div className="ml-auto flex gap-3">
            <button
              onClick={clearDiscounts}
              disabled={Object.keys(appliedModifications).length === 0 && selectedPrices.length === 0}
              className="px-4 py-2 bg-white text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors font-medium text-sm disabled:opacity-50"
            >
              {t.clearDiscounts}
            </button>
            <button
              onClick={() => applyModification(0.7)}
              disabled={selectedPrices.length === 0}
              className="px-4 py-2 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors font-medium text-sm disabled:opacity-50"
            >
              {t.applyDiscount} ({selectedPrices.length})
            </button>
            <button
              onClick={() => applyModification(1.3)}
              disabled={selectedPrices.length === 0}
              className="px-4 py-2 bg-rose-500 text-white rounded-lg hover:bg-rose-600 transition-colors font-medium text-sm disabled:opacity-50"
            >
              {t.applyPremium} ({selectedPrices.length})
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex flex-col gap-6">
        {/* Top Row: Arbitrage Status */}
        <div className={`p-6 rounded-xl border ${arbResult.feasible ? 'bg-blue-50 border-blue-200' : 'bg-white border-slate-200 shadow-sm'}`}>
          <div className="flex items-start gap-4">
            {arbResult.feasible ? (
              <div className="p-2 bg-blue-100 rounded-full text-blue-600">
                <CheckCircle2 className="w-6 h-6" />
              </div>
            ) : (
              <div className="p-2 bg-slate-100 rounded-full text-slate-400">
                <AlertTriangle className="w-6 h-6" />
              </div>
            )}
            <div>
              <h2 className={`text-lg font-semibold ${arbResult.feasible ? 'text-blue-800' : 'text-slate-700'}`}>
                {arbResult.feasible ? t.arbDetected : t.noArb}
              </h2>
              {arbResult.feasible ? (
                <div className="mt-2 space-y-2">
                  <p className="text-blue-700">
                    {t.guaranteedProfit} <span className="font-bold">${arbResult.profit.toFixed(2)}</span> {t.perUnit}
                  </p>
                  <div className="mt-4 bg-white/60 rounded-lg p-4 text-sm font-mono text-blue-900">
                    <p className="font-semibold mb-2">{t.optimalPortfolio}</p>
                    <ul className="space-y-1">
                      {arbResult.portfolio.map((pos, i) => (
                        <li key={i}>
                          {pos.action === 'buy' ? t.buy : t.sell} {pos.amount.toFixed(4)}x {pos.type === 'C' ? t.callAt : t.putAt} {pos.strike} ({t.price} ${pos.price.toFixed(2)})
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : (
                <p className="text-slate-500 mt-1">
                  {t.noArbDesc}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Middle Row: Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Convexity Chart */}
          <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 h-[350px] flex flex-col">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">{t.convexityChart}</h3>
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={convexityData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis 
                    dataKey="strike" 
                    type="number" 
                    domain={['dataMin', 'dataMax']} 
                    tickFormatter={(val) => `${val/1000}k`}
                    stroke="#94a3b8"
                    fontSize={12}
                  />
                  <YAxis 
                    stroke="#94a3b8" 
                    fontSize={12}
                    tickFormatter={(val) => `$${val}`}
                  />
                  <Tooltip 
                    formatter={(value: number) => [`$${value.toFixed(2)}`, '']}
                    labelFormatter={(label) => `${t.strike}: ${label}`}
                  />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
                  <Line type="monotone" dataKey="callAsk" stroke="#ef4444" strokeWidth={2} dot={{r: 2}} name={t.callAsk} connectNulls />
                  <Line type="monotone" dataKey="callBid" stroke="#22c55e" strokeWidth={2} dot={{r: 2}} name={t.callBid} connectNulls />
                  <Line type="monotone" dataKey="putAsk" stroke="#f97316" strokeWidth={2} dot={{r: 2}} name={t.putAsk} connectNulls />
                  <Line type="monotone" dataKey="putBid" stroke="#3b82f6" strokeWidth={2} dot={{r: 2}} name={t.putBid} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Payoff Chart */}
          <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 h-[350px] flex flex-col">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">{t.payoffChart}</h3>
            {arbResult.feasible ? (
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={payoffData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis 
                      dataKey="underlying" 
                      type="number" 
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(val) => `${val/1000}k`}
                      stroke="#94a3b8"
                      fontSize={12}
                    />
                    <YAxis 
                      stroke="#94a3b8" 
                      fontSize={12}
                      tickFormatter={(val) => `$${val}`}
                    />
                    <Tooltip 
                      formatter={(value: number) => [`$${value.toFixed(2)}`, t.totalPnl]}
                      labelFormatter={(label) => `${t.btcPrice} $${label}`}
                    />
                    <ReferenceLine y={0} stroke="#64748b" strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="totalPnL" stroke="#6366f1" strokeWidth={2} dot={false} name={t.totalPnlAtMaturity} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
                {t.noPortfolio}
              </div>
            )}
          </div>
        </div>

        {/* Bottom Row: Data Table */}
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
                  const callArbAction = arbResult.portfolio.find(p => p.strike === row.strike && p.type === 'C')?.action;
                  const putArbAction = arbResult.portfolio.find(p => p.strike === row.strike && p.type === 'P')?.action;
                  
                  const getCellClass = (type: 'C' | 'P', side: 'bid' | 'ask', action?: 'buy' | 'sell') => {
                    const key = `${row.strike}-${type}-${side}`;
                    const isSelected = selectedPrices.includes(key);
                    const mod = appliedModifications[key];
  
                    let baseClass = `px-2 py-2 whitespace-nowrap font-mono text-slate-600 transition-colors `;
                    if (isDemoMode) baseClass += 'cursor-pointer hover:bg-indigo-50 ';
  
                    if (isSelected) return baseClass + 'bg-indigo-100 ring-2 ring-inset ring-indigo-500 text-indigo-900 font-bold';
                    if (mod) {
                      if (mod > 1) return baseClass + 'bg-rose-100 text-rose-900 font-bold';
                      return baseClass + 'bg-emerald-100 text-emerald-900 font-bold';
                   }
  
                    // 精确匹配买卖方向
                    const isArbTarget = (action === 'buy' && side === 'ask') || (action === 'sell' && side === 'bid');
                    if (isArbTarget) return baseClass + 'bg-blue-100 text-blue-900 font-bold ring-1 ring-inset ring-blue-500';
  
                    return baseClass;
                   };
                  
                  return (
                    <tr key={row.strike} className="hover:bg-slate-50 border-b border-slate-100">
                      <td className="px-2 py-2 whitespace-nowrap text-right text-slate-500">{row.call?.volume || '-'}</td>
                      <td 
                        className={`${getCellClass('C', 'bid', callArbAction)} text-right`}
                        onClick={() => row.call && togglePriceSelection(row.strike, 'C', 'bid')}
                      >
                        {row.call ? `$${row.call.bid.toFixed(1)}` : '-'}
                      </td>
                      <td 
                        className={`${getCellClass('C', 'ask', callArbAction)} text-right`}
                        onClick={() => row.call && togglePriceSelection(row.strike, 'C', 'ask')}
                      >
                        {row.call ? `$${row.call.ask.toFixed(1)}` : '-'}
                      </td>
                      
                      <td className="px-4 py-2 whitespace-nowrap text-center font-bold font-mono text-slate-900 bg-slate-50">{row.strike}</td>
                      
                      <td 
                        className={`${getCellClass('P', 'bid', putArbAction)} text-left`}
                        onClick={() => row.put && togglePriceSelection(row.strike, 'P', 'bid')}
                      >
                        {row.put ? `$${row.put.bid.toFixed(1)}` : '-'}
                      </td>
                      <td 
                        className={`${getCellClass('P', 'ask', putArbAction)} text-left`}
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
      </div>
    </div>
  );
}
