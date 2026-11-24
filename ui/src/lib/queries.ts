import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { DecisionList } from '@api';
import type { ActionRequest, NewDecisionRequest, NewWorkerRequest, PickChooseRequest, SayRequest, SettingApproveRequest, SpendApproveRequest, TickRequest, WorkerEditRequest } from '@api';
import { useParams } from 'react-router';
import { toast } from 'sonner';
import { api, ApiFailure, type ConfigEdit, type ConfigTarget, type NewOrderBody, type OrderFieldsEdit } from './api.ts';
import { keys } from './keys.ts';
import { t } from '@/i18n';
import { actionLabel, stageLabel } from './stages.ts';

/** The project the address names (`/p/<project>/...`). */
export function useProjectId(): string {
  return useParams().project ?? '';
}

export const useSession = () => useQuery({ queryKey: keys.session, queryFn: api.session, staleTime: 30_000, refetchInterval: 120_000 });
export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: api.projects, staleTime: 15_000 });
export const useOverviewAll = () => useQuery({ queryKey: keys.overviewAll, queryFn: api.overviewAll, staleTime: 60_000 });
export const useProjectOverview = (project: string) => useQuery({ queryKey: keys.projectOverview(project), queryFn: () => api.overviewProject(project), enabled: !!project, staleTime: 60_000 });
/** Shell badges and the project page observe one cached response. The old API route remains available. */
export const useOverview = useProjectOverview;
export const useProducer = (project: string) => useQuery({ queryKey: keys.producer(project), queryFn: () => api.producer(project), enabled: !!project, staleTime: 10_000, refetchInterval: 30_000 });
export const useProducerLog = (project: string) => useQuery({ queryKey: ['producer-log', project], queryFn: () => api.producerLog(project), enabled: !!project, staleTime: 3_000, refetchInterval: 5_000 });
export const useProducerFacts = (project: string) => useQuery({ queryKey: keys.producerFacts(project), queryFn: () => api.producerFacts(project), enabled: !!project, staleTime: 30_000, refetchInterval: 60_000 });
export const useProducerWorkspace = (project: string) => useQuery({ queryKey: ['producer-workspace', project], queryFn: () => api.producerWorkspace(project), enabled: !!project, staleTime: 10_000, refetchInterval: 30_000 });
export const useProducerAnalysis = (project: string) => useQuery({ queryKey: ['producer-analysis', project], queryFn: () => api.producerAnalysis(project), enabled: !!project, staleTime: 30_000 });
export const useProducerInsights = (project: string) => useQuery({ queryKey: keys.producerInsights(project), queryFn: () => api.producerInsights(project), enabled: !!project, staleTime: 15_000, refetchInterval: 30_000 });

export function useProducerAction(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { actionId: string }) => api.producerAction({ project, actionId: body.actionId }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: keys.producer(project) }); void client.invalidateQueries({ queryKey: keys.overview(project) }); void client.invalidateQueries({ queryKey: keys.projectOverview(project) }); },
  });
}

export function useProducerPause(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => api.producerPause(project, paused),
    onSuccess: () => { void client.invalidateQueries({ queryKey: keys.producer(project) }); void client.invalidateQueries({ queryKey: keys.overview(project) }); void client.invalidateQueries({ queryKey: keys.projectOverview(project) }); },
  });
}
export const useOrders = (project: string, stage?: string) => useQuery({ queryKey: keys.orders(project, stage), queryFn: () => api.orders(project, stage), enabled: !!project, staleTime: 10_000, refetchInterval: 60_000 });
export const useOrder = (project: string, tag: string) => useQuery({ queryKey: keys.order(project, tag), queryFn: () => api.order(project, tag), enabled: !!project && !!tag, staleTime: 10_000 });
export const useDiff = (project: string, tag: string, enabled: boolean) => useQuery({ queryKey: keys.diff(project, tag), queryFn: () => api.diff(project, tag), enabled: enabled && !!project && !!tag, staleTime: 30_000, retry: false });
export function useVerify(project: string, tag: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.verify(project, tag),
    onSuccess: () => { void client.invalidateQueries({ queryKey: keys.order(project, tag) }); },
  });
}
export const useReadiness = (project: string, tag: string, enabled: boolean) => useQuery({ queryKey: keys.readiness(project, tag), queryFn: () => api.readiness(project, tag), enabled: enabled && !!project && !!tag, staleTime: 15_000, retry: false });
export const useWorkers = (project: string) => useQuery({ queryKey: keys.workers(project), queryFn: () => api.workers(project), enabled: !!project, staleTime: 15_000, refetchInterval: 60_000 });
// Every 5 seconds while a machine runs a job (an install), otherwise every 30.
export const useMachines = (project: string) => useQuery({ queryKey: ['machines', project], queryFn: () => api.machines(project), enabled: !!project, staleTime: 4_000,
  refetchInterval: q => (q.state.data?.machines.some(m => m.jobs?.some(j => j.status === 'running')) ? 5_000 : 30_000) });
export const useMachineGuide = (project: string, enabled: boolean) => useQuery({ queryKey: ['machine-guide', project], queryFn: () => api.machineGuide(project), enabled: !!project && enabled, staleTime: 60_000 });
/** One-off calls of the add-machine guide (no cache). */
export const machineCalls = { sshBlock: api.machineSshBlock, test: api.machineTest, edit: api.machineEdit };
/** The Host block of a machine's SSH alias, read while the edit dialog is open. */
export const useMachineSshHost = (project: string, alias: string | undefined) => useQuery({ queryKey: ['machine-ssh-host', project, alias], queryFn: () => api.machineSshHost(project, alias!), enabled: !!project && !!alias, staleTime: 5_000, retry: false });
/** What installing an item on a machine would run; fetched only while the install dialog is open. */
export const useMachineInstallPlan = (project: string, id: string, item: string | null) => useQuery({ queryKey: ['machine-install-plan', project, id, item],
  queryFn: () => api.machineInstallPlan(project, id, item!), enabled: !!project && !!item, staleTime: 60_000, retry: false });
/** Adding, removing and probing machines; every change refreshes the Machines page. */
export function useMachineChanges(project: string) {
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries({ queryKey: ['machines', project] });
  return {
    add: useMutation({ mutationFn: (machine: Record<string, unknown>) => api.machineAdd(project, machine), onSuccess: res => { toast.success(t('{id} added', { id: res.id })); refresh(); } }),
    remove: useMutation({ mutationFn: (id: string) => api.machineRemove(project, id), onSuccess: res => { toast.success(t('{id} removed', { id: res.id })); refresh(); } }),
    check: useMutation({ mutationFn: (id?: string) => api.machineCheck(project, id), onSuccess: () => refresh() }),
    install: useMutation({ mutationFn: (v: { id: string; item: string }) => api.machineInstall(project, v.id, v.item), onSuccess: res => { toast.success(t('Installing {what} on {id}', { what: res.job.title, id: res.job.machine })); refresh(); } }),
    cancelJob: useMutation({ mutationFn: (job: string) => api.machineJobCancel(project, job), onSuccess: () => refresh() }),
    roles: useMutation({ mutationFn: (v: { id: string; roles: string[] }) => api.machineRoles(project, v.id, v.roles), onSuccess: res => { toast.success(t('Roles of {id} updated', { id: res.id })); refresh(); } }),
  };
}
/** The project's shared resources (`resources` in the project file) and who holds a lease on them. */
export const useResources = (project: string) => useQuery({ queryKey: keys.resources(project), queryFn: () => api.resources(project), enabled: !!project, staleTime: 10_000, refetchInterval: 30_000 });
export const useSchedules = (project: string) => useQuery({ queryKey: keys.schedules(project), queryFn: () => api.schedules(project), enabled: !!project, staleTime: 10_000, refetchInterval: 30_000 });

export function useScheduleActions(project: string) {
  const client = useQueryClient();
  const refresh = () => {
    for (const k of [keys.schedules(project), keys.orders(project), keys.overview(project), keys.projectOverview(project), keys.producer(project)]) {
      void client.invalidateQueries({ queryKey: k });
    }
  };
  return {
    run: useMutation({
      mutationFn: (id: string) => api.scheduleRun(project, id),
      onSuccess: res => {
        if (res.status === 'created') toast.success(t('Schedule {id} created {tag}', { id: res.id, tag: res.orderTag ?? '' }));
        else if (res.status === 'duplicate') toast.message(t('Schedule {id} already ran for this minute', { id: res.id }));
        else toast.warning(t('Schedule {id} skipped: {reason}', { id: res.id, reason: res.reason ?? '' }));
        refresh();
      },
    }),
    pause: useMutation({
      mutationFn: (id: string) => api.schedulePause(project, id),
      onSuccess: res => { toast.success(t('Schedule {id} paused', { id: res.id })); refresh(); },
    }),
    resume: useMutation({
      mutationFn: (id: string) => api.scheduleResume(project, id),
      onSuccess: res => { toast.success(t('Schedule {id} resumed', { id: res.id })); refresh(); },
    }),
  };
}

/** A person takes back a lease that was not released (its run is gone). */
export function useReleaseLease(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { resource: string; tag: string }) => api.releaseLease({ ...body, project }),
    onSuccess: (res) => {
      toast.success(res.released ? t('{tag}: {resource} released', { tag: res.tag, resource: res.resource }) : t('{tag} held no lease on {resource}', { tag: res.tag, resource: res.resource }));
      for (const k of [keys.resources(project), keys.overview(project), keys.projectOverview(project), keys.orders(project)]) void client.invalidateQueries({ queryKey: k });
    },
  });
}

export const useQuotaHistory = (project: string, worker: string | undefined) =>
  useQuery({ queryKey: keys.quota(project, worker ?? '*'), queryFn: () => api.quotaHistory(project, worker), enabled: !!project && !!worker, staleTime: 30_000 });

/** The YAML of one worker as written in the workers file (the advanced editor starts from it). Read again each time the editor opens. */
export const useWorkerYaml = (project: string, id: string, enabled: boolean) => useQuery({ queryKey: keys.workerYaml(project, id), queryFn: () => api.workerYaml(project, id), enabled: enabled && !!project, staleTime: 0, gcTime: 0, retry: false });

export const errorText = (e: unknown) => (e instanceof ApiFailure ? e.message : e instanceof Error ? e.message : String(e));

/** An action on an order. The stream also refreshes the lists, so this only reads the affected ones at once. */
/** A message for a running order: the inbox, or stop its process and start again. */
export function useSay(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ tag, ...body }: { tag: string } & Omit<SayRequest, 'project'>) => api.say(tag, { ...body, project }),
    onSuccess: (res, vars) => {
      toast.success(res.message);
      for (const k of [keys.orders(project), keys.order(project, vars.tag), keys.overview(project), keys.projectOverview(project)]) void client.invalidateQueries({ queryKey: k });
    },
  });
}

export function useAct(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ tag, ...body }: { tag: string } & Omit<ActionRequest, 'project'>) => api.act(tag, { ...body, project }),
    onSuccess: (res, vars) => {
      toast.success(res.message ?? t('{action} done: {tag} is now {stage}', { action: actionLabel(vars.action), tag: vars.tag, stage: stageLabel(res.stage) }));
      for (const k of [keys.orders(project), keys.order(project, vars.tag), keys.overview(project), keys.projectOverview(project), keys.workers(project)]) void client.invalidateQueries({ queryKey: k });
    },
  });
}

/** After a write to the workers file the lists that show workers and routes are read again at once (the stream says it too). */
function refreshWorkers(client: ReturnType<typeof useQueryClient>, project: string) {
  for (const k of [keys.workers(project), ['route', project], keys.overview(project), keys.projectOverview(project), keys.skills(project)]) void client.invalidateQueries({ queryKey: k });
}

/** Change one worker (fields, or the whole worker as YAML); `dryRun` only checks. */
export function useEditWorker(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Omit<WorkerEditRequest, 'project'>) => api.editWorker(id, { ...body, project }),
    onSuccess: (res, vars) => {
      if (res.dryRun) return;
      toast.success(res.changed.length ? t('{id} saved: {fields}', { id: res.id, fields: res.changed.join(', ') }) : t('{id}: nothing changed', { id: res.id }));
      void client.invalidateQueries({ queryKey: keys.workerYaml(project, vars.id) });
      refreshWorkers(client, project);
    },
  });
}

/** A new worker, as YAML or as a copy of another. */
export function useNewWorker(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<NewWorkerRequest, 'project'>) => api.newWorker({ ...body, project }),
    onSuccess: (res) => {
      if (res.dryRun) return;
      toast.success(t('{id} added', { id: res.id }));
      refreshWorkers(client, project);
    },
  });
}

/** The project uses (or stops using) a skill of the machine: written into the project file. */
export function useSkillUse(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; use: boolean }) => api.skillUse({ ...body, project }),
    onSuccess: (res, vars) => {
      toast.success(res.changed.length ? vars.use ? t('{name} is used in this project', { name: vars.name }) : t('{name} is not used in this project', { name: vars.name }) : t('{name}: nothing changed', { name: vars.name }));
      for (const k of [keys.skills(project), ['order-skills', project], keys.overview(project), keys.projectOverview(project)]) void client.invalidateQueries({ queryKey: k });
    },
  });
}

export function useNewOrder(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<NewOrderBody, 'project'>) => api.newOrder({ ...body, project }),
    onSuccess: () => { for (const k of [keys.orders(project), keys.overview(project), keys.projectOverview(project), keys.projects]) void client.invalidateQueries({ queryKey: k }); },
  });
}

export function useTick(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<TickRequest, 'project'>) => api.tick({ ...body, project }),
    onSuccess: (res) => { if (res.real) for (const k of [keys.orders(project), keys.overview(project), keys.projectOverview(project), keys.workers(project)]) void client.invalidateQueries({ queryKey: k }); },
  });
}

export function useDecisions(project: string) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: keys.decisions(project), queryFn: () => api.decisions(project), enabled: !!project, staleTime: 15_000 });
  const cursor = query.data?.nextCursor;
  useEffect(() => {
    if (!cursor) return;
    let disposed = false;
    void api.decisions(project, cursor).then(page => {
      if (disposed) return;
      client.setQueryData<DecisionList>(keys.decisions(project), current => current?.nextCursor === cursor ? { ...page, items: [...current.items, ...page.items] } : current);
    }).catch(error => {
      if (!disposed) client.getQueryCache().find({ queryKey: keys.decisions(project), exact: true })?.setState({ error, status: 'error' });
    });
    return () => { disposed = true; };
  }, [project, cursor, client]);
  return query;
}
export const useLessons = (project: string, tag?: string) => useQuery({ queryKey: keys.lessons(project, tag), queryFn: () => api.lessons(project, tag), enabled: !!project, staleTime: 30_000 });
export const useRoute = (project: string, tag: string) => useQuery({ queryKey: keys.route(project, tag), queryFn: () => api.route(project, tag), enabled: !!project && !!tag, staleTime: 10_000 });
export const useSkills = (project: string) => useQuery({ queryKey: keys.skills(project), queryFn: () => api.skills(project), enabled: !!project, staleTime: 30_000 });
export const useOrderSkills = (project: string, tag: string) => useQuery({ queryKey: keys.orderSkills(project, tag), queryFn: () => api.orderSkills(project, tag), enabled: !!project && !!tag, staleTime: 30_000 });

/** Classify the order again (rules, and the classifier worker when `model` is set); the answer is the new route. */
export function useClassify(project: string, tag: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (model: boolean) => api.classify(tag, { project, model }),
    onSuccess: (route) => {
      client.setQueryData(keys.route(project, tag), route);
      for (const k of [keys.order(project, tag), keys.orders(project), keys.orderSkills(project, tag)]) void client.invalidateQueries({ queryKey: k });
    },
  });
}

export const useCredits = (project: string) => useQuery({ queryKey: keys.credits(project), queryFn: () => api.credits(project), enabled: !!project, staleTime: 15_000 });
export const useCleanEvents = (project: string) => useQuery({ queryKey: keys.cleanEvents(project), queryFn: async () => (await api.events(project, { limit: 500 })).events.filter(e => e.type.startsWith('clean')).reverse(), enabled: !!project, staleTime: 15_000 });
export const useCleanPlan = (project: string) => useQuery({ queryKey: keys.clean(project), queryFn: () => api.clean(project), enabled: !!project, staleTime: 30_000 });

export const useDocs = (project: string, enabled = true) => useQuery({ queryKey: keys.docs(project), queryFn: () => api.docs(project), enabled: !!project && enabled, staleTime: 15_000 });
export const useDoc = (project: string, path: string) => useQuery({ queryKey: keys.doc(project, path), queryFn: () => api.doc(project, path), enabled: !!project && !!path, staleTime: 15_000 });
export const useDocSearch = (project: string, q: string) => useQuery({ queryKey: keys.docSearch(project, q), queryFn: () => api.docSearch(project, q), enabled: !!project && q.length > 0 && q.length < 200, staleTime: 10_000 });

export function useAddDecision(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<NewDecisionRequest, 'project'>) => api.addDecision({ ...body, project }),
    onSuccess: (d) => { toast.success(t('Decision {id} recorded', { id: d.id })); void client.invalidateQueries({ queryKey: keys.decisions(project) }); void client.invalidateQueries({ queryKey: ['order', project] }); },
  });
}

// ---------------------------------------------------------------------------------------------------------------- : the art library

export const usePicks = (project: string, enabled = true) => useQuery({ queryKey: keys.picks(project), queryFn: () => api.picks(project), enabled: enabled && !!project, staleTime: 10_000, refetchInterval: 60_000 });
export const useArt = (project: string) => useQuery({ queryKey: keys.art(project), queryFn: () => api.art(project), enabled: !!project, staleTime: 15_000 });
export const useSpend = (project: string) => useQuery({ queryKey: keys.spend(project), queryFn: () => api.spend(project), enabled: !!project, staleTime: 15_000 });
export const useUsage = (project: string, enabled = true, days = 7) => useQuery({ queryKey: keys.usage(project, days), queryFn: () => api.usage(project, days), enabled: enabled && !!project, staleTime: 30_000, refetchInterval: 120_000 });
export const useUsageScorecard = (project: string | undefined, since = '14d', kind?: string, by?: import('@api').ScorecardBy) =>
  useQuery({ queryKey: ['usage-scorecard', project ?? '*', since, kind ?? '', by ?? 'worker'], queryFn: () => api.usageScorecard({ project, since, kind, by }), staleTime: 15_000, refetchInterval: 30_000 });

/** A choice on a pick set; the order that waited on it (a set from a report) is read again too. */
export function useChoosePick(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Omit<PickChooseRequest, 'project'>) => api.choosePick(id, { ...body, project }),
    onSuccess: (res) => {
      toast.success(res.answeredOrder ? t('{id} chosen; {tag} was answered', { id: res.set.id, tag: res.answeredOrder }) : t('{id} chosen', { id: res.set.id }));
      for (const k of [keys.picks(project), keys.overview(project), keys.projectOverview(project), keys.orders(project), ['order', project]]) void client.invalidateQueries({ queryKey: k });
    },
  });
}

export function useApproveSetting(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Omit<SettingApproveRequest, 'project'>) => api.approveSetting(id, { ...body, project }),
    onSuccess: (s) => { toast.success(t('The text of {id} is confirmed', { id: s.id })); void client.invalidateQueries({ queryKey: keys.art(project) }); },
  });
}

export function useApproveSpend(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Omit<SpendApproveRequest, 'project'>) => api.approveSpend(id, { ...body, project }),
    onSuccess: (q) => { toast.success(t('Quote {id} approved up to {cap}', { id: q.id, cap: q.approval?.cap ?? 0 })); void client.invalidateQueries({ queryKey: keys.spend(project) }); },
  });
}

export const useRoles = (project: string) => useQuery({ queryKey: ['roles', project], queryFn: () => api.roles(project), enabled: !!project, staleTime: 15_000 });
export function useSetRole(project: string, tag: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (role: string) => api.setRole(tag, { project, role }),
    onSuccess: route => {
      client.setQueryData(keys.route(project, tag), route);
      for (const key of [keys.order(project, tag), keys.orders(project), keys.orderSkills(project, tag)]) void client.invalidateQueries({ queryKey: key });
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------- : editing configuration, orders and workers

/** The editable sections of the project file or the workers file, as written there. Read again whenever an editor opens. */
export const useConfig = (project: string, target: ConfigTarget, enabled = true) => useQuery({ queryKey: ['config', project, target], queryFn: () => api.config(project, target), enabled: enabled && !!project, staleTime: 0, retry: false });
/** For each file that still has legacy `roles`, the `routing` that would replace them (nothing is written). */
export const useRoutingMigration = (project: string, enabled = true) => useQuery({ queryKey: ['routing-migrate', project], queryFn: () => api.routingMigration(project), enabled: enabled && !!project, staleTime: 0, retry: false });

/** After a write to a configuration file every view that reads it is read again. */
function refreshConfig(client: ReturnType<typeof useQueryClient>, project: string) {
  for (const k of [['config', project], ['plugins', project], ['routing-migrate', project], ['roles', project], ['route', project], keys.workers(project), keys.resources(project), keys.skills(project), ['order-skills', project], keys.overview(project), keys.projectOverview(project)]) void client.invalidateQueries({ queryKey: k });
}

/** Several changes to one configuration file in one write; the server checks the whole result first. */
export function useEditConfig(project: string, target: ConfigTarget) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (edits: ConfigEdit[]) => api.editConfig({ project, target, edits }),
    onSuccess: res => {
      toast.success(res.changed.length ? t('Saved: {fields}', { fields: res.changed.join(', ') }) : t('Nothing changed'));
      refreshConfig(client, project);
    },
  });
}

/** Fields of an order changed after it was made. */
export function useEditOrderFields(project: string, tag: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (fields: OrderFieldsEdit) => api.orderFields(project, tag, fields),
    onSuccess: (_res, fields) => {
      toast.success(t('{tag} saved: {fields}', { tag, fields: Object.keys(fields).join(', ') }));
      for (const k of [keys.order(project, tag), keys.orders(project), keys.route(project, tag), keys.orderSkills(project, tag), keys.overview(project), keys.projectOverview(project)]) void client.invalidateQueries({ queryKey: k });
    },
  });
}

/** The work-order text replaced; refused when the file changed since `expected` was read. */
export function useEditOrderBody(project: string, tag: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (v: { text: string; expected: string }) => api.orderBody(project, tag, v.text, v.expected),
    onSuccess: () => {
      toast.success(t('The work order of {tag} is saved', { tag }));
      for (const k of [keys.order(project, tag), keys.route(project, tag)]) void client.invalidateQueries({ queryKey: k });
    },
  });
}

/** A worker taken out of the workers file; refused while something still uses it. */
export function useRemoveWorker(project: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.removeWorker(project, id),
    onSuccess: res => {
      toast.success(t('{id} removed', { id: res.id }));
      refreshWorkers(client, project);
      refreshConfig(client, project);
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------- : tool plugins

/** The tool plugins the project can see, with their settings, servers, operations and the latest tool jobs. */
export const usePlugins = (project: string) => useQuery({ queryKey: ['plugins', project], queryFn: () => api.plugins(project), enabled: !!project, staleTime: 5_000, refetchInterval: 30_000 });

/** The doctor for some tools (or the enabled ones): starts their servers on the serving machine and lists their tools; nothing is called. */
export const usePluginDoctor = (project: string) => useMutation({ mutationFn: (ids?: string[]) => api.pluginDoctor(project, ids) });

export const useReviewStats = (project: string, days = 30) => useQuery({
  queryKey: ['review-stats', project, days],
  queryFn: () => api.reviewStats(project, days),
  enabled: !!project,
  staleTime: 15_000,
});

export function useFirstPassWrong(project: string, tag: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (note: string) => api.firstPassWrong(project, tag, note),
    onSuccess: () => {
      toast.success(t('{tag}: recorded wrong send-back', { tag }));
      void client.invalidateQueries({ queryKey: keys.order(project, tag) });
      void client.invalidateQueries({ queryKey: ['review-stats', project] });
    },
  });
}
