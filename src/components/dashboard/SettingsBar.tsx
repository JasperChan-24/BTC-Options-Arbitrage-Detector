import React from 'react';
import { RefreshCw, Activity, Wifi, WifiOff } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { Language } from '../../i18n';
import type { Exchange, Environment } from '../../types';
import type { BackendWsStatus } from '../../hooks/useBackendSSE';

interface SettingsBarProps {
  lang: Language;
  t: Record<string, string>;
  wsStatus: BackendWsStatus;
  deribitWsStatus: BackendWsStatus;
  isBackendOnline: boolean;
  isDataStale: boolean;
  hasNewData: boolean;
  loading: boolean;
  onRefresh: () => void;
}

export default function SettingsBar({
  lang, t, wsStatus, deribitWsStatus, isBackendOnline, isDataStale,
  hasNewData, loading, onRefresh,
}: SettingsBarProps) {
  const {
    selectedExchange, setSelectedExchange,
    selectedEnvironment, setSelectedEnvironment,
    selectedExpiry, setSelectedExpiry,
    useWebSocket,
    isExecutionDrawerOpen, setIsExecutionDrawerOpen,
    okxCreds, deribitCreds, autoExecute,
    options, executions,
    altArbResult, altArbExchange,
    setOptions,
  } = useAppStore();

  const expiries = [...new Set(options.map((o) => o.expiration))].sort();

  // Import backend API calls inline to avoid circular deps
  const handleEnvironmentChange = async (env: Environment) => {
    if (env === selectedEnvironment) return;
    setSelectedEnvironment(env);
    setOptions([]);
    const { setEnvironment } = await import('../../services/backendApi');
    setEnvironment(env).catch(console.error);
  };

  const handleExchangeChange = async (ex: Exchange) => {
    if (ex === selectedExchange) return;
    setSelectedExchange(ex);
    setOptions([]);
    const { setActiveExchange } = await import('../../services/backendApi');
    setActiveExchange(ex).catch(console.error);
  };

  return (
    <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-wrap gap-6 items-end">
      {/* Environment */}
      <div>
        <label className="block text-xs font-medium text-slate-500 mb-1">
          {lang === 'en' ? 'Environment' : '环境'}
        </label>
        <div className="flex rounded-md border border-slate-300 overflow-hidden">
          {(['real', 'testnet'] as Environment[]).map((env) => (
            <button
              key={env}
              onClick={() => handleEnvironmentChange(env)}
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                selectedEnvironment === env
                  ? env === 'real'
                    ? 'bg-emerald-600 text-white'
                    : 'bg-amber-500 text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {env === 'real'
                ? (lang === 'en' ? '🟢 Real' : '🟢 真实')
                : (lang === 'en' ? '🟡 Testnet' : '🟡 测试')}
            </button>
          ))}
        </div>
      </div>

      {/* Exchange */}
      <div>
        <label className="block text-xs font-medium text-slate-500 mb-1">{t.exchange}</label>
        <div className="flex rounded-md border border-slate-300 overflow-visible">
          {(['deribit', 'okx'] as Exchange[]).map((ex) => (
            <button
              key={ex}
              onClick={() => handleExchangeChange(ex)}
              className={`relative px-4 py-2 text-sm font-medium transition-colors ${
                selectedExchange === ex
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {t[ex]}
              {selectedExchange !== ex && altArbExchange === ex && altArbResult.feasible && (
                <span className="absolute -top-2 -right-2 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-rose-500 text-white text-[10px] font-bold shadow-lg animate-pulse whitespace-nowrap">
                  ${altArbResult.profit.toFixed(1)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Expiry */}
      <div>
        <label className="block text-xs font-medium text-slate-500 mb-1">{t.expirationDate}</label>
        <select
          className="block w-48 rounded-md border-slate-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-2 border"
          value={selectedExpiry}
          onChange={(e) => setSelectedExpiry(e.target.value)}
        >
          {expiries.map((exp) => (
            <option key={exp} value={exp}>{exp}</option>
          ))}
        </select>
      </div>

      {/* Real-market warning */}
      {selectedEnvironment === 'real' && (
        <div className="flex items-center">
          <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-amber-50 border border-amber-200 text-amber-700 text-xs font-medium">
            ⚠️ {lang === 'en' ? 'Detection only — no execution' : '仅检测 — 不执行交易'}
          </span>
        </div>
      )}

      {/* Right-side buttons */}
      <div className="flex items-center gap-4 ml-auto">
        <button
          onClick={(e) => {
            const btn = e.currentTarget;
            btn.classList.add('animate-pulse');
            setTimeout(() => btn.classList.remove('animate-pulse'), 300);
            onRefresh();
          }}
          disabled={loading}
          className="relative flex items-center gap-2 bg-indigo-50 text-indigo-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-indigo-100 transition-colors disabled:opacity-50"
        >
          {hasNewData && (
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-emerald-500 rounded-full animate-pulse" title="新数据可用" />
          )}
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : 'group-active:animate-spin'}`} />
          {t.refresh}
        </button>

        <button
          onClick={() => setIsExecutionDrawerOpen(true)}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border transition-all ${
            autoExecute && (selectedExchange === 'okx' ? okxCreds : deribitCreds)
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 shadow-sm'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
          }`}
        >
          <Activity className={`w-4 h-4 ${autoExecute && (selectedExchange === 'okx' ? okxCreds : deribitCreds) ? 'text-emerald-500 animate-pulse' : 'text-slate-500'}`} />
          {lang === 'en' ? 'Execution Center' : '执行中心'}
          {executions.length > 0 && (
            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-slate-100 text-xs text-slate-600 font-bold">
              {executions.length}
            </span>
          )}
        </button>

        {useWebSocket && (() => {
          const activeWsStatus = selectedExchange === 'okx' ? wsStatus : deribitWsStatus;
          return (
            <div className="flex items-center gap-2 text-xs">
              <div className={`w-2 h-2 rounded-full ${
                isDataStale ? 'bg-amber-500 animate-pulse'
                  : activeWsStatus === 'connected' ? 'bg-emerald-500 animate-pulse'
                  : activeWsStatus === 'connecting' ? 'bg-amber-400 animate-pulse'
                  : 'bg-red-400'
              }`} />
              <span className={`font-medium ${
                isDataStale ? 'text-amber-600'
                  : activeWsStatus === 'connected' ? 'text-emerald-600'
                  : activeWsStatus === 'connecting' ? 'text-amber-600'
                  : 'text-red-500'
              }`}>
                {isDataStale ? (lang === 'en' ? '⚠ Stale Data' : '⚠ 数据过时')
                  : activeWsStatus === 'connected' ? t.liveStreaming
                  : activeWsStatus === 'connecting' ? t.wsConnecting
                  : t.wsDisconnected}
              </span>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
