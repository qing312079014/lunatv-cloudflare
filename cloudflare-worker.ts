// Cloudflare Workers 自定义入口。
// OpenNext 生成的 .open-next/worker.js 只导出 fetch，这里补上 scheduled（Cron Triggers）。
// 参考：https://opennext.js.org/cloudflare/howtos/custom-worker

// @ts-ignore 构建期由 opennextjs-cloudflare 生成
import openNextWorker from './.open-next/worker.js';

// @ts-ignore 构建期生成
export * from './.open-next/worker.js';

interface Env {
  [key: string]: unknown;
}

// 只用到 waitUntil / passThroughOnException，本地声明避免引入 @cloudflare/workers-types
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return openNextWorker.fetch(request, env, ctx);
  },

  // 每天 01:00 触发一次，等价于 vercel.json 里的 crons 配置。
  // 内部直接调用路由，避免绕公网回源。
  async scheduled(
    _event: unknown,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const url = new URL('/api/cron', 'https://internal.invalid');
    try {
      await openNextWorker.fetch(new Request(url), env, ctx);
    } catch (err) {
      console.error('scheduled cron failed:', err);
    }
  },
};
