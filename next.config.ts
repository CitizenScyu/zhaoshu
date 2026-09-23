import type { NextConfig } from "next";

// 全站安全响应头（review-42 MS-11）：点击劫持、MIME 嗅探、Referrer 泄漏三道基础防线。
// 写法按 node_modules/next/dist/docs 的 headers 文档（Next 16.3.5）：headers() 返回
// { source, headers: [{ key, value }] } 数组；source 的匹配在 pages/public 之前生效。
// CSP 需为 Next 内联脚本逐个配 nonce，成本高，本轮后置。
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
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
