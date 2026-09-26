import { authAccountsEnabled } from '@/lib/auth';
import { authJson } from '@/lib/auth-http';
import { getSql } from '@/lib/db';
import { readRegistrationSettings, type RegistrationMode } from '@/lib/invite-codes';
import { withDbQuotaGuard } from '@/lib/db-quota-guard';

// 匿名只读：注册页用它决定是否显示邀请码输入。只暴露三态模式，绝不返回邀请列表、
// 用户名或配置细节；部署闸门未开、成员总闸关闭或读库失败一律表现为 closed（失败关闭）。
async function handleGET() {
  let mode: RegistrationMode = 'closed';
  if (authAccountsEnabled()) {
    try {
      const settings = await readRegistrationSettings(getSql());
      if (settings.membersEnabled) mode = settings.registrationMode;
    } catch {
      mode = 'closed';
    }
  }
  return authJson({ registrationMode: mode });
}

// 数据库配额闸（41-q402fix）：导出的处理器统一经 withDbQuotaGuard 包装（route-guard.test.ts 钉死）。
export const GET = withDbQuotaGuard(handleGET);
