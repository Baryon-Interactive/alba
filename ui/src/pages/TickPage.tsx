import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Eye, Play, RefreshCw } from 'lucide-react';
import type { TickView } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/misc';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { ErrorBox, PageHeader, Section, TagLink } from '@/components/common';
import { errorText, useProjectId, useSession, useTick } from '@/lib/queries';
import { ago, dateTime } from '@/lib/format';
import { t } from '@/i18n';

const MODE = (m: string) => (m === 'card' ? t('offer a card to start') : m === 'resume' ? t('resume') : t('start'));

function Result({ project, v }: { project: string; v: TickView }) {
  const none = !v.moves.length && !v.heldBack.length && !v.problems.length && !v.finishes.length && !v.waiting.length;
  return (
    <div className="grid gap-5">
      {v.real && v.done.length > 0 && (
        <Section title={t('What the tick did')} count={v.done.length}><Card><CardContent className="grid gap-1">{v.done.map((d, i) => <div key={i} className="text-sm">{d}</div>)}</CardContent></Card></Section>
      )}
      {v.finishes.length > 0 && (
        <Section title={t('Runs whose end would be recorded')} count={v.finishes.length}>
          <Card className="divide-y">{v.finishes.map(f => <div key={f.tag + f.run} className="flex items-center gap-2 px-4 py-2 text-sm"><TagLink project={project} tag={f.tag} /><span>{f.run}</span><Badge>{f.outcome}</Badge><span className="text-muted-foreground">{f.why}</span></div>)}</Card>
        </Section>
      )}
      {v.moves.length > 0 && (
        <Section title={v.real ? t('Started or offered') : t('The next tick would start or resume')} count={v.moves.length}>
          <Card className="divide-y">{v.moves.map(m => <div key={m.tag} className="flex items-center gap-2 px-4 py-2 text-sm"><Badge tone={m.mode === 'card' ? 'warning' : 'primary'}>{MODE(m.mode)}</Badge><TagLink project={project} tag={m.tag} /><span className="text-muted-foreground">{m.mode === 'card' ? t('in') : t('with')} {m.worker}{m.rework ? ` · ${t('rework')}` : ''}{m.rotated ? ` · ${t('handed over from {from}: {reason}', { from: m.rotated.from, reason: m.rotated.reason })}` : ''}</span></div>)}</Card>
        </Section>
      )}
      {v.heldBack.length > 0 && (
        <Section title={t('Held back')} count={v.heldBack.length}>
          <Card className="divide-y">{v.heldBack.map(h => <div key={h.tag} className="flex items-center gap-2 px-4 py-2 text-sm"><TagLink project={project} tag={h.tag} /><span className="text-muted-foreground">{h.why}</span></div>)}</Card>
        </Section>
      )}
      {v.waiting.length > 0 && (
        <Section title={t('Waiting on a command')} count={v.waiting.length}><Card className="divide-y">{v.waiting.map(w => <div key={w.tag} className="px-4 py-2 text-sm"><TagLink project={project} tag={w.tag} /> <span className="text-muted-foreground">{w.text}</span></div>)}</Card></Section>
      )}
      {v.monitoring.length > 0 && (
        <Section title={t('Monitoring')} count={v.monitoring.length}><Card className="divide-y">{v.monitoring.map(m => <div key={m.tag} className="px-4 py-2 text-sm"><TagLink project={project} tag={m.tag} /> <span className="text-muted-foreground">{m.text.replace(new RegExp(`^${m.tag}: `), '')}</span></div>)}</Card></Section>
      )}
      {v.problems.length > 0 && (
        <Section title={t('Problems')} count={v.problems.length}><Card className="divide-y">{v.problems.map((p, i) => <div key={i} className="px-4 py-2 text-sm">{p.text}{p.evidence && p.evidence.length > 0 && <ul className="mt-1 grid gap-0.5 font-mono text-xs text-muted-foreground">{p.evidence.map((line, j) => <li key={j}>{line}</li>)}</ul>}</div>)}</Card></Section>
      )}
      {v.unavailable.length > 0 && (
        <Section title={t('Workers not available')} count={v.unavailable.length}><Card className="divide-y">{v.unavailable.map(u => <div key={u.worker} className="px-4 py-2 text-sm"><b>{u.worker}</b> <span className="text-muted-foreground">{u.reasons.join('; ')}</span></div>)}</Card></Section>
      )}
      {none && <div className="text-sm text-muted-foreground">{t('Nothing to do now.')}</div>}
      <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{t('Same as the command line prints')}</summary><pre className="mt-2 overflow-auto rounded-lg bg-muted p-3 font-mono whitespace-pre-wrap">{v.text}</pre></details>
    </div>
  );
}

export function TickPage() {
  const project = useProjectId();
  const session = useSession();
  const tick = useTick(project);
  const [real, setReal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [last, setLast] = useState<TickView>();

  // Opening the page shows what the next tick would do; nothing is started or recorded by it.
  const preview = tick.mutate;
  useEffect(() => { preview({ real: false }, { onSuccess: v => setLast(v) }); }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

  const loop = session.data?.loop;
  const runReal = () => tick.mutate({ real: true, maxDispatch: 1 }, { onSuccess: v => { setLast(v); setConfirm(false); setReal(false); } });

  return (
    <div>
      <PageHeader
        title={t('Tick')}
        actions={
          <>
            <Button variant="outline" size="sm" disabled={tick.isPending} onClick={() => tick.mutate({ real: false }, { onSuccess: setLast })}><RefreshCw className={tick.isPending ? 'animate-spin' : ''} />{t('Preview again')}</Button>
          </>
        }
      >
        {t('A tick decides what to start, resume or record. The preview below changes nothing.')}
      </PageHeader>

      <div className="mb-5 grid gap-3 md:grid-cols-2">
        <Card><CardContent>
          <div className="mb-1 text-xs font-medium text-muted-foreground">{t('Last tick')}</div>
          {loop?.lastTickAt ? (
            <div className="flex items-center gap-2 text-sm"><span>{ago(loop.lastTickAt)}</span><span className="text-muted-foreground">({dateTime(loop.lastTickAt)})</span><Badge tone={loop.lastExitCode ? 'warning' : 'success'}>{t('exit code {n}', { n: loop.lastExitCode ?? 0 })}</Badge></div>
          ) : <div className="text-sm text-muted-foreground">{t('No tick has run in this server yet.')}</div>}
          {loop && <div className="mt-1 text-xs text-muted-foreground">{t('The server ticks every {n} min.', { n: loop.everyMinutes })}</div>}
        </CardContent></Card>
        <Card><CardContent>
          <div className="mb-2 text-xs font-medium text-muted-foreground">{t('Run it now')}</div>
          <label className="flex items-start gap-2 text-sm"><Checkbox checked={real} onCheckedChange={v => setReal(v === true)} className="mt-0.5" /><span>{t('really run it (start and resume workers); unchecked it only shows what it would do')}</span></label>
          <Button className="mt-3" variant={real ? 'default' : 'outline'} disabled={!real || tick.isPending} onClick={() => setConfirm(true)}><Play />{t('Tick once now')}</Button>
        </CardContent></Card>
      </div>

      {tick.isError && <ErrorBox error={errorText(tick.error)} />}
      {last && (
        <>
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            {last.real ? <Badge tone="warning"><Play />{t('real tick')}</Badge> : <Badge tone="primary"><Eye />{t('preview')}</Badge>}
            <span className="font-normal text-muted-foreground">{dateTime(last.at)}</span>
            {last.needsUser.some(n => n.tags.length) && <span className="font-normal text-muted-foreground">· {t('needs you')}: {last.needsUser.filter(n => n.tags.length).map(n => n.tags.join(', ')).join(', ')}</span>}
          </div>
          <Result project={project} v={last} />
        </>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogTitle>{t('Run a real tick now?')}</DialogTitle>
          <DialogDescription>{t('It starts at most one order, resumes what can be resumed and records finished runs, with the same limits as a scheduled tick.')}</DialogDescription>
          {(last?.moves.length ?? 0) > 0 && <ul className="rounded-md bg-muted px-4 py-2 text-sm">{last!.moves.map(m => <li key={m.tag}>{MODE(m.mode)} <b>{m.tag}</b> {m.mode === 'card' ? t('in') : t('with')} {m.worker}</li>)}</ul>}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>{t('Back')}</Button>
            <Button disabled={tick.isPending} onClick={runReal}>{tick.isPending ? t('Working…') : t('Confirm: {verb}', { verb: t('Tick once now') })}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="mt-6 text-xs text-muted-foreground"><Link className="hover:underline" to={`/p/${encodeURIComponent(project)}/board`}>{t('Board')}</Link></div>
    </div>
  );
}
