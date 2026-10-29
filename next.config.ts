import type { NextConfig } from "next";

// 全站安全响应头（review-42 MS-11）：点击劫持、MIME 嗅探、Referrer 泄漏、强制 HTTPS 四道基础防线。
// 写法按 node_modules/next/dist/docs 的 headers 文档（Next 16.3.5）：headers() 返回
// { source, headers: [{ key, value }] } 数组；source 的匹配在 pages/public 之前生效。
// CSP 需为 Next 内联脚本逐个配 nonce，成本高，本轮后置。
// HSTS（infrasyn-42 切换阻断项）：站点只经 HTTPS 提供服务（phoenix nginx / Vercel 都是），
// max-age=31536000（1 年）+ includeSubDomains。不加 preload——提交进浏览器预载清单基本不可逆，
// 须用户明确授权后再说。
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // 自托管入口（infrasyn-42 M5）：构建产出 .next/standalone/server.js，phoenix 的
  // zhaoshu-web.service 以它为入口（standalone 不含 public 与 .next/static，须手拷）。
  // Vercel 构建兼容此键、行为不变。
  output: "standalone",
  // qjsext1029：QuickJS 沙箱包不进服务端 bundle，运行时原生 require（standalone 追踪进 node_modules）。
  // 内联时 Turbopack 产出的 singlefile 变体 chunk（内嵌 wasm 的大模板字符串）在 Node 下解析失败
  // （SyntaxError: Octal escape sequences are not allowed in template strings → ChunkLoadError），
  // 2026-10-29 生产开 JS 开关后刷新 502 即此。
  serverExternalPackages: ["quickjs-emscripten-core", "@jitl/quickjs-singlefile-cjs-release-sync"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
