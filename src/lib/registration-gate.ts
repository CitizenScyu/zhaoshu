/**
 * 管理台注册区的显示判定（纯逻辑，不依赖 DOM）。
 * 本仓 vitest 只收 src/**\/*.test.ts 且没有 jsdom，所以把文案与生效判定从 AdminTab 抽出来直接测。
 *
 * 背景：注册入口受**两层**开关控制——部署层 env AUTH_ACCOUNTS_ENABLED（闸门，运行时改不了）
 * 和运行时 auth_settings（成员总闸 + 三态模式，管理台可改）。闸门未开时后一层完全无效，
 * 管理台必须把这件事说出来，否则「已保存」会骗人。
 */
import type { RegistrationMode } from './invite-codes';

/** 部署闸门状态（只读展示，没有写入入口：env 运行时改不了，给按钮就是假按钮）。 */
export function gateStatusLabel(accountsEnabled: boolean): string {
  return accountsEnabled ? '已启用' : '未启用';
}

/** 闸门未开启时的说明文案；已开启返回 null，界面不留空占位。 */
export function gateWarning(accountsEnabled: boolean): string | null {
  if (accountsEnabled) return null;
  return '部署闸门未开启，下方注册开关暂不生效；需在部署环境设置 AUTH_ACCOUNTS_ENABLED=true 并重新部署。';
}

/**
 * 对外真正生效的注册模式：闸门未开或成员总闸关闭时一律回到 closed，
 * 与 /api/auth/registration 对匿名访问的失败关闭语义一致。
 */
export function effectiveRegistrationMode(
  accountsEnabled: boolean,
  membersEnabled: boolean,
  mode: RegistrationMode,
): RegistrationMode {
  return accountsEnabled && membersEnabled ? mode : 'closed';
}
