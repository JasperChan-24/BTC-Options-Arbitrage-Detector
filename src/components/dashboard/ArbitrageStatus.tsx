import React, { useCallback, useRef } from 'react';
import { CheckCircle2, AlertTriangle, Zap, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { triggerExecution } from '../../services/backendApi';
import type { Language } from '../../i18n';
import type { ArbitrageResult, ArbitrageExecution, OkxCredentials } from '../../types';
import { placeArbitrageOrders, fetchTradableInstIds } from '../../services/okxTradingService';

interface ArbitrageStatusProps {
  t: Record<string, string>;
  lang: Language;
  safeTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

export default function ArbitrageStatus({ t, lang, safeTimeout }: ArbitrageStatusProps) {
  const {
    bestArbResult, bestArbExpiry,
    selectedExchange, okxCreds, deribitCreds,
    orderStatus, setOrderStatus,
    orderMessage, setOrderMessage,
    isDemoMode, useWebSocket,
    setDemoExecutions, setExecutions,
  } = useAppStore();
  const budgetBtc = useAppStore((s) => s.budgetBtc());

  const isExecuting = useRef(false);

  const executeArb = useCallback(async (arbResult: ArbitrageResult, creds: OkxCredentials) => {
    if (isExecuting.current) return;
    isExecuting.current = true;
    setOrderStatus('sending');
    setOrderMessage('');

    const tradable = await fetchTradableInstIds(creds.simulated);
    let validPortfolio = arbResult.portfolio;
    if (tradable.size > 0) {
      validPortfolio = arbResult.portfolio.filter((p) => tradable.has(p.instId));
    }

    if (validPortfolio.length === 0) {
      setOrderStatus('error');
      setOrderMessage('No valid instruments found on OKX — all legs unlisted');
      isExecuting.current = false;
      safeTimeout(() => setOrderStatus('idle'), 5000);
      return;
    }

    const orders = validPortfolio.map((pos) => ({
      instId: pos.instId,
      side: pos.action,
      sz: String(Math.max(1, Math.round(pos.amount))),
      px: pos.rawPrice.toFixed(4),
    }));

    // Self-trade detection
    const buyIds = new Set(arbResult.portfolio.filter((p) => p.action === 'buy').map((p) => p.instId));
    const sellIds = new Set(arbResult.portfolio.filter((p) => p.action === 'sell').map((p) => p.instId));
    const selfTrade = [...buyIds].some((id) => sellIds.has(id));
    if (selfTrade) {
      setOrderStatus('error');
      setOrderMessage('Inverted spread (paper trading artifact) — skipping');
      isExecuting.current = false;
      safeTimeout(() => setOrderStatus('idle'), 5000);
      return;
    }

    const result = await placeArbitrageOrders(creds, orders);

    const batchRejected = result.results.length === 0 && !result.success;
    const submittedOrders = validPortfolio.map((pos, i) => {
      const r = result.results[i];
      const ok = r?.sCode === '0';
      return {
        localId: `${Date.now()}-${i}`,
        instId: pos.instId,
        side: pos.action,
        type: pos.type,
        strike: pos.strike,
        sz: String(Math.max(1, Math.round(pos.amount))),
        px: pos.rawPrice.toFixed(4),
        ordId: ok ? r?.ordId : undefined,
        fillStatus: (ok ? 'live' : 'failed') as const,
        failureCode: ok ? undefined : (r?.sCode ?? (batchRejected ? 'BATCH' : undefined)),
        failureMsg: ok ? undefined : (r?.sMsg ?? (batchRejected ? result.error : 'Rejected')),
        submittedAt: new Date().toISOString(),
      };
    });

    const exec: ArbitrageExecution = {
      execId: `exec-${Date.now()}`,
      timestamp: new Date().toISOString(),
      expectedProfit: arbResult.profit,
      orders: submittedOrders,
      overallStatus: result.success ? 'pending' : result.partialSuccess ? 'partial' : 'failed',
    };

    if (!isDemoMode) {
      setExecutions((prev) => [...prev, exec]);
    }

    if (result.success) {
      setOrderStatus('success');
      setOrderMessage(`${result.results.length} / ${result.results.length}`);
    } else if (result.partialSuccess) {
      setOrderStatus('success');
      setOrderMessage(`${result.results.filter((r) => r.sCode === '0').length} / ${result.results.length}`);
    } else {
      setOrderStatus('error');
      setOrderMessage(result.error ?? 'Failed');
    }

    isExecuting.current = false;
    safeTimeout(() => setOrderStatus('idle'), 5000);
  }, [isDemoMode, setOrderStatus, setOrderMessage, setExecutions, safeTimeout]);

  const handleExecuteClick = () => {
    const activeCreds = selectedExchange === 'okx' ? okxCreds : deribitCreds;
    if (isDemoMode) {
      setOrderStatus('sending');
      safeTimeout(() => {
        const exec: ArbitrageExecution = {
          execId: `demo-${Date.now()}`,
          exchange: selectedExchange,
          timestamp: new Date().toISOString(),
          expectedProfit: bestArbResult.profit,
          orders: bestArbResult.portfolio.map((pos, i) => ({
            localId: `demo-${Date.now()}-${i}`,
            instId: pos.instId,
            side: pos.action,
            type: pos.type,
            strike: pos.strike,
            sz: String(Math.max(1, Math.round(pos.amount))),
            px: pos.rawPrice.toFixed(4),
            ordId: `demo-ord-${Date.now()}-${i}`,
            fillStatus: 'live' as const,
            submittedAt: new Date().toISOString(),
          })),
          overallStatus: 'pending' as const,
        };
        setDemoExecutions((prev) => [exec, ...prev]);
        setOrderStatus('success');
        safeTimeout(() => setOrderStatus('idle'), 3000);
      }, 600);
    } else if (useWebSocket) {
      setOrderStatus('sending');
      triggerExecution().catch((e) => {
        setOrderStatus('error');
        setOrderMessage(e.message);
        safeTimeout(() => setOrderStatus('idle'), 5000);
      });
    } else if (activeCreds && selectedExchange === 'okx') {
      executeArb(bestArbResult, activeCreds as OkxCredentials);
    }
  };

  const hasActiveCreds = selectedExchange === 'okx' ? okxCreds : deribitCreds;

  return (
    <div className={`p-6 rounded-xl border ${bestArbResult.feasible ? 'bg-blue-50 border-blue-200' : 'bg-white border-slate-200 shadow-sm'}`}>
      <div className="flex items-start gap-4">
        {bestArbResult.feasible ? (
          <div className="p-2 bg-blue-100 rounded-full text-blue-600">
            <CheckCircle2 className="w-6 h-6" />
          </div>
        ) : (
          <div className="p-2 bg-slate-100 rounded-full text-slate-400">
            <AlertTriangle className="w-6 h-6" />
          </div>
        )}
        <div>
          <h2 className={`text-lg font-semibold ${bestArbResult.feasible ? 'text-blue-800' : 'text-slate-700'}`}>
            {bestArbResult.feasible ? t.arbDetected : t.noArb}
            {bestArbResult.feasible && bestArbExpiry && (
              <span className="ml-2 text-xs bg-blue-200 text-blue-800 px-2 py-0.5 rounded-full font-mono">
                {bestArbExpiry}
              </span>
            )}
          </h2>
          {bestArbResult.feasible ? (
            <div className="mt-2 space-y-2">
              <p className="text-blue-700">
                {t.guaranteedProfit} <span className="font-bold">${bestArbResult.profit.toFixed(2)}</span> {t.perUnit}
              </p>
              <div className="mt-4 bg-white/60 rounded-lg p-4 text-sm font-mono text-blue-900">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-semibold">{t.optimalPortfolio}</p>
                  {budgetBtc > 0 && (
                    <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium font-sans">
                      {t.sizeByDepth}
                    </span>
                  )}
                </div>
                <ul className="space-y-2">
                  {bestArbResult.portfolio.map((pos, i) => (
                    <li key={i} className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-block w-10 text-center px-1.5 py-0.5 rounded text-xs font-bold ${
                        pos.action === 'buy' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                      }`}>
                        {pos.action === 'buy' ? t.buy : t.sell}
                      </span>
                      <span className="font-bold">{pos.amount.toFixed(2)}x</span>
                      <span>{pos.type === 'C' ? t.callAt : t.putAt} {pos.strike}</span>
                      <span className="text-blue-600">(${pos.price.toFixed(1)})</span>
                      {pos.maxDepth > 0 && (
                        <span className="text-xs text-slate-400 font-sans">
                          {t.depth}: {pos.maxDepth}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Execute Button */}
              <div className="mt-4 pt-4 border-t border-blue-200">
                <div className="flex items-center gap-3 flex-wrap">
                  {(okxCreds?.simulated || deribitCreds?.testnet) && (
                    <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">
                      {selectedExchange === 'okx' ? t.paperTrading : t.testnet}
                    </span>
                  )}

                  <button
                    disabled={(!hasActiveCreds && !isDemoMode) || orderStatus === 'sending'}
                    onClick={handleExecuteClick}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                      (!hasActiveCreds && !isDemoMode)
                        ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                        : orderStatus === 'sending'
                        ? 'bg-indigo-400 text-white animate-pulse'
                        : orderStatus === 'success'
                        ? 'bg-emerald-500 text-white'
                        : orderStatus === 'error'
                        ? 'bg-rose-500 text-white'
                        : 'bg-indigo-600 text-white hover:bg-indigo-700'
                    }`}
                  >
                    <Zap className="w-4 h-4" />
                    {orderStatus === 'sending' ? (
                      <><RefreshCw className="w-4 h-4 animate-spin" /> {t.placingOrders}</>
                    ) : (!hasActiveCreds && !isDemoMode) ? t.setApiKey : t.executeArbitrage}
                  </button>

                  {orderMessage && (
                    <span className={`text-xs font-medium font-mono ${
                      orderStatus === 'success' ? 'text-emerald-700' : 'text-rose-600'
                    }`}>
                      {orderMessage}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-slate-500 mt-1">{t.noArbDesc}</p>
          )}
        </div>
      </div>
    </div>
  );
}
