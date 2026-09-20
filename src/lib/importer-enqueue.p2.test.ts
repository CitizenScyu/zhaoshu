import { describe, expect, it } from 'vitest';
import { ensureSystemTask, importLabelWithSystemTask, type ImporterSql } from './importer-enqueue';

const record = { title: 'synthetic', author: 'author', category: '', finishStatus: '', sourceSite: '', sourceUrl: null, charsLabeled: 0, labels: {}, primaryGenre: '', subTags: [], quality: null };
const task = { policyVersion: 'p1', sourceKind: 'builtin' };

describe('unresolved importer outcomes', () => {
  it.each(['import', 'ledger', 'conflict'])('%s cannot claim an artifact without evidence', async mode => {
    const sql: ImporterSql = async parts => {
      const query = parts.join('?');
      if (query.includes('WITH upserted')) {
        if (mode === 'conflict') throw Object.assign(new Error('synthetic conflict'), { code: '23505' });
        return [{ labeled_book_id: 1, created_task_count: 0 }];
      }
      if (query.includes('WITH target')) return [{ labeled_book_id: 1, created_task_count: 0 }];
      if (query.includes('download_tasks')) return [];
      return [{ id: 1 }];
    };
    const result = mode === 'ledger' ? ensureSystemTask(sql, record, task)
      : importLabelWithSystemTask(sql, { record, marker: 'ready', task });
    await expect(result).rejects.toThrow('system_task_outcome_unresolved');
  });
});
