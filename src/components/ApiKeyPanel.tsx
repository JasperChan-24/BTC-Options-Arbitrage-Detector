import React, { useState, useEffect } from 'react';
import { KeyRound, Eye, EyeOff, Trash2, CheckCircle2, Wifi } from 'lucide-react';
import { OkxCredentials, DeribitCredentials, Exchange } from '../types';
import { saveCredentials as saveOkxCreds, clearCredentials as clearOkxCreds } from '../services/okxTradingService';
import { saveCredentials as saveDeribitCreds, clearCredentials as clearDeribitCreds } from '../services/deribitTradingService';
import { setBackendCredentials, clearBackendCredentials, getCredentialsStatus, testBackendConnection } from '../services/backendApi';
import { translations, Language } from '../i18n';

interface Props {
  exchange: Exchange;
  onCredentialsChange: (creds: OkxCredentials | DeribitCredentials | null) => void;
  lang: Language;
}

export default function ApiKeyPanel({ exchange, onCredentialsChange, lang }: Props) {
  const t = translations[lang];
  const [isOpen, setIsOpen] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  // OKX state
  const [okxCreds, setOkxCreds] = useState<OkxCredentials>({ apiKey: '', secretKey: '', passphrase: '', simulated: true });
  // Deribit state
  const [deribitCreds, setDeribitCreds] = useState<DeribitCredentials>({ clientId: '', clientSecret: '', testnet: true });

  const [saved, setSaved] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => {
    getCredentialsStatus().then(status => {
      if (exchange === 'okx' && status.okx?.hasCredentials) {
        setHasSaved(true);
        setOkxCreds({ apiKey: '***', secretKey: '***', passphrase: '***', simulated: status.okx.simulated ?? true });
        onCredentialsChange({ apiKey: '***', secretKey: '***', passphrase: '***', simulated: status.okx.simulated ?? true });
      } else if (exchange === 'deribit' && status.deribit?.hasCredentials) {
        setHasSaved(true);
        setDeribitCreds({ clientId: '***', clientSecret: '***', testnet: status.deribit.testnet ?? true });
        onCredentialsChange({ clientId: '***', clientSecret: '***', testnet: status.deribit.testnet ?? true });
      } else if (status.hasCredentials && exchange === 'okx') {
        // Legacy fallback
        setHasSaved(true);
        setOkxCreds({ apiKey: '***', secretKey: '***', passphrase: '***', simulated: status.simulated ?? true });
        onCredentialsChange({ apiKey: '***', secretKey: '***', passphrase: '***', simulated: status.simulated ?? true });
      } else {
        setHasSaved(false);
      }
    }).catch(console.error);
  }, [exchange]);

  const isOkx = exchange === 'okx';

  const canSave = isOkx
    ? !!(okxCreds.apiKey && okxCreds.secretKey && okxCreds.passphrase)
    : !!(deribitCreds.clientId && deribitCreds.clientSecret);

  const handleSave = async () => {
    if (!canSave) return;

    if (isOkx) {
      saveOkxCreds(okxCreds);
      await setBackendCredentials({ exchange: 'okx', ...okxCreds });
      onCredentialsChange(okxCreds);
    } else {
      saveDeribitCreds(deribitCreds);
      await setBackendCredentials({ exchange: 'deribit', ...deribitCreds });
      onCredentialsChange(deribitCreds);
    }

    setHasSaved(true);
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
      setIsOpen(false);
    }, 1500);
  };

  const handleTest = async () => {
    if (!canSave) return;

    // If credentials are loaded from backend (masked), just confirm
    if ((isOkx && okxCreds.apiKey === '***') || (!isOkx && deribitCreds.clientId === '***')) {
      setTestStatus('ok');
      setTestMsg(lang === 'en' ? 'Server credentials active' : '服务器凭证有效');
      setTimeout(() => setTestStatus('idle'), 6000);
      return;
    }

    setTestStatus('testing');
    setTestMsg('');

    const payload = isOkx
      ? { exchange: 'okx', ...okxCreds }
      : { exchange: 'deribit', ...deribitCreds };

    const result = await testBackendConnection(payload);
    if (result.ok) {
      setTestStatus('ok');
      setTestMsg(t.connectionSuccess);
    } else {
      setTestStatus('fail');
      setTestMsg(result.error ?? 'Failed');
    }
    setTimeout(() => setTestStatus('idle'), 6000);
  };

  const handleClear = async () => {
    if (isOkx) {
      clearOkxCreds();
      setOkxCreds({ apiKey: '', secretKey: '', passphrase: '', simulated: true });
    } else {
      clearDeribitCreds();
      setDeribitCreds({ clientId: '', clientSecret: '', testnet: true });
    }
    await clearBackendCredentials(exchange);
    setHasSaved(false);
    onCredentialsChange(null);
  };

  const panelTitle = isOkx ? t.apiPanelTitle : t.deribitApiTitle;
  const buttonLabel = hasSaved ? `${isOkx ? 'OKX' : 'Deribit'} API ✓` : `${isOkx ? 'OKX' : 'Deribit'} API Key`;

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
          hasSaved
            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
            : 'bg-slate-50 text-slate-600 border border-slate-300 hover:bg-slate-100'
        }`}
      >
        <KeyRound className="w-4 h-4" />
        {buttonLabel}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-11 z-50 w-80 bg-white rounded-xl shadow-xl border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-indigo-500" />
              {panelTitle}
            </h3>
            {hasSaved && (
              <button onClick={handleClear} className="text-rose-400 hover:text-rose-600 transition-colors" title="Clear saved credentials">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>

          <p className="text-xs text-slate-400 mb-3">{t.apiPanelNote}</p>

          <div className="space-y-2">
            {isOkx ? (
              <>
                {/* OKX: API Key, Secret Key, Passphrase */}
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">{t.apiKey}</label>
                  <input
                    type="text"
                    className={`w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 ${hasSaved ? 'bg-slate-50 text-slate-400' : ''}`}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    value={okxCreds.apiKey === '***' ? '••••••••••••••••••••••••' : okxCreds.apiKey}
                    onChange={e => setOkxCreds(prev => ({ ...prev, apiKey: e.target.value }))}
                    disabled={hasSaved}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">{t.secretKey}</label>
                  <div className="relative">
                    <input
                      type={showSecret ? 'text' : 'password'}
                      className={`w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 pr-8 ${hasSaved ? 'bg-slate-50 text-slate-400' : ''}`}
                      placeholder="32-character hex string"
                      value={okxCreds.secretKey === '***' ? '••••••••••••••••••••••••' : okxCreds.secretKey}
                      onChange={e => setOkxCreds(prev => ({ ...prev, secretKey: e.target.value }))}
                      disabled={hasSaved}
                    />
                    <button
                      onClick={() => setShowSecret(!showSecret)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      disabled={hasSaved}
                    >
                      {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">{t.passphrase}</label>
                  <input
                    type="password"
                    className={`w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 ${hasSaved ? 'bg-slate-50 text-slate-400' : ''}`}
                    placeholder="Your API passphrase"
                    value={okxCreds.passphrase === '***' ? '••••••••••••••••' : okxCreds.passphrase}
                    onChange={e => setOkxCreds(prev => ({ ...prev, passphrase: e.target.value }))}
                    disabled={hasSaved}
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={okxCreds.simulated}
                    onChange={e => setOkxCreds(prev => ({ ...prev, simulated: e.target.checked }))}
                    className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600"
                  />
                  <span className="text-xs text-slate-600">{t.paperTrading}</span>
                </label>
              </>
            ) : (
              <>
                {/* Deribit: Client ID, Client Secret */}
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">{t.clientId}</label>
                  <input
                    type="text"
                    className={`w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 ${hasSaved ? 'bg-slate-50 text-slate-400' : ''}`}
                    placeholder="Your Deribit Client ID"
                    value={deribitCreds.clientId === '***' ? '••••••••••••••••••••••••' : deribitCreds.clientId}
                    onChange={e => setDeribitCreds(prev => ({ ...prev, clientId: e.target.value }))}
                    disabled={hasSaved}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">{t.clientSecret}</label>
                  <div className="relative">
                    <input
                      type={showSecret ? 'text' : 'password'}
                      className={`w-full rounded-md border border-slate-300 px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 pr-8 ${hasSaved ? 'bg-slate-50 text-slate-400' : ''}`}
                      placeholder="Your Deribit Client Secret"
                      value={deribitCreds.clientSecret === '***' ? '••••••••••••••••••••••••' : deribitCreds.clientSecret}
                      onChange={e => setDeribitCreds(prev => ({ ...prev, clientSecret: e.target.value }))}
                      disabled={hasSaved}
                    />
                    <button
                      onClick={() => setShowSecret(!showSecret)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                      disabled={hasSaved}
                    >
                      {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={deribitCreds.testnet}
                    onChange={e => setDeribitCreds(prev => ({ ...prev, testnet: e.target.checked }))}
                    className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600"
                  />
                  <span className="text-xs text-slate-600">{t.testnet}</span>
                </label>
              </>
            )}

            {hasSaved && (
              <div className="text-xs text-emerald-600 bg-emerald-50 px-2 py-1.5 rounded border border-emerald-100 flex items-center justify-center">
                {lang === 'en' ? 'Credentials securely loaded from server' : '凭证已安全地从服务器加载'}
              </div>
            )}
          </div>

          <button
            onClick={handleSave}
            disabled={!canSave}
            className={`mt-3 w-full flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium transition-all ${
              saved
                ? 'bg-emerald-500 text-white'
                : 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
          >
            {saved ? <><CheckCircle2 className="w-4 h-4" /> {t.saved}</> : t.saveCredentials}
          </button>

          <button
            onClick={handleTest}
            disabled={!canSave || testStatus === 'testing'}
            className={`mt-2 w-full flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium border transition-all ${
              testStatus === 'ok'
                ? 'border-emerald-400 bg-emerald-50 text-emerald-700'
                : testStatus === 'fail'
                ? 'border-rose-400 bg-rose-50 text-rose-700'
                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed'
            }`}
          >
            <Wifi className={`w-4 h-4 ${testStatus === 'testing' ? 'animate-pulse' : ''}`} />
            {testStatus === 'testing' ? t.testing
              : testStatus === 'ok' ? t.connected
              : testStatus === 'fail' ? t.authFailed
              : t.testConnection}
          </button>

          {testMsg && (
            <p className={`mt-2 text-xs text-center font-mono break-all ${
              testStatus === 'ok' ? 'text-emerald-600' : 'text-rose-600'
            }`}>
              {testMsg}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
