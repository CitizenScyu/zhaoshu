import type { ProfileSnapshot, SeedBook } from './types';
import { isRecord } from './sanitize';

export interface ProfileDraftState {
  saved: ProfileSnapshot | null;
  seeds: SeedBook[];
  content: string;
  conflict: ProfileSnapshot | null;
  conflictDetected: boolean;
}

export type SaveScope = 'seeds' | 'content' | 'all';

export type ProfileDraftAction =
  | { type: 'load'; profile: ProfileSnapshot }
  | { type: 'edit-seeds'; seeds: SeedBook[] }
  | { type: 'edit-content'; content: string }
  | { type: 'saved'; profile: ProfileSnapshot; scope: SaveScope }
  | { type: 'conflict'; profile: ProfileSnapshot | null; generated?: Pick<ProfileSnapshot, 'seeds' | 'content'> }
  | { type: 'discard'; scope: Exclude<SaveScope, 'all'> }
  | { type: 'use-latest' };

export function createProfileDraft(): ProfileDraftState {
  return { saved: null, seeds: [], content: '', conflict: null, conflictDetected: false };
}

export function seedsChanged(state: ProfileDraftState): boolean {
  const saved = state.saved?.seeds ?? [];
  return saved.length !== state.seeds.length || state.seeds.some((seed, index) => {
    const original = saved[index];
    return !original || seed.title !== original.title || seed.kind !== original.kind ||
      (seed.author ?? '') !== (original.author ?? '') || (seed.reason ?? '') !== (original.reason ?? '');
  });
}

export function contentChanged(state: ProfileDraftState): boolean {
  return state.content !== (state.saved?.content ?? '');
}

function accept(profile: ProfileSnapshot): ProfileDraftState {
  return { saved: profile, seeds: profile.seeds, content: profile.content, conflict: null, conflictDetected: false };
}

export function profileDraftReducer(state: ProfileDraftState, action: ProfileDraftAction): ProfileDraftState {
  switch (action.type) {
    case 'load':
      if (!state.saved || (!seedsChanged(state) && !contentChanged(state) && !state.conflictDetected)) {
        return accept(action.profile);
      }
      // 重读、口令纠正和返回 tab 都不能悄悄覆盖草稿或替用户接受一个新版本。
      if (action.profile.updatedAt === state.saved.updatedAt && !state.conflictDetected) return state;
      return { ...state, conflict: action.profile, conflictDetected: true };
    case 'edit-seeds':
      return { ...state, seeds: action.seeds };
    case 'edit-content':
      return { ...state, content: action.content };
    case 'saved':
      return {
        ...accept(action.profile),
        seeds: action.scope === 'content' ? state.seeds : action.profile.seeds,
        content: action.scope === 'seeds' ? state.content : action.profile.content,
      };
    case 'conflict':
      return {
        ...state, ...action.generated,
        conflict: action.profile, conflictDetected: true,
      };
    case 'discard':
      return action.scope === 'seeds'
        ? { ...state, seeds: state.saved?.seeds ?? [] }
        : { ...state, content: state.saved?.content ?? '' };
    case 'use-latest':
      return state.conflict ? accept(state.conflict) : state;
  }
}

export function readProfileSnapshot(value: unknown): ProfileSnapshot | null {
  if (!isRecord(value) || typeof value.content !== 'string' ||
      typeof value.updatedAt !== 'string' || !value.updatedAt || !Array.isArray(value.seeds)) return null;
  if (!value.seeds.every((seed) => isRecord(seed) && typeof seed.title === 'string' &&
      (seed.kind === 'love' || seed.kind === 'drop') &&
      (seed.author === undefined || typeof seed.author === 'string') &&
      (seed.reason === undefined || typeof seed.reason === 'string'))) return null;
  return { seeds: value.seeds as SeedBook[], content: value.content, updatedAt: value.updatedAt };
}
