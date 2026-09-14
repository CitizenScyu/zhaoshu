'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createOwnerRequest } from '@/lib/owner-request';

interface OwnerContextValue {
  token: string;
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
      storage.removeItem(STORAGE_KEY);
      if (token && area === selected) storage.setItem(STORAGE_KEY, token);
    } catch {
      // Try both storage areas independently; authentication still works in memory.
    }
  }
}

export function OwnerProvider({ children }: { children: React.ReactNode }) {
  // A successful submission also refreshes consumers when the token is unchanged.
  const [credentials, setCredentials] = useState({ token: '' });
  const [ready, setReady] = useState(false);
  const [sessionOnly, setSessionOnlyState] = useState(false);
  const validation = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    const session = readStoredToken('sessionStorage');
    const stored = session || readStoredToken('localStorage');
    if (session) {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* Storage can be disabled. */ }
    }
    queueMicrotask(() => {
      if (!active) return;
      if (stored) setCredentials({ token: stored });
      setSessionOnlyState(Boolean(session));
      setReady(true);
    });
    return () => {
      active = false;
      validation.current?.abort();
    };
  }, []);

  const setSessionOnly = useCallback((value: boolean) => {
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
      setCredentials({ token: clean });
    } finally {
      if (validation.current === controller) validation.current = null;
    }
  }, [sessionOnly]);

  const logout = useCallback(() => {
    validation.current?.abort();
    validation.current = null;
    storeToken('', false);
    setCredentials({ token: '' });
  }, []);

  const apiFetch = useCallback(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    return fetch(createOwnerRequest(input, init, credentials.token, window.location.origin));
  }, [credentials]);

  return (
    <OwnerContext.Provider value={{ token: credentials.token, ready, sessionOnly, setSessionOnly, submitToken, logout, apiFetch }}>
      {children}
    </OwnerContext.Provider>
  );
}

export function useOwner() {
  const value = useContext(OwnerContext);
  if (!value) throw new Error('useOwner must be used within OwnerProvider');
  return value;
}
