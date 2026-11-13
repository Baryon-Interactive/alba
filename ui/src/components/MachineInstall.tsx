import type { MachineJob } from '../../../src/machines/jobs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { ErrorBox } from '@/components/common';
import { ago } from '@/lib/format';
import { useMachineChanges, useMachineInstallPlan } from '@/lib/queries';
import { t } from '@/i18n';

/** Shows what installing an item will do (commands, size, terms) and starts it only on the person's click. */
export function InstallDialog({ project, machine, item, jobs = [], onClose }: { project: string; machine: string; item: string | null; jobs?: MachineJob[]; onClose: () => void }) {
  const plan = useMachineInstallPlan(project, machine, item);
  const { install } = useMachineChanges(project);
  const p = plan.data?.plan;
  const locked = !!p && jobs.some(j => j.status === 'running' && (j.lock ?? 'install') === (p.lock ?? 'install'));
  return <Dialog open={!!item} onOpenChange={o => { if (!o) onClose(); }}>
    <DialogContent className="w-[min(94vw,42rem)]">
      <DialogTitle>{p ? t('Install {what} on {id}', { what: p.title, id: machine }) : t('Install on {id}', { id: machine })}</DialogTitle>
      <DialogDescription>{t('Nothing runs until you click Start. alba then runs these commands on the machine, shows the output here and scans the machine again at the end.')}</DialogDescription>
      {plan.isLoading && <p className="text-sm text-muted-foreground">{t('Preparing the installation plan…')}</p>}
      {plan.error && <ErrorBox error={plan.error} />}
      {p && <div className="grid gap-3 text-sm">
        <p><span className="text-muted-foreground">{t('Size and time')}: </span>{p.estimate}</p>
        <ul className="grid list-disc gap-1 pl-5 text-xs">{p.notes.map(n => <li key={n}>{t(n)}</li>)}</ul>
        <div className="grid gap-1"><span className="text-xs text-muted-foreground">{t('Commands')}</span>
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all">{p.display.join('\n')}</pre></div>
      </div>}
      {locked && <p className="text-xs text-warning">{t('Another job is using this installer lock. Wait for it to finish.')}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t('Cancel')}</Button>
        <Button disabled={!p || locked || install.isPending} onClick={() => install.mutate({ id: machine, item: item! }, { onSuccess: onClose })}>{t('Start installing')}</Button>
      </DialogFooter>
      {install.error && <ErrorBox error={install.error} />}
    </DialogContent>
  </Dialog>;
}

const TONE: Record<MachineJob['status'], 'primary' | 'success' | 'danger' | 'warning' | 'outline'> = { running: 'primary', ok: 'success', failed: 'danger', cancelled: 'outline', interrupted: 'warning' };
const STATUS: Record<MachineJob['status'], string> = { running: 'Running', ok: 'Done', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' };

/** The machine's running jobs (or else its latest one): status, current step and the end of its output. */
export function MachineJobs({ project, jobs }: { project: string; jobs: MachineJob[] }) {
  const running = jobs.filter(j => j.status === 'running');
  const shown = running.length ? running : jobs.slice(0, 1);
  if (!shown.length) return null;
  return <div className="grid gap-3 border-t pt-3">
    <h3 className="text-sm font-semibold">{t('Job')}</h3>
    {shown.map(job => <JobCard key={job.id} project={project} job={job} />)}
  </div>;
}

function JobCard({ project, job }: { project: string; job: MachineJob }) {
  const { cancelJob } = useMachineChanges(project);
  const tail = job.output.split(/\r?\n/).filter(l => l.trim()).slice(-12).join('\n');
  return <div className="grid gap-1.5">
    {job.status === 'running' && <div className="flex justify-end"><Button size="sm" variant="outline" disabled={cancelJob.isPending} onClick={() => cancelJob.mutate(job.id)}>{t('Stop')}</Button></div>}
    <div className="flex flex-wrap items-center gap-1.5 text-xs"><span className="font-medium">{job.title}</span><Badge tone={TONE[job.status]}>{t(STATUS[job.status])}</Badge>
      <span className="text-muted-foreground">{t('started {ago}', { ago: ago(job.started) })}{job.step && job.status === 'running' ? ` · ${job.step}` : ''}{job.exit_code !== undefined && job.status !== 'ok' ? ` · ${t('exit code {n}', { n: job.exit_code })}` : ''}</span></div>
    {job.status === 'interrupted' && <p className="text-xs text-warning">{t('alba restarted while this ran. Start it again; finished parts are skipped or overwritten.')}</p>}
    {tail && <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px] whitespace-pre-wrap break-all">{tail}</pre>}
  </div>;
}
