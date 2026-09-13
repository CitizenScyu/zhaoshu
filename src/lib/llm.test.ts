import { describe, expect, it } from 'vitest';
import { consumeSseChunk, parseJson } from './llm';

describe('parseJson', () => {
  it('parses bare JSON object', () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a ```json fenced block', () => {
    const text = '```json\n{"candidates":[]}\n```';
    expect(parseJson<{ candidates: unknown[] }>(text)).toEqual({ candidates: [] });
  });

  it('parses a bare ``` fenced block', () => {
    const text = '```\n[1,2,3]\n```';
    expect(parseJson<number[]>(text)).toEqual([1, 2, 3]);
  });

  it('extracts JSON surrounded by prose', () => {
    const text = '好的,这是结果:\n{"items":[{"title":"X"}]}\n希望有帮助!';
    expect(parseJson<{ items: { title: string }[] }>(text).items[0].title).toBe('X');
  });

  it('extracts a top-level array surrounded by prose', () => {
    const text = 'result: [{"a":1},{"a":2}] done';
    expect(parseJson<{ a: number }[]>(text)).toHaveLength(2);
  });

  it('throws on non-JSON garbage', () => {
    expect(() => parseJson('没有 JSON 在这里')).toThrow();
  });

  it('throws on empty input', () => {
    expect(() => parseJson('   ')).toThrow();
  });
});

describe('consumeSseChunk', () => {
  const evt = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;

  it('accumulates content from complete lines and keeps the partial line as rest', () => {
    const buf = evt('你好') + evt('世界') + 'data: {"choices":[{"delta":{"con';
    const out = consumeSseChunk(buf, false);
    expect(out.content).toBe('你好世界');
    expect(out.rest).toBe('data: {"choices":[{"delta":{"con');
    expect(out.done).toBe(false);
  });

  it('stops at [DONE] and reports done', () => {
    const out = consumeSseChunk(evt('hi') + 'data: [DONE]\n' + evt('ignored'), false);
    expect(out.content).toBe('hi');
    expect(out.done).toBe(true);
  });

  it('ignores malformed data events without aborting the stream', () => {
    const out = consumeSseChunk('data: {not json\n' + evt('ok'), false);
    expect(out.content).toBe('ok');
    expect(out.done).toBe(false);
  });

  it('ignores non-data lines and comment lines', () => {
    const out = consumeSseChunk('\n: keepalive\n' + evt('x'), false);
    expect(out.content).toBe('x');
  });

  it('drops the tail entirely when flushing', () => {
    const out = consumeSseChunk('data: {"choices":[{"delta":{"content":"par', true);
    expect(out.content).toBe('');
    expect(out.rest).toBe('');
  });

  it('handles an event with a missing content delta', () => {
    const out = consumeSseChunk(
      'data: {"choices":[{"delta":{}}]}\n' + evt('after'),
      false,
    );
    expect(out.content).toBe('after');
  });
});
