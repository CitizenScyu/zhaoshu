import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bookFilename } from '../src/lib/book-file-name.ts';
import { DOWNLOAD_TASK_STALE_MS } from '../src/lib/download-task-policy.ts';

// Explicit cross-repository check; normal unit tests also run these fixtures in each repo.
const workerRoot = resolve(process.argv[2] || '../zhaoshu-books');
const worker = await import(pathToFileURL(resolve(workerRoot, 'book-file-name.mjs')).href);
const cases = JSON.parse(readFileSync(new URL('../src/lib/fixtures/book-filenames.json', import.meta.url), 'utf8'));
assert.deepEqual(JSON.parse(readFileSync(resolve(workerRoot, 'test/fixtures/book-filenames.json'), 'utf8')), cases);
for (const { title, author, expected } of cases) {
  assert.equal(bookFilename(title, author), expected);
  assert.equal(worker.bookFilename(title, author), expected);
  assert.equal(bookFilename(title, author), worker.bookFilename(title, author));
}
console.log(`Cross-repository filename contract: ${cases.length} inputs passed`);
const heartbeat = await import(pathToFileURL(resolve(workerRoot, 'task-heartbeat.mjs')).href);
assert.ok(heartbeat.HEARTBEAT_INTERVAL_MS + heartbeat.HEARTBEAT_QUERY_TIMEOUT_MS < DOWNLOAD_TASK_STALE_MS);
console.log(`Task timing contract: heartbeat ${heartbeat.HEARTBEAT_INTERVAL_MS}ms + query ${heartbeat.HEARTBEAT_QUERY_TIMEOUT_MS}ms < reclaim ${DOWNLOAD_TASK_STALE_MS}ms`);
