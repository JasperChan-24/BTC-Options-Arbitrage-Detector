/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import Dashboard from './components/Dashboard';
import { translations, Language } from './i18n';
import { Languages } from 'lucide-react';

export default function App() {
  const [lang, setLang] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem('btc-arb-lang');
      return (saved === 'zh' ? 'zh' : 'en') as Language;
    } catch { return 'en'; }
  });
  const t = translations[lang];

  const toggleLang = () => {
    setLang(prev => {
      const next = prev === 'en' ? 'zh' : 'en';
      try { localStorage.setItem('btc-arb-lang', next); } catch {}
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800 tracking-tight">
            {t.title}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {t.subtitle}
          </p>
        </div>
        <button
          onClick={toggleLang}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 transition-colors shadow-sm bg-white"
        >
          <Languages className="w-4 h-4 text-indigo-500" />
          <span className="text-sm font-medium">{lang === 'en' ? 'EN' : '中文'}</span>
        </button>
      </header>
      <main className="p-6 max-w-[1600px] mx-auto">
        <Dashboard lang={lang} onLanguageChange={toggleLang} />
      </main>
    </div>
  );
}
