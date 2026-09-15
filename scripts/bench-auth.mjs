// 受控性能测量（设计 §1.2 / 任务 30.1）：不含任何真实密码，输入全部来自随机字节。
// Vercel Preview 不可用时交付本地 Node 测量；目标热 KDF p95<1s、热登录 p95<2s 仅为参考目标。
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [major] = process.versions.node.split('.').map(Number);
if (pkg.engines?.node && major < 22) {
  console.error(`This benchmark expects Node 22.x per package.json engines; current is ${process.versions.node}.`);
  process.exit(2);
}

const N = 131072;
const R = 8;
const P = 1;
const MAXMEM = 256 * 1024 * 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

const rounds = Number(process.argv[2] ?? 10);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 200) {
  console.error('Usage: node scripts/bench-auth.mjs [rounds=10]');
  process.exit(2);
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAXMEM }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function percentile(sorted, pct) {
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function summarize(label, samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  console.log(`${label}: rounds=${sorted.length} min=${sorted[0].toFixed(1)}ms p50=${percentile(sorted, 50).toFixed(1)}ms p95=${percentile(sorted, 95).toFixed(1)}ms max=${sorted[sorted.length - 1].toFixed(1)}ms`);
}

let peakRss = process.memoryUsage().rss;
function sampleRss() {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}

// 每轮都生成新的随机盐与随机“密码”字节；脚本本身不包含、也不接受任何真实口令。
async function oneKdf() {
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(SALT_BYTES);
  const start = performance.now();
  const key = await scryptAsync(password, salt);
  sampleRss();
  return { ms: performance.now() - start, key, salt, password };
}

const rssBefore = process.memoryUsage().rss;
const heapBefore = process.memoryUsage().heapUsed;

// 冷启动：进程内第一次 KDF（包含 crypto 初始化与首次分配工作内存）。
const cold = await oneKdf();
console.log(`cold KDF: ${cold.ms.toFixed(1)}ms (N=${N} r=${R} p=${P} maxmem=256MiB key=${KEY_BYTES}B)`);

// 热 KDF：稳态单次派生成本。
const warm = [];
for (let i = 0; i < rounds; i++) {
  const { ms } = await oneKdf();
  warm.push(ms);
}
summarize('warm KDF', warm);

// 热登录：完整 KDF + timingSafeEqual 比较（口令校验路径的全部计算）。
const loginSalt = randomBytes(SALT_BYTES);
const loginPassword = randomBytes(24).toString('base64url');
const loginKey = await scryptAsync(loginPassword, loginSalt);
const logins = [];
for (let i = 0; i < rounds; i++) {
  const start = performance.now();
  const key = await scryptAsync(loginPassword, loginSalt);
  const ok = key.length === loginKey.length && timingSafeEqual(key, loginKey);
  logins.push(performance.now() - start);
  if (!ok) throw new Error('benchmark self-check failed');
}
summarize('warm login (KDF + timingSafeEqual)', logins);

// 两并发 KDF：单实例并发上限 2 时的墙钟成本。
const concurrent = [];
for (let i = 0; i < Math.max(2, Math.round(rounds / 2)); i++) {
  const start = performance.now();
  await Promise.all([oneKdf(), oneKdf()]);
  concurrent.push(performance.now() - start);
}
summarize('2 concurrent KDFs (wall clock per pair)', concurrent);

const rssAfter = process.memoryUsage().rss;
const heapAfter = process.memoryUsage().heapUsed;
console.log(`RSS: before=${(rssBefore / 1048576).toFixed(1)}MiB after=${(rssAfter / 1048576).toFixed(1)}MiB peak≈${(peakRss / 1048576).toFixed(1)}MiB`);
console.log(`heapUsed: before=${(heapBefore / 1048576).toFixed(1)}MiB after=${(heapAfter / 1048576).toFixed(1)}MiB`);
console.log('All benchmark inputs were random bytes; no real password was hashed.');
