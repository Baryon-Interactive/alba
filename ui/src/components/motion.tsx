import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';

/** The place of an element in a staggered entrance (`.rise`): the `n`th rises `n` × 55 ms after the first. */
export const nth = (n: number) => ({ '--i': n }) as CSSProperties;

/**
 * The console's motion switch (the sparkle button in the header), kept in localStorage `alba-motion`. Animations are on
 * unless it is turned off: the system's "reduce motion" is not followed, because Windows sets it whenever its animation
 * effects are off (often for speed, on remote desktops), which would leave the console still for most people.
 */
export type Motion = 'full' | 'reduced';
const listeners = new Set<() => void>();
const reducedNow = () => typeof document !== 'undefined' && document.documentElement.getAttribute('data-motion') === 'reduced';

export function setMotion(m: Motion) {
  if (m === 'reduced') document.documentElement.setAttribute('data-motion', 'reduced'); else document.documentElement.removeAttribute('data-motion');
  try { if (m === 'reduced') localStorage.setItem('alba-motion', 'reduced'); else localStorage.removeItem('alba-motion'); } catch { /* ignore */ }
  listeners.forEach(l => l());
}

/** True when the motion switch has turned animations off. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, reducedNow, () => false);
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
