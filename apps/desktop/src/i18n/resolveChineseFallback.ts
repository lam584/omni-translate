import zhCN from './locales/zh-CN.json';

export function resolveChineseFallback(key: string): string {
  let value: unknown = zhCN;
  for (const segment of key.split('.')) {
    if (!value || typeof value !== 'object' || !(segment in value)) return key;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === 'string' ? value : key;
}
