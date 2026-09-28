export interface AdminUserSummary {
  id: number;
  username: string;
  role: string;
  canFind: boolean;
  canRead: boolean;
  canDownload: boolean;
  disabled: boolean;
  createdAt: string;
  inviteHint: string | null;
}

export type UserRow = {
  id: number;
  username: string;
  role: string;
  can_find: boolean;
  can_read: boolean;
  can_download: boolean;
  disabled_at: string | null;
  created_at: string;
  invite_hint: string | null;
};

// 不返回 password_hash、会话 token 或邀请码原文；邀请来源只给短提示。
export function toAdminUser(row: UserRow): AdminUserSummary {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    canFind: row.can_find,
    canRead: row.can_read,
    canDownload: row.can_download,
    disabled: row.disabled_at !== null,
    createdAt: row.created_at,
    inviteHint: row.invite_hint,
  };
}
