import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';

const query = '(prefers-reduced-motion: reduce)';

/** The place of an element in a staggered entrance (`.rise`): the `n`th rises `n` × 55 ms after the first. */
export const nth = (n: number) => ({ '--i': n }) as CSSProperties;

/** The console's motion switch: `system` follows the system's "reduce motion"; `full` and `reduced` override it. */
export type Motion = 'system' | 'full' | 'reduced';
const listeners = new Set<() => void>();
const setting = (): Motion => {
  const v = typeof document === 'undefined' ? null : document.documentElement.getAttribute('data-motion');
  return v === 'full' || v === 'reduced' ? v : 'system';
};
const systemReduced = () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches;
const reducedNow = () => { const s = setting(); return s === 'system' ? systemReduced() : s === 'reduced'; };

export function setMotion(m: Motion) {
  if (m === 'system') document.documentElement.removeAttribute('data-motion'); else document.documentElement.setAttribute('data-motion', m);
  try { if (m === 'system') localStorage.removeItem('alba-motion'); else localStorage.setItem('alba-motion', m); } catch { /* ignore */ }
  listeners.forEach(l => l());
}

/** True when animations are off: the switch says so, or it follows the system and the system asks for less motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(cb => {
    listeners.add(cb);
    const m = typeof window !== 'undefined' ? window.matchMedia?.(query) : undefined;
    m?.addEventListener('change', cb);
    return () => { listeners.delete(cb); m?.removeEventListener('change', cb); };
  }, reducedNow, () => false);
}

/**
 * A number that counts up to its value when it first appears and glides to a new value when it changes. Text values (`—`,
 * `1.2M`) are shown as they are. With reduced motion the value is shown at once.
 */
export function CountUp({ value, ms = 900 }: { value: number | string; ms?: number }) {
  const reduced = useReducedMotion();
  const target = typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  // The first render (and a server render) shows the value itself; the count starts before the browser paints.
  const [shown, setShown] = useState(target);
  const from = useRef(0);
  useLayoutEffect(() => {
    if (target === undefined) return;
    if (reduced) { setShown(target); from.current = target; return; }
    const start = performance.now(), begin = from.current;
    let frame = 0;
    setShown(begin);
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms), eased = 1 - (1 - k) ** 3;
      setShown(begin + (target - begin) * eased);
      if (k < 1) frame = requestAnimationFrame(step); else from.current = target;
    };
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); from.current = target; };
  }, [target, reduced, ms]);
  if (target === undefined) return <span className="count-pop">{value}</span>;
  return <span>{Number.isInteger(target) ? Math.round(shown ?? 0) : (shown ?? 0).toFixed(1)}</span>;
}
