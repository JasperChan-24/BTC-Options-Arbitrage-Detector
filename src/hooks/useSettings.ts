/**
 * useSettings — syncs store settings to backend (debounced).
 *
 * Extracted from Dashboard to keep side-effect logic out of components.
 */

import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { updateBackendConfig, setActiveExchange, setEnvironment } from '../services/backendApi';

export function useSettings() {
  const {
    useWebSocket, selectedExchange, selectedEnvironment,
    includeFee, autoExecute,
    okxRiskPct, deribitRiskPct, okxBudgetBtc, deribitBudgetBtc,
  } = useAppStore();
  const effectiveMinVolume = useAppStore((s) => s.effectiveMinVolume());
  const effectiveMaxSpreadPct = useAppStore((s) => s.effectiveMaxSpreadPct());

  // Sync settings to backend (debounced)
  useEffect(() => {
    if (!useWebSocket) return;
    const timer = setTimeout(() => {
      updateBackendConfig({
        minVolume: effectiveMinVolume, maxSpreadPct: effectiveMaxSpreadPct,
        includeFee, autoExecute,
        okxRiskPct, deribitRiskPct, okxBudgetBtc, deribitBudgetBtc,
      }).catch(console.error);
    }, 500);
    return () => clearTimeout(timer);
  }, [effectiveMinVolume, effectiveMaxSpreadPct, includeFee, autoExecute,
      okxRiskPct, deribitRiskPct, okxBudgetBtc, deribitBudgetBtc, useWebSocket]);

  // Sync environment & exchange on mount
  useEffect(() => {
    if (useWebSocket) {
      setEnvironment(selectedEnvironment).catch(console.error);
      setActiveExchange(selectedExchange).catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useWebSocket]);
}
