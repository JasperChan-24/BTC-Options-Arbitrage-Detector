/**
 * Backend API client — wraps all REST calls from frontend to backend.
 */

const API_BASE = '/api';

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

// ─── Credentials ─────────────────────────────────────────────────────────

export async function setBackendCredentials(creds: {
  exchange?: string;
  apiKey?: string;
  secretKey?: string;
  passphrase?: string;
  simulated?: boolean;
  clientId?: string;
  clientSecret?: string;
  testnet?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await api('/credentials', { method: 'POST', body: JSON.stringify(creds) });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function clearBackendCredentials(exchange?: string): Promise<void> {
  const qs = exchange ? `?exchange=${exchange}` : '';
  await api(`/credentials${qs}`, { method: 'DELETE' });
}

export async function getCredentialsStatus(): Promise<{
  hasCredentials: boolean;
  simulated: boolean | null;
  okx?: { hasCredentials: boolean; simulated: boolean | null };
  deribit?: { hasCredentials: boolean; testnet: boolean | null };
  activeExchange?: string;
}> {
  return api('/credentials/status');
}

export async function testBackendConnection(creds: {
  exchange?: string;
  apiKey?: string;
  secretKey?: string;
  passphrase?: string;
  simulated?: boolean;
  clientId?: string;
  clientSecret?: string;
  testnet?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  return api('/test-connection', { method: 'POST', body: JSON.stringify(creds) });
}

// ─── Balance ─────────────────────────────────────────────────────────────

export async function fetchBackendBalance(exchange?: string): Promise<{
  totalEq: number;
  availBal: number;
  availUsd: number;
} | null> {
  try {
    const qs = exchange ? `?exchange=${exchange}` : '';
    return await api(`/balance${qs}`);
  } catch {
    return null;
  }
}

// ─── Execution ───────────────────────────────────────────────────────────

export async function triggerExecution(): Promise<any> {
  return api('/execute', { method: 'POST' });
}

// ─── Config ──────────────────────────────────────────────────────────────

export async function getBackendConfig(): Promise<any> {
  return api('/config');
}

export async function updateBackendConfig(config: Record<string, any>): Promise<any> {
  return api('/config', { method: 'POST', body: JSON.stringify(config) });
}

export async function setActiveExchange(exchange: string): Promise<void> {
  await api('/exchange', { method: 'POST', body: JSON.stringify({ exchange }) });
}

// ─── Environment ─────────────────────────────────────────────────────────

export async function setEnvironment(environment: string): Promise<any> {
  return api('/environment', { method: 'POST', body: JSON.stringify({ environment }) });
}

export async function getEnvironment(): Promise<{ environment: string }> {
  return api('/environment');
}

// ─── Status ──────────────────────────────────────────────────────────────

export async function getBackendStatus(): Promise<{
  wsStatus: string;
  tickerCount: number;
  lastDataTime: number;
  spotPrice: number;
  sseClients: number;
  hasCredentials: boolean;
  config: any;
}> {
  return api('/status');
}

// ─── Executions (paginated) ──────────────────────────────────────────

export async function getExecutions(
  params: { offset?: number; limit?: number; date?: string } = {}
): Promise<{ items: any[]; total: number; hasMore: boolean }> {
  const qs = new URLSearchParams();
  if (params.offset != null) qs.set('offset', String(params.offset));
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.date) qs.set('date', params.date);
  
  const tzOffset = new Date().getTimezoneOffset();
  qs.set('tzOffset', String(tzOffset));
  
  return api(`/executions?${qs.toString()}`);
}

export async function getExecutionDates(): Promise<{ dates: string[] }> {
  const tzOffset = new Date().getTimezoneOffset();
  return api(`/execution-dates?tzOffset=${tzOffset}`);
}

export async function deleteExecution(execId: string): Promise<{ ok: boolean }> {
  return api(`/executions/${execId}`, { method: 'DELETE' });
}
