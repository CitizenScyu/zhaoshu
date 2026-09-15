'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createOwnerRequest } from '@/lib/owner-request';
import { OwnerSession } from '@/lib/owner-session';

interface OwnerContextValue {
  token: string;
  sessionId: number;
  ready: boolean;
  sessionOnly: boolean;
  setSessionOnly: (value: boolean) => void;
  submitToken: (draft: string) => Promise<void>;
  logout: () => void;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const OwnerContext = createContext<OwnerContextValue | null>(null);
const STORAGE_KEY = 'novel-finder-owner-token';

function readStoredToken(area: 'localStorage' | 'sessionStorage'): string {
  try {
    return window[area].getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeToken(token: string, sessionOnly: boolean) {
  const selected = sessionOnly ? 'sessionStorage' : 'localStorage';
  for (const area of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = window[area];
      if (token && area === selected) storage.setItem(STORAGE_KEY, token);
      else storage.removeItem(STORAGE_KEY);
    } catch {
      // Try both storage areas independently; authentication still works in memory.
    }
  }
}

export function OwnerProvider({ children }: { children: React.ReactNode }) {
  // A successful submission also refreshes consumers when the token is unchanged.
  const [credentials, setCredentials] = useState(() => new OwnerSession('', 0));
  const currentSession = useRef(credentials);
  const [ready, setReady] = useState(false);
  const [sessionOnly, setSessionOnlyState] = useState(false);
  const currentSessionOnly = useRef(false);
  const validation = useRef<AbortController | null>(null);

  const replaceSession = useCallback((token: string) => {
    const previous = currentSession.current;
    const next = new OwnerSession(token, previous.id + 1);
    currentSession.current = next;
    previous.close();
    setCredentials(next);
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const session = readStoredToken('sessionStorage');
      const stored = session || readStoredToken('localStorage');
      currentSessionOnly.current = Boolean(session);
      setSessionOnlyState(Boolean(session));
      // Always create a live generation, including after Strict Mode's effect replay.
      replaceSession(stored);
      setReady(true);
    });
    const onStorage = (event: StorageEvent) => {
      if (currentSessionOnly.current || (event.key !== STORAGE_KEY && event.key !== null)) return;
      try { if (event.storageArea !== window.localStorage) return; } catch { return; }
      // Read the latest value; queued storage events may describe older values.
      const stored = readStoredToken('localStorage');
      if (stored === currentSession.current.token) return;
      validation.current?.abort();
      validation.current = null;
      replaceSession(stored);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      active = false;
      validation.current?.abort();
      currentSession.current.close();
      window.removeEventListener('storage', onStorage);
    };
  }, [replaceSession]);

  const setSessionOnly = useCallback((value: boolean) => {
    currentSessionOnly.current = value;
    storeToken(credentials.token, value);
    setSessionOnlyState(value);
  }, [credentials.token]);

  const submitToken = useCallback(async (draft: string) => {
    const clean = draft.trim();
    if (!clean) throw new Error('请先输入访问口令');
    validation.current?.abort();
    const controller = new AbortController();
    validation.current = controller;
    try {
      const res = await fetch(createOwnerRequest('/api/owner', {
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      }, clean, window.location.origin));
      controller.signal.throwIfAborted();
      if (!res.ok) {
        throw new Error(res.status === 401
          ? '口令不正确，当前口令未更改'
          : '暂时无法验证口令，请稍后重试');
      }
      storeToken(clean, sessionOnly);
      replaceSession(clean);
    } finally {
      if (validation.current === controller) validation.current = null;
    }
  }, [sessionOnly, replaceSession]);

  const logout = useCallback(() => {
    validation.current?.abort();
    validation.current = null;
    storeToken('', false);
    replaceSession('');
  }, [replaceSession]);

  const apiFetch = useCallback(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    return credentials.fetch(input, init, window.location.origin);
  }, [credentials]);

  return (
    <OwnerContext.Provider value={{ token: credentials.token, sessionId: credentials.id, ready, sessionOnly, setSessionOnly, submitToken, logout, apiFetch }}>
      {children}
    </OwnerContext.Provider>
  );
}

export function useOwner() {
  const value = useContext(OwnerContext);
  if (!value) throw new Error('useOwner must be used within OwnerProvider');
  return value;
}
