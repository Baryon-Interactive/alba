import { useSyncExternalStore } from 'react';
import { zh } from './zh.ts';
import { machinesZh } from './machines.ts';
import { producerActivityEn, producerActivityZh } from './producer-activity.ts';
import { designGoalsEn, designGoalsZh } from './design-goals.ts';
import { independentCheckEn, independentCheckZh } from './independent-check.ts';
import { nightlyGatesEn, nightlyGatesZh } from './nightly-gates.ts';

export type Lang = 'en' | 'zh';

// The English text is the key (the same convention as src/i18n.ts of the tool). Chinese words follow docs/glossary.md.
const catalogs: Record<Lang, Record<string, string>> = { en: { ...producerActivityEn, ...designGoalsEn, ...independentCheckEn, ...nightlyGatesEn }, zh: { ...producerActivityZh, ...zh, ...designGoalsZh, ...independentCheckZh, ...nightlyGatesZh, ...machinesZh } };

function initial(): Lang {
  try {
    const stored = localStorage.getItem('alba-lang');
    if (stored === 'en' || stored === 'zh') return stored;
  } catch { /* no storage */ }
  return 'en';
}

let lang: Lang = initial();
const listeners = new Set<() => void>();

export function t(text: string, vars: Record<string, string | number> = {}): string {
  const template = catalogs[lang][text] ?? text;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

export function setLang(next: Lang) {
  lang = next;
  try { localStorage.setItem('alba-lang', next); } catch { /* ignore */ }
  if (typeof document !== 'undefined') document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  listeners.forEach(l => l());
}

export function getLang(): Lang { return lang; }

export function useLang(): Lang {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => lang);
}

if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
