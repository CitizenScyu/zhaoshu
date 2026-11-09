#!/bin/bash
# nosrc-tool.sh: back up and delete books that cannot be downloaded (see deploy/phoenix/README.md).
# usage: select p1|cohort|p2|gc|gclast <out> | backup <ids> <dir> [mode] | delete <dir> | enqueue <ids> <rev> | status | p2run | gcrun [--dry-run]
# ZS_DB / ZS_BASE override the database and backup root (scratch-copy tests only).
set -euo pipefail
umask 077
DB=${ZS_DB:-zhaoshu}
[[ $DB =~ ^[a-z_]+$ ]] || { echo "bad ZS_DB" >&2; exit 3; }
PSQL=(docker exec -i zhaoshu-tempdb-postgres-1 psql -U postgres -d "$DB" -X -q -A -t -v ON_ERROR_STOP=1)
BASE=${ZS_BASE:-/root/zs-backup}
[[ $BASE =~ ^/root/[a-z0-9-]+$ ]] || { echo "bad ZS_BASE" >&2; exit 3; }
GC_MAX_DELETE=${ZS_GC_MAX_DELETE:-2000}
GC_MAX_ENQUEUE=${ZS_GC_MAX_ENQUEUE:-300}
[[ $GC_MAX_DELETE =~ ^[0-9]+$ && $GC_MAX_ENQUEUE =~ ^[0-9]+$ ]] || { echo "bad ZS_GC_MAX_*" >&2; exit 3; }
GC_DELETE_WHERE="delkind AND final AND NOT freeok"
GC_LAST_WHERE="NOT ($GC_DELETE_WHERE) AND NOT had_last"
REV=lastcall-20261109
COHORT=$BASE/nosrc-$REV/cohort-ids.txt
DEADLINE=20261125
P1_WHERE="grp = 'nocand' AND verdict_at >= '2026-11-07 00:00:00+08' AND NOT user_req AND NOT freeok"

die() { echo "nosrc-tool: $*" >&2; exit 3; }
ids_literal() { printf '{%s}' "$(paste -sd, "$1")"; }
csv_rows() { python3 -c 'import csv,sys; print(sum(1 for _ in csv.reader(open(sys.argv[1], newline=""))) - 1)' "$1"; }
check_ids() { [ -s "$1" ] || die "empty id list $1"; if grep -qvxE '[0-9]+' "$1"; then die "bad id list $1"; fi; }

zs_sql() {
cat <<'SQL'
CREATE TEMP TABLE zs AS
WITH last AS (
  SELECT DISTINCT ON (book_id) book_id, error, updated_at, source_revision
  FROM download_tasks ORDER BY book_id, id DESC
)
SELECT lb.id, last.updated_at AS verdict_at, last.source_revision AS last_rev,
  CASE WHEN last.error LIKE '源不可用（search 阶段，已连续 % 次，停止自动重试）：no_candidates' THEN 'nocand'
       WHEN last.error LIKE 'Server error (HTTP status %timeout exceeded when trying to connect%' THEN 'srverr'
       ELSE 'adapter' END AS grp,
  EXISTS (SELECT 1 FROM download_tasks u WHERE u.book_id = lb.id AND u.requested_by = 'user') AS user_req,
  EXISTS (SELECT 1 FROM download_source_candidates c WHERE c.book_id = lb.id AND c.failure = ''
          AND c.host NOT IN ('book.qq.com', 'chuangshi.qq.com', 'ubook.reader.qq.com', 'yunqi.qq.com')) AS freeok
FROM labeled_books lb JOIN last ON last.book_id = lb.id
WHERE COALESCE(lower(substring(lb.source_url from '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#]+)')), '')
        IN ('book.qq.com', 'chuangshi.qq.com', 'ubook.reader.qq.com', 'yunqi.qq.com')
  AND NOT EXISTS (SELECT 1 FROM download_tasks d WHERE d.book_id = lb.id AND d.status IN ('done', 'pending', 'running'))
  AND (last.error LIKE '源不可用（search 阶段，已连续 % 次，停止自动重试）：no_candidates'
       OR last.error LIKE 'Server error (HTTP status %timeout exceeded when trying to connect%'
       OR last.error = 'adapter_runtime_error');
SQL
}

# gc: every book with no artifact, no done/pending/running task and no user request, whose latest task failed
# (or that never got a task). delkind = the failure means no usable source; final = this was already the second
# attempt (a lastcall revision, or >= 2 failed tasks with the latest started in the last 14 days).
gc_sql() {
cat <<'SQL'
CREATE TEMP TABLE gc AS
WITH l AS (
  SELECT DISTINCT ON (book_id) book_id, status, error, source_revision, created_at
  FROM download_tasks ORDER BY book_id, id DESC
), f AS (
  SELECT book_id, count(*) FILTER (WHERE status IN ('failed', 'partial')) AS fails,
         bool_or(source_revision LIKE 'lastcall-%' OR source_revision LIKE 'gc-lastcall-%') AS had_last
  FROM download_tasks GROUP BY book_id
)
SELECT lb.id,
  COALESCE(f.had_last, false) AS had_last,
  EXISTS (SELECT 1 FROM download_source_candidates c WHERE c.book_id = lb.id AND c.failure = ''
          AND c.host NOT IN ('book.qq.com', 'chuangshi.qq.com', 'ubook.reader.qq.com', 'yunqi.qq.com')) AS freeok,
  COALESCE((l.status = 'failed' AND l.error ~ '^(identity_mismatch|identity_mismatch_or_no_candidate|download_failed|invalid_next_page|invalid_chapter|unsupported_toc_rule|preview_truncated|toc_limit)$')
           OR l.error LIKE '源不可用（search 阶段，已连续 % 次，停止自动重试）：no_candidates', false) AS delkind,
  COALESCE(l.source_revision LIKE 'lastcall-%' OR l.source_revision LIKE 'gc-lastcall-%'
           OR (COALESCE(f.fails, 0) >= 2 AND l.created_at > now() - interval '14 days'), false) AS final,
  CASE WHEN l.book_id IS NULL THEN 'no_task'
       WHEN l.error LIKE '%：no_candidates' THEN 'no_candidates'
       WHEN l.error LIKE '%：source_unavailable' THEN 'source_unavailable'
       WHEN l.error LIKE '缺章%' THEN 'missing_chapters'
       WHEN l.error ~ '^[a-z_]+$' THEN l.error
       ELSE 'other' END AS kind
FROM labeled_books lb LEFT JOIN l ON l.book_id = lb.id LEFT JOIN f ON f.book_id = lb.id
WHERE NOT EXISTS (SELECT 1 FROM book_artifacts a WHERE a.labeled_book_id = lb.id)
  AND NOT EXISTS (SELECT 1 FROM download_tasks d WHERE d.book_id = lb.id AND d.status IN ('done', 'pending', 'running'))
  AND NOT EXISTS (SELECT 1 FROM download_tasks u WHERE u.book_id = lb.id AND u.requested_by = 'user')
  AND (l.book_id IS NULL OR l.status IN ('failed', 'partial'));
SQL
}

gc_report() {
  { gc_sql; cat <<'SQL'
SELECT bucket || ' ' || count(*) FROM (
  SELECT CASE WHEN delkind AND final AND NOT freeok THEN 'delete_' || kind
              WHEN NOT had_last THEN 'lastcall_' || kind
              WHEN freeok THEN 'held_freeok'
              ELSE 'held_' || kind END AS bucket FROM gc) s
GROUP BY bucket ORDER BY bucket;
SQL
  } | "${PSQL[@]}"
}

cmd_select() {
  local mode=$1 out=$2 where cohort='{}' gen=zs_sql tail=''
  case $mode in
    p1) where="$P1_WHERE" ;;
    cohort) where="NOT ($P1_WHERE)" ;;
    p2) check_ids "$COHORT"
        where="grp = 'nocand' AND last_rev = '$REV' AND NOT user_req AND NOT freeok AND id = ANY (:'cohort'::integer[])"
        cohort=$(ids_literal "$COHORT") ;;
    gc) gen=gc_sql; where="$GC_DELETE_WHERE" ;;
    gclast) gen=gc_sql; where="$GC_LAST_WHERE"; tail=" LIMIT $GC_MAX_ENQUEUE" ;;
    *) die "unknown select mode $mode" ;;
  esac
  { $gen; printf 'COPY (SELECT id FROM %s WHERE %s ORDER BY id%s) TO STDOUT;\n' "${gen%_sql}" "$where" "$tail"; } \
    | "${PSQL[@]}" -v cohort="$cohort" > "$out.tmp"
  if grep -qvxE '[0-9]+' "$out.tmp"; then die "unexpected select output"; fi
  mv "$out.tmp" "$out"
  echo "select $mode: $(wc -l < "$out")"
}

export_table() {
  printf 'COPY (%s) TO STDOUT WITH CSV HEADER;\n' "$2" | "${PSQL[@]}" -v ids="$IDS" > "$DIR/$1.csv"
  echo "$1 $(csv_rows "$DIR/$1.csv")" >> "$DIR/counts.txt"
}

export_all() {
  local ART="SELECT id FROM book_artifacts WHERE labeled_book_id = ANY (:'ids'::integer[])"
  export_table labeled_books "SELECT id, title, author, category, finish_status, source_site, source_url, chars_labeled, labels, labeled_at, primary_genre, sub_tags, quality FROM labeled_books WHERE id = ANY (:'ids'::integer[]) ORDER BY id"
  export_table book_artifacts "SELECT * FROM book_artifacts WHERE labeled_book_id = ANY (:'ids'::integer[]) ORDER BY id"
  export_table download_tasks "SELECT * FROM download_tasks WHERE book_id = ANY (:'ids'::integer[]) ORDER BY id"
  export_table download_source_candidates "SELECT * FROM download_source_candidates WHERE book_id = ANY (:'ids'::integer[]) ORDER BY book_id, position, source_url"
  export_table download_source_prefetch "SELECT * FROM download_source_prefetch WHERE book_id = ANY (:'ids'::integer[]) ORDER BY book_id"
  export_table followup_probe_state "SELECT * FROM followup_probe_state WHERE book_id = ANY (:'ids'::integer[]) ORDER BY book_id"
  export_table artifact_capacity_reservations "SELECT * FROM artifact_capacity_reservations WHERE labeled_book_id = ANY (:'ids'::integer[]) OR artifact_id IN ($ART) ORDER BY reservation_id"
}

cmd_backup() {
  local ids=$1 mode=${3:-nosrc}
  DIR=$2
  [[ $mode =~ ^(nosrc|gc)$ ]] || die "bad backup mode $mode"
  check_ids "$ids"
  mkdir -m 700 "$DIR"
  echo "$mode" > "$DIR/mode"
  sort -n -u "$ids" > "$DIR/ids.txt"
  IDS=$(ids_literal "$DIR/ids.txt")
  docker exec zhaoshu-tempdb-postgres-1 pg_dump -U postgres -Fc "$DB" > "$DIR/full.dump"
  docker exec -i zhaoshu-tempdb-postgres-1 pg_restore -l < "$DIR/full.dump" | grep -c 'TABLE DATA' > "$DIR/full.dump.tables"
  export_all
  [ "$(awk '$1 == "labeled_books" {print $2}' "$DIR/counts.txt")" = "$(wc -l < "$DIR/ids.txt")" ] || die "labeled_books export does not match id list"
  {
    printf '#!/bin/bash\n# Re-inserts the rows removed by "nosrc-tool.sh delete" from the CSVs next to this script, in one transaction.\nset -euo pipefail\nDB=%s\n' "$DB"
    cat <<'EOF'
cd "$(dirname "$(readlink -f "$0")")"
{
  printf '%s\n' 'BEGIN;'
  for t in labeled_books book_artifacts download_tasks download_source_candidates download_source_prefetch followup_probe_state artifact_capacity_reservations; do
    n=$(python3 -c 'import csv,sys; print(sum(1 for _ in csv.reader(open(sys.argv[1], newline=""))) - 1)' "$t.csv")
    [ "$n" -gt 0 ] || continue
    printf 'COPY %s (%s) FROM STDIN WITH CSV HEADER;\n' "$t" "$(head -n 1 "$t.csv")"
    cat "$t.csv"
    printf '%s\n' '\.'
  done
  printf '%s\n' 'COMMIT;'
} | docker exec -i zhaoshu-tempdb-postgres-1 psql -U postgres -d "$DB" -X -q -v ON_ERROR_STOP=1
echo "restored $(wc -l < ids.txt) books into $DB"
EOF
  } > "$DIR/restore.sh"
  chmod 700 "$DIR/restore.sh"
  echo "backup $DIR: $(tr '\n' ' ' < "$DIR/counts.txt")dump_tables=$(cat "$DIR/full.dump.tables")"
}

cmd_delete() {
  DIR=$1
  [ -s "$DIR/full.dump" ] && [ -s "$DIR/counts.txt" ] && [ -x "$DIR/restore.sh" ] || die "backup incomplete in $DIR"
  [ ! -e "$DIR/deleted.ok" ] || die "already deleted"
  c() { awk -v t="$1" '$1 == t {print $2}' "$DIR/counts.txt"; }
  local mode=nosrc
  [ -f "$DIR/mode" ] && mode=$(cat "$DIR/mode")
  [[ $mode =~ ^(nosrc|gc)$ ]] || die "bad mode in $DIR"
  IDS=$(ids_literal "$DIR/ids.txt")
  {
    cat <<'SQL'
BEGIN;
CREATE TEMP TABLE del_ids (id integer PRIMARY KEY) ON COMMIT DROP;
INSERT INTO del_ids SELECT DISTINCT unnest(:'ids'::integer[]);
CREATE TEMP TABLE exp ON COMMIT DROP AS
  SELECT :'e_books'::int AS books, :'e_tasks'::int AS tasks, :'e_cands'::int AS cands, :'e_arts'::int AS arts,
         :'e_pref'::int AS pref, :'e_fol'::int AS fol, :'e_cap'::int AS cap;
SQL
    # gc re-evaluates its rule after the books are locked, so a task enqueued meanwhile disqualifies the book.
    if [ "$mode" = gc ]; then
      printf 'SELECT count(*) AS locked FROM (SELECT 1 FROM labeled_books WHERE id IN (SELECT id FROM del_ids) FOR UPDATE) s;\n'
      gc_sql
    fi
    cat <<'SQL'
DO $$
DECLARE e record; n int; m int;
BEGIN
  SELECT * INTO e FROM exp;
  SELECT count(*) INTO n FROM del_ids;
  IF n <> e.books THEN RAISE EXCEPTION 'id list % <> backup %', n, e.books; END IF;
  SELECT count(*) INTO m FROM pg_constraint WHERE contype = 'f'
    AND confrelid IN ('labeled_books'::regclass, 'download_tasks'::regclass, 'book_artifacts'::regclass)
    AND conname NOT IN ('download_tasks_book_fk', 'book_artifacts_labeled_book_id_fkey', 'download_source_candidates_book_fk',
      'download_source_prefetch_book_fk', 'artifact_capacity_reservations_labeled_book_id_fkey', 'followup_probe_state_book_fk',
      'download_tasks_retry_of_fk', 'followup_probe_state_task_fk', 'download_tasks_artifact_fk',
      'artifact_capacity_reservations_artifact_id_fkey');
  IF m > 0 THEN RAISE EXCEPTION 'unexpected foreign keys: %', m; END IF;
  SELECT count(*) INTO m FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('labeled_books'::regclass,
    'download_tasks'::regclass, 'book_artifacts'::regclass, 'download_source_candidates'::regclass,
    'download_source_prefetch'::regclass, 'followup_probe_state'::regclass, 'artifact_capacity_reservations'::regclass);
  IF m > 0 THEN RAISE EXCEPTION 'unexpected triggers: %', m; END IF;
  PERFORM 1 FROM labeled_books WHERE id IN (SELECT id FROM del_ids) FOR UPDATE;
  GET DIAGNOSTICS m = ROW_COUNT;
  IF m <> n THEN RAISE EXCEPTION 'locked % of % books', m, n; END IF;
SQL
    if [ "$mode" = gc ]; then
      printf '  SELECT count(*) INTO m FROM del_ids x WHERE x.id NOT IN (SELECT id FROM gc WHERE %s);\n' "$GC_DELETE_WHERE"
    else
      cat <<'SQL'
  SELECT count(*) INTO m FROM del_ids x JOIN labeled_books lb ON lb.id = x.id
  WHERE NOT (
    COALESCE(lower(substring(lb.source_url from '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#]+)')), '')
      IN ('book.qq.com', 'chuangshi.qq.com', 'ubook.reader.qq.com', 'yunqi.qq.com')
    AND NOT EXISTS (SELECT 1 FROM download_tasks d WHERE d.book_id = x.id AND d.status IN ('done', 'pending', 'running'))
    AND NOT EXISTS (SELECT 1 FROM download_tasks u WHERE u.book_id = x.id AND u.requested_by = 'user')
    AND NOT EXISTS (SELECT 1 FROM download_source_candidates c WHERE c.book_id = x.id AND c.failure = ''
      AND c.host NOT IN ('book.qq.com', 'chuangshi.qq.com', 'ubook.reader.qq.com', 'yunqi.qq.com'))
    AND EXISTS (SELECT 1 FROM (SELECT d.error FROM download_tasks d WHERE d.book_id = x.id ORDER BY d.id DESC LIMIT 1) l
      WHERE l.error LIKE '源不可用（search 阶段，已连续 % 次，停止自动重试）：no_candidates'));
SQL
    fi
    cat <<'SQL'
  IF m > 0 THEN RAISE EXCEPTION '% books no longer qualify', m; END IF;
  SELECT count(*) INTO m FROM download_tasks o WHERE o.book_id NOT IN (SELECT id FROM del_ids)
    AND (o.retry_of IN (SELECT d.id FROM download_tasks d WHERE d.book_id IN (SELECT id FROM del_ids))
      OR o.artifact_id IN (SELECT a.id FROM book_artifacts a WHERE a.labeled_book_id IN (SELECT id FROM del_ids)));
  IF m > 0 THEN RAISE EXCEPTION '% outside tasks reference the set', m; END IF;
  SELECT count(*) INTO m FROM followup_probe_state f WHERE f.book_id NOT IN (SELECT id FROM del_ids)
    AND f.last_enqueued_task_id IN (SELECT d.id FROM download_tasks d WHERE d.book_id IN (SELECT id FROM del_ids));
  IF m > 0 THEN RAISE EXCEPTION '% outside follow-ups reference the set', m; END IF;
  SELECT count(*) INTO m FROM download_host_occupancy h
    WHERE h.task_id IN (SELECT d.id FROM download_tasks d WHERE d.book_id IN (SELECT id FROM del_ids));
  IF m > 0 THEN RAISE EXCEPTION '% host occupancy rows reference the set', m; END IF;
  SELECT count(*) INTO m FROM artifact_capacity_reservations r WHERE r.labeled_book_id NOT IN (SELECT id FROM del_ids)
    AND r.artifact_id IN (SELECT a.id FROM book_artifacts a WHERE a.labeled_book_id IN (SELECT id FROM del_ids));
  IF m > 0 THEN RAISE EXCEPTION '% outside reservations reference the set', m; END IF;

  DELETE FROM download_source_candidates WHERE book_id IN (SELECT id FROM del_ids);
  GET DIAGNOSTICS m = ROW_COUNT;
  IF m <> e.cands THEN RAISE EXCEPTION 'candidates % <> backup %', m, e.cands; END IF;
  DELETE FROM download_source_prefetch WHERE book_id IN (SELECT id FROM del_ids);
  GET DIAGNOSTICS m = ROW_COUNT;
  IF m <> e.pref THEN RAISE EXCEPTION 'prefetch % <> backup %', m, e.pref; END IF;
  DELETE FROM followup_probe_state WHERE book_id IN (SELECT id FROM del_ids);
  GET DIAGNOSTICS m = ROW_COUNT;
  IF m <> e.fol THEN RAISE EXCEPTION 'follow-ups % <> backup %', m, e.fol; END IF;
  DELETE FROM artifact_capacity_reservations WHERE labeled_book_id IN (SELECT id FROM del_ids)
    OR artifact_id IN (SELECT a.id FROM book_artifacts a WHERE a.labeled_book_id IN (SELECT id FROM del_ids));
  GET DIAGNOSTICS m = ROW_COUNT;
  IF m <> e.cap THEN RAISE EXCEPTION 'reservations % <> backup %', m, e.cap; END IF;
  DELETE FROM download_tasks WHERE book_id IN (SELECT id FROM del_ids);
  GET DIAGNOSTICS m = ROW_COUNT;
  IF m <> e.tasks THEN RAISE EXCEPTION 'tasks % <> backup %', m, e.tasks; END IF;
  DELETE FROM book_artifacts WHERE labeled_book_id IN (SELECT id FROM del_ids);
  GET DIAGNOSTICS m = ROW_COUNT;
  IF m <> e.arts THEN RAISE EXCEPTION 'artifacts % <> backup %', m, e.arts; END IF;
  DELETE FROM labeled_books WHERE id IN (SELECT id FROM del_ids);
  GET DIAGNOSTICS m = ROW_COUNT;
  IF m <> n THEN RAISE EXCEPTION 'books % <> %', m, n; END IF;
  RAISE NOTICE 'deleted books=% tasks=% candidates=% artifacts=%', n, e.tasks, e.cands, e.arts;
END $$;
COMMIT;
SQL
  } | "${PSQL[@]}" -v ids="$IDS" -v e_books="$(c labeled_books)" -v e_tasks="$(c download_tasks)" \
      -v e_cands="$(c download_source_candidates)" -v e_arts="$(c book_artifacts)" -v e_pref="$(c download_source_prefetch)" \
      -v e_fol="$(c followup_probe_state)" -v e_cap="$(c artifact_capacity_reservations)" 2>&1 | tee "$DIR/delete.log"
  local left
  left=$(printf "SELECT count(*) FROM labeled_books WHERE id = ANY (:'ids'::integer[]);\n" | "${PSQL[@]}" -v ids="$IDS")
  [ "$left" = 0 ] || die "rows still present after delete: $left"
  date -Is > "$DIR/deleted.ok"
  echo "deleted $DIR"
}

cmd_enqueue() {
  local ids=$1 rev=$2
  check_ids "$ids"
  cat <<'SQL' | "${PSQL[@]}" -v ids="$(ids_literal "$ids")" -v rev="$rev"
BEGIN;
CREATE TEMP TABLE want ON COMMIT DROP AS SELECT DISTINCT unnest(:'ids'::integer[]) AS id;
CREATE TEMP TABLE prm ON COMMIT DROP AS SELECT :'rev'::text AS rev;
DO $$
DECLARE w int; el int; n int; r text;
BEGIN
  SELECT rev INTO r FROM prm;
  SELECT count(*) INTO w FROM want;
  SELECT count(*) INTO el FROM want JOIN labeled_books lb ON lb.id = want.id
  WHERE NOT EXISTS (SELECT 1 FROM download_tasks d WHERE d.book_id = lb.id AND d.status IN ('done', 'pending', 'running'));
  WITH i AS (
    INSERT INTO download_tasks (user_id, book_id, title, author, source_url, status, requested_by,
                                source_kind, source_id, source_revision, policy_version, enqueue_key)
    SELECT NULL, lb.id, lb.title, lb.author, lb.source_url, 'pending', 'system', 'builtin', NULL, r, 't5-backfill-v1',
           lb.id::text || ':t5-backfill-v1:' || r
    FROM labeled_books lb JOIN want ON want.id = lb.id
    WHERE NOT EXISTS (SELECT 1 FROM download_tasks d WHERE d.book_id = lb.id AND d.status IN ('done', 'pending', 'running'))
    ON CONFLICT (enqueue_key) WHERE requested_by = 'system' AND enqueue_key IS NOT NULL DO NOTHING
    RETURNING id)
  SELECT count(*) INTO n FROM i;
  IF n <> el THEN RAISE EXCEPTION 'inserted % of % eligible (% wanted)', n, el, w; END IF;
  RAISE NOTICE 'enqueued % tasks revision % (wanted %, eligible %)', n, r, w, el;
END $$;
COMMIT;
SQL
}

cmd_status() {
  "${PSQL[@]}" -v rev="$REV" <<'SQL'
SELECT status || ' ' || kind || ' ' || n FROM (
  SELECT status, CASE WHEN error LIKE '%no_candidates' THEN 'nocand' WHEN status IN ('failed', 'partial') THEN 'otherfail' ELSE '-' END AS kind,
         count(*) AS n
  FROM download_tasks WHERE source_revision = :'rev' GROUP BY 1, 2) s ORDER BY 1;
SQL
}

cmd_p2run() {
  exec 9> /run/zs-maint.lock
  flock -w 900 9 || die "maintenance lock busy"
  local active ts final=0 sel
  active=$(printf "SELECT count(*) FROM download_tasks WHERE source_revision = :'rev' AND status IN ('pending', 'running');\n" \
    | "${PSQL[@]}" -v rev="$REV")
  [ "$active" = 0 ] && final=1
  [ "$(date +%Y%m%d)" -gt "$DEADLINE" ] && final=1
  ts=$(date +%Y%m%d-%H%M%S)
  sel=/run/zs-nosrc-p2-$ts.ids
  cmd_select p2 "$sel"
  if [ -s "$sel" ]; then
    cmd_backup "$sel" "$BASE/nosrc-p2-$ts"
    cmd_delete "$BASE/nosrc-p2-$ts"
  fi
  rm -f "$sel"
  cmd_status
  if [ "$final" = 1 ] && [ "$DB" = zhaoshu ]; then
    echo "cohort settled (active=$active); disabling zs-nosrc-p2.timer"
    systemctl disable --now zs-nosrc-p2.timer
  fi
}

# Daily rule-based cleanup: delete books that failed twice for lack of a source, give the rest one last search.
cmd_gcrun() {
  local dry=0 ts del last n
  case $1 in '') ;; --dry-run) dry=1 ;; *) die "usage: gcrun [--dry-run]" ;; esac
  exec 9> /run/zs-maint.lock
  flock -w 900 9 || die "maintenance lock busy"
  ts=$(date +%Y%m%d-%H%M%S)
  del=/run/zs-nosrc-gc-$ts.ids
  last=/run/zs-nosrc-gclast-$ts.ids
  trap "rm -f '$del' '$last' '$del.tmp' '$last.tmp'" EXIT
  gc_report
  cmd_select gc "$del"
  cmd_select gclast "$last"
  n=$(wc -l < "$del")
  if [ "$dry" = 1 ]; then
    echo "dry run: would delete $n books and enqueue $(wc -l < "$last") last calls"
    return
  fi
  [ "$n" -le "$GC_MAX_DELETE" ] || die "refusing to delete $n books (cap $GC_MAX_DELETE); review and raise ZS_GC_MAX_DELETE by hand"
  if [ "$n" -gt 0 ]; then
    cmd_backup "$del" "$BASE/nosrc-gc-$ts" gc
    cmd_delete "$BASE/nosrc-gc-$ts"
  fi
  if [ -s "$last" ]; then
    cmd_enqueue "$last" "gc-lastcall-$(date +%Y%m%d)"
  fi
}

case ${1:-} in
  select) cmd_select "$2" "$3" ;;
  backup) cmd_backup "$2" "$3" "${4:-nosrc}" ;;
  delete) cmd_delete "$2" ;;
  enqueue) cmd_enqueue "$2" "$3" ;;
  status) cmd_status ;;
  p2run) cmd_p2run ;;
  gcrun) cmd_gcrun "${2:-}" ;;
  *) die "usage: select p1|cohort|p2|gc|gclast <out> | backup <ids> <dir> [nosrc|gc] | delete <dir> | enqueue <ids> <rev> | status | p2run | gcrun [--dry-run]" ;;
esac
