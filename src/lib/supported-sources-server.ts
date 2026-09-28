// 仅服务端读取准入数据；客户端可用的静态注册表留在 supported-sources.ts。
import { getSql } from './db';

interface AdmissionHostRow { host: string }

/**
 * 从 DB source_admission 读「三滤网全过」源的 host 集合（设计 §5.2/§6.1）。
 * ok 态判据：compile_ok ∧ search_ok IS TRUE（滤网 3 probe 是 host 级健康态，由 probeWorker
 * 另行表达）。DB 不可达时**抛错**，由调用方 fail-closed 保持既有集合（绝不放大）。
 *
 * 只收**当前源表里还在**的源（41-srcfix 孤儿行）：shuyuan_sources 每轮整表替换、source_admission
 * 只 upsert 不删，合集删掉的源留下孤儿 ok 行——取书池（shuyuan.ts engineReadingSources 的 JOIN）
 * 早已不收它，门却还放行它的 host。门的全部消费者（取书池、下载、engine-fetch）刷门后都再走同一
 * JOIN 取源，孤儿 host 留在门里只多放行一个无人使用的 host。EXISTS 半连接走 source_url 唯一索引，
 * 只回 host 列，不读 source 大列、出站字节不增。
 * 故意**不**跟取书池一样滤 disabled/probe failed：刷新路径的探测入队也用这道门（canProbe），
 * 按 probe 态收窄会让判死的源永远重探不到、恢复不了。
 * admrunner42：phoenix_ok: 行（phoenix runner 探 ok、Vercel 未确认）不放行——与 shuyuan.ts readEngineRows /
 * readAdmissionFunnel ok 桶同一谓词，池与门口径一致。
 */
export async function engineHosts(signal?: AbortSignal): Promise<string[]> {
  const sql = getSql();
  const query = sql`
    SELECT DISTINCT host FROM source_admission a
    WHERE a.compile_ok AND a.search_ok IS TRUE AND (a.error IS NULL OR a.error NOT LIKE 'phoenix_ok:%') AND a.host <> ''
      AND EXISTS (SELECT 1 FROM shuyuan_sources src WHERE src.source_url = a.source_url)`;
  const [rows] = await sql.transaction([query], {
    readOnly: true, ...(signal ? { fetchOptions: { signal } } : {}),
  });
  return (rows as AdmissionHostRow[]).map((row) => row.host);
}
