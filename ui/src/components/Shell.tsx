import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, BookOpen, Bell, Factory, Coins, Eraser, Images, Palette, Menu as MenuIcon, Scale, ChevronsUpDown, Command, Cpu, KanbanSquare, Languages, Moon, Play, Plus, Puzzle, Route, Sparkles, Sun, Timer, Check, Files, Wrench } from 'lucide-react';
import { Toaster } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogTitle, DrawerContent } from '@/components/ui/dialog';
import { useNarrow } from '@/lib/media';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tip, TooltipProvider } from '@/components/ui/misc';
import { CommandPalette } from '@/components/CommandPalette';
import { groupNeedsYou, needsTotal } from '@/lib/needs';
import { ProjectOrders } from './OrderAttention';
import { presence, tabTitle } from '@/lib/presence';
import { useOrders, useOverview, useProjectId, useProjects, useSession } from '@/lib/queries';
import { openStream, type StreamState } from '@/lib/stream';
import { setTheme, useTheme } from '@/lib/theme';
import { setMotion, useReducedMotion } from '@/components/motion';
import { getLang, setLang, t, useLang } from '@/i18n';
import { cn } from '@/lib/utils';
import { AlbaLogo, AlbaMark } from '@/components/brand/Logo';
import { ago } from '@/lib/format';

export function Shell() {
  const project = useProjectId();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const producerWorkspace = location.pathname.endsWith('/producer');
  // The board has seven columns: it takes the whole width of the window; other pages stop at a width that still reads well.
  const fullWidth = location.pathname.endsWith('/board');
  const projects = useProjects();
  const session = useSession();
  const overview = useOverview(project);
  const orders = useOrders(project);
  const byTag = useMemo(() => new Map(orders.data?.items.map(o => [o.tag, o])), [orders.data]);
  const unread = orders.data?.items.filter(o => o.unread).length ?? 0;
  useEffect(() => { document.title = tabTitle(unread); return () => { document.title = 'Alba'; }; }, [unread]);
  useEffect(() => presence.listen(), []);
  const theme = useTheme();
  const still = useReducedMotion();
  const [stream, setStream] = useState<StreamState>('connecting');
  const [palette, setPalette] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const lang = useLang();
  const firstLang = useRef(lang);
  // The server writes some texts (reasons, check names) in the language it is asked for: read everything again after a switch.
  useEffect(() => { if (firstLang.current !== lang) { firstLang.current = lang; void client.invalidateQueries(); } }, [lang, client]);
  const narrow = useNarrow();

  useEffect(() => {
    const ids = project ? [project] : (projects.data ?? []).map(p => p.id);
    if (!ids.length) return;
    setStream('connecting');
    const states = new Map(ids.map(id => [id, 'connecting' as StreamState]));
    const handles = ids.map(id => openStream({ project: id, client, onState: state => {
      states.set(id, state);
      setStream([...states.values()].every(s => s === 'live') ? 'live' : 'reconnecting');
    } }));
    return () => handles.forEach(h => h.close());
  }, [project, projects.data, client]);

  useEffect(() => { setDrawer(false); }, [location.pathname, narrow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const groups = overview.data ? groupNeedsYou(overview.data) : [];
  const needs = needsTotal(groups);
  const running = overview.data?.running.items.length ?? 0;
  const pendingPicks = overview.data?.pendingPicks?.count ?? 0;
  const base = `/p/${encodeURIComponent(project)}`;
  const current = projects.data?.find(p => p.id === project);

  const nav: { to: string; end?: boolean; icon: typeof Bell; label: string; badge?: number; group: 'work' | 'resources' | 'reference' }[] = [
    { to: base, end: true, icon: Activity, group: 'work', label: t('Overview') },
    { to: `${base}/needs`, end: true, icon: Bell, group: 'work', label: t('Needs you'), badge: needs },
    { to: `${base}/producer`, end: true, icon: Factory, group: 'work', label: t('Producer') },
    { to: `${base}/board`, icon: KanbanSquare, group: 'work', label: t('Board'), badge: unread },
    { to: `${base}/runs`, icon: Activity, group: 'work', label: t('Runs') },
    { to: `${base}/usage`, icon: Activity, group: 'resources', label: t('Usage') },
    { to: `${base}/roles`, icon: Route, group: 'resources', label: t('Routing') },
    { to: `${base}/tools`, icon: Wrench, group: 'resources', label: t('Tools') },
    { to: `${base}/workers`, icon: Cpu, group: 'resources', label: t('Workers') },
    { to: `${base}/machines`, icon: Cpu, group: 'resources', label: t('Machines') },
    { to: `${base}/decisions`, icon: Scale, group: 'reference', label: t('Decision ledger') },
    ...(current?.design?.enabled ? [{ to: `${base}/design`, icon: BookOpen, group: 'reference' as const, label: t('Design') }] : []),
    { to: `${base}/skills`, icon: Puzzle, group: 'reference', label: t('Skills') },
    { to: `${base}/lessons`, icon: BookOpen, group: 'reference', label: t('Lessons') },
    { to: `${base}/clean`, icon: Eraser, group: 'resources', label: t('Clean') },
    { to: `${base}/tick`, icon: Timer, group: 'reference', label: t('Tick') },
    ...(current?.library?.picks || pendingPicks ? [{ to: `${base}/picks`, icon: Images, group: 'reference' as const, label: t('Picks'), badge: pendingPicks }] : []),
    ...(current?.library?.art ? [{ to: `${base}/art`, icon: Palette, group: 'reference' as const, label: t('Art') }] : []),
    ...(current?.library?.credits ? [{ to: `${base}/spend`, icon: Coins, group: 'resources' as const, label: t('Spend') }] : []),
    { to: `${base}/docs`, icon: Files, group: 'reference', label: t('Documents') },
  ];

  const sidebar = (
    <>
      <NavLink to="/" className="flex items-center px-4 pt-4 pb-3" aria-label="Alba">
        <AlbaLogo rise />
      </NavLink>
      <div className="px-2 pb-2">
        <Menu>
          <MenuTrigger asChild>
            <button className="flex w-full items-center justify-between gap-2 rounded-lg border bg-card px-2.5 py-2 text-left text-sm shadow-xs hover:border-primary/40">
              <span className="min-w-0 truncate font-medium">{current?.name ?? (project || t('Projects'))}</span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </MenuTrigger>
          <MenuContent className="w-52" align="start">
            <MenuItem onSelect={() => navigate('/')}>{t('All projects overview')}</MenuItem>
            <MenuLabel>{t('Projects')}</MenuLabel>
            {(projects.data ?? []).map(p => (
              <MenuItem key={p.id} onSelect={() => navigate(`/p/${encodeURIComponent(p.id)}`)}>
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{p.orderCount}</span>
                {p.id === project && <Check className="size-3.5" />}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {(['work', 'resources', 'reference'] as const).map(group => project && <div key={group} className="mb-1"><div className="px-2.5 pt-1 pb-0.5 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase">{group === 'work' ? t('Work') : group === 'resources' ? t('Resources') : t('Knowledge')}</div>{nav.filter(n => n.group === group).sort((a, b) => {
          const order = ['Overview', 'Needs you', 'Board', 'Runs', 'Producer', 'Workers', 'Usage', 'Clean', 'Decision ledger', 'Design', 'Skills', 'Lessons', 'Documents', 'Picks', 'Art', 'Tick'].map(k => t(k));
          return (order.indexOf(a.label) < 0 ? order.length : order.indexOf(a.label)) - (order.indexOf(b.label) < 0 ? order.length : order.indexOf(b.label));
        }).map(n => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) => cn('relative flex items-center gap-2.5 rounded-md px-2.5 py-[3px] text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-active/60 hover:text-foreground', isActive && 'bg-sidebar-active text-foreground before:absolute before:inset-y-1.5 before:-left-2 before:w-[3px] before:rounded-r before:bg-brand [&_svg]:text-primary')}
          >
            <n.icon className="size-4" />
            <span className="flex-1">{n.label}</span>
            {n.badge !== undefined && n.badge > 0 && (
              <span className={cn('inline-flex min-w-5 items-center justify-center gap-1 rounded-full px-1.5 text-[11px] font-semibold tabular-nums', 'bg-brand text-brand-foreground')}>
                {n.badge}
              </span>
            )}
          </NavLink>
        ))}</div>)}
        {!project && (projects.data ?? []).slice(0, 12).map(p => <NavLink className="rounded-md px-2.5 py-1.5 text-sm hover:bg-accent" key={p.id} to={`/p/${encodeURIComponent(p.id)}`}>{p.name}</NavLink>)}
        {!project && (projects.data?.length ?? 0) > 12 && <NavLink to="/overview/projects">{t('+{n} more', { n: projects.data!.length - 12 })}</NavLink>}
      </nav>
      {project && <div className="px-2 pt-2">
        <Button asChild size="sm" variant="outline" className="w-full justify-start">
          <NavLink to={`${base}/new`}><Plus />{t('New order')}</NavLink>
        </Button>
      </div>}
      {project && <div className="space-y-1 border-t px-3 py-2.5 text-xs text-muted-foreground">
        {running > 0 ? (
          <div className="flex items-center gap-1.5 font-medium text-info"><span className="ping size-1.5 rounded-full bg-info" /><Play className="size-3" />{t('{n} running', { n: running })}</div>
        ) : (
          <div>{t('Nothing is running')}</div>
        )}
        {session.data?.loop && (
          <div>{t('Tick every {n} min', { n: session.data.loop.everyMinutes })}{session.data.loop.lastTickAt ? ` · ${ago(session.data.loop.lastTickAt)}` : ''}</div>
        )}
      </div>}
    </>
  );

  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden">
        {narrow ? (
          <Dialog open={drawer} onOpenChange={setDrawer}>
            <DrawerContent>
              <DialogTitle className="sr-only">Alba</DialogTitle>
              <DialogDescription className="sr-only">{t('Navigation')}</DialogDescription>
              {sidebar}
            </DrawerContent>
          </Dialog>
        ) : <aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar">{sidebar}</aside>}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="relative flex h-13 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur sm:px-6">
            <div aria-hidden className="dawn-line pointer-events-none absolute inset-x-0 -bottom-px" />
            {narrow && <Button variant="ghost" size="icon" onClick={() => setDrawer(true)} aria-label={t('Menu')}><MenuIcon /></Button>}
            {narrow && <NavLink to="/" aria-label="Alba" className="shrink-0"><AlbaMark className="size-7" /></NavLink>}
            <button onClick={() => setPalette(true)} className="flex h-9 min-w-0 flex-1 items-center sm:w-80 sm:flex-none gap-2 rounded-lg border bg-card px-3 text-sm text-muted-foreground shadow-xs hover:border-primary/40">
              <Command className="size-3.5" />
              <span className="min-w-0 flex-1 truncate text-left">{t('Jump to an order or run an action')}</span>
              <kbd className="hidden rounded border bg-muted px-1 text-[10px] sm:block">Ctrl K</kbd>
            </button>
            <div className="hidden flex-1 sm:block" />
            <Tip text={stream === 'live' ? t('The live stream is connected') : t('Reconnecting to the live stream; lists are read again when it is back')}>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={cn('size-2 rounded-full', stream === 'live' ? 'live-dot bg-success' : 'bg-warning')} />
                <span className="hidden sm:inline">{stream === 'live' ? t('Live') : stream === 'connecting' ? t('Connecting…') : t('Reconnecting…')}</span>
              </span>
            </Tip>
            <Tip text={t('Switch language')}>
              <Button variant="ghost" size="icon" onClick={() => setLang(getLang() === 'zh' ? 'en' : 'zh')} aria-label={t('Switch language')}><Languages /></Button>
            </Tip>
            <Tip text={still ? t('Turn animations on') : t('Turn animations off')}>
              <Button variant="ghost" size="icon" onClick={() => setMotion(still ? 'full' : 'reduced')} aria-label={still ? t('Turn animations on') : t('Turn animations off')} aria-pressed={!still}><Sparkles className={still ? 'opacity-45' : 'text-primary'} /></Button>
            </Tip>
            <Tip text={t('Switch light or dark')}>
              <Button variant="ghost" size="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={t('Switch light or dark')}>{theme === 'dark' ? <Sun /> : <Moon />}</Button>
            </Tip>
          </header>
          <main className={`min-h-0 flex-1 ${producerWorkspace ? 'overflow-hidden' : 'overflow-auto'}`}>
            <div key={location.pathname.split('/').slice(0, 5).join('/')} className={`page-enter mx-auto w-full ${fullWidth ? '' : 'max-w-[2200px]'} px-3 py-4 sm:px-8 sm:py-6 ${producerWorkspace ? 'h-full' : ''}`}>
              <ProjectOrders.Provider value={byTag}><Outlet /></ProjectOrders.Provider>
            </div>
          </main>
        </div>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} project={project} projects={projects.data ?? []} />
      <Toaster position="bottom-right" theme={theme} richColors closeButton />
    </TooltipProvider>
  );
}
