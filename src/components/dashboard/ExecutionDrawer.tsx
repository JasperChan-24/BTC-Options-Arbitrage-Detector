import React from 'react';
import { Activity, X, AlertTriangle, Bot, Wifi, WifiOff } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import ApiKeyPanel from '../ApiKeyPanel';
import OrderPanel from '../OrderPanel';
import type { Language } from '../../i18n';
import type { OkxCredentials, DeribitCredentials } from '../../types';

interface ExecutionDrawerProps {
  t: Record<string, string>;
  lang: Language;
}

export default function ExecutionDrawer({ t, lang }: ExecutionDrawerProps) {
  const {
    isExecutionDrawerOpen, setIsExecutionDrawerOpen,
    selectedExchange,
    isDemoMode, setIsDemoMode,
    autoExecute, setAutoExecute,
    includeFee, setIncludeFee,
    useWebSocket, setUseWebSocket,
    filterEnabled, setFilterEnabled,
    minVolume, setMinVolume,
    maxSpreadPct, setMaxSpreadPct,
    accountBalance, balanceLoading,
    executions, demoExecutions,
    setExecutions, setDemoExecutions,
    setOkxCreds, setDeribitCreds,
    setSelectedPrices, setAppliedModifications,
    wsStatus,
  } = useAppStore();
  const riskPct = useAppStore((s) => s.riskPct());
  const setRiskPct = selectedExchange === 'okx'
    ? useAppStore.getState().setOkxRiskPct
    : useAppStore.getState().setDeribitRiskPct;

  // Server executions come from SSE hook — passed via combined list
  const serverExecutions = useAppStore((s) => s.executions);

  const toggleDemoMode = () => {
    const enteringDemo = !isDemoMode;
    setIsDemoMode(enteringDemo);
    if (!enteringDemo) {
      setSelectedPrices([]);
      setAppliedModifications({});
    }
  };

  return (
    <>
      {/* Overlay */}
      {isExecutionDrawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-sm transition-opacity"
          onClick={() => setIsExecutionDrawerOpen(false)}
        />
      )}

      {/* Drawer Panel */}
      <div
        className={`fixed right-0 top-0 bottom-0 w-full sm:w-[500px] bg-slate-50 shadow-2xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${
          isExecutionDrawerOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between p-4 bg-white border-b border-slate-200">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <Activity className="w-5 h-5 text-indigo-600" />
            {lang === 'en' ? 'Execution Center' : '执行中心'}
          </h2>
          <button
            onClick={() => setIsExecutionDrawerOpen(false)}
            className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Settings Section */}
          <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 space-y-4">
            <h3 className="text-sm font-semibold text-slate-700 pb-2 border-b border-slate-100">
              {lang === 'en' ? 'Trading Configuration' : '交易配置'}
            </h3>

            <ApiKeyPanel
              exchange={selectedExchange}
              onCredentialsChange={(creds) => {
                if (selectedExchange === 'okx') {
                  setOkxCreds(creds as OkxCredentials | null);
                } else {
                  setDeribitCreds(creds as DeribitCredentials | null);
                }
              }}
              lang={lang}
            />

            <div className="pt-2 grid grid-cols-2 gap-3">
              <button
                onClick={toggleDemoMode}
                className={`flex flex-col items-start p-3 rounded-lg text-xs font-medium border transition-all ${
                  isDemoMode
                    ? 'bg-amber-50 text-amber-700 border-amber-200 shadow-sm ring-1 ring-amber-500/20'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <AlertTriangle className={`w-4 h-4 ${isDemoMode ? 'text-amber-500' : 'text-slate-400'}`} />
                  {t.demoMode}
                </div>
                <div className={`text-[10px] ${isDemoMode ? 'text-amber-600/70' : 'text-slate-400'}`}>
                  {lang === 'en' ? 'Mock execution' : '模拟订单执行'}
                </div>
              </button>

              <button
                onClick={() => setAutoExecute(!autoExecute)}
                title={t.autoExecuteDesc}
                className={`flex flex-col items-start p-3 rounded-lg text-xs font-medium border transition-all ${
                  autoExecute
                    ? 'bg-indigo-50 text-indigo-700 border-indigo-200 shadow-sm ring-1 ring-indigo-500/20'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <Bot className={`w-4 h-4 ${autoExecute ? 'text-indigo-600 animate-pulse' : 'text-slate-400'}`} />
                  {t.autoExecute}
                </div>
                <div className={`text-[10px] ${autoExecute ? 'text-indigo-600/70' : 'text-slate-400'}`}>
                  {lang === 'en' ? 'Autonomous bot' : '全自动机器人'}
                </div>
              </button>

              <button
                onClick={() => setIncludeFee(!includeFee)}
                className={`flex flex-col items-start p-3 rounded-lg text-xs font-medium border transition-all ${
                  includeFee
                    ? 'bg-blue-50 text-blue-700 border-blue-200 shadow-sm ring-1 ring-blue-500/20'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className={`text-sm font-bold leading-none ${includeFee ? 'text-blue-500' : 'text-slate-400'}`}>%</span>
                  {t.includeFee}
                </div>
                <div className={`text-[10px] ${includeFee ? 'text-blue-600/70' : 'text-slate-400'}`}>
                  {lang === 'en' ? 'Deduct 0.03%' : '扣除0.03%费率'}
                </div>
              </button>

              <button
                onClick={() => setUseWebSocket(!useWebSocket)}
                title={t.wsToggleDesc}
                className={`flex flex-col items-start p-3 rounded-lg text-xs font-medium border transition-all ${
                  useWebSocket
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 shadow-sm ring-1 ring-emerald-500/20'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  {useWebSocket ? <Wifi className="w-4 h-4 text-emerald-500" /> : <WifiOff className="w-4 h-4 text-slate-400" />}
                  {t.wsToggle}
                </div>
                <div className={`text-[10px] ${useWebSocket ? 'text-emerald-600/70' : 'text-slate-400'}`}>
                  {useWebSocket && wsStatus === 'connected' ? (lang === 'en' ? 'Live connected' : '已连接后端') : (lang === 'en' ? 'SSE Streaming' : 'SSE 推送流')}
                </div>
              </button>
            </div>
          </div>

          {/* Market Data Filters */}
          <div className={`bg-white p-3 rounded-xl shadow-sm border transition-all ${filterEnabled ? 'border-slate-200' : 'border-dashed border-slate-300 opacity-60'}`}>
            <h3 className="text-xs font-semibold text-slate-700 pb-2 border-b border-slate-100 flex items-center justify-between mb-2">
              <span>{lang === 'en' ? 'Data Filters' : '数据过滤'}</span>
              <button
                onClick={() => setFilterEnabled(!filterEnabled)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  filterEnabled ? 'bg-indigo-600' : 'bg-slate-300'
                }`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                  filterEnabled ? 'translate-x-4' : 'translate-x-0.5'
                }`} />
              </button>
            </h3>
            <div className={`flex gap-2 transition-opacity ${filterEnabled ? '' : 'pointer-events-none'}`}>
              <div className="flex-1">
                <label className="block text-[10px] font-medium text-slate-500 mb-1">{t.minVolume}</label>
                <input
                  type="number"
                  className="w-full rounded-md border-slate-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-xs p-1.5 border"
                  value={minVolume}
                  onChange={(e) => setMinVolume(Number(e.target.value))}
                />
              </div>
              <div className="flex-1">
                <label className="block text-[10px] font-medium text-slate-500 mb-1">{t.maxSpread}</label>
                <input
                  type="number"
                  className="w-full rounded-md border-slate-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-xs p-1.5 border"
                  value={maxSpreadPct}
                  onChange={(e) => setMaxSpreadPct(Number(e.target.value))}
                />
              </div>
            </div>
          </div>

          {/* Risk Allocation */}
          <div className="bg-white p-3 rounded-xl shadow-sm border border-slate-200">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-xs font-semibold text-slate-700">{t.riskAllocation}</h3>
              <span className="font-mono text-xs font-semibold text-slate-800">
                {balanceLoading ? '...' : accountBalance ? `${accountBalance.availBal.toFixed(4)} BTC` : '0 BTC'}
              </span>
            </div>
            <input
              type="range"
              min={0} max={100} step={1}
              value={riskPct}
              onChange={(e) => setRiskPct(Number(e.target.value))}
              className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-slate-200 accent-indigo-600 mb-1"
            />
            <div className="flex justify-between text-[10px] text-slate-400 font-mono">
              <span>0%</span>
              <span className="text-indigo-600 font-bold">{riskPct}%</span>
              <span>100%</span>
            </div>
          </div>

          {/* Order Tracking */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden min-h-[400px]">
            <OrderPanel
              executions={[...demoExecutions, ...(useWebSocket ? serverExecutions : executions)]}
              lang={lang}
              onUpdate={(newExecs) => {
                setExecutions(newExecs.filter((e) => !e.execId.startsWith('demo-')));
                setDemoExecutions(newExecs.filter((e) => e.execId.startsWith('demo-')));
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}
