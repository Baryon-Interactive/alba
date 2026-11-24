/** Only foreground input counts. Keep the timestamp across navigation so the click opening an order counts. */
export function createPresence() {
  let lastInput = -Infinity;
  const listeners = new Set<() => void>();
  const present = () => document.visibilityState === 'visible' && document.hasFocus();
  function check() {
    if (present() && Date.now() - lastInput < 60_000) for (const listener of listeners) listener();
  }
  function input() { if (present()) { lastInput = Date.now(); check(); } }
  return {
    listen() {
      const inputs = ['keydown', 'click', 'scroll'] as const;
      for (const event of inputs) window.addEventListener(event, input, true);
      window.addEventListener('focus', check);
      document.addEventListener('visibilitychange', check);
      return () => {
        for (const event of inputs) window.removeEventListener(event, input, true);
        window.removeEventListener('focus', check);
        document.removeEventListener('visibilitychange', check);
      };
    },
    watch(listener: () => void) {
      listeners.add(listener);
      check();
      return () => { listeners.delete(listener); };
    },
  };
}
export const presence = createPresence();
export const tabTitle = (count: number) => count ? `(${count}) Alba` : 'Alba';
