WITH bucketed AS (
  SELECT
    search_ok, search_verdict, error, search_checked_at,
    CASE
      WHEN search_ok IS NULL THEN 'null'
      WHEN search_ok=true AND error LIKE 'phoenix_ok:%' THEN 'phnx'
      WHEN search_ok=true AND error LIKE 'recheck_fail:%' THEN 'recheck_fail'
      WHEN search_ok=true THEN 'clean_ok'
      ELSE 'rejected'
    END AS bucket
  FROM source_admission
)
SELECT
  COUNT(*) FILTER (WHERE bucket='null') AS null_count,
  COUNT(*) FILTER (WHERE bucket='phnx') AS phnx,
  COUNT(*) FILTER (WHERE bucket='phnx' AND search_checked_at < NOW() - INTERVAL '20 hours') AS phnx_overdue20h,
  COUNT(*) FILTER (WHERE bucket='clean_ok') AS clean_ok,
  COUNT(*) FILTER (WHERE bucket='recheck_fail') AS recheck_fail,
  COUNT(*) FILTER (WHERE search_verdict='conn_fail') AS conn_fail,
  COUNT(*) FILTER (WHERE search_verdict='no_result') AS no_result,
  COUNT(*) FILTER (WHERE search_verdict='http_4xx') AS http_4xx,
  COUNT(*) FILTER (WHERE search_verdict='http_5xx') AS http_5xx,
  COUNT(*) FILTER (WHERE search_verdict='url_invalid') AS url_invalid,
  COUNT(*) FILTER (WHERE search_verdict='challenge') AS challenge,
  COUNT(*) FILTER (WHERE search_verdict='ok') AS ok,
  COUNT(*) FILTER (WHERE search_verdict='query_insensitive') AS q_insens
FROM bucketed;
SELECT COUNT(*) FROM shuyuan_sources WHERE disabled_at IS NULL;
