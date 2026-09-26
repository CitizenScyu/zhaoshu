import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  SOURCE_MEMORY_KEY, SOURCE_MEMORY_LIMIT, SOURCE_MEMORY_TTL_MS,
  dropEntry, forgetSource, parseSourceMemory, pickEntry, putEntry,
  readSourceMemory, rememberSource, type SourceMemoryStore,
} from './source-memory';
import { sourceBookIdentityKey } from './source-parser';

const KEY = sourceBookIdentityKey('剑来', '烽火戏诸侯');

describe('source-memory 纯函数', () => {
  it('parseSourceMemory 丢弃坏 JSON / 坏形状 / 数组', () => {
    expect(parseSourceMemory(null)).toEqual({});
    expect(parseSourceMemory('not json')).toEqual({});
    expect(parseSourceMemory('[1,2]')).toEqual({});
    expect(parseSourceMemory(JSON.stringify({ a: { sourceUrl: 's', bookUrl: 'b' /* 缺 at */ } }))).toEqual({});
    expect(parseSourceMemory(JSON.stringify({ a: { sourceUrl: '', bookUrl: 'b', at: 1 } }))).toEqual({});
    const good = { [KEY]: { sourceUrl: 's', bookUrl: 'b', at: 5 } };
    expect(parseSourceMemory(JSON.stringify(good))).toEqual(good);
  });

  it('pickEntry 命中返回条目，过期返回 null', () => {
    const now = 1_000_000_000_000;
    const store: SourceMemoryStore = { [KEY]: { sourceUrl: 's', bookUrl: 'b', at: now } };
    expect(pickEntry(store, KEY, now)).toEqual({ sourceUrl: 's', bookUrl: 'b', at: now });
    expect(pickEntry(store, KEY, now + SOURCE_MEMORY_TTL_MS)).toEqual({ sourceUrl: 's', bookUrl: 'b', at: now });
    expect(pickEntry(store, KEY, now + SOURCE_MEMORY_TTL_MS + 1)).toBeNull();
    expect(pickEntry(store, 'missing', now)).toBeNull();
  });

  it('putEntry 写入本条并以最新时间覆盖', () => {
    const store: SourceMemoryStore = { [KEY]: { sourceUrl: 'old', bookUrl: 'oldb', at: 1 } };
    const next = putEntry(store, KEY, { sourceUrl: 'new', bookUrl: 'newb' }, 100);
    expect(next[KEY]).toEqual({ sourceUrl: 'new', bookUrl: 'newb', at: 100 });
  });

  it('putEntry 顺带剔除已过期的其他条目', () => {
    const now = 10 * SOURCE_MEMORY_TTL_MS;
    const store: SourceMemoryStore = {
      fresh: { sourceUrl: 's', bookUrl: 'b', at: now - 1 },
      expired: { sourceUrl: 's', bookUrl: 'b', at: now - SOURCE_MEMORY_TTL_MS - 1 },
    };
    const next = putEntry(store, KEY, { sourceUrl: 'x', bookUrl: 'y' }, now);
    expect(Object.keys(next).sort()).toEqual(['fresh', KEY].sort());
    expect(next.expired).toBeUndefined();
  });

  it('putEntry 超上限按 LRU（at 最小）淘汰', () => {
    let store: SourceMemoryStore = {};
    // 填满上限，at 递增（key0 最旧）。
    for (let i = 0; i < SOURCE_MEMORY_LIMIT; i++) store[`key${i}`] = { sourceUrl: 's', bookUrl: 'b', at: 1000 + i };
    // 再放入一条新的（at 最大）⇒ 超上限，最旧的 key0 被淘汰。
    store = putEntry(store, 'newest', { sourceUrl: 's', bookUrl: 'b' }, 999_999);
    expect(Object.keys(store)).toHaveLength(SOURCE_MEMORY_LIMIT);
    expect(store.key0).toBeUndefined();
    expect(store.key1).toBeDefined();
    expect(store.newest).toBeDefined();
  });

  it('dropEntry 删除命中条目，不存在原样返回', () => {
    const store: SourceMemoryStore = { [KEY]: { sourceUrl: 's', bookUrl: 'b', at: 1 } };
    expect(dropEntry(store, KEY)).toEqual({});
    expect(dropEntry(store, 'missing')).toBe(store);
  });
});

describe('source-memory 身份键（复用换源比对口径）', () => {
  it('繁简同书折叠到同一个键', () => {
    // 愛→爱 在繁简折叠表内；书名/作者两侧都折叠。
    expect(sourceBookIdentityKey('恋爱日常', '张三')).toBe(sourceBookIdentityKey('戀愛日常', '張三'));
  });

  it('作者字段修饰（作者：/@/著）归一到同键', () => {
    expect(sourceBookIdentityKey('剑来', '作者：烽火戏诸侯')).toBe(sourceBookIdentityKey('剑来', '烽火戏诸侯'));
    expect(sourceBookIdentityKey('剑来', '烽火戏诸侯 著')).toBe(sourceBookIdentityKey('剑来', '烽火戏诸侯'));
  });

  it('书名号《》与空白归一到同键', () => {
    expect(sourceBookIdentityKey('《剑来》', '烽火戏诸侯')).toBe(sourceBookIdentityKey('剑来', '烽火戏诸侯'));
    expect(sourceBookIdentityKey('剑 来', '烽火 戏诸侯')).toBe(sourceBookIdentityKey('剑来', '烽火戏诸侯'));
  });

  it('不同书不撞键', () => {
    expect(sourceBookIdentityKey('剑来', '烽火戏诸侯')).not.toBe(sourceBookIdentityKey('雪中悍刀行', '烽火戏诸侯'));
    expect(sourceBookIdentityKey('剑来', '甲')).not.toBe(sourceBookIdentityKey('剑', '来甲'));
  });
});

describe('source-memory localStorage 封装', () => {
  const backing = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => { backing.set(k, v); },
    removeItem: (k: string) => { backing.delete(k); },
  };

  afterEach(() => {
    backing.clear();
    vi.unstubAllGlobals();
  });

  it('无 window 时读写都是安全的空操作', () => {
    // node 环境默认无 window。
    expect(readSourceMemory('剑来', '烽火戏诸侯')).toBeNull();
    expect(() => rememberSource('剑来', '烽火戏诸侯', { sourceUrl: 's', bookUrl: 'b' })).not.toThrow();
    expect(() => forgetSource('剑来', '烽火戏诸侯')).not.toThrow();
  });

  it('记住→读取往返；过期视为无记忆', () => {
    vi.stubGlobal('window', { localStorage: storage });
    const now = 1_700_000_000_000;
    rememberSource('剑来', '烽火戏诸侯', { sourceUrl: 'https://src/x', bookUrl: 'https://src/book/1' }, now);
    expect(readSourceMemory('剑来', '烽火戏诸侯', now)).toEqual({ sourceUrl: 'https://src/x', bookUrl: 'https://src/book/1', at: now });
    // 繁体书名同键命中。
    expect(readSourceMemory('劍來', '烽火戏诸侯', now)?.sourceUrl).toBe('https://src/x');
    // 过期。
    expect(readSourceMemory('剑来', '烽火戏诸侯', now + SOURCE_MEMORY_TTL_MS + 1)).toBeNull();
  });

  it('sourceUrl / bookUrl 为空不记', () => {
    vi.stubGlobal('window', { localStorage: storage });
    rememberSource('剑来', '烽火戏诸侯', { sourceUrl: '', bookUrl: 'b' });
    rememberSource('剑来', '烽火戏诸侯', { sourceUrl: 's', bookUrl: '' });
    expect(readSourceMemory('剑来', '烽火戏诸侯')).toBeNull();
  });

  it('forgetSource 清掉记忆；空 store 时删除整个键', () => {
    vi.stubGlobal('window', { localStorage: storage });
    rememberSource('剑来', '烽火戏诸侯', { sourceUrl: 's', bookUrl: 'b' });
    forgetSource('剑来', '烽火戏诸侯');
    expect(readSourceMemory('剑来', '烽火戏诸侯')).toBeNull();
    expect(backing.has(SOURCE_MEMORY_KEY)).toBe(false);
  });

  it('存储抛错（隐私模式 / 配额满）时静默降级不抛', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
        removeItem: () => { throw new Error('blocked'); },
      },
    });
    expect(readSourceMemory('剑来', '烽火戏诸侯')).toBeNull();
    expect(() => rememberSource('剑来', '烽火戏诸侯', { sourceUrl: 's', bookUrl: 'b' })).not.toThrow();
    expect(() => forgetSource('剑来', '烽火戏诸侯')).not.toThrow();
  });
});
