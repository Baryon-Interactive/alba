import type { ProjectConfig } from '../config.ts';
import { stateStore } from '../orders/backend.ts';
import { SqliteStore, type ScheduleFireRow, type ScheduleStateRow } from '../orders/sqlite-store.ts';
import type { OrderStore } from '../orders/store.ts';

export type { ScheduleFireRow, ScheduleStateRow };

interface FileScheduleStore {
  version: 1;
  states: Record<string, ScheduleStateRow>;
  fires: ScheduleFireRow[];
}

const META_NAME = 'schedules';

function readFileData(store: OrderStore): FileScheduleStore {
  const raw = store.readMeta(META_NAME) as Partial<FileScheduleStore> | undefined;
  if (!raw || typeof raw !== 'object') return { version: 1, states: {}, fires: [] };
  return {
    version: 1,
    states: raw.states && typeof raw.states === 'object' ? { ...raw.states } : {},
    fires: Array.isArray(raw.fires) ? [...raw.fires] : [],
  };
}

function writeFileData(store: OrderStore, data: FileScheduleStore): void {
  store.writeMeta(META_NAME, data);
}

export function getScheduleFire(store: OrderStore, scheduleId: string, plannedAt: string): ScheduleFireRow | undefined {
  if (store instanceof SqliteStore) return store.getScheduleFire(scheduleId, plannedAt);
  return readFileData(store).fires.find(f => f.schedule_id === scheduleId && f.planned_at === plannedAt);
}

export function listScheduleFires(store: OrderStore, scheduleId?: string): ScheduleFireRow[] {
  if (store instanceof SqliteStore) return store.listScheduleFires(scheduleId);
  const fires = readFileData(store).fires;
  const filtered = scheduleId !== undefined ? fires.filter(f => f.schedule_id === scheduleId) : fires;
  return filtered.sort((a, b) => a.planned_at.localeCompare(b.planned_at) || a.fired_at.localeCompare(b.fired_at));
}

export function insertScheduleFire(store: OrderStore, fire: ScheduleFireRow): boolean {
  if (store instanceof SqliteStore) return store.insertScheduleFire(fire);
  const data = readFileData(store);
  if (data.fires.some(f => f.schedule_id === fire.schedule_id && f.planned_at === fire.planned_at)) return false;
  data.fires.push(fire);
  writeFileData(store, data);
  return true;
}

export function getScheduleState(store: OrderStore, scheduleId: string): ScheduleStateRow | undefined {
  if (store instanceof SqliteStore) return store.getScheduleState(scheduleId);
  return readFileData(store).states[scheduleId];
}

export function allScheduleStates(store: OrderStore): ScheduleStateRow[] {
  if (store instanceof SqliteStore) return store.allScheduleStates();
  return Object.values(readFileData(store).states).sort((a, b) => a.schedule_id.localeCompare(b.schedule_id));
}

export function setScheduleState(store: OrderStore, state: ScheduleStateRow): void {
  if (store instanceof SqliteStore) {
    store.setScheduleState(state);
    return;
  }
  const data = readFileData(store);
  data.states[state.schedule_id] = state;
  writeFileData(store, data);
}

/** Producer card inputs for auto-paused schedules (namespace `schedule/<id>`). */
export function scheduleCaseInputs(project: ProjectConfig) {
  if (!project.schedules?.length) return [];
  const store = stateStore(project);
  const ids = new Set(project.schedules.map(s => s.id));
  const states = allScheduleStates(store).filter(s => ids.has(s.schedule_id) && s.paused && s.auto_paused);
  return states.map(st => {
    const recentTags = listScheduleFires(store, st.schedule_id)
      .filter(f => f.status === 'created' && f.order_tag)
      .slice(-3)
      .map(f => f.order_tag!);
    return {
      key: `schedule/${st.schedule_id}`,
      trigger: 'schedule-paused',
      project: project.id,
      facts: {
        schedule: st.schedule_id,
        pausedAt: st.paused_at ?? st.updated_at,
        reason: st.paused_reason ?? 'Last 3 scheduled orders ended failed or dropped.',
        orders: recentTags,
      },
      card: {
        trigger: 'schedule-paused',
        summary: `Schedule ${st.schedule_id} paused automatically: ${st.paused_reason ?? 'last 3 orders ended failed or dropped'}. Inspect the failed orders and resume the schedule when ready.`,
        pointers: [`schedule:${st.schedule_id}`, ...recentTags.map(tag => `order:${tag}`)],
        untrusted: [] as string[],
      },
    };
  });
}
