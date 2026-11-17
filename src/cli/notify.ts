import os from 'node:os';
import path from 'node:path';
import { loadProject } from '../config.ts';
import { fail, t } from '../i18n.ts';
import {
  inspectChannel,
  sendChannel,
  type ChannelSendOptions,
  type NotifyPayload,
} from '../notify/channels.ts';
import { isInQuietHours, parseClockMinutes } from '../notify/config.ts';
import { localDateKey } from '../notify/notifier.ts';
import { readNotifyState } from '../notify/state.ts';
import { machineDir } from '../resources/machine-store.ts';
import { loadWorkers, type WorkersFile } from '../workers/config.ts';

export function resolveNotifyWorkers(
  workersFlag: string | undefined,
  projectFlags: string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): WorkersFile {
  let file = workersFlag ?? env.ALBA_WORKERS;
  if (!file) {
    const projects = projectFlags?.length
      ? projectFlags
      : (env.ALBA_PROJECT ?? '').split(path.delimiter).filter(Boolean);
    for (const pFile of projects) {
      const cfg = loadProject(pFile);
      if (cfg.workers) {
        file = cfg.workers;
        break;
      }
    }
  }
  if (!file) {
    fail('No workers file. Pass --workers <workers.yaml>, set ALBA_WORKERS or write "workers:" in the project file.');
  }
  return loadWorkers(file);
}

export async function runNotifyTest(
  workers: WorkersFile,
  options: {
    channel?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    now?: Date;
    sendOptions?: ChannelSendOptions;
  } = {},
): Promise<{ output: string; ok: boolean }> {
  const notify = workers.notify;
  if (!notify) fail('{file} has no "notify" section.', { file: workers.file });

  const known = Object.keys(notify.channels);
  let targetIds: string[];
  if (options.channel !== undefined) {
    const id = options.channel.trim();
    if (!notify.channels[id]) {
      fail('Unknown notification channel "{channel}" in {file}. Known channels: {known}.', {
        channel: id,
        file: workers.file,
        known: known.join(', '),
      });
    }
    targetIds = [id];
  } else {
    targetIds = known;
  }

  const now = options.now ?? new Date();
  const at = now.toISOString();
  const host = os.hostname();
  const lines: string[] = [];
  let ok = true;

  for (const id of targetIds) {
    const channel = notify.channels[id]!;
    const payload: NotifyPayload = {
      source: 'alba',
      host,
      trigger: 'test',
      key: `test:${id}`,
      title: 'Alba test notification',
      text: `Alba test notification for channel "${id}" on ${host}.`,
      since: at,
      at,
      cleared: false,
    };
    const result = await sendChannel(channel, payload, {
      env: options.env ?? process.env,
      platform: options.platform ?? process.platform,
      ...options.sendOptions,
    });
    if (result.ok) {
      lines.push(result.status !== undefined ? `${id}: sent (HTTP ${result.status})` : `${id}: sent`);
    } else {
      ok = false;
      lines.push(`${id}: ${result.error ?? (result.status ? `HTTP ${result.status}` : 'failed')}`);
    }
  }

  return { output: lines.join('\n'), ok };
}

function computeNextDigest(now: Date, atHm: string, lastDigestDate: string | undefined): Date {
  const minutes = parseClockMinutes(atHm);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const todayCandidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  const todayKey = localDateKey(now);
  if (now.getTime() < todayCandidate.getTime() && lastDigestDate !== todayKey) {
    return todayCandidate;
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, h, m, 0, 0);
}

export function runNotifyStatus(
  workers: WorkersFile,
  options: {
    json?: boolean;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    now?: Date;
    machineDir?: string;
  } = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? new Date();
  const dir = options.machineDir ?? machineDir(env);
  const notify = workers.notify;

  if (!notify) {
    if (options.json) {
      return JSON.stringify({
        configured: false,
        file: workers.file,
        channels: [],
        open_conditions: [],
        quiet_hours: null,
        next_digest: null,
      }, null, 2);
    }
    return t('Notifications are not configured ({file} has no "notify" section).', { file: workers.file });
  }

  const state = readNotifyState(dir);
  const channels = Object.entries(notify.channels).map(([id, ch]) => inspectChannel(id, ch, env, platform));
  const openConditions = Object.entries(state.conditions)
    .filter(([, c]) => c.cleared_at === undefined)
    .map(([key, c]) => ({
      key,
      trigger: c.trigger,
      since: c.first_seen,
      notified_at: c.notified_at ?? null,
      ...(c.project ? { project: c.project } : {}),
      ...(c.tag ? { tag: c.tag } : {}),
      ...(c.worker ? { worker: c.worker } : {}),
      ...(c.text ? { text: c.text } : {}),
    }));

  const quietHours = notify.quiet_hours
    ? {
        from: notify.quiet_hours.from,
        to: notify.quiet_hours.to,
        except: notify.quiet_hours.except,
        active: isInQuietHours(now, notify.quiet_hours),
        held: state.held.length,
      }
    : null;

  const nextDigest = notify.digest
    ? (() => {
        const next = computeNextDigest(now, notify.digest.at, state.last_digest_date);
        return {
          at: notify.digest.at,
          next_at: `${localDateKey(next)} ${notify.digest.at}`,
          next_iso: next.toISOString(),
          to: notify.digest.to,
          last_sent_date: state.last_digest_date ?? null,
        };
      })()
    : null;

  if (options.json) {
    return JSON.stringify({
      configured: true,
      file: workers.file,
      default_to: notify.to,
      channels,
      open_conditions: openConditions,
      quiet_hours: quietHours,
      next_digest: nextDigest,
    }, null, 2);
  }

  const lines: string[] = ['Channels:'];
  for (const ch of channels) {
    const envNote = ch.env.length
      ? `  [${ch.env.map(e => `${e.name}: ${e.status}`).join(', ')}]`
      : '';
    lines.push(`  ${ch.id} (${ch.type}): ${ch.status}${envNote}`);
  }

  lines.push('', 'Open conditions:');
  if (!openConditions.length) {
    lines.push('  (none)');
  } else {
    for (const cond of openConditions) {
      lines.push(`  ${cond.key}  since ${cond.since}  notified ${cond.notified_at ?? 'pending'}`);
    }
  }

  lines.push('', 'Quiet hours:');
  if (!quietHours) {
    lines.push('  (off)');
  } else {
    const exceptPart = quietHours.except.length ? `; except: ${quietHours.except.join(', ')}` : '';
    lines.push(`  ${quietHours.from} to ${quietHours.to} (${quietHours.active ? 'active' : 'inactive'}, ${quietHours.held} held${exceptPart})`);
  }

  lines.push('', 'Next digest:');
  if (!nextDigest) {
    lines.push('  (off)');
  } else {
    lines.push(`  ${nextDigest.next_at} -> ${nextDigest.to.join(', ')}${nextDigest.last_sent_date ? ` (last sent ${nextDigest.last_sent_date})` : ''}`);
  }

  return lines.join('\n');
}

export async function runNotifyCli(
  command: string | undefined,
  rest: readonly string[],
  values: { channel?: string; workers?: string; project?: string[]; json?: boolean },
): Promise<{ output: string; code: number }> {
  if (rest.length > 0 || (command !== 'test' && command !== 'status')) {
    fail('Usage: alba notify test [--channel id] [--workers file] | alba notify status [--json] [--workers file]');
  }
  const workers = resolveNotifyWorkers(values.workers, values.project);
  if (command === 'test') {
    const res = await runNotifyTest(workers, { channel: values.channel });
    return { output: res.output, code: res.ok ? 0 : 1 };
  }
  return { output: runNotifyStatus(workers, { json: values.json === true }), code: 0 };
}
