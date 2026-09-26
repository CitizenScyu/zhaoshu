// labels.jsonl → Neon labeled_books 表。
// labeler.py 在 phoenix 上只产 jsonl,入库由本地用项目的 @neondatabase/serverless 执行。
//
// 用法:
//   node scripts/import_labels.mjs --env .env.local --file labels.jsonl
//   DATABASE_URL=postgres://... node scripts/import_labels.mjs --file labels.jsonl
//   node scripts/import_labels.mjs --dry-run --file labels.jsonl
// dry-run 不读取 --env、不创建数据库客户端；失败退出 1，跳过/待核验单独计数。
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeGenre } from './genre_map.mjs';
import { HTML_SOURCE, normalizeAuthor } from './normalize_author.mjs';

const DEFAULT_FILE = './labels.jsonl';
// PG 的 jsonb/text 严禁 NUL(0x00),源码里直接写裸 NUL 字节会被编辑链污染,
// 用码位构造
const NUL_CHAR = String.fromCharCode(0);
const NUL_RE = new RegExp(NUL_CHAR, 'g');

function parseArgs(argv) {
  const args = { env: null, file: DEFAULT_FILE, dryRun: false };
  let hasFile = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--env' || a === '--file') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(a + ' 缺少路径');
      if (a === '--env') args.env = value;
      else { args.file = value; hasFile = true; }
    }
    else if (!a.startsWith('--') && !hasFile) { args.file = a; hasFile = true; }
    else throw new Error(`未知参数: ${a}`);
  }
  return args;
}

// env 文件:每行 KEY=VALUE,忽略空行与 # 注释,容忍 export 前缀与外围引号
function loadEnvFile(path) {
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq < 1) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

// 字符串清洗:去 NUL、孤立 UTF-16 代理项替换为 U+FFFD。
// 与 src/lib/shuyuan.ts 的 cleanJson 同一套规则(上游数据里确实存在这类脏值)。
function cleanString(value) {
  return value
    .replace(NUL_RE, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, '�')
    .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanJson(value) {
  if (typeof value === 'string') return cleanString(value);
  if (Array.isArray(value)) return value.map(cleanJson);
  if (isRecord(value)) {
    // 键也是字符串,同样可能带脏字符
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) out[cleanString(k)] = cleanJson(v);
    return out;
  }
  return value;
}

function explicitNumber(value) {
  if (typeof value !== 'number' &&
      (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// 导入和补评分共享同一规则，尤其不能把 null / 空串 / false 变成 0。
function parseQuality(value) {
  const score = explicitNumber(value);
  return score !== null && score >= 0 && score <= 10 ? score : null;
}

function sourceUrl(value) {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url || url.length > 2_048 || cleanString(url) !== url ||
      [...url].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return null;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname &&
      !parsed.username && !parsed.password ? url : null;
  } catch {
    return null;
  }
}

// 仅忽略全半角、书名号、空白和大小写；包含关系不足以证明是同一本书。
// 不改变待写入的原始书名，也不合并任何存量身份。
function titleMatches(guess, actual) {
  if (typeof guess !== 'string' || typeof actual !== 'string') return false;
  const normalize = (title) => title.normalize('NFKC').replace(/[《》\s]/g, '').toLocaleLowerCase();
  const g = normalize(guess);
  return Boolean(g) && g === normalize(actual);
}

// ready: 可导入；skipped: 明确不合格的文本；review: 身份证据不足；failed: 数据结构损坏。
// 不用 title_guess 覆盖站点书名，缺失来源/分数只传空值给保留旧值的 UPSERT。
function validateImportRecord(rec) {
  const failed = (reason) => ({ status: 'failed', reason });
  const review = (reason) => ({ status: 'review', reason });
  if (!isRecord(rec) || !isRecord(rec.labels)) return failed('记录或 labels 字段不是对象');

  // lblmeta41：label_model / prompt_version / label_source 三个打标元数据字段新加到
  // labels.jsonl。它们**不写库**（labeled_books 无对应列，加列要改表结构），只做类型校验
  // ——与 import_one.py 的 FIELD_STRINGS 逐条对齐，别让两边对同一批输入的裁决分叉。
  // 其余未知字段一律忽略（这里不是白名单，是显式字段的类型校验）。
  for (const field of ['title', 'site_title', 'author', 'author_encoding', 'category', 'status', 'source',
    'label_model', 'prompt_version', 'label_source']) {
    if (rec[field] != null && typeof rec[field] !== 'string') return failed(field + ' 必须是字符串');
  }
  const normalizedAuthor = normalizeAuthor(rec.author ?? '', {
    sourceSite: rec.source, encoding: rec.author_encoding,
  });
  // 空作者现在由 normalizeAuthor 归为 review（见 empty-author），在此统一拦下：
  // 该行按 review 计数并报告，**不写库**——否则 author_key='' 与存量同书名的非空
  // 作者行不冲突，ON CONFLICT 不触发会插入第二行（与 python 自动导入语义对齐）。
  if (normalizedAuthor.status !== 'ready') {
    return { status: normalizedAuthor.status, reason: normalizedAuthor.reason };
  }
  const listedTitle = (rec.title ?? '').trim();
  const siteTitle = (rec.site_title ?? '').trim();
  const title = siteTitle || listedTitle;
  const author = normalizedAuthor.value;
  if (!title || title.length > 200 || listedTitle.length > 200) {
    return failed('书名缺失或书名/作者超过 200 字');
  }
  if (cleanString(title) !== title || cleanString(listedTitle) !== listedTitle || cleanString(author) !== author) {
    return review('书名或作者含非法字符，不能清洗后自动裁决身份');
  }
  // lblmeta41：删掉「site_title 与 title 不一致 → review」这条。title(= site_title 优先)
  // 与 site_title 不一致只说明**扫描时**的记录里 title 曾被 LLM 猜名覆盖过（旧 labeler 写法），
  // 并不构成本本身份证据不足——身份证据由下面的 site_title_match 与作者校验负责。
  // 现场 45 条 title≠site_title 全是 site_title_match=true，即被这条误拦。
  // 注意：身份键仍取 title(= siteTitle 优先)，删这条**不改变**身份键，不新增第二行。

  const labels = rec.labels;
  if (labels.title_guess != null && typeof labels.title_guess !== 'string') {
    return failed('labels.title_guess 必须是字符串');
  }
  if (labels.site_title_note != null && typeof labels.site_title_note !== 'string') {
    return failed('labels.site_title_note 必须是字符串');
  }
  // 旧数据没有 text_quality 字段时仍可导入，未知新枚举值留待核验。
  const textQuality = labels.text_quality;
  if (textQuality != null && typeof textQuality !== 'string') return failed('text_quality 必须是字符串');
  // lbladfix41：labeler 对「含广告注入」降级入库时打 quality_flag=ad_injection（书名核验 true 且置信度够），
  // 只有这一组合放行；与 import_one.py 同口径。
  const adDowngraded = textQuality?.trim() === '含广告注入' && rec.quality_flag === 'ad_injection';
  if (!adDowngraded && ['疑似乱码', '大面积重复', '含广告注入'].includes(textQuality?.trim())) {
    return { status: 'skipped', reason: '文本质量异常：' + textQuality };
  }
  if (!adDowngraded && textQuality != null && textQuality.trim() !== '正常') {
    return review('无法识别的 text_quality');
  }

  // 新格式：明确的布尔确认可替代盲猜；false/不确定不能被相似书名掩盖。
  if (labels.site_title_match !== undefined) {
    if (labels.site_title_match !== true) return review('站点书名未获明确确认（site_title_match）');
  } else if (!titleMatches(labels.title_guess, title)) {
    return review('盲猜书名与站点书名不符或缺失');
  }

  const warnings = [];
  const url = sourceUrl(rec.url);
  if (rec.url != null && rec.url !== '' && url === null) {
    warnings.push('来源 URL 无效，本次不覆盖旧 URL');
  }
  const q = labels.quality;
  const quality = isRecord(q) ? parseQuality(q.overall) : null;
  if (q != null && (quality === null && (!isRecord(q) || q.overall != null))) {
    warnings.push('quality.overall 缺失或无效，本次不覆盖旧评分');
  }

  let chars = 0; // 现有表以 0 表示未提供采样字数。
  if (rec.chars != null && !(typeof rec.chars === 'string' && !rec.chars.trim())) {
    chars = explicitNumber(rec.chars);
    if (chars === null || !Number.isSafeInteger(chars) || chars < 0 || chars > 2_147_483_647) {
      return failed('chars 必须是 0 到 2147483647 的整数');
    }
  }
  const category = cleanString((rec.category ?? '').trim());
  const { primary, sub } = normalizeGenre(category, typeof labels.genre === 'string' ? cleanString(labels.genre) : '');
  return {
    status: 'ready',
    warnings,
    record: {
      title, author, category,
      finishStatus: cleanString((rec.status ?? '').trim()),
      sourceSite: cleanString((rec.source ?? '').trim()),
      sourceUrl: url,
      charsLabeled: chars,
      // 保留 title_guess / site_title_match / site_title_note 和质量四维等原始标签；
      // 只沿用既有 PG 字符清洗，不补造原材料里不存在的来源或评分。
      labels: cleanJson(labels),
      primaryGenre: primary,
      subTags: sub,
      quality,
    },
  };
}

async function writeImportRecord(sql, record) {
  await sql`
    INSERT INTO labeled_books
      (title, author, category, finish_status, source_site, source_url,
       chars_labeled, labels, labeled_at, primary_genre, sub_tags, quality)
    VALUES (${record.title}, ${record.author}, ${record.category}, ${record.finishStatus},
            ${record.sourceSite}, ${record.sourceUrl ?? ''}, ${record.charsLabeled},
            ${JSON.stringify(record.labels)}::jsonb, now(),
            ${record.primaryGenre}, ${JSON.stringify(record.subTags)}::jsonb, ${record.quality})
    ON CONFLICT (title_key, author_key) DO UPDATE SET
      labels = EXCLUDED.labels,
      finish_status = EXCLUDED.finish_status,
      chars_labeled = EXCLUDED.chars_labeled,
      source_url = COALESCE(NULLIF(EXCLUDED.source_url, ''), labeled_books.source_url),
      primary_genre = EXCLUDED.primary_genre,
      sub_tags = EXCLUDED.sub_tags,
      quality = COALESCE(EXCLUDED.quality, labeled_books.quality),
      labeled_at = now()`;
}

// R02 前置逐记录拦截（最小实现，原型）：写入前检查本条记录归一后的身份键是否会
// 与既有「非不动点行」碰撞 —— 即某条存量行的 author 不等于它自身的归一结果，
// 却与本次待写入的 author 归一后相同。这类行 ON CONFLICT (title_key, author_key)
// 匹配不到，直接写就会凭空多一条重复。碰撞则跳过该条写入；只读，不改 DDL，
// 也不合并/改写任何存量行的身份。
//
// 判据不依赖既有行自己存的 source_site：手工 INSERT / 旧备份恢复 / 跨环境 merge
// 恰恰常不带干净的来源，若拿 row.source_site 去归一，normalizeAuthor 会返回
// review 而漏判孪生（缺口）。normalizeAuthor 只在 sourceSite === HTML_SOURCE 时
// 才可能改变值，其余来源一律是恒等或 review，所以「该行是否非不动点」只需按
// HTML_SOURCE 归一一次即完备 —— 既不再漏，也不需要再并列试别的来源。
//
// 驱动差异：neon 的 tag 模板 await 出来是行数组，PGlite 返回 { rows }，两种都兼容。
async function findNonFixpointTwin(sql, record) {
  const result = await sql`
    SELECT id, author FROM labeled_books
    WHERE lower(title) = lower(${record.title})`;
  const rows = Array.isArray(result) ? result : (result?.rows ?? []);
  const target = record.author.toLowerCase();
  for (const row of rows) {
    const stored = row.author ?? '';
    const normalized = normalizeAuthor(stored, { sourceSite: HTML_SOURCE });
    // 归一后与原文一致 = 不动点行，ON CONFLICT 能正确合并，不由本护栏处理
    if (normalized.status !== 'ready' || normalized.value === stored) continue;
    if (normalized.value.toLowerCase() === target) return row;
  }
  return null;
}

async function run(argv = process.argv.slice(2), { createSql = neon, env = process.env, log = console.log } = {}) {
  const args = parseArgs(argv);
  const file = resolve(args.file);
  // 不先过滤空行，明细中的行号必须能回到原始 jsonl 材料。
  const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  let sql;
  if (!args.dryRun) {
    let databaseUrl = env.DATABASE_URL;
    if (args.env) {
      const envPath = resolve(args.env);
      databaseUrl = loadEnvFile(envPath).DATABASE_URL;
      if (!databaseUrl) throw new Error(envPath + ' 里没有 DATABASE_URL');
    }
    if (!databaseUrl) throw new Error('缺少 DATABASE_URL(--env <path> 或环境变量)');
    sql = createSql(databaseUrl);
  }

  const counts = { total: 0, ready: 0, imported: 0, skipped: 0, review: 0, failed: 0, nonFixpointSkipped: 0 };
  const reasons = [];
  const labels = { skipped: '跳过', review: '待核验', failed: '失败' };
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    counts.total += 1;
    const at = file + ':' + (i + 1);
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      counts.failed += 1;
      reasons.push(at + ' [失败] JSON 解析失败');
      continue;
    }
    let result;
    try {
      result = validateImportRecord(rec);
    } catch {
      counts.failed += 1;
      reasons.push(at + ' [失败] 记录校验失败');
      continue;
    }
    if (result.status !== 'ready') {
      counts[result.status] += 1;
      reasons.push(at + ' [' + labels[result.status] + '] ' + result.reason);
      continue;
    }
    for (const warning of result.warnings) reasons.push(at + ' [提示] ' + warning);
    if (args.dryRun) {
      counts.ready += 1;
      continue;
    }
    try {
      const twin = await findNonFixpointTwin(sql, result.record);
      if (twin) {
        counts.nonFixpointSkipped += 1;
        reasons.push(at + ' [拦截] 与既有非不动点行 id=' + twin.id + ' 归一后身份相同，跳过写入');
        continue;
      }
      await writeImportRecord(sql, result.record);
      counts.imported += 1;
    } catch (error) {
      counts.failed += 1;
      reasons.push(at + ' [失败] 入库失败：' + (error instanceof Error ? error.message : String(error)));
    }
  }

  if (reasons.length > 0) {
    log('校验/导入明细:');
    for (const reason of reasons) log(' - ' + reason);
  }
  // 非不动点拦截单独汇总。放在主汇总行之前，让主汇总行保持为最后一行
  // （既有工具与测试按最后一行解析）；dry-run 不跑护栏，不打这行。
  if (!args.dryRun) log('本次因非不动点孪生行跳过 ' + counts.nonFixpointSkipped + ' 条');
  log((args.dryRun ? '[dry-run] ' : '') + '总数 ' + counts.total +
    (args.dryRun ? ' / 可导入 ' + counts.ready : ' / 入库 ' + counts.imported) +
    ' / 跳过 ' + counts.skipped + ' / 待核验 ' + counts.review + ' / 失败 ' + counts.failed);
  // 有拦截即非 0 退出：写入被跳过属于需要人看的信号，不能静默成功。
  return counts.failed > 0 || counts.nonFixpointSkipped > 0 ? 1 : 0;
}

// 导出纯函数便于本地自测;直接运行时才连库
export {
  cleanJson, cleanString, loadEnvFile, parseArgs, parseQuality,
  run, titleMatches, validateImportRecord, writeImportRecord,
};

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  run().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
