import { createContext, useContext, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AttentionState, OrderSummary } from '@api';
import { Ellipsis } from 'lucide-react';
import { toast } from 'sonner';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { keys } from '@/lib/keys';
import { presence } from '@/lib/presence';
import { t } from '@/i18n';

export const ProjectOrders = createContext<ReadonlyMap<string, OrderSummary>>(new Map());

export function NewPill({ tag, unread }: { tag?: string; unread?: boolean }) {
  const orders = useContext(ProjectOrders);
  if (!(unread ?? orders.get(tag ?? '')?.unread)) return null;
  return <span className="new-pill mx-1 inline-flex shrink-0 items-center rounded-full bg-primary px-1.5 py-0.5 font-sans text-[10px] leading-none font-semibold text-primary-foreground"><span aria-hidden>{t('New')}</span><span className="sr-only">{t('New')}</span></span>;
}

function useAttentionWrite(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (write: () => Promise<unknown>) => write(),
    onSuccess: () => Promise.all([keys.orders(project), ['order', project], keys.overview(project), keys.projectOverview(project)].map(queryKey => client.invalidateQueries({ queryKey }))),
    onError: error => toast.error(error.message),
  });
}

export function useSeenWhilePresent(project: string, tag: string, order?: AttentionState) {
  const { mutate } = useAttentionWrite(project);
  const at = order?.unread && order.attention?.at;
  useEffect(() => {
    if (!at) return;
    let sent = false;
    return presence.watch(() => {
      if (sent) return;
      sent = true;
      mutate(() => api.markSeen(project, tag, at), { onError: () => { sent = false; } });
    });
  }, [project, tag, at, mutate]);
}

export function MarkAllRead({ project }: { project: string }) {
  const write = useAttentionWrite(project);
  return <button className="text-xs text-primary hover:underline" disabled={write.isPending} onClick={() => write.mutate(() => api.markAllSeen(project))}>{t('Mark all read')}</button>;
}

export function MuteMenu({ project, tag, muted }: { project: string; tag: string; muted?: boolean }) {
  const write = useAttentionWrite(project);
  return <Menu><MenuTrigger className="rounded p-1 hover:bg-accent" aria-label={t('Order menu for {tag}', { tag })}><Ellipsis className="size-4" /></MenuTrigger>
    <MenuContent><MenuItem disabled={write.isPending} onSelect={() => write.mutate(() => api.mute(project, tag, !muted))}>{muted ? t('Unmute order') : t('Mute order')}</MenuItem></MenuContent></Menu>;
}
