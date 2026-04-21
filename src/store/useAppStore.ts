/**
 * Zustand App Store — unified state management.
 *
 * Replaces 30+ useState calls in the old Dashboard monolith.
 * Uses zustand/middleware `persist` for localStorage sync.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  OptionData, ArbitrageResult, Exchange, Environment,
  OkxCredentials, DeribitCredentials, OrderStatus, ArbitrageExecution,
} from '../types';

// ── Types ────────────────────────────────────────────────────────────────────

interface SettingsSlice {
  filterEnabled: boolean;
  minVolume: number;
  maxSpreadPct: number;
  selectedExchange: Exchange;
  selectedEnvironment: Environment;
  autoExecute: boolean;
  useWebSocket: boolean;
  includeFee: boolean;
  okxRiskPct: number;
  deribitRiskPct: number;
  okxBudgetBtc: number;
  deribitBudgetBtc: number;
}

interface MarketSlice {
  options: OptionData[];
  loading: boolean;
  lastUpdated: Date | null;
  selectedExpiry: string;
  spotPrice: number;
  tickerCount: number;
}

interface ArbitrageSlice {
  bestArbResult: ArbitrageResult;
  bestArbExpiry: string;
  altArbResult: ArbitrageResult;
  altArbExpiry: string;
  altArbExchange: string;
}

interface ExecutionSlice {
  executions: ArbitrageExecution[];
  demoExecutions: ArbitrageExecution[];
  orderStatus: OrderStatus;
  orderMessage: string;
  isExecutionDrawerOpen: boolean;
}

interface CredentialsSlice {
  okxCreds: OkxCredentials | null;
  deribitCreds: DeribitCredentials | null;
  hasCredentials: boolean;
  accountBalance: { totalEq: number; availBal: number; availUsd: number } | null;
  balanceLoading: boolean;
}

interface DemoSlice {
  isDemoMode: boolean;
  selectedPrices: string[];
  appliedModifications: Record<string, number>;
}

// ── Combined Store ───────────────────────────────────────────────────────────

const EMPTY_ARB: ArbitrageResult = { feasible: false, profit: 0, portfolio: [] };

export interface AppState extends SettingsSlice, MarketSlice, ArbitrageSlice, ExecutionSlice, CredentialsSlice, DemoSlice {
  // ── Settings actions ────────────────────────────────────────────────────
  setFilterEnabled: (v: boolean) => void;
  setMinVolume: (v: number) => void;
  setMaxSpreadPct: (v: number) => void;
  setSelectedExchange: (v: Exchange) => void;
  setSelectedEnvironment: (v: Environment) => void;
  setAutoExecute: (v: boolean) => void;
  setUseWebSocket: (v: boolean) => void;
  setIncludeFee: (v: boolean) => void;
  setOkxRiskPct: (v: number) => void;
  setDeribitRiskPct: (v: number) => void;
  setOkxBudgetBtc: (v: number) => void;
  setDeribitBudgetBtc: (v: number) => void;

  // ── Market actions ──────────────────────────────────────────────────────
  setOptions: (v: OptionData[]) => void;
  setLoading: (v: boolean) => void;
  setLastUpdated: (v: Date | null) => void;
  setSelectedExpiry: (v: string) => void;
  setSpotPrice: (v: number) => void;
  setTickerCount: (v: number) => void;

  // ── Arbitrage actions ───────────────────────────────────────────────────
  setBestArbResult: (v: ArbitrageResult) => void;
  setBestArbExpiry: (v: string) => void;
  setAltArbResult: (v: ArbitrageResult) => void;
  setAltArbExpiry: (v: string) => void;
  setAltArbExchange: (v: string) => void;

  // ── Execution actions ───────────────────────────────────────────────────
  setExecutions: (v: ArbitrageExecution[] | ((prev: ArbitrageExecution[]) => ArbitrageExecution[])) => void;
  setDemoExecutions: (v: ArbitrageExecution[] | ((prev: ArbitrageExecution[]) => ArbitrageExecution[])) => void;
  setOrderStatus: (v: OrderStatus) => void;
  setOrderMessage: (v: string) => void;
  setIsExecutionDrawerOpen: (v: boolean) => void;

  // ── Credentials actions ─────────────────────────────────────────────────
  setOkxCreds: (v: OkxCredentials | null) => void;
  setDeribitCreds: (v: DeribitCredentials | null) => void;
  setHasCredentials: (v: boolean) => void;
  setAccountBalance: (v: { totalEq: number; availBal: number; availUsd: number } | null) => void;
  setBalanceLoading: (v: boolean) => void;

  // ── Demo actions ────────────────────────────────────────────────────────
  setIsDemoMode: (v: boolean) => void;
  setSelectedPrices: (v: string[] | ((prev: string[]) => string[])) => void;
  setAppliedModifications: (v: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>)) => void;

  // ── Derived helpers ─────────────────────────────────────────────────────
  /** Effective min volume (0 when filter disabled) */
  effectiveMinVolume: () => number;
  /** Effective max spread (9999 when filter disabled) */
  effectiveMaxSpreadPct: () => number;
  /** Current risk pct for active exchange */
  riskPct: () => number;
  /** Current budget for active exchange */
  budgetBtc: () => number;
}

// ── Helper: load legacy settings from old localStorage key ───────────────────
function loadLegacySettings(): Partial<SettingsSlice> {
  try {
    const raw = localStorage.getItem('btc-arb-settings-v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      // Clean up legacy key after migration
      localStorage.removeItem('btc-arb-settings-v1');
      return parsed;
    }
  } catch { /* ignore */ }
  return {};
}

const legacy = loadLegacySettings();

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // ── Settings defaults (with legacy migration) ───────────────────────
      filterEnabled: legacy.filterEnabled ?? true,
      minVolume: legacy.minVolume ?? 10,
      maxSpreadPct: legacy.maxSpreadPct ?? 20,
      selectedExchange: legacy.selectedExchange ?? 'okx',
      selectedEnvironment: legacy.selectedEnvironment ?? 'testnet',
      autoExecute: legacy.autoExecute ?? true,
      useWebSocket: legacy.useWebSocket ?? true,
      includeFee: legacy.includeFee ?? true,
      okxRiskPct: legacy.okxRiskPct ?? 25,
      deribitRiskPct: legacy.deribitRiskPct ?? 25,
      okxBudgetBtc: legacy.okxBudgetBtc ?? 0,
      deribitBudgetBtc: legacy.deribitBudgetBtc ?? 0,

      // ── Market ──────────────────────────────────────────────────────────
      options: [],
      loading: true,
      lastUpdated: null,
      selectedExpiry: '',
      spotPrice: 0,
      tickerCount: 0,

      // ── Arbitrage ───────────────────────────────────────────────────────
      bestArbResult: EMPTY_ARB,
      bestArbExpiry: '',
      altArbResult: EMPTY_ARB,
      altArbExpiry: '',
      altArbExchange: '',

      // ── Execution ──────────────────────────────────────────────────────
      executions: [],
      demoExecutions: [],
      orderStatus: 'idle' as OrderStatus,
      orderMessage: '',
      isExecutionDrawerOpen: false,

      // ── Credentials ────────────────────────────────────────────────────
      okxCreds: null,
      deribitCreds: null,
      hasCredentials: false,
      accountBalance: null,
      balanceLoading: false,

      // ── Demo ───────────────────────────────────────────────────────────
      isDemoMode: false,
      selectedPrices: [],
      appliedModifications: {},

      // ── Settings actions ────────────────────────────────────────────────
      setFilterEnabled: (v) => set({ filterEnabled: v }),
      setMinVolume: (v) => set({ minVolume: v }),
      setMaxSpreadPct: (v) => set({ maxSpreadPct: v }),
      setSelectedExchange: (v) => set({ selectedExchange: v }),
      setSelectedEnvironment: (v) => set({ selectedEnvironment: v }),
      setAutoExecute: (v) => set({ autoExecute: v }),
      setUseWebSocket: (v) => set({ useWebSocket: v }),
      setIncludeFee: (v) => set({ includeFee: v }),
      setOkxRiskPct: (v) => set({ okxRiskPct: v }),
      setDeribitRiskPct: (v) => set({ deribitRiskPct: v }),
      setOkxBudgetBtc: (v) => set({ okxBudgetBtc: v }),
      setDeribitBudgetBtc: (v) => set({ deribitBudgetBtc: v }),

      // ── Market actions ──────────────────────────────────────────────────
      setOptions: (v) => set({ options: v }),
      setLoading: (v) => set({ loading: v }),
      setLastUpdated: (v) => set({ lastUpdated: v }),
      setSelectedExpiry: (v) => set({ selectedExpiry: v }),
      setSpotPrice: (v) => set({ spotPrice: v }),
      setTickerCount: (v) => set({ tickerCount: v }),

      // ── Arbitrage actions ───────────────────────────────────────────────
      setBestArbResult: (v) => set({ bestArbResult: v }),
      setBestArbExpiry: (v) => set({ bestArbExpiry: v }),
      setAltArbResult: (v) => set({ altArbResult: v }),
      setAltArbExpiry: (v) => set({ altArbExpiry: v }),
      setAltArbExchange: (v) => set({ altArbExchange: v }),

      // ── Execution actions ───────────────────────────────────────────────
      setExecutions: (v) => set((s) => ({
        executions: typeof v === 'function' ? v(s.executions) : v,
      })),
      setDemoExecutions: (v) => set((s) => ({
        demoExecutions: typeof v === 'function' ? v(s.demoExecutions) : v,
      })),
      setOrderStatus: (v) => set({ orderStatus: v }),
      setOrderMessage: (v) => set({ orderMessage: v }),
      setIsExecutionDrawerOpen: (v) => set({ isExecutionDrawerOpen: v }),

      // ── Credentials actions ─────────────────────────────────────────────
      setOkxCreds: (v) => set({ okxCreds: v }),
      setDeribitCreds: (v) => set({ deribitCreds: v }),
      setHasCredentials: (v) => set({ hasCredentials: v }),
      setAccountBalance: (v) => set({ accountBalance: v }),
      setBalanceLoading: (v) => set({ balanceLoading: v }),

      // ── Demo actions ────────────────────────────────────────────────────
      setIsDemoMode: (v) => set({ isDemoMode: v }),
      setSelectedPrices: (v) => set((s) => ({
        selectedPrices: typeof v === 'function' ? v(s.selectedPrices) : v,
      })),
      setAppliedModifications: (v) => set((s) => ({
        appliedModifications: typeof v === 'function' ? v(s.appliedModifications) : v,
      })),

      // ── Derived helpers ─────────────────────────────────────────────────
      effectiveMinVolume: () => {
        const s = get();
        return s.filterEnabled ? s.minVolume : 0;
      },
      effectiveMaxSpreadPct: () => {
        const s = get();
        return s.filterEnabled ? s.maxSpreadPct : 9999;
      },
      riskPct: () => {
        const s = get();
        return s.selectedExchange === 'okx' ? s.okxRiskPct : s.deribitRiskPct;
      },
      budgetBtc: () => {
        const s = get();
        return s.selectedExchange === 'okx' ? s.okxBudgetBtc : s.deribitBudgetBtc;
      },
    }),
    {
      name: 'btc-arb-store',
      // Only persist settings — volatile state (options, arb, etc.) is transient
      partialize: (state) => ({
        filterEnabled: state.filterEnabled,
        minVolume: state.minVolume,
        maxSpreadPct: state.maxSpreadPct,
        selectedExchange: state.selectedExchange,
        selectedEnvironment: state.selectedEnvironment,
        autoExecute: state.autoExecute,
        useWebSocket: state.useWebSocket,
        includeFee: state.includeFee,
        okxRiskPct: state.okxRiskPct,
        deribitRiskPct: state.deribitRiskPct,
        okxBudgetBtc: state.okxBudgetBtc,
        deribitBudgetBtc: state.deribitBudgetBtc,
      }),
    }
  )
);
