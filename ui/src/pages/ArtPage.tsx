import { useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, ImageOff, Palette, Search, Check } from 'lucide-react';
import type { ArtRef, ArtSetting } from '@api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Lightbox, type LightboxItem } from '@/components/Lightbox';
import { Empty, ErrorBox, PageHeader, Section } from '@/components/common';
import { fileUrl, refImageUrl } from '@/lib/api';
import { canConfirm, confirmationText, filterRefs, settingStatusTone, shortSha, tagsLeft } from '@/lib/library';
import { dateTime } from '@/lib/format';
import { errorText, useApproveSetting, useArt, useProjectId } from '@/lib/queries';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

/** The reference board: every picture is a card; the tags narrow the board (a card must carry all the tags chosen). */
function RefBoard({ project, refs, allTags }: { project: string; refs: ArtRef[]; allTags: { tag: string; count: number }[] }) {
  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const shown = useMemo(() => filterRefs(refs, tags, query), [refs, tags, query]);
  const left = useMemo(() => tagsLeft(refs, tags, query), [refs, tags, query]);
  const offered = tags.length ? left : allTags;
  const items: LightboxItem[] = shown.filter(r => r.cached).map(r => ({ src: refImageUrl(project, r.id), name: r.title, kind: 'image' as const, caption: [r.work, r.learn].filter(Boolean).join(' · ') }));
  const toggle = (tag: string) => setTags(s => (s.includes(tag) ? s.filter(x => x !== tag) : [...s, tag]));
  if (!refs.length) return <Empty>{t('The board is empty. Add a card with: alba refs add --page <address> --title … --tags … --learn …')}</Empty>;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" /><Input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Search title, work, notes, tags')} className="pl-8" /></div>
        <span className="text-xs text-muted-foreground">{t('{n} of {total} cards', { n: shown.length, total: refs.length })}</span>
        {tags.length > 0 && <Button size="sm" variant="ghost" onClick={() => setTags([])}>{t('Clear tags')}</Button>}
      </div>
      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label={t('Tags')}>
        {[...tags.filter(x => !offered.some(o => o.tag === x)).map(tag => ({ tag, count: 0 })), ...offered].map(({ tag, count }) => {
          const on = tags.includes(tag);
          return (
            <button key={tag} type="button" aria-pressed={on} onClick={() => toggle(tag)} className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors', on ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent')}>
              {tag}<span className={cn('tabular-nums', on ? 'text-primary-foreground/80' : 'text-muted-foreground/70')}>{count}</span>
            </button>
          );
        })}
      </div>
      {shown.length === 0 ? <Empty>{t('No card carries all of these tags.')}</Empty> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map(r => {
            const at = r.cached ? items.findIndex(i => i.src === refImageUrl(project, r.id)) : -1;
            return (
              <Card key={r.id} className="flex flex-col overflow-hidden">
                {r.cached ? (
                  <button type="button" className="block aspect-[4/3] overflow-hidden bg-muted" onClick={() => setOpen(at)} title={t('Look at it large')}>
                    <img src={refImageUrl(project, r.id)} alt={r.title} loading="lazy" className="size-full object-cover" />
                  </button>
                ) : (
                  <div className="grid aspect-[4/3] place-items-center gap-1 bg-muted p-3 text-center text-xs text-muted-foreground"><ImageOff className="size-5 opacity-60" />{r.failure ? <span className="line-clamp-3">{r.failure}</span> : t('not fetched yet (alba refs fetch)')}</div>
                )}
                <div className="flex flex-1 flex-col gap-1.5 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><div className="truncate text-sm font-medium" title={r.title}>{r.title}</div>{r.work && <div className="truncate text-xs text-muted-foreground">{r.work}</div>}</div>
                    {r.page && <a href={r.page} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={t('Open the page')}><ExternalLink className="size-3.5" /></a>}
                  </div>
                  {r.learn && <p className="text-xs">{r.learn}</p>}
                  <div className="mt-auto flex flex-wrap gap-1 pt-1">
                    {r.tags.map(tag => <button key={tag} type="button" onClick={() => toggle(tag)} className={cn('rounded-full border px-1.5 text-[11px]', tags.includes(tag) ? 'border-primary text-primary' : 'text-muted-foreground hover:bg-accent')}>{tag}</button>)}
                    {r.cacheFrom === 'external' && <Badge tone="outline">{t('studio cache')}</Badge>}
                    {r.failure && <Badge tone="warning" title={r.failure}>{t('not fetched')}</Badge>}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </div>
  );
}

function ConfirmDialog({ project, setting, onClose }: { project: string; setting: ArtSetting; onClose: () => void }) {
  const approve = useApproveSetting(project);
  const [note, setNote] = useState('');
  return (
    <Dialog open onOpenChange={o => { if (!o && !approve.isPending) onClose(); }}>
      <DialogContent className="w-[min(94vw,40rem)]">
        <DialogTitle>{t('Confirm the text of {title}?', { title: setting.title })}</DialogTitle>
        <DialogDescription>{t('The words below are fixed by their fingerprint. If the section of the file is edited afterwards, the confirmation no longer counts. No picture — not even a test picture — is made before the text is confirmed.')}</DialogDescription>
        <pre className="max-h-72 overflow-auto rounded-md border-l-2 border-primary bg-muted px-3 py-2 text-xs whitespace-pre-wrap">{setting.body}</pre>
        <div className="font-mono text-[11px] text-muted-foreground">sha256 {shortSha(setting.textSha256)}…</div>
        <div className="grid gap-1.5"><Label>{t('Note (optional)')}</Label><Textarea value={note} onChange={e => setNote(e.target.value)} className="min-h-14" /></div>
        {approve.isError && <ErrorBox error={errorText(approve.error)} />}
        <DialogFooter>
          <Button variant="ghost" disabled={approve.isPending} onClick={onClose}>{t('Back')}</Button>
          <Button variant="success" disabled={approve.isPending} onClick={() => approve.mutate({ id: setting.id, note: note.trim() || undefined, fingerprint: setting.textSha256 }, { onSuccess: onClose })}>{approve.isPending ? t('Working…') : t('Confirm the text')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A setting card: its text (the section the card points to), the cards it takes from, its pictures, what is wrong with the file, and the confirmation of the text. */
function SettingCard({ project, s }: { project: string; s: ArtSetting }) {
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const conf = confirmationText(s);
  const shown = s.images.filter(i => i.exists);
  const items: LightboxItem[] = shown.map(i => ({ src: fileUrl(project, i.path), name: i.path.split('/').pop() ?? i.path, kind: 'image' as const, caption: i.path }));
  return (
    <Card className="p-4" id={`setting-${s.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{s.title}</span>
        <span className="font-mono text-xs text-muted-foreground">{s.id}</span>
        {s.kind && <Badge tone="outline">{s.kind}</Badge>}
        <Badge tone={settingStatusTone(s)} title={s.standard ? undefined : t('not one of text-draft, text-approved, sheets, final')}>{s.status || t('no status')}{s.standard ? '' : ` · ${t('not standard')}`}</Badge>
        <Badge tone={conf.tone}>{conf.text}</Badge>
        {canConfirm(s) && <Button size="sm" className="ml-auto" onClick={() => setConfirming(true)}><Check />{t('Confirm the text')}</Button>}
      </div>
      <div className="mt-1 font-mono text-[11px] text-muted-foreground">{s.text}{s.textSha256 ? ` · sha256 ${shortSha(s.textSha256)}…` : ''}{s.decision ? ` · ${s.decision}` : ''}</div>
      {s.confirmation && <div className="mt-0.5 text-xs text-muted-foreground">{t('confirmed {when} by {who}', { when: dateTime(s.confirmation.at), who: s.confirmation.who ?? s.confirmation.by })}{s.confirmation.source === 'external' ? ` · ${t('from the studio’s record')}` : ''}{s.confirmation.note ? ` · “${s.confirmation.note}”` : ''}</div>}

      {s.body !== undefined
        ? <details className="mt-2" open={!s.confirmed}><summary className="cursor-pointer text-xs text-primary hover:underline">{t('The text')}</summary><pre className="mt-1 max-h-72 overflow-auto rounded-md bg-muted px-3 py-2 text-[13px] whitespace-pre-wrap">{s.body}</pre></details>
        : <p className="mt-2 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">{t('The text of this setting cannot be read; see below.')}</p>}

      {s.refCards.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">{t('References')}</div>
          <div className="flex flex-wrap gap-2">
            {s.refCards.map(r => (
              <div key={r.id} className="w-28" title={`${r.title}${r.learn ? ` — ${r.learn}` : ''}`}>
                {r.cached ? <img src={refImageUrl(project, r.id)} alt={r.title} loading="lazy" className="aspect-[4/3] w-full rounded-md object-cover" /> : <div className="grid aspect-[4/3] place-items-center rounded-md bg-muted text-muted-foreground"><ImageOff className="size-4 opacity-60" /></div>}
                <div className="truncate text-[11px] text-muted-foreground">{r.title}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {s.images.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">{t('Pictures')} · {s.images.length}</div>
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {s.images.map(i => i.exists ? (
              <button key={i.path} type="button" onClick={() => setOpen(shown.findIndex(x => x.path === i.path))} className="block aspect-[4/3] overflow-hidden rounded-md bg-muted" title={i.path}>
                <img src={fileUrl(project, i.path)} alt={i.path} loading="lazy" className="size-full object-cover" />
              </button>
            ) : <div key={i.path} className="grid aspect-[4/3] place-items-center rounded-md border border-dashed px-2 text-center text-[11px] text-muted-foreground">{t('missing')}: {i.path.split('/').pop()}</div>)}
          </div>
        </div>
      )}
      {s.problems.length > 0 && (
        <ul className="mt-3 grid gap-1 rounded-md border border-warning/40 bg-warning/8 px-3 py-2 text-xs">
          {s.problems.map((p, i) => <li key={i} className="flex items-start gap-1.5"><AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />{p}</li>)}
        </ul>
      )}
      <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      {confirming && <ConfirmDialog project={project} setting={s} onClose={() => setConfirming(false)} />}
    </Card>
  );
}

/** The art page: the setting cards (words first), and the reference board. */
export function ArtPage() {
  const project = useProjectId();
  const q = useArt(project);
  if (q.isError) return <ErrorBox error={q.error} />;
  if (!q.data) return <div className="grid gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-64" /></div>;
  const d = q.data;
  const confirmed = d.settings.filter(s => s.confirmed).length;
  return (
    <div>
      <PageHeader title={<><Palette className="size-5" />{t('Art')}</>}>
        {t('{r} references ({c} fetched) · {s} settings ({k} with confirmed text)', { r: d.refs.length, c: d.cache.cached, s: d.settings.length, k: confirmed })}
        {d.compare.length > 0 && <> · {t('{n} file(s) in compare/ (listed only)', { n: d.compare.length })}</>}
      </PageHeader>
      {!d.enabled && <Empty>{t('This project has no art section. Add "art: dir" to the project file.')}</Empty>}
      {d.problems.length > 0 && (
        <details className="mb-4 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm" open={d.problems.length <= 3}>
          <summary className="cursor-pointer">{t('{n} thing(s) to look at in the art files', { n: d.problems.length })}</summary>
          <ul className="mt-1.5 grid gap-0.5 text-xs">{d.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </details>
      )}
      {d.enabled && (
        <Tabs defaultValue="settings">
          <TabsList>
            <TabsTrigger value="settings">{t('Settings')} · {d.settings.length}</TabsTrigger>
            <TabsTrigger value="board">{t('Reference board')} · {d.refs.length}</TabsTrigger>
          </TabsList>
          <TabsContent value="settings">
            {d.settings.length === 0 ? <Empty>{t('No setting cards in settings/.')}</Empty> : <div className="grid gap-3">{d.settings.map(s => <SettingCard key={s.id} project={project} s={s} />)}</div>}
          </TabsContent>
          <TabsContent value="board">
            <RefBoard project={project} refs={d.refs} allTags={d.tags} />
            {d.cache.failures.length > 0 && (
              <Section title={t('Pictures that could not be fetched')} count={d.cache.failures.length} className="mt-6">
                <Card className="divide-y text-xs">{d.cache.failures.map(f => <div key={f.id} className="flex flex-wrap gap-x-3 px-3 py-1.5"><span className="font-mono">{f.id}</span><span className="min-w-0 flex-1 break-all text-muted-foreground">{f.image}</span><span>{f.reason}</span></div>)}</Card>
              </Section>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
