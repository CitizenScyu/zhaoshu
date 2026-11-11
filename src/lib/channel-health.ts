// fqhealth1111：番茄渠道心跳（cron_health 行），供 /api/health/sources 透传、探针判龄。
// 11-09~11 番茄 WebDriver 全 400 两天，熔断照常把书退回免费源，没有任何告警，靠人翻 events 日志才发现。
// 下载线（runtime-download）写、web 只读；行名在这里一处定义。本文件不 import 任何东西（两边都打包它）。
//
// 只记**通道故障**（界面遮挡/自动化异常/容器没出结果/产物读不到、socket 不通），不记某本书拿不全：
// 后者是书的问题，混进来会让「几本书恰好都残缺」冒充通道坏掉。
//   fanqie_ok          最近一次成功
//   fanqie_fault       最近一次通道故障
//   fanqie_fault_since 自上次成功以来第一次通道故障（成功即删）
// 探针判据：fault_since 与 fault 都在、且两者相隔 ≥ FANQIE_FAULT_ALERT_HOURS（见 source-health.ts）——
// 「故障持续了这么久、期间一次都没成功」。单次故障后渠道闲着不会误报（两者相隔为 0）。
export const FANQIE_OK_HEALTH_ROW = 'fanqie_ok';
export const FANQIE_FAULT_HEALTH_ROW = 'fanqie_fault';
export const FANQIE_FAULT_SINCE_HEALTH_ROW = 'fanqie_fault_since';

type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown>;

export async function recordFanqieOk(sql: SqlTag): Promise<void> {
  await sql`
    INSERT INTO cron_health (name, last_success_at) VALUES (${FANQIE_OK_HEALTH_ROW}, now())
    ON CONFLICT (name) DO UPDATE SET last_success_at = now()`;
  await sql`DELETE FROM cron_health WHERE name = ${FANQIE_FAULT_SINCE_HEALTH_ROW}`;
}

export async function recordFanqieFault(sql: SqlTag): Promise<void> {
  await sql`
    INSERT INTO cron_health (name, last_success_at) VALUES (${FANQIE_FAULT_HEALTH_ROW}, now())
    ON CONFLICT (name) DO UPDATE SET last_success_at = now()`;
  await sql`
    INSERT INTO cron_health (name, last_success_at) VALUES (${FANQIE_FAULT_SINCE_HEALTH_ROW}, now())
    ON CONFLICT (name) DO NOTHING`;
}
