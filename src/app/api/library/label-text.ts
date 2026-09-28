import { isRecord } from '@/lib/sanitize';

// 标签字段的安全提取（labels 来自离线脚本，字段宽松）
export function labelText(labels: unknown, key: string, maxLength = 600): string {
  if (!isRecord(labels)) return '';
  const v = labels[key];
  if (typeof v === 'string') return v.slice(0, maxLength);
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string').slice(0, 6).join('；').slice(0, maxLength);
  }
  return '';
}
