// 仅服务端读取准入数据；客户端可用的静态注册表留在 supported-sources.ts。
import { getSql } from './db';

/**
 * urlfix：URL 形态归一化的共享 SQL 片段（取书池 JOIN 与本文件 host 门共用，杜绝两处漂移）。
 *
 * 上游书源 JSON 的 bookSourceUrl 有两种形态（`https://x.com` vs `https://x.com#` / `#🎃` / `#一程`），
 * shuyuan_sources 每轮整表替换、source_admission 只 upsert 不删，于是同一条上游条目在两表分裂成两个键：
 * 规则行是新键、准入行停在旧键，纯字符串等值 JOIN/EXISTS 永远配不上。
 *
 * 归一化 = btrim + 剥 fragment（`#` 起到结尾，**只剥 # 之后，query 串完整保留**）+ 去尾斜杠，
 * 口径 = normalizeUrl（trim + 去尾斜杠）再加剥 fragment。
 */
const NORMALIZE_URL_SQL = `regexp_replace(regexp_replace(btrim(COALESCE(%s, '')), '#.*$', ''), '/+$', '')`;

/** 把归一化片段填成某列表达式。调用方只传列名/表达式（不含用户输入），不拼裸字符串。 */
export function normalizeUrlSql(column: string): string {
  return NORMALIZE_URL_SQL.replace('%s', column);
}

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
 * bpool-normalize：includePhoenixOk=true 时额外放行 phoenix_ok: 行（下载腿扩池用）；缺省 false 与改前逐字相同。
 * urlfix：EXISTS 半连接与取书池 JOIN **同款三段判据**（精确等值 OR 归一化+同条目+旧形态孤儿）——
 * 裸精确 EXISTS 堵不住形态分裂孤儿（`chuangshi.qq.com#🎃` 与规则行 `chuangshi.qq.com` 同条目不同形态），
 * 裸归一化又会把「同 host 但另一条目」的孤儿行放进来。归一化片段即本文件的 normalizeUrlSql，
 * 取书池（shuyuan.ts readEngineRows）也从这里引用，两处不会漂移。
 * EXISTS 只判存在性、不聚合，行数与 DISTINCT 语义不变；includePhoenixOk 谓词原样保留。
 */
export async function engineHosts(
  signal?: AbortSignal, { includePhoenixOk = false }: { includePhoenixOk?: boolean } = {},
): Promise<string[]> {
  const sql = getSql();
  const query = sql`
    SELECT DISTINCT host FROM source_admission a
    WHERE a.compile_ok AND a.search_ok IS TRUE
      AND (${includePhoenixOk}::boolean OR a.error IS NULL OR a.error NOT LIKE 'phoenix_ok:%')
      AND a.host <> ''
      AND EXISTS (
    SELECT 1 FROM shuyuan_sources src
    WHERE src.source_url = a.source_url
       OR (${sql.unsafe(normalizeUrlSql('a.source_url'))} = ${sql.unsafe(normalizeUrlSql('src.source_url'))}
         AND ${sql.unsafe(normalizeUrlSql("src.source->>'bookSourceUrl'"))} = ${sql.unsafe(normalizeUrlSql('a.source_url'))}
         AND NOT EXISTS (SELECT 1 FROM shuyuan_sources s2 WHERE s2.source_url = a.source_url)))`;
  const [rows] = await sql.transaction([query], {
    readOnly: true, ...(signal ? { fetchOptions: { signal } } : {}),
  });
  return (rows as AdmissionHostRow[]).map((row) => row.host);
}
