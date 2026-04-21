import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

interface DemoModePanelProps {
  t: Record<string, string>;
}

export default function DemoModePanel({ t }: DemoModePanelProps) {
  const isDemoMode = useAppStore((s) => s.isDemoMode);
  const selectedPrices = useAppStore((s) => s.selectedPrices);
  const appliedModifications = useAppStore((s) => s.appliedModifications);
  const { setSelectedPrices, setAppliedModifications } = useAppStore();

  if (!isDemoMode) return null;

  const applyModification = (multiplier: number) => {
    setAppliedModifications((prev) => {
      const next = { ...prev };
      selectedPrices.forEach((key) => {
        next[key] = multiplier;
      });
      return next;
    });
    setSelectedPrices([]);
  };

  const clearDiscounts = () => {
    setAppliedModifications({});
    setSelectedPrices([]);
  };

  return (
    <div className="bg-amber-50 p-4 rounded-xl shadow-sm border border-amber-200 flex flex-wrap gap-4 items-center">
      <div className="text-amber-800 font-medium flex items-center gap-2 text-sm">
        <AlertTriangle className="w-5 h-5" />
        {t.demoModeDesc}
      </div>
      <div className="ml-auto flex gap-3">
        <button
          onClick={clearDiscounts}
          disabled={Object.keys(appliedModifications).length === 0 && selectedPrices.length === 0}
          className="px-4 py-2 bg-white text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors font-medium text-sm disabled:opacity-50"
        >
          {t.clearDiscounts}
        </button>
        <button
          onClick={() => applyModification(0.7)}
          disabled={selectedPrices.length === 0}
          className="px-4 py-2 bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors font-medium text-sm disabled:opacity-50"
        >
          {t.applyDiscount} ({selectedPrices.length})
        </button>
        <button
          onClick={() => applyModification(1.3)}
          disabled={selectedPrices.length === 0}
          className="px-4 py-2 bg-rose-500 text-white rounded-lg hover:bg-rose-600 transition-colors font-medium text-sm disabled:opacity-50"
        >
          {t.applyPremium} ({selectedPrices.length})
        </button>
      </div>
    </div>
  );
}
