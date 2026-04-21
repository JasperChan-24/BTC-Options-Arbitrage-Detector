/**
 * Dashboard — main layout shell.
 *
 * Orchestrates sub-components and hooks. All state lives in Zustand store.
 * The old 1401-line monolith has been split into:
 *   - SettingsBar, ArbitrageStatus, ConvexityChart, PayoffChart,
 *     OptionsTable, DemoModePanel, ExecutionDrawer
 *   - useSettings, useBalance, useLiveDataBuffer hooks
 */

import React, { useMemo, useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useBackendSSE } from '../hooks/useBackendSSE';
import { useSettings } from '../hooks/useSettings';
import { useBalance } from '../hooks/useBalance';
import { useLiveDataBuffer } from '../hooks/useLiveDataBuffer';
import { detectArbitrage } from '../services/arbitrageService';
import { fetchDeribitOptions } from '../services/deribitService';
import { fetchOkxOptions } from '../services/okxService';
import { translations, Language } from '../i18n';

import SettingsBar from './dashboard/SettingsBar';
import DemoModePanel from './dashboard/DemoModePanel';
import ArbitrageStatus from './dashboard/ArbitrageStatus';
import ConvexityChart from './dashboard/ConvexityChart';
import PayoffChart from './dashboard/PayoffChart';
import OptionsTable from './dashboard/OptionsTable';
import ExecutionDrawer from './dashboard/ExecutionDrawer';

import type { OptionData } from '../types';

export default function Dashboard({ lang, onLanguageChange }: { lang: Language; onLanguageChange: () => void }) {
  const t = translations[lang];

  // Zustand state
  const {
    useWebSocket, selectedExchange,
    options, loading, selectedExpiry,
    isDemoMode, appliedModifications, includeFee,
    setOptions, setLoading, setSelectedExpiry,
    setBestArbResult, setBestArbExpiry,
    setAltArbResult, setAltArbExpiry, setAltArbExchange,
    setHasCredentials,
    bestArbResult, bestArbExpiry,
  } = useAppStore();
  const budgetBtc = useAppStore((s) => s.budgetBtc());
  const effectiveMinVolume = useAppStore((s) => s.effectiveMinVolume());
  const effectiveMaxSpreadPct = useAppStore((s) => s.effectiveMaxSpreadPct());

  // ── Side-effect hooks ──────────────────────────────────────────────────
  useSettings();
  useBalance();

  // ── Backend SSE ────────────────────────────────────────────────────────
  const wsEnabled = useWebSocket;
  const {
    options: backendOptions,
    wsStatus,
    deribitWsStatus,
    spotPrice,
    isBackendOnline,
    hasCredentials,
    executions: serverExecutions,
    arbResult: sseArbResult,
    arbExpiry: sseArbExpiry,
    altArbResult: sseAltArbResult,
    altArbExpiry: sseAltArbExpiry,
    altArbExchange: sseAltArbExchange,
    backendActiveExchange,
  } = useBackendSSE(wsEnabled);

  // ── Determine if frontend LP is needed ─────────────────────────────────
  // Frontend LP is needed when:
  //   1. WebSocket is disabled (REST fallback mode), OR
  //   2. Demo mode is active AND user has applied price modifications
  const hasDemoModifications = isDemoMode && Object.keys(appliedModifications).length > 0;
  const needsFrontendLP = !wsEnabled || hasDemoModifications;

  // Use a ref to make needsFrontendLP accessible in effects without causing re-subscriptions
  const needsFrontendLPRef = useRef(needsFrontendLP);
  needsFrontendLPRef.current = needsFrontendLP;

  // Sync SSE → Zustand store
  useEffect(() => { setHasCredentials(hasCredentials); }, [hasCredentials, setHasCredentials]);

  // Sync SSE arb results — but NEVER when frontend LP is active (demo mode)
  useEffect(() => {
    if (wsEnabled && sseArbResult && !needsFrontendLPRef.current) {
      setBestArbResult(sseArbResult);
    }
  }, [sseArbResult, wsEnabled, setBestArbResult]);
  
  useEffect(() => {
    if (wsEnabled && sseArbExpiry !== undefined && !needsFrontendLPRef.current) {
      setBestArbExpiry(sseArbExpiry);
    }
  }, [sseArbExpiry, wsEnabled, setBestArbExpiry]);

  useEffect(() => {
    if (sseAltArbResult) setAltArbResult(sseAltArbResult);
  }, [sseAltArbResult, setAltArbResult]);
  useEffect(() => {
    if (sseAltArbExpiry !== undefined) setAltArbExpiry(sseAltArbExpiry);
  }, [sseAltArbExpiry, setAltArbExpiry]);
  useEffect(() => {
    if (sseAltArbExchange !== undefined) setAltArbExchange(sseAltArbExchange);
  }, [sseAltArbExchange, setAltArbExchange]);

  // Sync server executions to store
  useEffect(() => {
    if (wsEnabled && serverExecutions.length > 0) {
      useAppStore.setState({ executions: serverExecutions });
    }
  }, [serverExecutions, wsEnabled]);

  // ── Live data buffer ───────────────────────────────────────────────────
  // Only feed options from the currently selected exchange to the buffer.
  // When backendActiveExchange doesn't match selectedExchange, feed empty
  // so the buffer treats subsequent matching data as "first load" (instant render).
  const filteredBackendOptions = selectedExchange === backendActiveExchange ? backendOptions : [];
  const { commitLiveData, hasNewData } = useLiveDataBuffer(filteredBackendOptions);

  const activeWsStatus = selectedExchange === 'okx' ? wsStatus : deribitWsStatus;
  const isDataStale = !isBackendOnline || activeWsStatus !== 'connected';

  // ── REST fallback (when WS disabled) ───────────────────────────────────
  const loadData = async () => {
    setLoading(true);
    const data = selectedExchange === 'okx' ? await fetchOkxOptions() : await fetchDeribitOptions();
    setOptions(data);
    useAppStore.setState({ lastUpdated: new Date() });

    if (!selectedExpiry && data.length > 0) {
      const validData = data.filter((d) => d.volume >= effectiveMinVolume && d.spread_pct <= effectiveMaxSpreadPct);
      const expiries = [...new Set(validData.map((d) => d.expiration))];
      const counts = expiries.map((exp) => ({ exp, count: validData.filter((d) => d.expiration === exp).length }));
      if (counts.length > 0) {
        counts.sort((a, b) => b.count - a.count);
        setSelectedExpiry(counts[0].exp);
      } else if (data[0]?.expiration) {
        setSelectedExpiry(data[0].expiration);
      }
    }
    setLoading(false);
  };

  useEffect(() => {
    if (wsEnabled && options.length > 0) return;
    if (!wsEnabled) {
      loadData();
      const interval = setInterval(loadData, 60000);
      return () => clearInterval(interval);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExchange, wsEnabled, options.length]);

  // ── Frontend LP (demo mode / non-SSE) ──────────────────────────────────
  const filteredForLP = useMemo(() => {
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

  useEffect(() => {
    if (!needsFrontendLP) return;
    const result = detectArbitrage(filteredForLP, includeFee ? 0.0003 : 0, budgetBtc);
    setBestArbResult(result);
    setBestArbExpiry(selectedExpiry);
  }, [filteredForLP, includeFee, budgetBtc, needsFrontendLP, selectedExpiry, setBestArbResult, setBestArbExpiry]);

  // ── Timer cleanup ──────────────────────────────────────────────────────
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const safeTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
    return id;
  }, []);
  useEffect(() => {
    return () => {
      for (const id of timersRef.current) clearTimeout(id);
      timersRef.current.clear();
    };
  }, []);

  // ── Chart data ─────────────────────────────────────────────────────────
  const strikeRows = useMemo(() => {
    const filtered = options
      .filter((o) => o.expiration === selectedExpiry)
      .filter((o) => o.volume >= effectiveMinVolume)
      .filter((o) => o.spread_pct <= effectiveMaxSpreadPct)
      .sort((a, b) => a.strike - b.strike);
    const map = new Map<number, { strike: number; call?: OptionData; put?: OptionData }>();
    filtered.forEach((opt) => {
      if (!map.has(opt.strike)) map.set(opt.strike, { strike: opt.strike });
      const row = map.get(opt.strike)!;
      if (opt.type === 'C') row.call = opt;
      else row.put = opt;
    });
    return Array.from(map.values()).sort((a, b) => a.strike - b.strike);
  }, [options, selectedExpiry, effectiveMinVolume, effectiveMaxSpreadPct]);

  const convexityData = useMemo(() => {
    return strikeRows.map((row) => ({
      strike: row.strike,
      callBid: row.call?.bid,
      callAsk: row.call?.ask,
      putBid: row.put?.bid,
      putAsk: row.put?.ask,
    }));
  }, [strikeRows]);

  const payoffData = useMemo(() => {
    if (!bestArbResult.feasible || bestArbResult.portfolio.length === 0) return [];
    const strikes = bestArbResult.portfolio.map((p) => p.strike);
    const minStrike = Math.min(...strikes);
    const maxStrike = Math.max(...strikes);
    const step = (maxStrike - minStrike) / 50;

    let initialProfit = 0;
    bestArbResult.portfolio.forEach((pos) => {
      if (pos.action === 'buy') initialProfit -= pos.amount * pos.price;
      else initialProfit += pos.amount * pos.price;
    });

    const data = [];
    for (let s = minStrike * 0.8; s <= maxStrike * 1.2; s += step) {
      let payoff = 0;
      bestArbResult.portfolio.forEach((pos) => {
        const optionPayoff = pos.type === 'C' ? Math.max(s - pos.strike, 0) : Math.max(pos.strike - s, 0);
        if (pos.action === 'buy') payoff += pos.amount * optionPayoff;
        else payoff -= pos.amount * optionPayoff;
      });
      data.push({ underlying: Math.round(s), payoff, totalPnL: payoff + initialProfit });
    }
    return data;
  }, [bestArbResult]);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <SettingsBar
        lang={lang} t={t}
        wsStatus={wsStatus} deribitWsStatus={deribitWsStatus}
        isBackendOnline={isBackendOnline} isDataStale={isDataStale}
        hasNewData={hasNewData} loading={loading}
        onRefresh={() => { commitLiveData(); if (!wsEnabled) loadData(); }}
      />

      <DemoModePanel t={t} />

      <div className="flex flex-col gap-6">
        <ArbitrageStatus t={t} lang={lang} safeTimeout={safeTimeout} />

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 h-[350px] flex flex-col">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">{t.convexityChart}</h3>
            <div className="flex-1 min-h-0">
              <ConvexityChart data={convexityData} t={t} />
            </div>
          </div>
          <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 h-[350px] flex flex-col">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">{t.payoffChart}</h3>
            {bestArbResult.feasible ? (
              <div className="flex-1 min-h-0">
                <PayoffChart data={payoffData} t={t} />
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
                {t.noPortfolio}
              </div>
            )}
          </div>
        </div>

        <OptionsTable t={t} />
      </div>

      <ExecutionDrawer t={t} lang={lang} />
    </div>
  );
}
