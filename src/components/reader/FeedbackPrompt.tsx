'use client';

import { useState } from 'react';
import FeedbackForm from '@/components/FeedbackForm';
import type { FeedbackStatus } from '@/lib/types';
import styles from './reader.module.css';

/**
 * 阅读器返回时的轻量反馈卡（T66）：读完 / 弃书，再顺手说一句话。
 * 编辑与提交完整复用 FeedbackForm（版本校验、冲突回显、原因减少确认都在那边），
 * 这里只做「入口」：引导文案 + 把用户送到既有链路，不新增反馈维度。
 */
export default function FeedbackPrompt({ title, author, onDone }: {
  title: string;
  author: string;
  onDone: () => void;
}) {
  const [status, setStatus] = useState<FeedbackStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ note: string; profileUpdated: boolean } | null>(null);

  if (saved) {
    return (
      <aside className={styles.prompt} role="region" aria-label="反馈已记录">
        <p className={styles.promptTitle}>已记下，谢谢。</p>
        <p className={styles.promptHint}>
          {saved.note ? '下次「找书」会带上这一条。' : '阅读状态已更新。'}
          {saved.profileUpdated ? '口味画像已随之更新。' : ''}
        </p>
        <div className={styles.promptActions}>
          <button className={styles.primary} onClick={onDone}>返回</button>
        </div>
      </aside>
    );
  }

  return (
    <aside className={styles.prompt} role="region" aria-label="阅读反馈">
      <p className={styles.promptTitle}>《{title}》读得怎么样？</p>
      <p className={styles.promptHint}>一句话就够，帮「找书」更懂你；不想说也可以直接返回。</p>
      {status
        ? <FeedbackForm
            title={title}
            author={author}
            status={status}
            onBusyChange={setBusy}
            onSaved={(note, profileUpdated) => setSaved({ note, profileUpdated })}
            onCancel={() => setStatus(null)}
          />
        : (
          <div className={styles.promptActions}>
            <button className={styles.primary} disabled={busy} onClick={() => setStatus('done')}>读完了</button>
            <button className={styles.secondary} disabled={busy} onClick={() => setStatus('dropped')}>弃书</button>
            <button className={styles.locate} onClick={onDone}>先不填，返回</button>
          </div>
        )}
    </aside>
  );
}
