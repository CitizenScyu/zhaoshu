// 复现脚本：认证请求 200 响应头到达后正文永不结束 → 队列卡死。
// 用 vite-node 跑（auth-client.ts 用了 TS 参数属性，strip-types 不支持）。
// node 的 fetch 里，「headers 已到、body 永不发」用「pending body 的 Response」模拟
// （返回这个 Response 就等于响应头已到达）。abort 的传导用 signal 监听反映；
// 正文读取是否受 signal 控制无关紧要，关键是 response.json() 的 promise
// 永不 settle 时 controller 的行为。
import { AuthController } from './src/lib/auth-client';

const ORIGIN = 'https://books.example';

const store = {
  value: '',
  read: () => store.value,
  readSessionOnly: () => false,
  write: () => {},
  clear: () => {},
};

const pendingBody = new ReadableStream({
  start() { /* 永不 enqueue、永不 close：正文半截且永不结束 */ },
});

const fetchCalls = [];
globalThis.fetch = (async (input) => {
  const req = input instanceof Request ? input : new Request(input);
  fetchCalls.push(req);
  req.signal.addEventListener('abort', () => {
    console.log(`[t=${Date.now() - t0}ms] signal aborted, reason=`, (req.signal.reason)?.name);
    try { pendingBody.cancel(req.signal.reason).catch(() => {}); } catch { /* noop */ }
  });
  return new Response(pendingBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
});

const t0 = Date.now();
const instance = new AuthController({
  origin: () => ORIGIN,
  storage: store,
  requestTimeoutMs: 20,
});

const log = (tag, p) => {
  p.then(() => console.log(`[t=${Date.now() - t0}ms] ${tag}: RESOLVED`), (e) => console.log(`[t=${Date.now() - t0}ms] ${tag}: REJECTED ${(e)?.name}`));
};

log('start', instance.start());
setTimeout(() => {
  log('refresh-after', instance.refresh('visible'));
}, 100);

setTimeout(() => {
  console.log(`--- t=2500ms 收割 ---`);
  console.log('fetchCalls =', fetchCalls.length, 'aborted =', fetchCalls.map((c) => c.signal.aborted));
  console.log('phase =', instance.state.phase);
  console.log('AUTH_STUCK_REPRODUCED');
  process.exit(0);
}, 2500);
