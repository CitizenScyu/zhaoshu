#!/bin/sh
# prune1108：B 线下载缓存保留（scripts/prune-download-out.mjs）的保护名单 = 用户书及其候选源的适配键。
# 由 zhaoshu-download-b-prune.service 的 ExecStartPre=-+ 以 root 调用（要 docker exec 读库）；
# 只写 root 自建的 /run/zhaoshu-prune-protect/，不碰 zsdownload 可写的目录（防软链劫持 root 写）。
# 适配键 = sha256("<source_url>|<title>|<author>") 十六进制前 24 位；回退腿的 source_url 是候选 URL，
# title/author 仍取任务的。键数为 0 按查询异常处理而失败：prune 拿不到新名单会降级为只删 book.txt。
# 只输出键数。
set -eu
DIR=/run/zhaoshu-prune-protect
install -d -m 0755 -o root -g root "$DIR"
tmp=$(mktemp "$DIR/protect.XXXXXX")
keys=$(mktemp "$DIR/keys.XXXXXX")
trap 'rm -f "$tmp" "$keys"' EXIT
timeout 300 docker exec -i "${ZS_PG_CONTAINER:-zhaoshu-tempdb-postgres-1}" \
  sh -c 'exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d zhaoshu -At' > "$keys" <<'SQL'
WITH t AS (
  SELECT DISTINCT book_id, source_url, title, author FROM download_tasks WHERE requested_by = 'user'
), u AS (
  SELECT source_url, title, author FROM t
  UNION
  SELECT c.source_url, t.title, t.author FROM download_source_candidates c JOIN t ON t.book_id = c.book_id
)
SELECT DISTINCT left(encode(sha256(convert_to(source_url || '|' || title || '|' || author, 'UTF8')), 'hex'), 24) FROM u;
SQL
if grep -qvE '^[0-9a-f]{24}$' "$keys"; then echo 'prune-protect: 查询输出含非键行，放弃' >&2; exit 1; fi
n=$(wc -l < "$keys" | tr -d ' ')
[ "$n" -gt 0 ] || { echo 'prune-protect: 键数为 0，放弃' >&2; exit 1; }
{ echo "# protect-ok $n"; cat "$keys"; } > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$DIR/protect.txt"
echo "keys=$n"
