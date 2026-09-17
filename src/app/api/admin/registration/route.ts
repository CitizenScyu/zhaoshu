import type { NextRequest } from 'next/server';
import { guardOwnerRead, guardOwnerWrite } from '@/lib/admin-http';
import { authAccountsEnabled } from '@/lib/auth';
import { authError, authJson } from '@/lib/auth-http';
import { isRegistrationMode, readRegistrationSettings, writeRegistrationSettings } from '@/lib/invite-codes';
import { getSql } from '@/lib/db';
import { readJsonBody, RequestBodyError } from '@/lib/http';

const MAX_BODY_BYTES = 2 * 1024;
const UNAVAILABLE = '注册设置暂时不可用，请稍后重试。';

// owner 读写注册开关与成员总闸。写入不做探测、立即生效：注册接口每次都在自己的事务里
// 重读这一行，所以「随时关闭」对已经发出的注册请求也是有界的（先提交的关闭生效）。
// accountsEnabled 是**只读**的部署闸门快照（env AUTH_ACCOUNTS_ENABLED，运行时改不了）：
// 管理台据此说明「下方开关是否真的生效」，因此没有对应的写入入口。
export async function GET(req: NextRequest) {
  const guard = await guardOwnerRead(req);
  if (!guard.ok) return guard.response;
  try {
    const settings = await readRegistrationSettings(getSql());
    return authJson({ ...settings, accountsEnabled: authAccountsEnabled() });
  } catch {
    return authError(503, 'SETTINGS_UNAVAILABLE', UNAVAILABLE);
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await guardOwnerWrite(req);
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown> | null;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return authError(413, error.code, error.message);
    throw error;
  }
  if (!body) return authError(400, 'INVALID_BODY', '请求体必须是 JSON 对象');

  const membersEnabled = body.membersEnabled;
  const registrationMode = body.registrationMode;
  if (membersEnabled === undefined && registrationMode === undefined) {
    return authError(400, 'INVALID_BODY', '至少提供 membersEnabled 或 registrationMode 之一');
  }
  if (membersEnabled !== undefined && typeof membersEnabled !== 'boolean') {
    return authError(400, 'INVALID_BODY', 'membersEnabled 只能是布尔值');
  }
  if (registrationMode !== undefined && !isRegistrationMode(registrationMode)) {
    return authError(400, 'INVALID_REGISTRATION_MODE', 'registrationMode 只能是 closed、open 或 invite');
  }

  try {
    const sql = getSql();
    // 部分更新：以库里的当前值为基线，只覆盖请求里出现的字段，避免把未提交的另一项改回去。
    const current = await readRegistrationSettings(sql);
    const updatedAt = await writeRegistrationSettings(sql, {
      membersEnabled: typeof membersEnabled === 'boolean' ? membersEnabled : current.membersEnabled,
      registrationMode: isRegistrationMode(registrationMode) ? registrationMode : current.registrationMode,
    });
    return authJson({
      membersEnabled: typeof membersEnabled === 'boolean' ? membersEnabled : current.membersEnabled,
      registrationMode: isRegistrationMode(registrationMode) ? registrationMode : current.registrationMode,
      updatedAt,
      // 与 GET 同形：管理台用本响应整体替换状态，缺了它闸门提示会在保存后消失。
      accountsEnabled: authAccountsEnabled(),
    });
  } catch {
    return authError(503, 'SETTINGS_UNAVAILABLE', UNAVAILABLE);
  }
}
