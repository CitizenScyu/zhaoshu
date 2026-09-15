export type Permission = 'find' | 'read' | 'download';

export type Principal = {
  userId: number;
  role: 'owner' | 'member';
  canFind: boolean;
  canRead: boolean;
  canDownload: boolean;
  authMethod: 'owner-header' | 'session';
};

export type AuthSuccess = { ok: true; principal: Principal };
export type AuthFailure = { ok: false; response: Response };
export type AuthResult = AuthSuccess | AuthFailure;
