import { describe, expect, it } from 'vitest';
import type { ProfileSnapshot } from './types';
import {
  contentChanged, createProfileDraft, profileDraftReducer as reduce, readProfileSnapshot, seedsChanged,
} from './profile-draft';

const saved: ProfileSnapshot = {
  seeds: [{ title: '原书', kind: 'love' }], content: '原画像', updatedAt: '2026-09-15 00:00:00.123456+00',
};
const latest: ProfileSnapshot = {
  seeds: [{ title: '新书', kind: 'drop', reason: '节奏慢' }], content: '另一窗口的画像', updatedAt: '2026-09-15 00:00:00.123457+00',
};
const loaded = () => reduce(createProfileDraft(), { type: 'load', profile: saved });
const edited = () => reduce(reduce(loaded(), {
  type: 'edit-seeds', seeds: [{ title: '我的书', kind: 'love', author: '作者' }],
}), { type: 'edit-content', content: '我的修订' });

describe('profile baseline, drafts and conflict recovery', () => {
  it('refreshes an untouched profile after a feedback update', () => {
    const state = reduce(loaded(), { type: 'load', profile: latest });
    expect(state).toEqual({ saved: latest, seeds: latest.seeds, content: latest.content, conflict: null, conflictDetected: false });
    expect(seedsChanged(state)).toBe(false);
    expect(contentChanged(state)).toBe(false);
  });

  it('preserves both drafts when returning to the tab or correcting credentials', () => {
    const state = edited();
    expect(reduce(state, { type: 'load', profile: saved })).toEqual(state);
  });

  it('detects another writer even when versions differ only within the same millisecond', () => {
    const state = edited();
    const conflict = reduce(state, { type: 'load', profile: latest });
    expect(conflict.saved).toEqual(saved);
    expect(conflict.seeds).toEqual(state.seeds);
    expect(conflict.content).toBe(state.content);
    expect(conflict.conflict).toEqual(latest);
    expect(conflict.conflictDetected).toBe(true);
  });

  it('discards seed additions, removals and edits by restoring the saved list', () => {
    for (const state of [edited(), reduce(loaded(), { type: 'edit-seeds', seeds: [] })]) {
      const discarded = reduce(state, { type: 'discard', scope: 'seeds' });
      expect(discarded.seeds).toEqual(saved.seeds);
      expect(discarded.content).toBe(state.content);
      expect(seedsChanged(discarded)).toBe(false);
    }
  });

  it('discards only the content draft and keeps seed edits', () => {
    const state = edited();
    const discarded = reduce(state, { type: 'discard', scope: 'content' });
    expect(discarded.content).toBe(saved.content);
    expect(discarded.seeds).toEqual(state.seeds);
    expect(contentChanged(discarded)).toBe(false);
  });

  it('accepts normalized seed saves while preserving an unfinished content draft', () => {
    const state = edited();
    const response = { ...saved, seeds: state.seeds, updatedAt: latest.updatedAt };
    const result = reduce(state, { type: 'saved', profile: response, scope: 'seeds' });
    expect(result.saved).toEqual(response);
    expect(result.content).toBe('我的修订');
    expect(seedsChanged(result)).toBe(false);
    expect(contentChanged(result)).toBe(true);
    expect(reduce(result, { type: 'discard', scope: 'content' }).content).toBe(saved.content);
  });

  it('saves content independently without accidentally accepting unfinished seed edits', () => {
    const state = edited();
    const response = { ...saved, content: state.content, updatedAt: latest.updatedAt };
    const result = reduce(state, { type: 'saved', profile: response, scope: 'content' });
    expect(result.saved).toEqual(response);
    expect(result.seeds).toEqual(state.seeds);
    expect(seedsChanged(result)).toBe(true);
    expect(contentChanged(result)).toBe(false);
    expect(reduce(result, { type: 'discard', scope: 'seeds' }).seeds).toEqual(saved.seeds);
  });

  it('retains a generated draft even when the conflict response cannot include the latest profile', () => {
    const generated = { seeds: saved.seeds, content: '冲突生成稿' };
    const state = reduce(loaded(), { type: 'conflict', profile: null, generated });
    expect(state.content).toBe(generated.content);
    expect(state.saved).toEqual(saved);
    expect(state.conflictDetected).toBe(true);
    const reloaded = reduce(state, { type: 'load', profile: latest });
    expect(reloaded.content).toBe(generated.content);
    expect(reloaded.seeds).toEqual(generated.seeds);
    expect(reloaded.conflict).toEqual(latest);
  });

  it('does not silently settle a conflict just because drafts match the old baseline', () => {
    const state = reduce(loaded(), { type: 'conflict', profile: latest });
    const reloaded = reduce(state, { type: 'load', profile: latest });
    expect(reloaded.saved).toEqual(saved);
    expect(reloaded.conflictDetected).toBe(true);
  });

  it('accepts the latest server data only after an explicit choice', () => {
    const state = reduce(edited(), { type: 'conflict', profile: latest });
    const chosen = reduce(state, { type: 'use-latest' });
    expect(chosen.saved).toEqual(latest);
    expect(chosen.seeds).toEqual(latest.seeds);
    expect(chosen.content).toBe(latest.content);
    expect(chosen.conflictDetected).toBe(false);
  });

  it('keeps merged edits through another conflict and accepts them only after a successful save', () => {
    const state = reduce(edited(), { type: 'conflict', profile: latest });
    const newer = { ...latest, updatedAt: '2026-09-15 00:00:00.123458+00', content: '第三次更新' };
    const again = reduce(state, { type: 'conflict', profile: newer });
    expect(again.content).toBe('我的修订');
    expect(again.seeds).toEqual(state.seeds);
    const result = { seeds: again.seeds, content: again.content, updatedAt: '2026-09-15 00:00:00.123459+00' };
    expect(reduce(again, { type: 'saved', profile: result, scope: 'all' }))
      .toEqual({ saved: result, seeds: result.seeds, content: result.content, conflict: null, conflictDetected: false });
  });

  it('treats blank optional fields as unchanged without ignoring real edits', () => {
    const state = reduce(loaded(), { type: 'edit-seeds', seeds: [{ ...saved.seeds[0], author: '', reason: '' }] });
    expect(seedsChanged(state)).toBe(false);
    expect(seedsChanged(reduce(state, { type: 'edit-seeds', seeds: [{ ...state.seeds[0], kind: 'drop' }] }))).toBe(true);
  });

  it('reads snapshots without normalizing raw versions', () => {
    expect(readProfileSnapshot(saved)).toEqual(saved);
    expect(readProfileSnapshot(latest)?.updatedAt).toBe(latest.updatedAt);
  });

  it.each([null, {}, { ...saved, updatedAt: '' }, { ...saved, seeds: [null] }, { ...saved, content: null }])(
    'rejects malformed loads instead of erasing local data %#', (value) => {
      expect(readProfileSnapshot(value)).toBeNull();
    },
  );
});
