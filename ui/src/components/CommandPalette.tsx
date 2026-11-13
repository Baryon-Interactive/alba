import { Command } from 'cmdk';
import { useNavigate } from 'react-router';
import { Activity, Bell, BookOpen, Cpu, Eraser, Files, Scale, KanbanSquare, Languages, Moon, Plus, Puzzle, Timer, FileText, Zap } from 'lucide-react';
import type { ProjectInfo } from '@api';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { docReaderTo } from '@/lib/docs';
import { useDocs, useOrders } from '@/lib/queries';
import { getLang, setLang, t } from '@/i18n';
import { setTheme, useTheme } from '@/lib/theme';
import { actionLabel, stageLabel } from '@/lib/stages';
import type { OrderAction, OrderSummary } from '@api';

/** The actions worth offering from the palette for an order in this stage; each opens the confirmation on the order page. */
const PALETTE_ACTIONS: Partial<Record<OrderSummary['stage'], OrderAction[]>> = {
  'awaiting-user': ['answer'], 'awaiting-review': ['approve', 'rework'], blocked: ['rework', 'queue'], failed: ['rework', 'queue'],
  dropped: ['queue'], draft: ['queue'], queued: ['run'], held: ['release'],
};

const item = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm data-[selected=true]:bg-accent';

/** Ctrl/⌘ K: jump to an order, a page or a project, or run a general action. Order actions are done on the order page, behind a confirmation. */
export function CommandPalette({ open, onOpenChange, project, projects }: { open: boolean; onOpenChange: (o: boolean) => void; project: string; projects: ProjectInfo[] }) {
  const navigate = useNavigate();
  const orders = useOrders(project);
  const docs = useDocs(project, open);
  const documents = (docs.data?.items ?? []).filter(d => d.exists);
  const theme = useTheme();
  const base = `/p/${encodeURIComponent(project)}`;
  const go = (to: string) => () => { onOpenChange(false); navigate(to); };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[14vh] w-[min(92vw,38rem)] gap-0 p-0">
        <DialogTitle className="sr-only">{t('Command palette')}</DialogTitle>
        <Command loop className="flex max-h-[60vh] flex-col">
          <Command.Input autoFocus placeholder={t('Type an order tag or title, a page or an action…')} className="h-11 border-b bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground" />
          <Command.List className="overflow-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">{t('Nothing found.')}</Command.Empty>
            <Command.Group heading={t('Pages')} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
              <Command.Item className={item} onSelect={go(base)}><Bell className="size-4" />{t('Needs you')}</Command.Item>
              <Command.Item className={item} onSelect={go(`${base}/board`)}><KanbanSquare className="size-4" />{t('Board')}</Command.Item>
              <Command.Item className={item} onSelect={go(`${base}/runs`)}><Activity className="size-4" />{t('Runs')}</Command.Item>
              <Command.Item className={item} onSelect={go(`${base}/workers`)}><Cpu className="size-4" />{t('Workers')}</Command.Item>
              <Command.Item className={item} onSelect={go(`${base}/decisions`)}><Scale className="size-4" />{t('Decision ledger')}</Command.Item>
              <Command.Item className={item} onSelect={go(`${base}/skills`)}><Puzzle className="size-4" />{t('Skills')}</Command.Item>
              <Command.Item className={item} onSelect={go(`${base}/lessons`)}><BookOpen className="size-4" />{t('Lessons')}</Command.Item>
              <Command.Item className={item} onSelect={go(`${base}/clean`)}><Eraser className="size-4" />{t('Clean')}</Command.Item>
              <Command.Item className={item} onSelect={go(`${base}/tick`)}><Timer className="size-4" />{t('Tick')}</Command.Item>
              <Command.Item className={item} onSelect={go(`${base}/docs`)}><Files className="size-4" />{t('Documents')}</Command.Item>
            </Command.Group>
            <Command.Group heading={t('Actions')} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
              <Command.Item className={item} onSelect={go(`${base}/new`)}><Plus className="size-4" />{t('New order')}</Command.Item>
              <Command.Item className={item} onSelect={go(`${base}/tick`)}><Timer className="size-4" />{t('Preview what the next tick would do')}</Command.Item>
              <Command.Item className={item} onSelect={() => { setTheme(theme === 'dark' ? 'light' : 'dark'); onOpenChange(false); }}><Moon className="size-4" />{t('Switch light or dark')}</Command.Item>
              <Command.Item className={item} onSelect={() => { setLang(getLang() === 'zh' ? 'en' : 'zh'); onOpenChange(false); }}><Languages className="size-4" />{t('Switch language')}</Command.Item>
            </Command.Group>
            {projects.length > 1 && (
              <Command.Group heading={t('Projects')} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
                {projects.filter(p => p.id !== project).map(p => (
                  <Command.Item key={p.id} className={item} onSelect={go(`/p/${encodeURIComponent(p.id)}`)}>{t('Switch to {name}', { name: p.name })}</Command.Item>
                ))}
              </Command.Group>
            )}
            <Command.Group heading={t('Order actions (asks you to confirm)')} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
              {(orders.data?.items ?? []).flatMap(o => (PALETTE_ACTIONS[o.stage] ?? []).filter(a => o.actions.includes(a)).map(a => (
                <Command.Item key={`${o.tag}-${a}`} value={`${actionLabel(a)} ${a} ${o.tag} ${o.title}`} className={item} onSelect={go(`${base}/orders/${encodeURIComponent(o.tag)}?do=${a}`)}>
                  <Zap className="size-4 text-primary" />
                  <span>{actionLabel(a)}</span>
                  <span className="font-mono text-[13px] font-semibold">{o.tag}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{o.title}</span>
                </Command.Item>
              )))}
            </Command.Group>
            <Command.Group heading={t('Orders')} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
              {(orders.data?.items ?? []).map(o => (
                <Command.Item key={o.tag} value={`${o.tag} ${o.title} ${o.kind}`} className={item} onSelect={go(`${base}/orders/${encodeURIComponent(o.tag)}`)}>
                  <FileText className="size-4 text-muted-foreground" />
                  <span className="font-mono text-[13px] font-semibold">{o.tag}</span>
                  <span className="min-w-0 flex-1 truncate">{o.title}</span>
                  <span className="text-xs text-muted-foreground">{stageLabel(o.stage)}</span>
                </Command.Item>
              ))}
            </Command.Group>
            {documents.length > 0 && (
              <Command.Group heading={t('Documents')} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground">
                {documents.map(d => (
                  <Command.Item key={d.path} value={`${d.title} ${d.path}`} className={item} onSelect={go(docReaderTo(project, d.path))}>
                    <Files className="size-4 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{d.title}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">{d.path}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
