import { getLang, t } from '@/i18n';

const locale = () => (getLang() === 'zh' ? 'zh-CN' : 'en-GB');

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return t('{n} s ago', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('{n} min ago', { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t('{n} h ago', { n: h });
  return t('{n} d ago', { n: Math.round(h / 24) });
}

export function minutes(m: number): string {
  if (m < 60) return t('{n} min', { n: Math.round(m) });
  return t('{n} h {m} min', { n: Math.floor(m / 60), m: Math.round(m % 60) });
}

export function duration(startIso: string, endIso?: string, now = Date.now()): string {
  const ms = (endIso ? Date.parse(endIso) : now) - Date.parse(startIso);
  return minutes(Math.max(0, ms / 60000));
}

export function dateTime(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(locale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function tokens(n: number | undefined): string {
  if (n === undefined) return '–';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function usd(n: number | undefined, estimated?: boolean): string {
  if (n === undefined) return '–';
  const s = n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
  return estimated ? `~${s}` : s;
}

export function bytes(n: number | undefined): string {
  if (n === undefined) return '–';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} B`;
}
