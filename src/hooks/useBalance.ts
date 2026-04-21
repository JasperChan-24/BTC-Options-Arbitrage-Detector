/**
 * useBalance — fetch account balance on interval.
 *
 * Updates Zustand store with balance + auto-computes budget.
 */

import { useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { fetchBackendBalance } from '../services/backendApi';

export function useBalance() {
  const hasCredentials = useAppStore((s) => s.hasCredentials);
  const selectedExchange = useAppStore((s) => s.selectedExchange);
  const okxRiskPct = useAppStore((s) => s.okxRiskPct);
  const deribitRiskPct = useAppStore((s) => s.deribitRiskPct);
  const { setAccountBalance, setBalanceLoading, setOkxBudgetBtc, setDeribitBudgetBtc } = useAppStore();

  // Fetch balance
  useEffect(() => {
    if (!hasCredentials || (selectedExchange !== 'okx' && selectedExchange !== 'deribit')) {
      setAccountBalance(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setBalanceLoading(true);
      const bal = await fetchBackendBalance(selectedExchange);
      if (!cancelled && bal) {
        setAccountBalance(bal);
        setBalanceLoading(false);
      }
    };
    load();
    const iv = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [hasCredentials, selectedExchange, setAccountBalance, setBalanceLoading]);

  // Auto-compute budget from balance
  const accountBalance = useAppStore((s) => s.accountBalance);
  useEffect(() => {
    if (accountBalance) {
      if (selectedExchange === 'okx') setOkxBudgetBtc(accountBalance.availBal * (okxRiskPct / 100));
      if (selectedExchange === 'deribit') setDeribitBudgetBtc(accountBalance.availBal * (deribitRiskPct / 100));
    }
  }, [accountBalance, selectedExchange, okxRiskPct, deribitRiskPct, setOkxBudgetBtc, setDeribitBudgetBtc]);
}
