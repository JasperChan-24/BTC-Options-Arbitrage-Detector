import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  ClipboardList, ChevronDown, ChevronUp,
  CheckCircle2, Clock, XCircle, AlertTriangle, RefreshCw, Search, Star, Loader2
} from 'lucide-react';
import { ArbitrageExecution, MarketId, SubmittedOrder } from '../types';
import { translations, Language } from '../i18n';
import { getExecutions, getExecutionDates, deleteExecution } from '../services/backendApi';

interface Props {
  /** Real-time executions pushed via SSE (latest ~30) */
  executions: ArbitrageExecution[];
  lang: Language;
  onUpdate: (updated: ArbitrageExecution[]) => void;
}

const PAGE_SIZE = 30;

const FILL_COLORS: Record<SubmittedOrder['fillStatus'], string> = {
  pending:           'bg-slate-100 text-slate-500',
  live:              'bg-blue-100 text-blue-700',
  filled:            'bg-emerald-100 text-emerald-700',
  partially_filled:  'bg-amber-100 text-amber-700',
  cancelled:         'bg-slate-200 text-slate-500',
  failed:            'bg-rose-100 text-rose-600',
};
const FILL_ICONS: Record<SubmittedOrder['fillStatus'], React.ReactNode> = {
  pending:          <Clock className="w-3 h-3" />,
  live:             <RefreshCw className="w-3 h-3 animate-spin" />,
  filled:           <CheckCircle2 className="w-3 h-3" />,
  partially_filled: <AlertTriangle className="w-3 h-3" />,
  cancelled:        <XCircle className="w-3 h-3" />,
  failed:           <XCircle className="w-3 h-3" />,
};

function FillBadge({ status }: { status: SubmittedOrder['fillStatus'] }) {
  const s = status ?? 'pending';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${FILL_COLORS[s] ?? FILL_COLORS.pending}`}>
      {FILL_ICONS[s] ?? FILL_ICONS.pending}
      {s.replace('_', ' ')}
    </span>
  );
}

// Market badge: shows exchange name + environment color
function MarketBadge({ exec }: { exec: ArbitrageExecution }) {
  const market = exec.market as MarketId | undefined;
  const badgeMap: Record<string, { label: string; bg: string }> = {
    okx:          { label: 'OKX',     bg: 'bg-slate-800' },
    okx_paper:    { label: 'OKX-P',   bg: 'bg-amber-600' },
    deribit:      { label: 'DRB',     bg: 'bg-blue-600' },
    deribit_test: { label: 'DRB-T',   bg: 'bg-blue-400' },
  };
  const fallback = (exec.exchange ?? 'okx') === 'deribit'
    ? { label: 'DRB', bg: 'bg-blue-500' }
    : { label: 'OKX', bg: 'bg-slate-800' };
  const { label, bg } = market ? (badgeMap[market] ?? fallback) : fallback;
  const isReal = market === 'okx' || market === 'deribit';
  return (
    <span className={`inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded text-white tracking-wider leading-none ${bg}`}>
      {isReal && '🟢'}{!isReal && market && '🟡'}{label}
    </span>
  );
}

// Status badge with i18n
function StatusBadge({ status, lang = 'en' }: { status: ArbitrageExecution['overallStatus']; lang?: string }) {
  const map: Record<string, string> = {
    pending:  'bg-blue-100 text-blue-700',
    partial:  'bg-amber-100 text-amber-700',
    complete: 'bg-emerald-100 text-emerald-700',
    failed:   'bg-rose-100 text-rose-600',
    detected: 'bg-violet-100 text-violet-700',
  };
  const labels: Record<string, Record<string, string>> = {
    en: { pending: 'pending', partial: 'partial', complete: 'complete', failed: 'failed', detected: 'detected' },
    zh: { pending: '待处理', partial: '部分成交', complete: '已完成', failed: '失败', detected: '已检测' },
  };
  const label = (labels[lang] ?? labels.en)[status] ?? status;
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold whitespace-nowrap ${map[status] ?? map.pending}`}>
      {label}
    </span>
  );
}

export default function OrderPanel({ executions: sseExecutions, lang, onUpdate }: Props) {
  const t = translations[lang];
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filterDate, setFilterDate] = useState('');
  const [filterEnv, setFilterEnv] = useState<'' | 'real' | 'testnet'>('');
  const [showFavOnly, setShowFavOnly] = useState(false);
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  // Favorites persisted in localStorage
  const FAV_KEY = 'btc-arb-favorites';
  const loadFavs = (): Set<string> => {
    try {
      const raw = localStorage.getItem(FAV_KEY);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  };
  const [favorites, setFavorites] = useState<Set<string>>(loadFavs);

  const toggleFav = (id: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ─── Available dates from API ────────────────────────────────────────
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  useEffect(() => {
    getExecutionDates().then(r => setAvailableDates(r.dates ?? [])).catch(console.error);
    // Refresh dates periodically
    const iv = setInterval(() => {
      getExecutionDates().then(r => setAvailableDates(r.dates ?? [])).catch(console.error);
    }, 60_000);
    return () => clearInterval(iv);
  }, []);

  // ─── Paginated API data ──────────────────────────────────────────────
  const [apiItems, setApiItems] = useState<ArbitrageExecution[]>([]);
  const [apiTotal, setApiTotal] = useState(0);
  const [apiHasMore, setApiHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const offsetRef = useRef(0);

  const fetchPage = useCallback(async (date: string, offset: number, append: boolean) => {
    setLoading(true);
    try {
      const res = await getExecutions({ offset, limit: PAGE_SIZE, date: date || undefined });
      if (append) {
        setApiItems(prev => [...prev, ...res.items]);
      } else {
        setApiItems(res.items);
      }
      setApiTotal(res.total);
      setApiHasMore(res.hasMore);
      offsetRef.current = offset + res.items.length;
    } catch (e) {
      console.error('[OrderPanel] fetch error', e);
    } finally {
      setLoading(false);
    }
  }, []);

  // When filterDate changes, fetch first page from API
  useEffect(() => {
    offsetRef.current = 0;
    fetchPage(filterDate, 0, false);
  }, [filterDate, fetchPage]);

  // Merge: if no date filter, prepend real-time SSE items (dedup by execId)
  const displayItems = useMemo(() => {
    if (filterDate) {
      // Date filter active → only API data
      return apiItems;
    }
    // No filter → merge SSE (real-time latest) + API (historical)
    const sseIds = new Set(sseExecutions.map(e => e.execId));
    const deduped = apiItems.filter(e => !sseIds.has(e.execId));
    // SSE items are already newest-first, API items are also newest-first
    const merged = [...sseExecutions, ...deduped];
    // Sort by timestamp desc
    merged.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta);
    });
    return merged;
  }, [sseExecutions, apiItems, filterDate]);

  // Apply environment + favorites filter + remove deleted ids
  const filteredItems = useMemo(() => {
    let items = displayItems.filter(e => !deletedIds.has(e.execId));
    if (filterEnv) items = items.filter(e => (e.environment ?? 'testnet') === filterEnv);
    if (showFavOnly) items = items.filter(e => favorites.has(e.execId));
    return items;
  }, [displayItems, filterEnv, showFavOnly, favorites, deletedIds]);

  const loadMore = () => {
    if (!loading && apiHasMore) {
      fetchPage(filterDate, offsetRef.current, true);
    }
  };

  // Infinite scroll: observe sentinel element
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { threshold: 0.1 }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  });

  const totalLabel = filterDate
    ? `${filteredItems.length}/${apiTotal}`
    : `${filteredItems.length}`;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 space-y-2">
        <div className="flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-indigo-500" />
          <h3 className="text-sm font-semibold text-slate-700">{t.orderPanel}</h3>
          <span className="text-xs text-slate-400">({totalLabel})</span>

          {/* Right: fav + date */}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setShowFavOnly(v => !v)}
              className={`p-1 rounded transition-colors ${showFavOnly ? 'text-amber-500 bg-amber-50' : 'text-slate-300 hover:text-amber-400'}`}
              title={lang === 'en' ? 'Show favorites only' : '仅显示收藏'}
            >
              <Star className={`w-3.5 h-3.5 ${showFavOnly ? 'fill-amber-400' : ''}`} />
            </button>
            <Search className="w-3.5 h-3.5 text-slate-400" />
            <select
              value={filterDate}
              onChange={e => setFilterDate(e.target.value)}
              className="text-xs border border-slate-200 rounded px-2 py-1 bg-white text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            >
              <option value="">{lang === 'en' ? 'All dates' : '全部日期'}</option>
              {availableDates.map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
        </div>
        {/* Environment filter */}
        <div className="flex rounded-md border border-slate-200 overflow-hidden w-fit">
          {([['', lang === 'en' ? 'All' : '全部'], ['real', lang === 'en' ? '🟢 Real' : '🟢 真实'], ['testnet', lang === 'en' ? '🟡 Testnet' : '🟡 测试']] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setFilterEnv(val as '' | 'real' | 'testnet')}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                filterEnv === val
                  ? val === 'real' ? 'bg-emerald-600 text-white'
                    : val === 'testnet' ? 'bg-amber-500 text-white'
                    : 'bg-indigo-600 text-white'
                  : 'bg-white text-slate-500 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {filteredItems.length === 0 && !loading ? (
        <p className="text-sm text-slate-400 text-center py-8">
          {filterDate
            ? (lang === 'en' ? `No records on ${filterDate}` : `${filterDate} 无记录`)
            : t.noOrders}
        </p>
      ) : (
        <div className="divide-y divide-slate-100 max-h-[60vh] overflow-y-auto">
          {filteredItems.map(exec => {
            const isOpen = expanded.has(exec.execId);
            const timeStr = exec.timestamp
              ? new Date(exec.timestamp).toLocaleString(undefined, {
                  month: '2-digit', day: '2-digit',
                  hour: '2-digit', minute: '2-digit', second: '2-digit',
                  hour12: false,
                })
              : '';
            const legCount = (exec.orders ?? []).length;

            return (
              <div
                key={exec.execId}
                className={`relative ${
                  exec.environment === 'real' ? 'border-l-[3px] border-l-emerald-500' :
                  (exec.exchange ?? 'okx') === 'deribit' ? 'border-l-[3px] border-l-blue-500' : 'border-l-[3px] border-l-amber-500'
                }`}
              >
                {/* Execution row — compact 2-line layout */}
                <div className="flex items-start">
                  <button
                    onClick={() => toggle(exec.execId)}
                    className="flex-1 px-4 py-2.5 hover:bg-slate-50 transition-colors text-left min-w-0"
                  >
                    {/* Line 1: Badge + Time */}
                    <div className="flex items-center gap-2">
                      <MarketBadge exec={exec} />
                      <span className="text-xs font-mono text-slate-400">{timeStr}</span>
                    </div>
                    {/* Line 2: Profit + Legs + Status + Chevron */}
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[11px] text-slate-500">{t.expectedProfit}:</span>
                      <span className="text-sm font-semibold text-indigo-600">${exec.expectedProfit?.toFixed(2) ?? '0'}</span>
                      <span className="text-[11px] text-slate-400">{legCount} {lang === 'en' ? 'legs' : '条'}</span>
                      <span className="ml-auto"><StatusBadge status={exec.overallStatus} lang={lang} /></span>
                      <span className="text-slate-400">
                        {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </span>
                    </div>
                  </button>
                  {/* Action buttons: favorite + delete — right column, no overlap */}
                  <div className="flex flex-col items-center pt-2 pr-1.5 gap-0.5 shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleFav(exec.execId); }}
                      className={`p-1 rounded transition-colors ${
                        favorites.has(exec.execId)
                          ? 'text-amber-400'
                          : 'text-slate-300 hover:text-amber-400'
                      }`}
                      title={lang === 'en' ? 'Favorite' : '收藏'}
                    >
                      <Star className={`w-3.5 h-3.5 ${favorites.has(exec.execId) ? 'fill-amber-400' : ''}`} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // Immediately hide from UI
                        setDeletedIds(prev => new Set(prev).add(exec.execId));
                        setApiItems(prev => prev.filter(ex => ex.execId !== exec.execId));
                        onUpdate(sseExecutions.filter(ex => ex.execId !== exec.execId));
                        // Delete from backend (fire-and-forget)
                        deleteExecution(exec.execId).catch(console.error);
                      }}
                      className="p-1 text-slate-300 hover:text-rose-500 hover:bg-rose-50 rounded transition-colors"
                      title={lang === 'en' ? 'Delete' : '删除'}
                    >
                      <XCircle className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Order detail table */}
                {isOpen && (
                  <div className="px-4 pb-4 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-100">
                          <th className="text-left py-1.5 pr-3 font-medium">{t.orderInstrument}</th>
                          <th className="text-left py-1.5 pr-3 font-medium">{t.orderSide}</th>
                          <th className="text-right py-1.5 pr-3 font-medium">{t.orderSize}</th>
                          <th className="text-right py-1.5 pr-3 font-medium">{t.orderPrice}</th>
                          <th className="text-left py-1.5 pr-3 font-medium">{t.fillStatus}</th>
                          <th className="text-left py-1.5 font-medium">{(exec.exchange ?? 'okx') === 'deribit' ? 'Deribit Order ID' : 'OKX Order ID'}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {(exec.orders ?? []).map(order => (
                          <tr key={order.localId} className="font-mono align-top">
                            <td className="py-1.5 pr-3 text-slate-600 whitespace-nowrap">{order.instId}</td>
                            <td className={`py-1.5 pr-3 font-semibold whitespace-nowrap ${order.side === 'buy' ? 'text-emerald-600' : 'text-rose-500'}`}>
                              {order.side?.toUpperCase() ?? '—'}
                            </td>
                            <td className="py-1.5 pr-3 text-right text-slate-700">{order.sz}</td>
                            <td className="py-1.5 pr-3 text-right text-slate-700">${order.px}</td>
                            <td className="py-1.5 pr-3"><FillBadge status={order.fillStatus} /></td>
                            <td className="py-1.5 text-slate-700">
                              {order.ordId ? (
                                <span className="text-slate-400 truncate block max-w-[140px]">{order.ordId}</span>
                              ) : order.fillStatus === 'failed' ? (
                                <span className="text-rose-500 text-[10px] leading-tight block max-w-[200px]">
                                  {order.failureCode && <strong>[{order.failureCode}]</strong>}
                                  {' '}{order.failureMsg || ((exec.exchange ?? 'okx') === 'deribit' ? 'Rejected by Deribit' : 'Rejected by OKX')}
                                </span>
                              ) : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}

          {/* Infinite scroll sentinel */}
          {apiHasMore && (
            <div ref={sentinelRef} className="flex items-center justify-center py-3 text-slate-400 text-xs gap-2">
              {loading ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {lang === 'en' ? 'Loading...' : '加载中...'}</>
              ) : (
                <button onClick={loadMore} className="hover:text-indigo-500 transition-colors">
                  {lang === 'en' ? 'Load more' : '加载更多'}
                </button>
              )}
            </div>
          )}
          {!apiHasMore && filteredItems.length > PAGE_SIZE && (
            <p className="text-center text-xs text-slate-300 py-2">
              {lang === 'en' ? 'All records loaded' : '已加载全部记录'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
