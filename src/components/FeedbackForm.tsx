'use client';

import { useEffect, useRef, useState } from 'react';
import { useOwner } from './OwnerProvider';
import FeedbackEditor from './FeedbackEditor';
import { feedbackNeedsConfirmation, feedbackReductionMessage, readFeedbackSnapshot, type FeedbackSnapshot } from '@/lib/feedback';
import type { FeedbackStatus } from '@/lib/types';

export default function FeedbackForm({ title, author, status, initialSnapshot, clearInitially = false, onSaved, onCancel, onBusyChange }: {
  title: string;
  author: string;
  status: FeedbackStatus;
  initialSnapshot?: FeedbackSnapshot;
  clearInitially?: boolean;
  onSaved: (note: string, profileUpdated: boolean) => void;
  onCancel: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { apiFetch } = useOwner();
  const [baseline, setBaseline] = useState<FeedbackSnapshot | null>(initialSnapshot ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<FeedbackSnapshot | null>(null);
  const [conflictDetected, setConflictDetected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const currentBaseline = useRef(baseline);
  const initial = useRef(initialSnapshot);
  useEffect(() => { currentBaseline.current = baseline; }, [baseline]);

  useEffect(() => () => { operation.current?.abort(); onBusyChange(false); }, [onBusyChange]);

  useEffect(() => {
    if (initial.current && attempt === 0) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setBusy(true); onBusyChange(true);
      void apiFetch('/api/feedback?' + new URLSearchParams({ title, author }), { signal: controller.signal, cache: 'no-store' }).then(async (res) => {
        const data = await res.json();
        controller.signal.throwIfAborted();
        const snapshot = readFeedbackSnapshot(data.current);
        if (!res.ok || !snapshot) throw new Error('读取当前反馈失败，请重试');
        if (currentBaseline.current) { setConflict(snapshot); setConflictDetected(true); }
        else setBaseline(snapshot);
        setError('');
      }).catch((error) => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '读取当前反馈失败');
      }).finally(() => {
        if (!controller.signal.aborted) { setBusy(false); onBusyChange(false); }
      });
    });
    return () => controller.abort();
  }, [apiFetch, title, author, attempt, onBusyChange]);

  async function save(note: string) {
    if (!baseline || busy || conflictDetected || operation.current) return;
    const confirmNoteReduction = feedbackNeedsConfirmation(baseline.note, note);
    if (confirmNoteReduction && !window.confirm(feedbackReductionMessage(baseline.note, note))) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); onBusyChange(true); setError('');
    try {
      const res = await apiFetch('/api/feedback', {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, author, status, note, expectedFeedbackId: baseline.version, confirmNoteReduction }),
      });
      const data = await res.json();
      controller.signal.throwIfAborted();
      if (res.status === 409) {
        setConflict(readFeedbackSnapshot(data.current));
        setConflictDetected(true);
        setError('反馈有新改动，草稿已保留。请先对比线上反馈。');
        return;
      }
      if (!res.ok || data.ok !== true) throw new Error(typeof data.error === 'string' ? data.error : '保存反馈失败');
      onSaved(note, data.profileUpdated === true);
    } catch (error) {
      if (!controller.signal.aborted) setError((error instanceof Error ? error.message : '保存反馈失败') + '，草稿已保留。');
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) { setBusy(false); onBusyChange(false); }
    }
  }

  return <div className="w-full">
    {error && <p role="alert" className="mt-3 text-xs" style={{ color: 'var(--cinnabar)' }}>{error}</p>}
    {conflictDetected && <div className="mt-3 border-l-2 pl-3 text-xs leading-6" style={{ borderColor: 'var(--cinnabar)' }}>
      <p className="font-bold">线上最新反馈</p>
      {conflict ? <>
        <p className="whitespace-pre-wrap break-words">{conflict.note || '（暂无原因）'}</p>
        <button type="button" className="chip mt-2" disabled={busy} onClick={() => {
          setBaseline(conflict); setConflictDetected(false); setConflict(null); setError('');
        }}>已对比，保留草稿继续编辑</button>
      </> : <button type="button" className="chip" disabled={busy} onClick={() => setAttempt((value) => value + 1)}>重读线上反馈</button>}
    </div>}
    {baseline ? <FeedbackEditor
      status={status} initialNote={baseline.note} clearInitially={clearInitially} busy={busy}
      saveDisabled={conflictDetected} onSubmit={save} onCancel={onCancel}
    /> : <div className="mt-3 text-xs">
      {busy ? <p role="status">正在读取已有反馈…</p> : <button type="button" className="chip" onClick={() => setAttempt((value) => value + 1)}>重读反馈</button>}
      <button type="button" className="chip ml-2" onClick={onCancel}>取消</button>
    </div>}
  </div>;
}
