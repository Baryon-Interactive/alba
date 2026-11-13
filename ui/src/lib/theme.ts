import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';
const listeners = new Set<() => void>();
const current = (): Theme => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

export function setTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark');
  try { localStorage.setItem('alba-theme', t); } catch { /* ignore */ }
  listeners.forEach(l => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, current);
}
