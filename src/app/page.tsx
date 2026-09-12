'use client';

import { useState } from 'react';
import FindTab from '@/components/FindTab';
import ShelfTab from '@/components/ShelfTab';
import ProfileTab from '@/components/ProfileTab';

type Tab = 'find' | 'shelf' | 'profile';

const TABS: { key: Tab; label: string }[] = [
  { key: 'find', label: '找书' },
  { key: 'shelf', label: '书架' },
  { key: 'profile', label: '画像' },
];

export default function Home() {
  const [tab, setTab] = useState<Tab>('find');

  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶栏 */}
      <header className="flex items-end gap-5 px-6 sm:px-10 pt-8 pb-0 max-w-5xl w-full mx-auto">
        <div className="seal w-14 h-14 text-xl rotate-[-3deg] shrink-0 ink-rise">书径</div>
        <div className="pb-1 ink-rise" style={{ animationDelay: '0.08s' }}>
          <h1 className="text-2xl tracking-[0.3em] font-bold">书径</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--ink-faint)' }}>
            书山有路 · 按口味寻径
          </p>
        </div>
        <span
          className="vertical-motto hidden md:block ml-auto pb-2 h-24 ink-rise"
          style={{ animationDelay: '0.16s' }}
        >
          彼仙我毒 · 交叉验证 · 宁缺毋滥
        </span>
      </header>

      {/* 书签 Tab */}
      <nav className="flex gap-2 px-6 sm:px-10 pt-6 max-w-5xl w-full mx-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`bookmark-tab text-sm ${tab === t.key ? 'active' : 'hover:text-[var(--ink)]'}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* 内容区：纸面卡片 */}
      <main className="max-w-5xl w-full mx-6 sm:mx-10 lg:mx-auto px-0 flex-1">
        <div
          className="border-t border-[var(--line)] bg-[var(--paper-card)]/60 px-5 sm:px-8 py-8"
          style={{ boxShadow: '0 4px 24px rgba(46,42,35,0.05)' }}
        >
          {tab === 'find' && <FindTab />}
          {tab === 'shelf' && <ShelfTab />}
          {tab === 'profile' && <ProfileTab />}
        </div>
      </main>

      <footer className="text-center text-xs py-6" style={{ color: 'var(--ink-faint)' }}>
        LLM 召回 · 豆瓣验证 · 口味画像 —— 评分仅供参考，彼仙我毒是常态
      </footer>
    </div>
  );
}
