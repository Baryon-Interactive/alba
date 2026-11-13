import type { OrderAction, Stage, WaitingFor } from '@api';
import type { Tone } from '@/components/ui/badge';
import { t } from '@/i18n';

/** Label of a stage (the Chinese words are in docs/glossary.md). Function so that the language is read when the label is drawn. */
export const stageLabel = (s: Stage, wf?: WaitingFor): string => {
  switch (s) {
    case 'cancelled': return t('Cancelled');
    case 'merged': return t('Merged');
    case 'held': return t('Held');
    case 'awaiting-user': return wf === 'card' ? t('Waiting for a card click') : t('Waiting for your answer');
    case 'awaiting-review': return t('Waiting for review');
    case 'blocked': return t('Blocked');
    case 'failed': return t('Failed');
    case 'dropped': return t('Dropped');
    case 'running': return t('Running');
    case 'monitoring': return t('Monitoring');
    case 'idle': return t('Idle');
    case 'waiting-needs': return t('Waiting for other orders');
    case 'planned': return t('Planned');
    case 'queued': return t('Queued');
    case 'draft': return t('Draft');
  }
};

export const stageTone: Record<Stage, Tone> = {
  cancelled: 'neutral', merged: 'success', held: 'warning', 'awaiting-user': 'primary', 'awaiting-review': 'primary', blocked: 'danger',
  failed: 'danger', dropped: 'danger', running: 'success', monitoring: 'primary', idle: 'neutral', 'waiting-needs': 'neutral', planned: 'outline', queued: 'neutral', draft: 'outline',
};

/** Who is being waited for (document 002). */
export const waitingFor = (s: Stage, wf?: WaitingFor): string => {
  switch (s) {
    case 'awaiting-user': return wf === 'card' ? t('waiting for you to click a card') : t('waiting for your answer');
    case 'awaiting-review': return t('waiting for your review');
    case 'blocked': return t('waiting for your decision');
    case 'failed':
    case 'dropped': return t('waiting for you to look');
    case 'held': return t('waiting for you to release it');
    case 'planned': return t('waiting for producer drafting');
    case 'draft': return t('waiting for you to queue it');
    case 'running': return t('the worker is on it');
    case 'monitoring': return t('the monitor is watching its long job');
    case 'waiting-needs': return t('waiting for other orders');
    case 'queued': return t('waiting for a worker slot');
    case 'idle': return t('nobody in particular');
    case 'merged':
    case 'cancelled': return t('done');
  }
};

export const actionLabel = (a: OrderAction): string => {
  switch (a) {
    case 'queue': return t('Queue');
    case 'hold': return t('Hold');
    case 'release': return t('Release');
    case 'cancel': return t('Cancel order');
    case 'approve': return t('Approve');
    case 'rework': return t('Send back for rework');
    case 'answer': return t('Answer');
    case 'run': return t('Run now');
    case 'stop': return t('Stop');
  }
};

export const actionExplain = (a: OrderAction): string => {
  switch (a) {
    case 'queue': return t('The order becomes queued; the next tick may start it.');
    case 'hold': return t('The order is paused until you release it.');
    case 'release': return t('The order leaves the held state.');
    case 'cancel': return t('The order is cancelled. Nothing is deleted.');
    case 'approve': return t('The branch must already be merged. The accept command runs and the accept file is written.');
    case 'rework': return t('The order goes back to the queue; the note below goes to the next run.');
    case 'answer': return t('Your answer goes to the worker. The original session is continued when the engine can, otherwise a new run starts with the answer.');
    case 'run': return t('Starts the order now on the worker you choose (a held order too), without waiting for a tick.');
    case 'stop': return t('Ends the run now: the worker process and every process it started. The order is held, so no tick starts it again; start it on a worker of your choice with Run now, or release it.');
  }
};

/**
 * The buttons an order shows, in order: what makes sense in the stage, out of what the server allows. The server lets a running order
 * be approved (the person may know better), but the console offers approve only where a review is waiting.
 */
const STAGE_BUTTONS: Record<Stage, OrderAction[]> = {
  'awaiting-review': ['approve', 'rework', 'hold', 'cancel'],
  'awaiting-user': ['answer', 'hold', 'cancel'],
  running: ['stop', 'cancel'],
  monitoring: ['hold', 'cancel'],
  blocked: ['rework', 'queue', 'cancel'],
  failed: ['rework', 'queue', 'cancel'],
  dropped: ['queue', 'cancel'],
  idle: ['queue', 'hold', 'cancel'],
  queued: ['run', 'hold', 'cancel'],
  'waiting-needs': ['hold', 'cancel'],
  held: ['run', 'release', 'cancel'],
  planned: ['cancel'],
  draft: ['queue', 'cancel'],
  merged: [],
  cancelled: [],
};

export function visibleActions(stage: Stage, allowed: readonly OrderAction[]): OrderAction[] {
  return STAGE_BUTTONS[stage].filter(a => allowed.includes(a));
}

export const NEEDS_YOU_STAGES: Stage[] = ['awaiting-user', 'awaiting-review', 'blocked', 'failed', 'dropped'];

/** The columns of the board: 14 stages folded into seven groups. */
export const BOARD_COLUMNS: { id: string; title: () => string; stages: Stage[] }[] = [
  { id: 'planned', title: () => t('Planned'), stages: ['planned'] },
  { id: 'plan', title: () => t('Draft and held'), stages: ['draft', 'held'] },
  { id: 'queue', title: () => t('Queued'), stages: ['queued', 'waiting-needs'] },
  { id: 'run', title: () => t('Running'), stages: ['running', 'idle'] },
  { id: 'monitor', title: () => t('Monitoring'), stages: ['monitoring'] },
  { id: 'you', title: () => t('Needs you'), stages: ['awaiting-user', 'blocked', 'failed', 'dropped'] },
  { id: 'review', title: () => t('Waiting for review'), stages: ['awaiting-review'] },
  { id: 'done', title: () => t('Done'), stages: ['merged', 'cancelled'] },
];
