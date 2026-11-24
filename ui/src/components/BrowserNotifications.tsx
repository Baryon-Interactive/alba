import { useEffect, useState } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { Bell } from 'lucide-react';
import type { OrderSummary } from '@api';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog';
import { enableAudio, notificationTracker, notifyOrder, preferences, savePreference, watchFocusedOrder } from '@/lib/notifications';
import { t } from '@/i18n';

const loaded = Date.now();
export function BrowserNotifications({ project, orders }: { project: string; orders?: OrderSummary[] }) {
  const [prefs, setPrefs] = useState(preferences);
  const [blocked, setBlocked] = useState(() => typeof Notification === 'undefined' || Notification.permission === 'denied');
  const [track] = useState(() => notificationTracker(loaded));
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const update = () => setPrefs(preferences());
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  useEffect(() => {
    if (!prefs.sound) return;
    window.addEventListener('click', enableAudio);
    window.addEventListener('keydown', enableAudio);
    return () => { window.removeEventListener('click', enableAudio); window.removeEventListener('keydown', enableAudio); };
  }, [prefs.sound]);
  const match = matchPath('/p/:project/orders/:tag/*', pathname);
  const openTag = match?.params.project === project ? match.params.tag : undefined;
  useEffect(() => {
    if (openTag && (prefs.sound || prefs.notify)) return watchFocusedOrder(project, openTag);
  }, [project, openTag, prefs.sound, prefs.notify]);
  useEffect(() => {
    if (!orders) return;
    const tag = document.hasFocus() && !document.hidden ? openTag : undefined;
    for (const order of track(project, orders, tag)) {
      if (prefs.notify || prefs.sound) void notifyOrder(order, () => navigate(`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(order.tag)}`)).catch(() => {});
    }
  }, [orders, openTag, project, prefs, navigate, track]);
  const save = (key: 'notify' | 'sound', value: boolean) => { savePreference(key, value); setPrefs(preferences()); };
  async function toggleNotify(on: boolean) {
    if (!on) { save('notify', false); return; }
    try {
      const permission = typeof Notification === 'undefined' ? 'denied' : await Notification.requestPermission();
      setBlocked(permission === 'denied');
      save('notify', permission === 'granted');
    } catch { setBlocked(true); save('notify', false); }
  }
  return <Dialog><DialogTrigger asChild><Button size="icon" variant="ghost" aria-label={t('Browser notifications')}><Bell /></Button></DialogTrigger>
    <DialogContent aria-describedby={undefined}><DialogTitle>{t('Browser notifications')}</DialogTitle>
      <label className="flex items-center gap-2"><input type="checkbox" checked={prefs.notify && !blocked} onChange={e => void toggleNotify(e.target.checked)} />{t('Notify me in this browser')}</label>
      {blocked && <p className="text-sm text-muted-foreground">{t('Blocked by the browser')}</p>}
      <label className="flex items-center gap-2"><input type="checkbox" checked={prefs.sound} onChange={e => { if (e.target.checked) enableAudio(); save('sound', e.target.checked); }} />{t('Play a sound')}</label>
    </DialogContent></Dialog>;
}
