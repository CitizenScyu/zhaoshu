import type { Permission, Principal } from './auth-types';

export const OWNER_PRINCIPAL: Principal = Object.freeze({
  userId: 1,
  role: 'owner',
  canFind: true,
  canRead: true,
  canDownload: true,
  authMethod: 'owner-header',
});

export function hasPermission(principal: Principal, permission: Permission): boolean {
  if (principal.role !== 'owner' && principal.role !== 'member') return false;
  if (permission === 'find') return principal.canFind;
  if (permission === 'read') return principal.canRead;
  return principal.canDownload;
}
