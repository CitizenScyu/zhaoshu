// 固定清单 blob 只读取回适配：按官方 git blobs 相对端点取回单个清单 blob 的**解码原始字节**。
// 纯适配层：注入已认证只读 JSON 请求函数；无默认 fetch/token/env/host 参数；不重试或回退 contents。
//
// 边界约定（见 capacity970 合同）：
//   - 唯一路由 /repos/{owner}/{repo}/git/blobs/{sha}；owner/repo 单段编码，branch 不入路由仅作身份。
//   - 每次调用在第一个 await 前取调用 target 与 SHA 的原语快照；错绑/非法 SHA **零请求**。
//   - 就地信封校验后进入本片**材料门**：M/E/N/C 额度、严格 base64 唯一表示、原字节 Git blob hash。
//   - 只限制 json() 之后的材料；**不**限制传输/解压/JSON 解析前内存（真实请求器另交）。
//   - 不接 969/959/955；不把固定 blob 字节称为有效清单、已验证逻辑容量或仓级 inventory。

import { gitBlobSha } from '../src/lib/artifact-bytes';
import type { TreeTarget } from './reconcile-tree-snapshot';
import type { GitHubJsonRequest } from './reconcile-tree-github';

/** Git 对象 ID：40 位小写十六进制。 */
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/;

/** M：4 MiB 解码字节上限。 */
const MAX_DECODED_BYTES = 4 * 1024 * 1024;                       // 4,194,304
/** E：非折行 base64 ASCII 字符上限（含 padding）= 4×ceil(M/3)。 */
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_DECODED_BYTES / 3);   // 5,592,408
/** N：CR/LF 折行字符独立额度（CRLF 计 2）。 */
const MAX_FOLD_CHARS = 192 * 1024;                               // 196,608
/** C：JSON 解析后 content 字符串 UTF-16 code unit 上限 = E + N。 */
const MAX_CONTENT_UNITS = MAX_BASE64_CHARS + MAX_FOLD_CHARS;     // 5,789,016

export type GitHubManifestBlobErrorCode =
  | 'GITHUB_BLOB_INVALID_TARGET'
  | 'GITHUB_BLOB_TARGET_MISMATCH'
  | 'GITHUB_BLOB_INVALID_REQUEST'
  | 'GITHUB_BLOB_HTTP'
  | 'GITHUB_BLOB_MALFORMED'
  | 'GITHUB_BLOB_SHA_MISMATCH'
  | 'GITHUB_BLOB_SIZE_LIMIT'
  | 'GITHUB_BLOB_INVALID_BASE64'
  | 'GITHUB_BLOB_SIZE_MISMATCH'
  | 'GITHUB_BLOB_HASH_MISMATCH';

export class GitHubManifestBlobError extends Error {
  readonly code: GitHubManifestBlobErrorCode;
  readonly status?: number;
  constructor(code: GitHubManifestBlobErrorCode, status?: number) {
    super(status === undefined ? code : `${code}_${status}`);
    this.name = 'GitHubManifestBlobError';
    this.code = code;
    if (status !== undefined) this.status = status; // 仅 HTTP 可带已校验数字 status
  }
}

export interface FixedManifestBlobBytes {
  status: 'fixed_manifest_blob_bytes';
  target: TreeTarget;
  manifestGitBlobSha: string;
  bytes: Uint8Array;
}

export interface GitHubManifestBlobReaderOptions {
  request: GitHubJsonRequest;
  target: TreeTarget;
}

export interface GitHubManifestBlobReader {
  readManifestBlob(target: TreeTarget, manifestGitBlobSha: string): Promise<FixedManifestBlobBytes>;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object';

/** 拒绝孤立 UTF-16 代理项（UTF-8 编码会同码折叠，见 capacity959 F1）；不改写文本。 */
function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (n < 0xdc00 || n > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** 身份文本基础合法性：非空、无 NUL、无孤立代理项。 */
function isSafeText(value: unknown): value is string {
  return isStr(value) && value.length > 0 && !value.includes('\0') && !hasUnpairedSurrogate(value);
}

const isGitObjectId = (value: unknown): value is string =>
  isStr(value) && GIT_OBJECT_ID.test(value);

/** owner/repo 单路径段：拒原始斜杠与点段，再一次编码。 */
function encodeSegment(value: string): string {
  if (value.includes('/')) throw new GitHubManifestBlobError('GITHUB_BLOB_INVALID_TARGET');
  if (value === '.' || value === '..') throw new GitHubManifestBlobError('GITHUB_BLOB_INVALID_TARGET');
  return encodeURIComponent(value);
}

/** 防御：自建路由必须是相对的（绝不含 scheme 或 protocol-relative 命首）。 */
function assertRelativeRoute(route: string): string {
  if (!route.startsWith('/') || route.startsWith('//') || route.includes('://')) {
    throw new GitHubManifestBlobError('GITHUB_BLOB_INVALID_REQUEST');
  }
  return route;
}

function classifyBase64Char(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)
    || c === 0x2b || c === 0x2f || c === 0x3d; // A-Z a-z 0-9 + / =
}

/**
 * 创建 GitHub 清单 blob 只读回适配。工厂保存**私有目标原语**；生产注入须固定官方 host、
 * 只读 GET、禁自动重试/重定向（3xx 交信封处理）——本层不证明底层物理请求次数或认证实现。
 */
export function createGitHubManifestBlobReader(options: GitHubManifestBlobReaderOptions): GitHubManifestBlobReader {
  if (!isObj(options) || typeof options.request !== 'function' || !isObj(options.target)) {
    throw new GitHubManifestBlobError('GITHUB_BLOB_INVALID_TARGET');
  }
  const request = options.request;
  const fixed: TreeTarget = {
    repositoryId: options.target.repositoryId,
    owner: options.target.owner,
    repo: options.target.repo,
    branch: options.target.branch,
  };
  if (!Number.isSafeInteger(fixed.repositoryId) || fixed.repositoryId <= 0
    || !isSafeText(fixed.owner) || !isSafeText(fixed.repo) || !isSafeText(fixed.branch)) {
    throw new GitHubManifestBlobError('GITHUB_BLOB_INVALID_TARGET');
  }
  if (fixed.branch === '.' || fixed.branch === '..') throw new GitHubManifestBlobError('GITHUB_BLOB_INVALID_TARGET');
  const ownerSeg = encodeSegment(fixed.owner);
  const repoSeg = encodeSegment(fixed.repo);
  const prefix = `/repos/${ownerSeg}/${repoSeg}/git/blobs`;

  async function readManifestBlob(target: TreeTarget, manifestGitBlobSha: string): Promise<FixedManifestBlobBytes> {
    // 第一个 await 之前：调用 target 与 SHA 的原语快照。
    if (!isObj(target)) throw new GitHubManifestBlobError('GITHUB_BLOB_TARGET_MISMATCH');
    const call: TreeTarget = {
      repositoryId: target.repositoryId, owner: target.owner, repo: target.repo, branch: target.branch,
    };
    if (call.repositoryId !== fixed.repositoryId || call.owner !== fixed.owner
      || call.repo !== fixed.repo || call.branch !== fixed.branch) {
      throw new GitHubManifestBlobError('GITHUB_BLOB_TARGET_MISMATCH');
    }
    if (!isGitObjectId(manifestGitBlobSha)) throw new GitHubManifestBlobError('GITHUB_BLOB_INVALID_REQUEST');
    const route = assertRelativeRoute(`${prefix}/${manifestGitBlobSha}`);

    // 每次 read 最多一次注入请求；异常原引用透传。
    const res = await request(route);

    // 信封：非 null 对象且非数组；status 有限整数 100..599。
    if (!isObj(res) || Array.isArray(res)) throw new GitHubManifestBlobError('GITHUB_BLOB_MALFORMED');
    const status = res.status;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
      throw new GitHubManifestBlobError('GITHUB_BLOB_MALFORMED');
    }
    if (status < 200 || status >= 300) throw new GitHubManifestBlobError('GITHUB_BLOB_HTTP', status); // 不读正文
    const json = res.json;
    if (typeof json !== 'function') throw new GitHubManifestBlobError('GITHUB_BLOB_MALFORMED');
    const body = await (json as () => Promise<unknown>).call(res); // 保留 receiver、调用一次

    // JSON 对象：取 sha/encoding/content/size 四原语局部。
    if (!isObj(body) || Array.isArray(body)) throw new GitHubManifestBlobError('GITHUB_BLOB_MALFORMED');
    const sha = body.sha, encoding = body.encoding, content = body.content, size = body.size;
    if (!isGitObjectId(sha) || encoding !== 'base64' || !isStr(content)
      || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw new GitHubManifestBlobError('GITHUB_BLOB_MALFORMED');
    }
    if (sha !== manifestGitBlobSha) throw new GitHubManifestBlobError('GITHUB_BLOB_SHA_MISMATCH');

    // 材料门：先拒 size>M 或 content 超 C，之后才扫描。
    if (size > MAX_DECODED_BYTES || content.length > MAX_CONTENT_UNITS) {
      throw new GitHubManifestBlobError('GITHUB_BLOB_SIZE_LIMIT');
    }

    // 有界扫描：CR/LF 可移除但单独限额；其余仅 A-Za-z0-9+/=；其它空白/URL-safe 一律拒绝。
    const canonical: string[] = [];
    let nonFold = 0, fold = 0;
    for (let i = 0; i < content.length; i++) {
      const c = content.charCodeAt(i);
      if (c === 0x0d || c === 0x0a) {
        fold++;
        if (fold > MAX_FOLD_CHARS) throw new GitHubManifestBlobError('GITHUB_BLOB_SIZE_LIMIT');
        continue;
      }
      if (classifyBase64Char(c)) {
        nonFold++;
        if (nonFold > MAX_BASE64_CHARS) throw new GitHubManifestBlobError('GITHUB_BLOB_SIZE_LIMIT');
        canonical.push(String.fromCharCode(c));
        continue;
      }
      throw new GitHubManifestBlobError('GITHUB_BLOB_INVALID_BASE64');
    }
    const text = canonical.join('');

    // 语法：非空须为 4 的倍数；= 仅末尾、至多 2 个、只在最后四元组。
    let pad = 0;
    if (text.length > 0) {
      if (text.length % 4 !== 0) throw new GitHubManifestBlobError('GITHUB_BLOB_INVALID_BASE64');
      while (pad < text.length && text.charCodeAt(text.length - 1 - pad) === 0x3d) pad++;
      if (pad > 2) throw new GitHubManifestBlobError('GITHUB_BLOB_INVALID_BASE64');
      for (let i = 0; i < text.length - pad; i++) {
        if (text.charCodeAt(i) === 0x3d) throw new GitHubManifestBlobError('GITHUB_BLOB_INVALID_BASE64');
      }
    }
    // 预计解码长度 d：分配结果前完成 d>M 与 d≠size 两门。
    const d = text.length === 0 ? 0 : 3 * (text.length / 4) - pad;
    if (d > MAX_DECODED_BYTES) throw new GitHubManifestBlobError('GITHUB_BLOB_SIZE_LIMIT');
    if (d !== size) throw new GitHubManifestBlobError('GITHUB_BLOB_SIZE_MISMATCH');

    const decoded = Buffer.from(text, 'base64');
    if (decoded.byteLength !== d || decoded.byteLength !== size) {
      throw new GitHubManifestBlobError('GITHUB_BLOB_SIZE_MISMATCH');
    }
    // 重编码逐字符相等：拒绝非零 pad bits 等宽松解码可吞掉的非法表示。
    if (decoded.toString('base64') !== text) throw new GitHubManifestBlobError('GITHUB_BLOB_INVALID_BASE64');
    // 原始字节 Git blob hash 与固定期望比较。
    if (gitBlobSha(decoded) !== manifestGitBlobSha) throw new GitHubManifestBlobError('GITHUB_BLOB_HASH_MISMATCH');

    // 独立字节副本与新 target；不复用可变返回对象。
    return {
      status: 'fixed_manifest_blob_bytes',
      target: { repositoryId: call.repositoryId, owner: call.owner, repo: call.repo, branch: call.branch },
      manifestGitBlobSha,
      bytes: new Uint8Array(decoded),
    };
  }

  return { readManifestBlob };
}
