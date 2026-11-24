import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { keys } from '@/lib/keys';
import { useOrder } from '@/lib/queries';
import { t } from '@/i18n';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { LivePanel } from './LivePanel';
import { MessageBox } from './MessageBox';
import { Empty, ErrorBox } from './common';

export function refreshWhilePeeking(refresh: () => void) {
  const timer = setInterval(refresh, 5_000);
  return () => clearInterval(timer);
}

function PeekContent({ project, tag }: { project: string; tag: string }) {
  const order = useOrder(project, tag);
  const run = order.data?.runs.find(r => !r.ended) ?? order.data?.runs.at(-1);
  const key = run?.key ?? '';
  const log = useQuery({ queryKey: [...keys.runLog(project, key), 200], queryFn: () => api.runLog(project, key, 200), enabled: !!run?.hasLog, retry: false });
  const { refetch: readOrder } = order, { refetch: readLog } = log;
  useEffect(() => refreshWhilePeeking(() => { void readOrder(); if (run?.hasLog) void readLog(); }), [readOrder, readLog, run?.hasLog]);
  return <DialogContent className="w-[min(94vw,52rem)]" aria-describedby={undefined}>
    <DialogTitle>{t('Peek')} · {tag}</DialogTitle>
    {order.isError && <ErrorBox error={order.error} />}
    {run && <>
      <Link className="text-sm text-primary hover:underline" to={`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(tag)}/runs/${encodeURIComponent(run.id)}`}>{t('Open full run')}</Link>
      {run.live ? <LivePanel live={run.live} /> : <Empty>{t('No live activity recorded for this run.')}</Empty>}
      {log.isError ? <ErrorBox error={log.error} /> : run.hasLog ? <pre className="max-h-56 overflow-auto rounded bg-muted p-2 text-xs">{log.data?.lines.join('\n')}</pre> : <Empty>{t('No log: this run was not started by the tool.')}</Empty>}
    </>}
    {order.data && <MessageBox project={project} tag={tag} d={order.data} />}
  </DialogContent>;
}

export function RunPeek({ project, tag }: { project: string; tag: string }) {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}><button className="relative text-xs text-primary hover:underline" onClick={() => setOpen(true)}>{t('Peek')}</button>
    {open && <PeekContent project={project} tag={tag} />}
  </Dialog>;
}
