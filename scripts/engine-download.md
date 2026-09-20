# engine-fetch download

```powershell
node --import ./scripts/ts-esm-loader.mjs scripts/engine-fetch.mjs download --source book15.net --title "书名" --author "作者" --out ./downloads --max-chapters 10000 --rate-ms 800 --timeout-ms 30000 --budget-ms 19800000
```

Exit codes: `0` complete, `1` partial/runtime failure, `2` invalid usage or unavailable engine source pool (including DB failure). Stdout is one JSON result `{ code, manifestPath, manifest }`. The built-in source does not require DATABASE_URL; engine source resolution uses the existing approved source pool. Do not use production credentials for testing.

Each source + canonical title/author gets its own hashed directory. `manifest.json` is atomically checkpointed; chapters are `<index>.txt`. Only a fully validated attempt writes `book.txt` and sets `status: done`. A partial attempt must never be published, even if a previous `book.txt` remains in the directory.

Manifest v1 records title/author/source, sourceRevision (SHA-256 of the selected source snapshot), bookUrl, tocHash, chapters_total, chapters_done, chars, generated_at, errors and chapters `{ index, title, url, chars, status, file, sha256?, error? }`. Complete results also contain artifact `{ file, sha256, bytes }`. This is a local adapter manifest, not the F03 release manifest: T3 must convert it and use the existing five-stage publication path.

Resume reloads the directory and skips a chapter only when rule fingerprint, book URL and ordered catalog hash still match and the chapter file passes SHA-256 verification. All other chapters are fetched again. An exclusive lock prevents concurrent writes to the same output. SIGINT/SIGTERM and budget expiry save partial progress; hard kill cannot run cleanup, so a stale `download.lock` requires the operator to verify the prior process has exited before removing it.

Defaults: 800 ms between actual HTTP request starts, 30 seconds per operation/chapter including pagination, 330 minutes total, 20,000 requested chapter cap (engine/parser independently limits catalogs to 10,000), 15 MiB aggregate TXT cap. The shared slot includes redirects and alternate-host attempts inside one download process. Cross-process coordination with labeler/workers remains T3 integration work. No retry loop or automatic source switching is added.

The engine's optional strict mode rejects empty/unparseable catalog pages, invalid chapter URLs, unsupported catalog rules, invalid next links, cycles and page caps. Content pagination also rejects empty pages/cycles/caps/unsupported next rules. The catalog is read again after chapter downloads; any ordered change leaves partial. Builtin book15 retains its existing single-detail-page directory grammar.

Offline validation uses book15 synthetic HTML and rules from the first two sources in `rule-engine/fixtures/smoke-174.json` (网阅小说、免费小说), with synthetic search/detail/catalog/content pages. A synthetic nextTocUrl rule exercises pagination without contacting their hosts.

Checkpoints are throttled to once per 5 seconds during chapter processing, with forced initial/final checkpoints. A hard kill may require re-fetching chapters since the last checkpoint. Chapter, book and manifest temporary files are fsynced before rename; directory-entry durability on power loss remains filesystem/platform dependent. T3 integration must preserve exit 2 for source/DB unavailability.

模型调用超 8min 双计费窗口为已知遗留（供应商级 exactly-once，本地测不了）。
