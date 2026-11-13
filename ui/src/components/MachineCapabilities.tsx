import type { Capabilities, Suggestions } from '../../../src/machines/capabilities';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ago } from '@/lib/format';
import { t } from '@/i18n';

const TOOL_ORDER = ['git', 'git-lfs', 'python', 'cmake', 'ninja', 'node', 'dotnet', 'cl', 'gcc', 'clang', 'docker'];

const ROLES: Record<string, [string, string]> = {
  'package': ['Packaging machine', 'Builds and packages the project with its configured engine.'],
  'compile-helper': ['Compile helper', "Helps other machines compile using the configured engine tools."],
  'gpu-qa': ['GPU test machine', 'Runs the packaged game on its own graphics card for screenshots and checks on that vendor.'],
  'timing-baseline': ['Timing baseline', 'Measures speed. It must have nothing else running, so it is only set by hand.'],
};
export const roleTitle = (role: string) => (ROLES[role] ? t(ROLES[role][0]) : role);
const roleDoes = (role: string) => (ROLES[role] ? t(ROLES[role][1]) : '');

/** What a machine has (from its capability scan), the roles that fit and what is missing for the others. */
export function CapabilitySummary({ caps, suggestions, current = [], onInstall, busy }: { caps: Capabilities | null; suggestions?: Suggestions; current?: string[];
  /** Offers an Install button per missing item (on saved machines). */ onInstall?: (item: string) => void; busy?: boolean }) {
  if (!caps) return <p className="text-xs text-muted-foreground">{t('Not scanned yet. The scan runs after the first successful probe.')}</p>;
  if (caps.error) return <p className="text-xs text-destructive">{t('The capability scan failed. Probe now to retry.')}</p>;
  const tools = [
    ...Object.entries(caps.engines ?? {}).flatMap(([id, result]) => [
      ...result.versions.map(v => id + ' ' + v),
      ...Object.entries(result.features).flatMap(([name, values]) => values.map(v => name + ' ' + v)),
    ]),
    ...TOOL_ORDER.filter(k => caps.tools[k]).map(k => caps.tools[k] === 'installed' ? k : `${k} ${caps.tools[k].split('.').slice(0, 2).join('.')}`),
  ];
  const missingByRole = new Map<string, Suggestions['missing']>();
  for (const m of suggestions?.missing ?? []) missingByRole.set(m.for, [...(missingByRole.get(m.for) ?? []), m]);
  return <div className="grid gap-2 text-sm">
    <p className="break-words">{[caps.cpu, caps.threads && t('{n} threads', { n: caps.threads }), caps.ram_gb && `${caps.ram_gb} GB`].filter(Boolean).join(' · ')}</p>
    {caps.gpus.length > 0 && <p className="break-words text-xs text-muted-foreground">{caps.gpus.map(g => g.vram_gb ? `${g.name} (${g.vram_gb} GB)` : g.name).join(' · ')}</p>}
    {caps.os_version && <p className="text-xs text-muted-foreground">{caps.os_version}</p>}
    <div className="flex flex-wrap gap-1">{tools.length ? tools.map(x => <Badge key={x} tone="outline">{x}</Badge>) : <span className="text-xs text-muted-foreground">{t('No build tools found.')}</span>}</div>
    {(suggestions?.roles.length ?? 0) > 0 && <div className="grid gap-1"><span className="text-xs font-medium">{t('This machine can work as')}</span>
      <ul className="grid gap-1.5">{suggestions!.roles.map(r => <li key={r.role} className="grid gap-0.5 rounded-md border px-2 py-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{roleTitle(r.role)}</span><Badge tone="primary">{r.role}</Badge>
          {current.includes(r.role) ? <span className="text-muted-foreground">{t('already set')}</span> : <span className="text-success">{t('not set yet')}</span>}</div>
        <span className="text-muted-foreground">{t('Does')}: {roleDoes(r.role)}</span>
        <span className="text-muted-foreground">{t('Why')}: {r.key ? t(r.key, r.vars) : r.reason}</span>
      </li>)}</ul></div>}
    {Object.entries(caps.engines ?? {}).map(([id, result]) => <div key={id} className="grid gap-1 text-xs text-muted-foreground">
      {result.error && <p className="text-destructive">{t('Engine scan failed.')}</p>}
      {result.unsupported?.map(note => <p key={note}>{t(note)}</p>)}
    </div>)}
    {missingByRole.size > 0 && <div className="grid gap-1"><span className="text-xs font-medium">{t('Could also work as, after installing')}</span>
      <ul className="grid gap-1.5">{[...missingByRole].map(([role, whats]) => <li key={role} className="grid gap-0.5 rounded-md border border-dashed px-2 py-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{roleTitle(role)}</span><Badge tone="outline">{role}</Badge></div>
        <span className="text-muted-foreground">{t('Does')}: {roleDoes(role)}</span>
        <div className="flex flex-wrap items-center gap-1.5"><span>{t('Install')}:</span>{whats.map(w => <span key={w.what} className="inline-flex items-center gap-1">
          <span className="text-warning">{t(w.what)}</span>
          {onInstall && w.item && <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy} onClick={() => onInstall(w.item!)}>{t('Install…')}</Button>}</span>)}</div>
      </li>)}</ul></div>}
    <p className="text-[11px] text-muted-foreground">{t('Scanned {ago}. Timing baselines are never suggested: they need a quiet machine.', { ago: ago(caps.at) })}</p>
  </div>;
}
