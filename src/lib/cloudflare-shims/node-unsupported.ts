/* Cloudflare 构建专用 shim：Node-only 依赖的替身。
 *
 * 作用有两个：
 * 1. 让 webpack 能解析 `redis` / `better-sqlite3` 这类在 Workers 上无法运行的包；
 * 2. 万一线上真的走到这些分支，抛出明确错误而不是神秘的 500。
 */

function unsupported(name = 'This Node-only package'): never {
  throw new Error(`${name} is not supported in Cloudflare Workers`);
}

export function createClient(): never {
  return unsupported('redis');
}

const shim: any = new Proxy(
  function nodeUnsupportedDefault() {
    unsupported();
  },
  {
    apply: () => unsupported(),
    construct: () => unsupported(),
    get: (_target, prop) => {
      if (prop === 'default') return shim;
      return () => unsupported(String(prop));
    },
  }
);

export default shim;
