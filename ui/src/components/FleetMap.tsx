import { useMemo, useState } from 'react';
import type { OrderSummary, Worker } from '@api';
import type { MachineView } from '../../../src/machines/probe';
import { AlbaMark } from '@/components/brand/Logo';
import { useReducedMotion } from '@/components/motion';
import { cn } from '@/lib/utils';
import { t } from '@/i18n';

/** One machine on the map: the workers that live there and the runs they are doing now. */
interface Place { m: MachineView; workers: Worker[]; runs: { tag: string; title: string; worker: string }[] }

const W = 1100, NODE_W = 360, NODE_H = 96, GAP = 20, HUB_X = 205, HUB_R = 50;

/** Stars of the night sky behind the map; fixed, so they do not jump between renders. */
const STARS = Array.from({ length: 46 }, (_, i) => ({ x: (i * 241) % W, y: (i * 137) % 520, r: i % 7 === 0 ? 1.4 : 0.8, delay: (i % 9) * 0.45 }));

const pct = (n?: number) => (n === undefined || !Number.isFinite(n) ? undefined : Math.max(0, Math.min(1, n)));

function Meter({ label, value, warn }: { label: string; value?: number; warn?: boolean }) {
  const v = pct(value);
  return <div className="min-w-0 flex-1">
    <div className="flex justify-between text-[10px] text-muted-foreground"><span>{label}</span><span className="tabular-nums">{v === undefined ? '—' : `${Math.round(v * 100)}%`}</span></div>
    <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full transition-[width] duration-700', warn ? 'bg-destructive' : 'bg-primary')} style={{ width: `${(v ?? 0) * 100}%` }} /></div>
  </div>;
}

function NodeCard({ place, hot, onEnter, onLeave }: { place: Place; hot: boolean; onEnter: () => void; onLeave: () => void }) {
  const { m, workers, runs } = place;
  const r = m.latest;
  const down = !!r && !r.reachable;
  const used = r?.free_mem_gb !== undefined && r.total_mem_gb ? 1 - r.free_mem_gb / r.total_mem_gb : undefined;
  return <a href={`#machine-${m.id}`} onMouseEnter={onEnter} onMouseLeave={onLeave} onFocus={onEnter} onBlur={onLeave}
    className={cn('flex h-full flex-col justify-between rounded-xl border bg-card/90 px-3 py-2 backdrop-blur transition-[border-color,box-shadow,transform] duration-300',
      runs.length ? 'border-brand/60 shadow-[0_0_24px_-8px_var(--brand)]' : down ? 'border-destructive/50' : 'border-border', hot && 'translate-x-1 border-primary')}>
    <div className="flex items-center gap-2">
      <span className={cn('size-2 shrink-0 rounded-full', !r ? 'bg-muted-foreground' : down ? 'bg-destructive' : 'ping bg-success')} />
      <span className="truncate text-[13px] font-semibold">{m.name}</span>
      <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">{m.os}</span>
      <span className="ml-auto shrink-0 text-[11px] font-medium">{runs.length ? <span className="rounded-full bg-brand/15 px-2 py-0.5 text-primary">{t('{n} running', { n: runs.length })}</span> : <span className="text-muted-foreground">{down ? t('Unreachable') : t('Idle')}</span>}</span>
    </div>
    <div className="flex gap-3"><Meter label={t('Memory')} value={used} warn={r?.free_mem_gb !== undefined && r.free_mem_gb < m.min_free_mem_gb} /><Meter label={t('CPU')} value={r?.load} warn={(r?.load ?? 0) > 0.95} /></div>
    <div className="flex min-w-0 items-center gap-1 overflow-hidden text-[10.5px] text-muted-foreground">
      {workers.length ? workers.slice(0, 3).map(w => <span key={w.id} className={cn('shrink-0 rounded-full border px-1.5', runs.some(x => x.worker === w.id) && 'border-brand/50 text-foreground')}>{w.id}</span>) : <span className="truncate">{m.roles.length ? m.roles.join(' · ') : t('No workers here')}</span>}
      {workers.length > 3 && <span>+{workers.length - 3}</span>}
      {runs[0] && <span className="ml-auto truncate font-mono text-[10px] text-primary" title={runs.map(x => `${x.tag} ${x.title}`).join('\n')}>{runs.map(x => x.tag).join(' · ')}</span>}
    </div>
  </a>;
}

/**
 * The machines as a map: this computer (where alba runs) in the middle of the night sky, the registry's other machines around
 * it. A line carries light while a run is out on that machine: gold going out (the branch, the prompt, LFS objects), ember coming
 * back (commits and LFS objects fetched every few minutes). A machine that does not answer hangs on a broken line.
 */
export function FleetMap({ machines, workers, running }: { machines: MachineView[]; workers: Worker[]; running: OrderSummary[] }) {
  const reduced = useReducedMotion();
  const [hot, setHot] = useState<string | null>(null);
  const local = machines.find(m => 'local' in m.connect);
  const places = useMemo(() => machines.map<Place>(m => {
    const here = workers.filter(w => (w.host ?? local?.id) === m.id);
    const ids = new Set(here.map(w => w.id));
    const runs = running.flatMap(o => { const worker = o.run?.worker ?? o.worker; return worker && ids.has(worker) ? [{ tag: o.tag, title: o.title, worker }] : []; });
    return { m, workers: here, runs };
  }), [machines, workers, running, local?.id]);
  const hub = places.find(p => p.m.id === local?.id);
  const remote = places.filter(p => p !== hub);
  const H = Math.max(300, remote.length * (NODE_H + GAP) + 40);
  const cy = H / 2;
  const top = (H - (remote.length * (NODE_H + GAP) - GAP)) / 2;
  const nodes = remote.map((p, i) => {
    const y = top + i * (NODE_H + GAP), mid = y + NODE_H / 2;
    const bow = 1 - ((mid - cy) / (H / 2)) ** 2;
    return { p, x: 640 + bow * 70, y, mid };
  });
  const reachable = machines.filter(m => m.latest?.reachable).length;
  const outRuns = remote.reduce((n, p) => n + p.runs.length, 0);
  const hubRuns = hub?.runs.length ?? running.filter(o => { const w = o.run?.worker ?? o.worker; return !!w && !workers.find(x => x.id === w)?.host; }).length;
  return <section className="rise relative hidden overflow-hidden rounded-2xl border bg-card md:block" aria-label={t('Fleet')}>
    <div className="relative z-10 flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
      <div className="max-w-2xl">
        <h2 className="dawn-text w-fit text-[15px] font-semibold">{t('Fleet')}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('Orders run where their worker lives. A worker with a host runs on that machine over SSH: Alba pushes the branch there, copies Git LFS objects both ways and fetches the commits back.')}</p>
      </div>
      <dl className="flex gap-5 text-right">
        <div><dt className="text-[10.5px] text-muted-foreground">{t('Reachable')}</dt><dd className="text-lg font-semibold tabular-nums">{reachable}/{machines.length}</dd></div>
        <div><dt className="text-[10.5px] text-muted-foreground">{t('Remote runs')}</dt><dd className="text-lg font-semibold tabular-nums text-primary">{outRuns}</dd></div>
        <div><dt className="text-[10.5px] text-muted-foreground">{t('Local runs')}</dt><dd className="text-lg font-semibold tabular-nums">{hubRuns}</dd></div>
      </dl>
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={t('Fleet')}>
      <defs>
        <radialGradient id="fleet-hub" cx="50%" cy="40%" r="65%"><stop offset="0%" stopColor="#2B3170" /><stop offset="100%" stopColor="#14183A" /></radialGradient>
        <radialGradient id="fleet-halo"><stop offset="0%" stopColor="var(--brand)" stopOpacity="0.45" /><stop offset="100%" stopColor="var(--brand)" stopOpacity="0" /></radialGradient>
        <linearGradient id="fleet-horizon" x1="0" y1="0" x2="0" y2="1"><stop offset="55%" stopColor="var(--brand)" stopOpacity="0" /><stop offset="100%" stopColor="var(--brand)" stopOpacity="0.12" /></linearGradient>
        <filter id="fleet-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <rect width={W} height={H} fill="url(#fleet-horizon)" />
      {STARS.filter(s => s.y < H).map((s, i) => <circle key={i} className="fleet-star" cx={s.x} cy={s.y} r={s.r} fill="var(--muted-foreground)" style={{ animationDelay: `${s.delay}s` }} />)}
      {nodes.map(({ p, x, mid }) => {
        const d = `M ${HUB_X + HUB_R + 6} ${cy} C ${HUB_X + 230} ${cy}, ${x - 200} ${mid}, ${x} ${mid}`;
        const down = !!p.m.latest && !p.m.latest.reachable;
        const live = p.runs.length > 0;
        const id = `fleet-path-${p.m.id}`;
        return <g key={p.m.id} opacity={hot && hot !== p.m.id ? 0.35 : 1} style={{ transition: 'opacity 250ms' }}>
          <path id={id} d={d} className="fleet-link" stroke={down ? 'var(--destructive)' : 'var(--border)'} strokeOpacity={down ? 0.55 : 1} strokeWidth={hot === p.m.id ? 3 : 2} strokeDasharray={down ? '6 8' : undefined} />
          {live && <path d={d} className="fleet-link fleet-link-live" stroke="var(--brand)" strokeWidth="2.5" filter="url(#fleet-glow)" />}
          {live && !reduced && p.runs.slice(0, 3).map((run, k) => <g key={run.tag}>
            <circle r="4" fill="var(--brand)" filter="url(#fleet-glow)"><animateMotion dur="2.6s" begin={`${k * 0.85}s`} repeatCount="indefinite" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1"><mpath href={`#${id}`} /></animateMotion></circle>
            <circle r="3" fill="var(--ember)" filter="url(#fleet-glow)"><animateMotion dur="3.4s" begin={`${1.3 + k * 1.1}s`} repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1"><mpath href={`#${id}`} /></animateMotion></circle>
          </g>)}
        </g>;
      })}
      <circle cx={HUB_X} cy={cy} r={HUB_R * 2.1} fill="url(#fleet-halo)" />
      <circle className="fleet-orbit" cx={HUB_X} cy={cy} r={HUB_R + 14} fill="none" stroke="var(--brand)" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="3 9" />
      <circle cx={HUB_X} cy={cy} r={HUB_R} fill="url(#fleet-hub)" stroke="var(--brand)" strokeOpacity="0.6" />
      <AlbaMark tile={false} x={HUB_X - 26} y={cy - 30} width={52} height={52} className="text-[#FAF3E6]" />
      <foreignObject x={HUB_X - 110} y={cy + HUB_R + 18} width="220" height="56">
        <div className="text-center leading-tight">
          <div className="truncate text-[13px] font-semibold">{hub?.m.name ?? t('This computer')}</div>
          <div className="text-[11px] text-muted-foreground">alba · {t('{n} workers', { n: hub?.workers.length ?? workers.filter(w => !w.host).length })}{hubRuns ? ` · ${t('{n} running', { n: hubRuns })}` : ''}</div>
        </div>
      </foreignObject>
      {nodes.map(({ p, x, y }) => <foreignObject key={p.m.id} x={x} y={y} width={NODE_W} height={NODE_H}>
        <NodeCard place={p} hot={hot === p.m.id} onEnter={() => setHot(p.m.id)} onLeave={() => setHot(null)} />
      </foreignObject>)}
    </svg>
    <div className="relative z-10 flex flex-wrap gap-x-5 gap-y-1 border-t px-5 py-2 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-brand shadow-[0_0_8px_var(--brand)]" />{t('Out: branch, prompt and LFS objects')}</span>
      <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-ember shadow-[0_0_8px_var(--ember)]" />{t('Back: commits and LFS objects, every few minutes')}</span>
      <span className="flex items-center gap-1.5"><span className="h-0 w-4 border-t-2 border-dashed border-destructive/60" />{t('Unreachable')}</span>
    </div>
  </section>;
}
