/**
 * What this host is (`GET /api/host`, shared/api/platform.ts): the self-hosted single club,
 * the platform site, or one club of a hosted install. Fetched once before any routing
 * (client/HostGate.tsx), then available everywhere:
 *
 *   const host = useHost();                 // HostContext ({ mode: 'single' } outside a provider)
 *   if (host.mode === 'club') …             // a hosted club: its address is fixed, etc.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { HostContext } from '../../shared/api/platform';
import { api } from './api';

export const HOST_QUERY_KEY = ['host'] as const;

export function fetchHost(signal?: AbortSignal): Promise<HostContext> {
  return api.get<HostContext>('/host', { signal });
}

const SINGLE: HostContext = { mode: 'single' };
const HostCtx = createContext<HostContext>(SINGLE);

export function HostProvider({ value, children }: { value: HostContext; children: ReactNode }) {
  return <HostCtx.Provider value={value}>{children}</HostCtx.Provider>;
}

export function useHost(): HostContext {
  return useContext(HostCtx);
}
