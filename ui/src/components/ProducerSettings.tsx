import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProducerConfigEdit } from '@api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/input';
import { ErrorBox } from '@/components/common';
import { api } from '@/lib/api';
import { errorText } from '@/lib/queries';
import { diffRows } from '@/lib/producer-settings';
import { t } from '@/i18n';

function Diff({ edit }: { edit: ProducerConfigEdit }) {
  if (!edit.changed) return <p className="text-sm text-muted-foreground">{t('No change.')}</p>;
  return <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 text-xs leading-5 whitespace-pre" aria-label={t('Changes')}>
    {diffRows(edit.diff).map((d, i) => <div key={i} className={d.op === '+' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : d.op === '-' ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300' : 'text-muted-foreground'}>{d.op === '…' ? '…' : `${d.op} ${d.text}`}</div>)}
  </pre>;
}

/** Edits the producer section of the project file: Preview checks the whole file and shows the change, Save writes it with a backup. */
export function ProducerSettingsDialog({ project, open, onOpenChange }: { project: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const client = useQueryClient();
  const current = useQuery({ queryKey: ['producer-config', project], queryFn: () => api.producerConfig(project), enabled: open && !!project });
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<ProducerConfigEdit>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open && current.data) { setText(current.data.yaml); setPreview(undefined); setError(undefined); } }, [open, current.data]);
  const run = async (dryRun: boolean) => {
    setBusy(true); setError(undefined);
    try {
      const result = await api.producerConfigEdit(project, text, dryRun);
      if (dryRun) { setPreview(result); return; }
      toast.success(result.changed ? t('Producer settings saved; serve reads them again by itself.') : t('No change.'));
      await client.invalidateQueries({ queryKey: ['producer-config', project] });
      void client.invalidateQueries({ queryKey: ['producer-workspace', project] });
      onOpenChange(false);
    } catch (e) { setError(errorText(e)); setPreview(undefined); } finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="top-[4vh] max-h-[92vh] w-[min(96vw,56rem)] overflow-y-auto">
      <DialogTitle>{t('Producer settings')}</DialogTitle>
      <DialogDescription>{t('The producer section of {file}. Preview checks the whole file as serve reads it; Save keeps a backup next to it.', { file: current.data?.file ?? 'alba.yaml' })}</DialogDescription>
      {current.isError ? <ErrorBox error={current.error} /> : <div className="grid gap-3">
        <Textarea aria-label={t('Producer section (YAML)')} className="h-[45vh] min-h-48 font-mono text-xs" spellCheck={false} value={text} onChange={e => { setText(e.target.value); setPreview(undefined); }} />
        {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive" role="alert">{error}</p>}
        {preview && <Diff edit={preview} />}
      </div>}
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('Cancel')}</Button>
        <Button variant="outline" disabled={busy || !current.data} onClick={() => void run(true)}>{t('Preview')}</Button>
        <Button disabled={busy || !preview?.changed} onClick={() => void run(false)}>{t('Save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
