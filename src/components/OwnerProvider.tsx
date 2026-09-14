'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createOwnerRequest } from '@/lib/owner-request';

interface OwnerContextValue {
  token: string;
  sessionOnly: boolean;
  setSessionOnly: (value: boolean) => void;
  submitToken: (draft: string) => Promise<void>;
  logout: () => void;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const OwnerContext = createContext<OwnerContextValue | null>(null);
const STORAGE_KEY = 'novel-finder-owner-token';

function storeToken(token: string, sessionOnly: boolean) {
  window.localStorage.removeItem(STORAGE_KEY);
  window.sessionStorage.removeItem(STORAGE_KEY);
  if (token) {
    const storage = sessionOnly ? window.sessionStorage : window.localStorage;
    storage.setItem(STORAGE_KEY, token);
  }
}

export function OwnerProvider({ children }: { children: React.ReactNode }) {
  // A successful submission also refreshes consumers when the token is unchanged.
  const [credentials, setCredentials] = useState({ token: '' });
  const [sessionOnly, setSessionOnlyState] = useState(false);
  const validation = useRef<AbortController | null>(null);

  useEffect(() => {
    const session = window.sessionStorage.getItem(STORAGE_KEY) ?? '';
    const stored = session || window.localStorage.getItem(STORAGE_KEY) || '';
    if (session) window.localStorage.removeItem(STORAGE_KEY);
    if (stored) queueMicrotask(() => {
      setCredentials({ token: stored });
      setSessionOnlyState(Boolean(session));
    });
    return () => validation.current?.abort();
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
    <OwnerContext.Provider value={{ token: credentials.token, sessionOnly, setSessionOnly, submitToken, logout, apiFetch }}>
      {children}
    </OwnerContext.Provider>
  );
}

export function useOwner() {
  const value = useContext(OwnerContext);
  if (!value) throw new Error('useOwner must be used within OwnerProvider');
  return value;
}
