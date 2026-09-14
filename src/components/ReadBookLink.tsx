'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useOwner } from '@/components/OwnerProvider';

interface Props {
  taskId?: number | null;
  title: string;
  from: 'library' | 'shelf';
}

export default function ReadBookLink(props: Props) {
  const { ready, token } = useOwner();
  if (!ready || !token || !props.taskId) return null;
  return <AvailableBook key={`${props.taskId}:${token}`} {...props} taskId={props.taskId} />;
}

function AvailableBook({ taskId, title, from }: Props & { taskId: number }) {
  const { apiFetch } = useOwner();
  const slot = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState<'checking' | 'available' | 'missing' | 'error'>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let started = false;
    async function check() {
      if (started || controller.signal.aborted) return;
      started = true;
      setStatus('checking');
      try {
        const response = await apiFetch(`/api/read/${taskId}/availability`, { signal: controller.signal, cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error('无法检查文件');
        if (!controller.signal.aborted) setStatus(data.available === true ? 'available' : 'missing');
      } catch {
        if (!controller.signal.aborted) setStatus('error');
      }
    }
    // Only check completed downloads on cards near the viewport; no TXT is fetched.
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        void check();
      }
    }, { rootMargin: '160px' });
    if (observer && slot.current) observer.observe(slot.current);
    else queueMicrotask(() => void check());
    return () => { observer?.disconnect(); controller.abort(); };
  }, [apiFetch, taskId, attempt]);

  return (
    <span ref={slot} className="inline-flex" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      {status === 'available' ? (
        <Link
          href={`/read/${taskId}?from=${from}`}
          prefetch={false}
          className="chip chip-dai !inline-flex min-h-11 items-center justify-center !px-4 !text-sm"
          aria-label={`阅读《${title}》`}
        >阅读 →</Link>
      ) : (
        <button
          className="chip !text-xs disabled:opacity-60"
          disabled={status === 'checking'}
          title={status === 'missing' ? '文件不存在、为空或超过阅读大小限制；可稍后重新检查' : undefined}
          onClick={() => setAttempt((value) => value + 1)}
        >
          {status === 'checking' ? '检查阅读文件…' : status === 'missing' ? '文件暂不可读 · 重查' : '重试阅读检查'}
        </button>
      )}
    </span>
  );
}
