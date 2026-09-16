'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AuthController } from '@/lib/auth-client';
import type { AuthPhase, AuthUser, LegacyTokenStore, Permission } from '@/lib/auth-client';
import { forgetHistory } from '@/lib/recent-queries';

interface OwnerContextValue {
  /** 认证状态是否已经确定（无论是否已登录）。 */
  ready: boolean;
  status: AuthPhase;
  user: AuthUser | null;
  permissions: Record<Permission, boolean>;
  authMethod: 'owner-header' | 'session' | null;
  accountsEnabled: boolean;
  /** Cookie 失效被服务端拒绝过：只作提示，不代表已切换身份。 */
  expired: boolean;
  /** 前端请求代际；数据库 session token 永远不在这里。 */
  sessionId: number;
  sessionOnly: boolean;
  setSessionOnly: (value: boolean) => void;
  submitToken: (draft: string) => Promise<void>;
  login: (username: string, password: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  can: (permission: Permission) => boolean;
}

const OwnerContext = createContext<OwnerContextValue | null>(null);
const STORAGE_KEY = 'novel-finder-owner-token';
// 跨标签回退信号键：只写时间戳，不含任何凭据。
const AUTH_SIGNAL_KEY = 'novel-finder-auth-signal';
const AUTH_CHANNEL_NAME = 'novel-finder-auth';

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

const LEGACY_STORE: LegacyTokenStore = {
  read: () => readStoredToken('sessionStorage') || readStoredToken('localStorage'),
  readSessionOnly: () => Boolean(readStoredToken('sessionStorage')),
  write: storeToken,
  clear: () => storeToken('', false),
};

// Cookie 变更没有 storage 事件；优先 BroadcastChannel，只广播非秘密通知。
function createAuthNotifier(onExternalChange: () => void): { notify: () => void; dispose: () => void } {
  if (typeof window === 'undefined') return { notify: () => {}, dispose: () => {} };
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(AUTH_CHANNEL_NAME) : null;
  const onMessage = () => onExternalChange();
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== AUTH_SIGNAL_KEY) return;
    onExternalChange();
  };
  if (channel) channel.addEventListener('message', onMessage);
  else window.addEventListener('storage', onStorage);
  const onVisible = () => { if (document.visibilityState === 'visible') onExternalChange(); };
  document.addEventListener('visibilitychange', onVisible);
  return {
    notify: () => {
      try { channel?.postMessage({ type: 'auth-changed' }); } catch { /* 通道已关闭 */ }
      if (!channel) {
        try { window.localStorage.setItem(AUTH_SIGNAL_KEY, String(Date.now())); } catch { /* 存储被禁用 */ }
      }
    },
    dispose: () => {
      if (channel) { channel.removeEventListener('message', onMessage); channel.close(); }
      else window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}

export function OwnerProvider({ children }: { children: React.ReactNode }) {
  const [controller] = useState(() => new AuthController({
    origin: () => (typeof window === 'undefined' ? 'https://internal.invalid' : window.location.origin),
    storage: LEGACY_STORE,
  }));
  const [snapshot, setSnapshot] = useState(() => controller.state);

  useEffect(() => {
    const notifier = createAuthNotifier(() => { void controller.handleExternalChange().catch(() => {}); });
    controller.setNotify(() => notifier.notify());
    const unsubscribe = controller.subscribe(() => setSnapshot(controller.state));
    // Always create a live generation, including after Strict Mode's effect replay.
    queueMicrotask(() => { void controller.start().catch(() => {}); });
    return () => {
      controller.setNotify(null);
      unsubscribe();
      notifier.dispose();
      controller.close();
    };
  }, [controller]);

  const setSessionOnly = useCallback((value: boolean) => controller.setLegacySessionOnly(value), [controller]);
  const submitToken = useCallback(
    (draft: string) => controller.loginOwner(draft, controller.state.sessionOnly),
    [controller],
  );
  const login = useCallback(
    (username: string, password: string, remember: boolean) => controller.login(username, password, remember),
    [controller],
  );
  const logout = useCallback(async () => {
    // 显式退出要清掉当前用户的查询缓存：存储与模块快照一起清（设计 §6.4）。
    const userId = controller.state.user?.id;
    await controller.logout();
    if (typeof userId === 'number' && userId > 0) forgetHistory(userId);
  }, [controller]);
  const refresh = useCallback(() => controller.refresh('visible'), [controller]);
  const apiFetch = useCallback(
    (input: RequestInfo | URL, init: RequestInit = {}) => controller.fetch(input, init),
    [controller],
  );
  const value = useMemo<OwnerContextValue>(() => {
    const user = snapshot.user;
    const permissions = {
      find: Boolean(user?.canFind),
      read: Boolean(user?.canRead),
      download: Boolean(user?.canDownload),
    };
    return {
      ready: snapshot.phase !== 'loading',
      status: snapshot.phase,
      user,
      permissions,
      authMethod: user?.authMethod ?? null,
      accountsEnabled: snapshot.accountsEnabled,
      expired: snapshot.expired,
      sessionId: snapshot.generation,
      sessionOnly: snapshot.sessionOnly,
      setSessionOnly,
      submitToken,
      login,
      logout,
      refresh,
      apiFetch,
      can: (permission: Permission) => permissions[permission],
    };
  }, [snapshot, setSessionOnly, submitToken, login, logout, refresh, apiFetch]);

  return <OwnerContext.Provider value={value}>{children}</OwnerContext.Provider>;
}

export function useOwner() {
  const value = useContext(OwnerContext);
  if (!value) throw new Error('useOwner must be used within OwnerProvider');
  return value;
}
