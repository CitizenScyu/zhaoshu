// 测试夹具：在 Windows（管道同步写）上模拟 POSIX 管道的异步写语义，供 engine-fetch 截断回归用。
// 用法：node --import <本文件 file:// URL> …；PIPE_SHIM_SYNC_BYTES=每条流可同步写出的字节数
// （默认 65536 = Linux 管道缓冲），超出部分进队列、稍后才真正写出并回调——与 libuv 在管道满时的
// 行为同构：write() 立即返回，process.exit() 会丢掉队列里的尾部。
const SYNC_BYTES = Number(process.env.PIPE_SHIM_SYNC_BYTES ?? 65536);
const DELAY_MS = 30;

for (const stream of [process.stdout, process.stderr]) {
  const realWrite = stream.write.bind(stream);
  let budget = SYNC_BYTES;
  const queue = [];
  let draining = false;

  const drain = () => {
    const next = queue.shift();
    if (!next) { draining = false; return; }
    realWrite(next.buf);
    next.cb?.();
    setTimeout(drain, DELAY_MS);
  };

  stream.write = (chunk, encoding, cb) => {
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding ?? 'utf8');
    if (!draining && queue.length === 0) {
      const head = buf.subarray(0, Math.max(budget, 0));
      budget -= head.length;
      if (head.length) realWrite(head);
      if (head.length === buf.length) {
        if (cb) process.nextTick(cb);
        return true;
      }
      queue.push({ buf: buf.subarray(head.length), cb });
    } else {
      queue.push({ buf, cb });
    }
    if (!draining) { draining = true; setTimeout(drain, DELAY_MS); }
    return false;
  };
}
