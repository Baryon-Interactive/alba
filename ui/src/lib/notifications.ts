import type { OrderSummary } from '@api';

type Candidate = Pick<OrderSummary, 'project' | 'tag' | 'attention' | 'muted' | 'unread'>;
export function notificationTracker(since: number) {
  const initial = new Set<string>();
  const latest = new Map<string, string>();
  return <T extends Candidate>(project: string, orders: readonly T[], focusedTag?: string): T[] => {
    const baseline = !initial.has(project);
    initial.add(project);
    return orders.filter(order => {
      const point = order.attention;
      if (!point) return false;
      const key = JSON.stringify([project, order.tag]);
      if ((latest.get(key) ?? '') >= point.at) return false;
      latest.set(key, point.at);
      return !baseline && Date.parse(point.at) > since && !!order.unread && !order.muted && order.tag !== focusedTag;
    });
  };
}

const notifyKey = 'alba-browser-notify', soundKey = 'alba-browser-sound';
export function preferences() {
  try { return { notify: localStorage.getItem(notifyKey) === 'true', sound: localStorage.getItem(soundKey) === 'true' }; }
  catch { return { notify: false, sound: false }; }
}
export function savePreference(key: 'notify' | 'sound', value: boolean) {
  localStorage.setItem(key === 'notify' ? notifyKey : soundKey, String(value));
}

let audio: AudioContext | undefined;
export function enableAudio() {
  if (!window.AudioContext) return;
  audio ??= new AudioContext();
  if (audio.state === 'suspended') void audio.resume().catch(() => {});
}
function tone() {
  if (audio?.state !== 'running') return;
  const oscillator = audio.createOscillator(), gain = audio.createGain();
  const start = audio.currentTime;
  oscillator.frequency.value = 660;
  gain.gain.setValueAtTime(0.06, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.17);
}

const focusKey = (project: string, tag: string) => 'alba-reading:' + JSON.stringify([project, tag]);

/** A focused order tab suppresses alerts from sibling tabs, including tabs in another window. */
export function watchFocusedOrder(project: string, tag: string) {
  if (!navigator.locks) return;
  let release: (() => void) | undefined;
  const update = () => {
    release?.();
    release = undefined;
    if (!document.hidden && document.hasFocus()) {
      const held = new Promise<void>(resolve => { release = resolve; });
      void navigator.locks.request(focusKey(project, tag), { mode: 'shared' }, () => held);
    }
  };
  update();
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  return () => {
    release?.();
    window.removeEventListener('focus', update);
    window.removeEventListener('blur', update);
    document.removeEventListener('visibilitychange', update);
  };
}

export async function notifyOrder(order: OrderSummary, open: () => void) {
  const key = 'alba-notified:' + JSON.stringify([order.project, order.tag]);
  const deliver = () => {
    const { sound, notify } = preferences();
    const point = order.attention!;
    if ((!sound && !notify) || (localStorage.getItem(key) ?? '') >= point.at) return;
    localStorage.setItem(key, point.at);
    if (sound) tone();
    if (notify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const message = new Notification(order.tag + ' · ' + order.title, { body: point.text, tag: key });
      message.onclick = () => { window.focus(); open(); message.close(); };
    }
  };
  if (!navigator.locks) return deliver();
  await navigator.locks.request(key, () => navigator.locks.request(focusKey(order.project, order.tag), { ifAvailable: true }, lock => {
    if (lock) deliver();
  }));
}
