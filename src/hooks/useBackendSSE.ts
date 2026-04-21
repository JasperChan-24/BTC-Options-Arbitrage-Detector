/**
 * useBackendSSE — React hook that connects to the backend SSE endpoint.
 *
 * Replaces the direct WebSocket hook when the backend is available.
 * Receives: ticker data, arbitrage results, execution status, WS status.
 *
 * Memory-safe version:
 *  - Executions capped at MAX_EXECUTIONS
 *  - setTimeout IDs tracked and cleaned up on unmount
 *  - Options only updated from snapshot (no repeated full-array pushes)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { OptionData, ArbitrageResult, ArbitrageExecution } from '../types';

export type BackendWsStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface BackendState {
  // Market data
  options: OptionData[];
  spotPrice: number;
  tickerCount: number;

  // Arbitrage
  arbResult: ArbitrageResult;
  arbExpiry: string;

  // Connection
  wsStatus: BackendWsStatus;
  deribitWsStatus: BackendWsStatus;
  isBackendOnline: boolean;

  // Execution
  executions: ArbitrageExecution[];
  executionStatus: { status: string; message?: string } | null;

  // Credentials
  hasCredentials: boolean;
  isSimulated: boolean | null;

  // Config
  config: Record<string, any>;

  // Alternate exchange arbitrage (dual-active)
  altArbResult: ArbitrageResult;
  altArbExpiry: string;
  altArbExchange: string;

  // Track backend's acknowledged exchange
  backendActiveExchange: string;
}

const SSE_URL = '/api/events';
const MAX_EXECUTIONS = 50; // Real-time cap; historical data fetched via paginated API

const EMPTY_ARB: ArbitrageResult = { feasible: false, profit: 0, portfolio: [] };

export function useBackendSSE(enabled: boolean): BackendState {
  const [options, setOptions] = useState<OptionData[]>([]);
  const [spotPrice, setSpotPrice] = useState(0);
  const [tickerCount, setTickerCount] = useState(0);
  const [arbResult, setArbResult] = useState<ArbitrageResult>(EMPTY_ARB);
  const [arbExpiry, setArbExpiry] = useState('');
  const [wsStatus, setWsStatus] = useState<BackendWsStatus>('disconnected');
  const [deribitWsStatus, setDeribitWsStatus] = useState<BackendWsStatus>('disconnected');
  const [isBackendOnline, setIsBackendOnline] = useState(false);
  const [executions, setExecutions] = useState<ArbitrageExecution[]>([]);
  const [executionStatus, setExecutionStatus] = useState<{ status: string; message?: string } | null>(null);
  const [hasCredentials, setHasCredentials] = useState(false);
  const [isSimulated, setIsSimulated] = useState<boolean | null>(null);
  const [config, setConfig] = useState<Record<string, any>>({});
  // Alternate exchange arb (dual-active)
  const [altArbResult, setAltArbResult] = useState<ArbitrageResult>(EMPTY_ARB);
  const [altArbExpiry, setAltArbExpiry] = useState('');
  const [altArbExchange, setAltArbExchange] = useState('');
  const [backendActiveExchange, setBackendActiveExchange] = useState('okx');
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeExchangeRef = useRef<string>('okx');

  // Track setTimeout IDs for cleanup on unmount
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const safeTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
    return id;
  }, []);

  const handleEvent = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);

      switch (event.type) {
        case 'snapshot':
          // Initial state dump from server — only time we get full options
          if (data.options) setOptions(data.options);
          if (data.arbitrage) {
            setArbResult(data.arbitrage.result ?? EMPTY_ARB);
            setArbExpiry(data.arbitrage.expiry ?? '');
          }
          if (data.config) setConfig(data.config);
          if (data.wsStatus) setWsStatus(data.wsStatus);
          if (data.deribitWsStatus) setDeribitWsStatus(data.deribitWsStatus);
          if (data.tickerCount) setTickerCount(data.tickerCount);
          if (data.executions) setExecutions(data.executions.slice(0, MAX_EXECUTIONS));
          if (data.hasCredentials !== undefined) setHasCredentials(data.hasCredentials);
          if (data.activeExchange) {
            activeExchangeRef.current = data.activeExchange;
            setBackendActiveExchange(data.activeExchange);
          }
          break;

        case 'ticker':
          if (data.wsStatus) setWsStatus(data.wsStatus);
          // Only update options if OKX is the active exchange AND market matches
          if (activeExchangeRef.current === 'okx') {
            setTickerCount(data.count ?? 0);
            setSpotPrice(data.spotPrice ?? 0);
            if (data.options) setOptions(data.options);
          }
          break;

        case 'deribit_ticker':
          if (data.wsStatus) setDeribitWsStatus(data.wsStatus);
          // Only update options if Deribit is the active exchange AND market matches
          if (activeExchangeRef.current === 'deribit') {
            setTickerCount(data.count ?? 0);
            setSpotPrice(data.spotPrice ?? 0);
            if (data.options) setOptions(data.options);
          }
          break;

        case 'arbitrage':
          setArbResult(data.result ?? EMPTY_ARB);
          setArbExpiry(data.expiry ?? '');
          if (data.config) setConfig(data.config);
          // NOTE: Backend no longer sends options in arbitrage events
          // Options are only received via snapshot on initial connection
          if (data.options) setOptions(data.options);
          break;

        case 'arbitrage_alt':
          setAltArbResult(data.result ?? EMPTY_ARB);
          setAltArbExpiry(data.expiry ?? '');
          setAltArbExchange(data.exchange ?? '');
          break;

        case 'execution':
          // Cap at MAX_EXECUTIONS to prevent unbounded growth
          setExecutions(prev => [data, ...prev].slice(0, MAX_EXECUTIONS));
          break;

        case 'execution_status':
          setExecutionStatus(data);
          // Auto-clear after 5 seconds — tracked for cleanup
          safeTimeout(() => setExecutionStatus(null), 5000);
          break;

        case 'execution_update':
          // Replace the execution with updated fill statuses
          setExecutions(prev => prev.map(e => e.execId === data.execId ? data : e));
          break;

        case 'ws_status':
          setWsStatus(data.status);
          break;

        case 'credentials_status':
          setHasCredentials(data.hasCredentials ?? false);
          setIsSimulated(data.simulated ?? null);
          break;

        case 'config':
          setConfig(data);
          break;

        case 'connected':
          // SSE connection confirmed
          break;

        case 'environment_change':
          if (data.wsStatus) setWsStatus(data.wsStatus);
          if (data.deribitWsStatus) setDeribitWsStatus(data.deribitWsStatus);
          // Don't clear options/arb here — backend sends follow-up
          // arbitrage + ticker events with fresh data immediately after
          break;

        case 'active_exchange_change':
          if (data.activeExchange) {
            activeExchangeRef.current = data.activeExchange;
            setBackendActiveExchange(data.activeExchange);
            // Clear options immediately so the buffer treats next data as fresh
            setOptions([]);
          }
          break;

        default:
          break;
      }
    } catch (err) {
      console.warn('[SSE] Failed to parse event:', event.type, err);
    }
  }, [safeTimeout]);

  useEffect(() => {
    if (!enabled) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setIsBackendOnline(false);
      return;
    }

    const es = new EventSource(SSE_URL);
    eventSourceRef.current = es;

    es.onopen = () => {
      console.log('[SSE] Connected to backend');
      setIsBackendOnline(true);
    };

    es.onerror = () => {
      setIsBackendOnline(false);
      // EventSource auto-reconnects
    };

    // Listen to all custom event types
    const eventTypes = [
      'connected', 'snapshot', 'ticker', 'deribit_ticker', 'arbitrage', 'arbitrage_alt',
      'execution', 'execution_status', 'execution_update', 'ws_status',
      'deribit_ws_status', 'credentials_status', 'config', 'environment_change',
      'active_exchange_change',
    ];

    for (const type of eventTypes) {
      es.addEventListener(type, handleEvent);
    }

    return () => {
      for (const type of eventTypes) {
        es.removeEventListener(type, handleEvent);
      }
      es.close();
      eventSourceRef.current = null;

      // Clean up all pending timeouts
      for (const id of timersRef.current) {
        clearTimeout(id);
      }
      timersRef.current.clear();
    };
  }, [enabled, handleEvent]);

  return {
    options,
    spotPrice,
    tickerCount,
    arbResult,
    arbExpiry,
    wsStatus,
    deribitWsStatus,
    isBackendOnline,
    executions,
    executionStatus,
    hasCredentials,
    isSimulated,
    config,
    altArbResult,
    altArbExpiry,
    altArbExchange,
    backendActiveExchange,
  };
}
