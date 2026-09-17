/**
 * 书源管理页的纯逻辑：状态筛选、分页换算、状态文案。
 * 抽成不依赖 DOM 的模块，才能在 node 环境直接测——本仓 vitest 只收 *.test.ts 且没有 jsdom。
 */

/** 单页条数。列表要放下错误原文，20 条在手机上仍要滚动，不再加大。 */
export const SOURCE_PAGE_SIZE = 20;

/**
 * 页码上限。URL 的 page 是用户可控输入，封顶避免手改出 page=1e9 时算出一个巨大的 OFFSET。
 * 20 × 500 = 10000 条，远超目前 ~995 个源。
 */
export const MAX_SOURCE_PAGE = 500;

/** 探测状态。unprobed 表示没有快照记录，不代表失败。 */
export type ShuyuanAvailability = 'unprobed' | 'pending' | 'reachable' | 'failed';

const AVAILABILITY_LABELS: Record<ShuyuanAvailability, string> = {
  unprobed: '未探测', pending: '待核验', reachable: '最近探测可达', failed: '最近探测失败',
};

export function availabilityLabel(availability: ShuyuanAvailability): string {
  return AVAILABILITY_LABELS[availability] ?? AVAILABILITY_LABELS.unprobed;
}

/**
 * 列表筛选维度。界面上的统计卡与后端 SQL 谓词共用这一份 id，避免两处各起一套名字。
 * enabled/disabled 看的是 disabled_at（启停开关），其余四项看的是探测快照，两者正交：
 * 一个已禁用的源仍可能是「最近探测可达」。
 */
export type ShuyuanSourceFilter = 'all' | 'enabled' | 'disabled' | 'unprobed' | 'pending' | 'reachable' | 'failed';

export const SOURCE_FILTERS: readonly ShuyuanSourceFilter[] = [
  'all', 'enabled', 'disabled', 'unprobed', 'pending', 'reachable', 'failed',
];

const FILTER_LABELS: Record<ShuyuanSourceFilter, string> = {
  all: '全部', enabled: '已启用', disabled: '已禁用',
  unprobed: '未探测', pending: '待核验', reachable: '最近探测可达', failed: '最近探测失败',
};

export function filterLabel(filter: ShuyuanSourceFilter): string {
  return FILTER_LABELS[filter] ?? FILTER_LABELS.all;
}

/**
 * 筛选 id 与 ShuyuanCounts 里的计数字段一一对应。列表页脚显示的总条数直接取这个字段，
 * 所以「统计卡上的数字」和「点进去看到的条数」不可能对不上——两者同源。
 */
export const FILTER_COUNT_KEYS = {
  all: 'total', enabled: 'enabled', disabled: 'disabled',
  unprobed: 'unprobed', pending: 'pending', reachable: 'reachable', failed: 'failed',
} as const satisfies Record<ShuyuanSourceFilter, string>;

/** 非白名单值一律退回 all：筛选 id 会决定 SQL 谓词，不能拿原始输入直接比对。 */
export function parseSourceFilter(value: string | null | undefined): ShuyuanSourceFilter {
  return SOURCE_FILTERS.includes(value as ShuyuanSourceFilter) ? value as ShuyuanSourceFilter : 'all';
}

/** 页码从 1 起；空串、0、负数、小数、非数字一律回第 1 页，超过上限则封顶。 */
export function parseSourcePage(value: string | null | undefined): number {
  if (value === null || value === undefined || value.trim() === '') return 1;
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1) return 1;
  return Math.min(page, MAX_SOURCE_PAGE);
}

/** 总页数至少为 1：空结果也该停在第 1 页，页脚不显示「第 1 / 0 页」。 */
export function pageCount(total: number, pageSize: number = SOURCE_PAGE_SIZE): number {
  const size = normalizedPageSize(pageSize);
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  return Math.max(1, Math.ceil(safeTotal / size));
}

/**
 * 页码收口：把页码夹回 [1, 总页数]。
 *
 * 收口只发生在「重载之后总数可能变小」的场合：筛选下的最后一条被停用/启用后移出当前
 * 筛选，总数缩水，原地停在旧页码就会显示一个空列表（页脚却还写着第 N 页）。
 * 总数变 0 也要回第 1 页——pageCount 保证至少 1 页，所以这里不会返回 0。
 * 页码本身非法（非整数、<1）时同样回第 1 页，与 parseSourcePage 的口径一致。
 *
 * 只返回收口后的页码，不碰 state：调用方在返回值与请求页码不同时才写回。
 * 「该退到第几页」的判断只此一处，组件不再自己比较 totalPages。
 */
export function clampSourcePage(
  page: number, total: number, pageSize: number = SOURCE_PAGE_SIZE,
): number {
  if (!Number.isSafeInteger(page) || page < 1) return 1;
  return Math.min(page, pageCount(total, pageSize));
}

export function offsetFor(page: number, pageSize: number = SOURCE_PAGE_SIZE): number {
  return (Math.max(1, Math.floor(page)) - 1) * normalizedPageSize(pageSize);
}

function normalizedPageSize(pageSize: number): number {
  return Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : SOURCE_PAGE_SIZE;
}

/** getReadingSources 的两个可用条件。上游规则自带的 enabled 标记是第三个条件，界面暂不展示。 */
export function participatesInSearch(source: { disabled: boolean; availability: ShuyuanAvailability }): boolean {
  return !source.disabled && source.availability !== 'failed';
}

/**
 * 「开关开着但实际不会参与搜索」的原因。这是最容易误判的一态：开关是开的，
 * 但探测状态是 failed 时 getReadingSources 会把它排除——刷新后重探成功才回来。
 */
export function participationHint(source: { disabled: boolean; availability: ShuyuanAvailability }): string {
  if (participatesInSearch(source)) return '';
  if (source.disabled) return '已禁用，不会参与书源搜索';
  return '已启用，但最近一次探测失败，当前不会参与搜索；刷新后会重试';
}
