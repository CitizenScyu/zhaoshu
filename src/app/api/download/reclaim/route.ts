import { timingSafeEqual } from 'node:crypto';
import { after } from 'next/server';
import { NextRequest } from 'next/server';
import { authJson } from '@/lib/auth-http';
import { ensureSchema, getSql } from '@/lib/db';
import { reclaimStaleTasks } from '@/lib/download-task-reclaim';

// F16：过期下载租约的兜底回收入口。Vercel Hobby 计划限「每项目 2 个 cron、每天一次」，
// 更密的表达式会让部署直接失败，因此这里只做每日兜底（见 vercel.json）。
// 主要恢复路径不依赖 cron：GET 返回派生 leaseExpired，UI 给受控重试，重试走 POST 时会先回收。
// 不引入常驻进程，无新运行时依赖。
//
// F15 残留③：本 cron 窗口顺带做画像吸收 drain（动态 import，见下），因为 Hobby 的
// 2-cron 上限容不下第三条。drain 是模型调用（分钟级），不能占本路由 30s 的响应——
// 用 after() 挂到响应后执行，失败也不影响回收结果本身。
export const maxDuration = 30;

function equalSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 与 /api/shuyuan 的 cron 路径同款：只认 CRON_SECRET 的 Bearer 头，未配置则 fail closed。
function cronAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const authorization = req.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') && equalSecret(authorization.slice(7), expected);
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return authJson({ error: 'forbidden', code: 'FORBIDDEN' }, { status: 403 });
  }
  try {
    await ensureSchema();
    await reclaimStaleTasks(getSql());
    // F15 drain 挂接：动态 import 打断路由对 drain 模块的静态依赖（drain 拉进 chatRobust
    // 一整串模型客户端代码，静态 import 会把它们全并进本路由的 bundle）。after() 保证
    // 30s 响应先落地；drain 内部逐用户独立预算与租约，中断/失败自愈（明日窗口重试）。
    after(async () => {
      try {
        const { drainProfileFeedbackQueue } = await import('../../profile/absorb/drain/route');
        const drained = await drainProfileFeedbackQueue();
        console.log('profile absorb drain done', { drained: drained.length });
      } catch (error) {
        console.error('profile absorb drain (after reclaim) failed',
          error instanceof Error ? { name: error.name } : error);
      }
    });
    return authJson({ ok: true });
  } catch (e) {
    console.error('download reclaim failed', e);
    return authJson({ error: 'db error', code: 'DB_ERROR' }, { status: 500 });
  }
}
