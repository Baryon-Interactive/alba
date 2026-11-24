import { afterEach, expect, it, vi } from 'vitest';
import { createPresence, tabTitle } from './presence';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('only acknowledges a foreground reader with input during the last minute', () => {
  vi.useFakeTimers();
  const win = new EventTarget();
  let focused = true;
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => focused });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  const presence = createPresence();
  const stop = presence.listen();
  const mark = vi.fn();
  const leave = presence.watch(mark);
  expect(mark).not.toHaveBeenCalled();
  doc.visibilityState = 'hidden';
  win.dispatchEvent(new Event('click'));
  doc.visibilityState = 'visible';
  focused = false;
  win.dispatchEvent(new Event('keydown'));
  expect(mark).not.toHaveBeenCalled();
  focused = true;
  win.dispatchEvent(new Event('scroll'));
  expect(mark).toHaveBeenCalledTimes(1);
  leave();
  const next = vi.fn();
  const leaveNext = presence.watch(next);
  expect(next).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60_000);
  win.dispatchEvent(new Event('focus'));
  doc.dispatchEvent(new Event('visibilitychange'));
  expect(next).toHaveBeenCalledTimes(1);
  win.dispatchEvent(new Event('keydown'));
  expect(next).toHaveBeenCalledTimes(2);
  leaveNext();
  stop();
});

it('shows the project unread count in the tab', () => {
  expect(tabTitle(3)).toBe('(3) Alba');
  expect(tabTitle(0)).toBe('Alba');
});
