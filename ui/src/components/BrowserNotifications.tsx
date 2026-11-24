import { useEffect, useRef, useState } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router';
import { Bell } from 'lucide-react';
import type { OrderSummary } from '@api';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog';
import { enableAudio, newNotifications, notifyOrder, preferences, savePreference } from '@/lib/notifications';
import { t } from '@/i18n';

const loaded = Date.now();
export function BrowserNotifications({ project, orders }: { project: string; orders?: OrderSummary[] }) {
  const [prefs, setPrefs] = useState(preferences);
  const [blocked, setBlocked] = useState(() => typeof Notification === 'undefined' || Notification.permission === 'denied');
  const latest = useRef(new Map<string, string>());
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
  useEffect(() => {
    const match = matchPath('/p/:project/orders/:tag/*', pathname);
    const tag = document.hasFocus() && !document.hidden && match?.params.project === project ? match.params.tag : undefined;
    for (const order of newNotifications(orders ?? [], latest.current, loaded, tag)) {
      if (prefs.notify || prefs.sound) void notifyOrder(order, () => navigate(`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(order.tag)}`)).catch(() => {});
    }
  }, [orders, pathname, project, prefs, navigate]);
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
