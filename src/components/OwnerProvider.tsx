'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

interface OwnerContextValue {
  token: string;
  ready: boolean;
  setToken: (token: string) => void;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const OwnerContext = createContext<OwnerContextValue | null>(null);

export function OwnerProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stored = '';
    try {
      stored = window.localStorage.getItem('novel-finder-owner-token') ?? '';
    } catch {
      // Private browsing can disable storage; an in-memory token still works.
    }
    queueMicrotask(() => {
      setTokenState(stored);
      setReady(true);
    });
  }, []);

  const setToken = useCallback((value: string) => {
    const clean = value.trim();
    setTokenState(clean);
    try {
      if (clean) window.localStorage.setItem('novel-finder-owner-token', clean);
      else window.localStorage.removeItem('novel-finder-owner-token');
    } catch {
      // Authentication remains usable when localStorage is unavailable.
    }
  }, []);

  const apiFetch = useCallback((input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }, [token]);

  return (
    <OwnerContext.Provider value={{ token, ready, setToken, apiFetch }}>
      {children}
    </OwnerContext.Provider>
  );
}

export function useOwner() {
  const value = useContext(OwnerContext);
  if (!value) throw new Error('useOwner must be used within OwnerProvider');
  return value;
}
