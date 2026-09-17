/**
 * 登录卡上注册入口的可见性判定。三个输入轴：
 * - 部署总闸（AUTH_ACCOUNTS_ENABLED，前端表现为 accountsEnabled）：决定本站有没有账号模式；
 * - 运行时注册开关（admin 的 membersEnabled + registrationMode，经 /api/auth/registration 出三态）；
 * - 当前表单模式（用户名密码 / 管理员口令）。
 * 抽成不依赖 DOM 的模块才能在 node 环境直接测——本仓 vitest 只收 *.test.ts 且没有 jsdom。
 *
 * 与 src/lib/invite-codes.ts 的同名类型重复一份：那边 import 了 node:crypto，不能进客户端包。
 */
export type RegistrationMode = 'closed' | 'open' | 'invite';

/**
 * - hidden：不渲染任何注册相关内容（账号模式总闸未开，或用户主动切到了管理员口令入口）。
 * - closed：注册开关是关闭的：只给一句说明，不给链接。
 * - open / invite：给链接；invite 额外标明需要邀请码。
 * - unknown：三态还没取到（首帧，或请求失败/形状不认识）。**乐观放行**：入口只是一个链接，
 *   真正的资格判定在服务端注册接口；把未知当 closed 会重演「用户找不到注册入口」的症状。
 */
export type RegisterEntryState = 'hidden' | 'closed' | 'open' | 'invite' | 'unknown';

export function registerEntryState(input: {
  accountsEnabled: boolean;
  memberMode: boolean;
  registrationMode: RegistrationMode | null;
}): RegisterEntryState {
  // 口令入口不是「另一种登录方式」而是部署未开账号模式时的退路：那里不该提注册。
  if (!input.accountsEnabled || !input.memberMode) return 'hidden';
  if (input.registrationMode === 'closed') return 'closed';
  return input.registrationMode ?? 'unknown';
}

/** 是否渲染注册链接。closed/hidden 都不给链接。 */
export function registerEntryVisible(state: RegisterEntryState): boolean {
  return state === 'open' || state === 'invite' || state === 'unknown';
}

/** 链接文案：三态语义与 AdminTab 的 MODE_LABELS 同义（开放注册 / 邀请码注册 / 关闭注册）。 */
export function registerEntryLabel(state: RegisterEntryState): string | null {
  switch (state) {
    case 'open':
    case 'unknown':
      return '注册新账号';
    case 'invite':
      return '注册新账号（需邀请码）';
    default:
      return null;
  }
}

/**
 * 关闭时的一句话说明。hidden 不解释：用户主动选了口令入口，或本站根本没开账号模式——
 * 那时页面本身就不是账号登录，再提注册只会让人以为漏开了什么。
 */
export function registerEntryNotice(state: RegisterEntryState): string | null {
  return state === 'closed' ? '本站当前未开放注册。' : null;
}

/** 注册链接：带已过滤的站内 returnTo，注册成功后能回到深链原处。 */
export function registerEntryHref(state: RegisterEntryState, returnTo: string | null): string | null {
  if (!registerEntryVisible(state)) return null;
  return `/register${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`;
}

/**
 * 服务端响应 → 三态。不认识的形状一律 null，由调用方决定乐观还是悲观——这里不替它失败关闭，
 * 否则一次读库抖动就会把注册入口藏掉。
 */
export function parseRegistrationMode(value: unknown): RegistrationMode | null {
  return value === 'open' || value === 'invite' || value === 'closed' ? value : null;
}
