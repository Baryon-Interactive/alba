import { Bot, Eye } from 'lucide-react';
import { Link } from 'react-router';
import type { LiveAgent } from '@api';
import { Badge } from './ui/badge';
import { Section, TagLink } from './common';
import { ago } from '@/lib/format';
import { t } from '@/i18n';

const kindLabel = (kind: LiveAgent['kind']) => ({
  run: t('Run'), consult: t('Consult'), check: t('Independent check'), monitor: t('Monitor'), child: t('Child order'),
}[kind]);
const kindTone = (kind: LiveAgent['kind']) => kind === 'consult' ? 'warning' : kind === 'child' ? 'neutral' : kind === 'check' ? 'success' : 'primary';

/** Every agent working on the order right now, one row each, with a link to watch the run it belongs to. */
export function LiveAgents({ project, tag, agents }: { project: string; tag: string; agents?: LiveAgent[] }) {
  if (!agents?.length) return null;
  return <Section title={<span className="inline-flex items-center gap-1.5"><Bot className="size-4" />{t('Running agents')}</span>} count={agents.length}>
    <ul className="grid gap-1.5 text-sm">{agents.map((a, i) => {
      const watch = a.run ? `/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(a.tag)}/runs/${encodeURIComponent(a.run)}?tab=transcript` : undefined;
      return <li key={`${a.kind}-${a.tag}-${a.run ?? i}`} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2" data-agent={a.kind}>
        <Badge tone={kindTone(a.kind)}>{kindLabel(a.kind)}</Badge>
        {a.tag !== tag && <TagLink project={project} tag={a.tag} />}
        <span className="font-medium">{a.label}</span>
        {(a.worker || a.model) && <span className="text-muted-foreground">{[a.worker, a.model].filter(Boolean).join(' / ')}</span>}
        {a.started && <span className="text-xs text-muted-foreground tabular-nums">{t('started {when}', { when: ago(a.started) })}</span>}
        {a.question && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={a.question}>“{a.question}”</span>}
        {watch && <Link className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" to={watch}><Eye className="size-3" />{t('Watch')}</Link>}
      </li>;
    })}</ul>
  </Section>;
}

/** A small board marker when more than one agent works on an order at once. */
export function AgentCount({ count }: { count?: number }) {
  if (!count || count < 2) return null;
  return <Badge tone="primary" title={t('Agents working on this order now')}><Bot className="size-3" />{t('{n} agents', { n: count })}</Badge>;
}
