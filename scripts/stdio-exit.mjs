// CLI 收尾：stdout/stderr 刷完再退出。
//
// POSIX 管道下 process.stdout/stderr 是异步写：write() 返回时，超出管道缓冲（Linux 64KB）的部分
// 还在 Node 的写队列里；紧接着 process.exit() 会把队列直接丢掉。labeler 经 subprocess 管道读
// engine-fetch 的 --json 输出，于是长目录/长正文的 JSON 恰好截在 65536 字节（labelerdiag41 实证：
// `utf-8 ... position 65535`、`Unterminated string`）。Windows 管道是同步写，本机复现不出来。
//
// 不改成「设 exitCode 自然退出」：引擎/DB 客户端可能留有活句柄，自然退出有挂死风险（labeler 只能等
// 超时）。这里保留强制退出，但先等两条流的写队列排空（写回调按序触发，空写回调 = 之前的写都已完成）。

const FLUSH_TIMEOUT_MS = 10_000; // 读端卡死/流已销毁时的兜底，防止收尾本身挂住

function drained(stream) {
  return new Promise((resolve) => {
    try {
      stream.write('', () => resolve());
    } catch {
      resolve(); // 流已关闭/销毁：没有可等的了
    }
  });
}

/** 等 stdout/stderr 写队列排空后以 code 退出（写失败如 EPIPE 也照常退出）。 */
export async function exitAfterFlush(code) {
  process.exitCode = code;
  const timer = setTimeout(() => process.exit(code), FLUSH_TIMEOUT_MS);
  timer.unref();
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  process.exit(code);
}
