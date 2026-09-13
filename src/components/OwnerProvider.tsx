'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

interface OwnerContextValue {
  token: string;
  setToken: (token: string) => void;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

const OwnerContext = createContext<OwnerContextValue | null>(null);

export function OwnerProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState('');

  useEffect(() => {
    const stored = window.localStorage.getItem('novel-finder-owner-token') ?? '';
    if (stored) queueMicrotask(() => setTokenState(stored));
  }, []);

  const setToken = useCallback((value: string) => {
    const clean = value.trim();
    setTokenState(clean);
    if (clean) window.localStorage.setItem('novel-finder-owner-token', clean);
    else window.localStorage.removeItem('novel-finder-owner-token');
  }, []);

  const apiFetch = useCallback((input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }, [token]);

  return (
    <OwnerContext.Provider value={{ token, setToken, apiFetch }}>
      {children}
    </OwnerContext.Provider>
  );
}

export function useOwner() {
  const value = useContext(OwnerContext);
  if (!value) throw new Error('useOwner must be used within OwnerProvider');
  return value;
}
