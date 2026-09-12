import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '书径 · 找书',
  description: '按口味找网络小说：LLM 召回 · 豆瓣验证 · 画像重排',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        {/* 霞鹜文楷屏幕版（按 unicode-range 分包，按需加载） */}
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/style.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
