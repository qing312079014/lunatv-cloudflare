import type { OpenNextConfig } from '@opennextjs/cloudflare';

const config: OpenNextConfig = {
  default: {
    override: {
      wrapper: 'cloudflare-node',
      converter: 'edge',
      proxyExternalRequest: 'fetch',
      // LunaTV 页面基本都是 force-dynamic，不需要 ISR 缓存。
      // 若以后要用 ISR，把这里换成 r2 / kv 缓存并配置对应 binding。
      incrementalCache: 'dummy',
      tagCache: 'dummy',
      queue: 'dummy',
    },
  },
  // middleware 单独打成 edge 函数（只用 WebCrypto，不依赖 Node API）
  middleware: {
    external: true,
    override: {
      wrapper: 'cloudflare-edge',
      converter: 'edge',
      proxyExternalRequest: 'fetch',
      incrementalCache: 'dummy',
      tagCache: 'dummy',
      queue: 'dummy',
    },
  },
  edgeExternals: [
    'node:crypto',
    'node:async_hooks',
    'node:buffer',
    'node:stream',
    'node:util',
    'node:events',
    'node:path',
    'node:url',
    'node:fs',
    'node:http',
    'node:https',
    'node:net',
    'node:tls',
    'node:dns',
    'node:os',
    'node:zlib',
    'node:vm',
    'node:child_process',
    'node:string_decoder',
    'node:tty',
    'node:assert',
    'node:punycode',
    'node:timers',
    'node:worker_threads',
  ],
};

export default config;
