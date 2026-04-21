/**
 * useLiveDataBuffer — buffers SSE option updates to avoid excessive re-renders.
 *
 * SSE pushes options every ~500ms. We buffer them in a ref and only
 * commit to display state on:
 *  1. First load (snapshot)
 *  2. Exchange/expiry switch
 *  3. Manual refresh button
 *  4. Auto-refresh every 30s
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { OptionData } from '../types';

const AUTO_REFRESH_INTERVAL = 30_000;

export function useLiveDataBuffer(backendOptions: OptionData[]) {
  const liveOptionsRef = useRef<OptionData[]>([]);
  const autoRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    setOptions, setLastUpdated, setLoading, setSelectedExpiry,
    useWebSocket, selectedExchange, selectedExpiry,
  } = useAppStore();
  const effectiveMinVolume = useAppStore((s) => s.effectiveMinVolume());
  const effectiveMaxSpreadPct = useAppStore((s) => s.effectiveMaxSpreadPct());
  const [hasNewData, setHasNewData] = useState(false);

  // Track the exchange for which we last committed data.
  // This prevents re-committing stale data from a previous exchange.
  const committedExchangeRef = useRef<string>(selectedExchange);

  const commitLiveData = useCallback(() => {
    const live = liveOptionsRef.current;
    if (live.length > 0) {
      setOptions(live);
      setLastUpdated(new Date());
      setLoading(false);
      setHasNewData(false);
      committedExchangeRef.current = selectedExchange;
    }
  }, [setOptions, setLastUpdated, setLoading, selectedExchange]);

  // When SSE sends new options, buffer them
  useEffect(() => {
    if (backendOptions.length === 0) return;
    const isFirstLoad = liveOptionsRef.current.length === 0;
    liveOptionsRef.current = backendOptions;

    if (isFirstLoad) {
      commitLiveData();
      // Auto-select expiry on first load
      if (!selectedExpiry && backendOptions.length > 0) {
        const validData = backendOptions.filter(
          (d) => d.volume >= effectiveMinVolume && d.spread_pct <= effectiveMaxSpreadPct
        );
        const expiries = [...new Set(validData.map((d) => d.expiration))];
        const counts = expiries.map((exp) => ({
          exp,
          count: validData.filter((d) => d.expiration === exp).length,
        }));
        if (counts.length > 0) {
          counts.sort((a, b) => b.count - a.count);
          setSelectedExpiry(counts[0].exp);
        } else if (backendOptions[0]?.expiration) {
          setSelectedExpiry(backendOptions[0].expiration);
        }
      }
    } else {
      setHasNewData(true);
    }
  }, [backendOptions, commitLiveData, effectiveMinVolume, effectiveMaxSpreadPct, selectedExpiry, setSelectedExpiry]);

  // Auto-refresh timer
  useEffect(() => {
    if (!useWebSocket) return;
    const tick = () => {
      if (liveOptionsRef.current.length > 0) commitLiveData();
      autoRefreshTimerRef.current = setTimeout(tick, AUTO_REFRESH_INTERVAL);
    };
    autoRefreshTimerRef.current = setTimeout(tick, AUTO_REFRESH_INTERVAL);
    return () => {
      if (autoRefreshTimerRef.current) {
        clearTimeout(autoRefreshTimerRef.current);
        autoRefreshTimerRef.current = null;
      }
    };
  }, [useWebSocket, commitLiveData]);

  // Clear buffer when exchange changes so we don't accidentally display old data
  useEffect(() => {
    liveOptionsRef.current = [];
    setHasNewData(false);
    committedExchangeRef.current = selectedExchange;
  }, [selectedExchange]);

  // On expiry switch — commit latest
  useEffect(() => {
    if (liveOptionsRef.current.length > 0) commitLiveData();
  }, [selectedExpiry, commitLiveData]);

  return {
    commitLiveData,
    liveOptionsRef,
    hasNewData,
  };
}
