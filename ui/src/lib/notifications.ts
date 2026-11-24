import type { OrderSummary } from '@api';

type Candidate = Pick<OrderSummary, 'project' | 'tag' | 'attention' | 'muted' | 'unread'>;
export function newNotifications<T extends Candidate>(orders: readonly T[], latest: Map<string, string>, since: number, focusedTag?: string): T[] {
  return orders.filter(order => {
    const point = order.attention;
    if (!point) return false;
    const key = JSON.stringify([order.project, order.tag]);
    if ((latest.get(key) ?? '') >= point.at) return false;
    latest.set(key, point.at);
    return Date.parse(point.at) > since && !!order.unread && !order.muted && order.tag !== focusedTag;
  });
}

const notifyKey = 'alba-browser-notify', soundKey = 'alba-browser-sound';
export const preferences = () => ({ notify: localStorage.getItem(notifyKey) === 'true', sound: localStorage.getItem(soundKey) === 'true' });
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
  if (navigator.locks) await navigator.locks.request(key, deliver);
  else deliver();
}
