import { execFile } from 'node:child_process';
import type { NotifyChannelConfig, TriggerName } from './config.ts';

export interface NotifyPayload {
  source: 'alba';
  host: string;
  trigger: TriggerName | 'quiet-summary' | 'digest' | 'test';
  key: string;
  project?: string;
  tag?: string;
  worker?: string;
  title: string;
  text: string;
  since: string;
  at: string;
  cleared: boolean;
}

export interface ToastCommand {
  program: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

export type ToastRunner = (command: ToastCommand) => Promise<void> | void;

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
  tries: number;
  notConfigured?: boolean;
  notAvailable?: boolean;
}

export interface ChannelAvailability {
  id: string;
  type: NotifyChannelConfig['type'];
  status: 'configured' | 'not configured' | 'not available';
  reason?: string;
  env: { name: string; status: 'set' | 'missing'; required: boolean }[];
}

export interface ChannelSendOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  toastRunner?: ToastRunner;
  timeoutMs?: number;
  maxTries?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_SEND_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_TRIES = 3;

export const WINDOWS_TOAST_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * Windows PowerShell 5.1 WinRT toast script. Title and text are read from child environment variables
 * and inserted as DOM text nodes, never interpolated into the script text.
 */
export const WINDOWS_TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
  '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$nodes = $xml.GetElementsByTagName('text')",
  '[void]$nodes.Item(0).AppendChild($xml.CreateTextNode([string]$env:ALBA_TOAST_TITLE))',
  '[void]$nodes.Item(1).AppendChild($xml.CreateTextNode([string]$env:ALBA_TOAST_TEXT))',
  `$appId = '${WINDOWS_TOAST_APP_ID}'`,
  '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
].join('; ');

export function buildToastCommand(payload: Pick<NotifyPayload, 'title' | 'text'>, timeoutMs = DEFAULT_SEND_TIMEOUT_MS): ToastCommand {
  return {
    program: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TOAST_SCRIPT],
    env: {
      ALBA_TOAST_TITLE: payload.title,
      ALBA_TOAST_TEXT: payload.text,
    },
    timeoutMs,
  };
}

export const defaultToastRunner: ToastRunner = command =>
  new Promise<void>((resolve, reject) => {
    execFile(
      command.program,
      command.args,
      {
        env: { ...process.env, ...command.env },
        timeout: command.timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
      },
      error => (error ? reject(error) : resolve()),
    );
  });

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const defaultBackoffMs = (attempt: number): number => 400 * 2 ** (attempt - 1);

/** Removes URLs, host/port origins and secret values from any error text before logging or returning. */
export function scrubSecrets(raw: string, secrets: readonly (string | undefined)[] = []): string {
  let out = raw.replace(/\r?\n/g, ' ').trim();
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (!trimmed) continue;
    out = out.split(trimmed).join('<redacted>');
    try {
      const parsed = new URL(trimmed);
      if (parsed.origin && parsed.origin !== 'null') out = out.split(parsed.origin).join('<redacted>');
      if (parsed.host) out = out.split(parsed.host).join('<redacted>');
      if (parsed.hostname) out = out.split(parsed.hostname).join('<redacted>');
    } catch { /* not a URL */ }
  }
  out = out.replace(/https?:\/\/\S+/gi, '<redacted>');
  out = out.replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>');
  return out || 'request failed';
}

function ntfyPriority(trigger: NotifyPayload['trigger']): string {
  if (trigger === 'serve-crashed' || trigger === 'machine-down') return 'urgent';
  if (trigger === 'run-stalled' || trigger === 'worker-paused') return 'high';
  if (trigger === 'digest' || trigger === 'quiet-summary') return 'low';
  return 'default';
}

function headerSafeAscii(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').trim() || 'Alba';
}

export function inspectChannel(
  id: string,
  channel: NotifyChannelConfig,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ChannelAvailability {
  if (channel.type === 'windows-toast') {
    if (platform !== 'win32') {
      return { id, type: channel.type, status: 'not available', reason: `not available on ${platform}`, env: [] };
    }
    return { id, type: channel.type, status: 'configured', env: [] };
  }
  const urlSet = Boolean(env[channel.url_env]?.trim());
  const envEntries: ChannelAvailability['env'] = [
    { name: channel.url_env, status: urlSet ? 'set' : 'missing', required: true },
  ];
  if ('token_env' in channel && channel.token_env) {
    const tokenSet = Boolean(env[channel.token_env]?.trim());
    envEntries.push({ name: channel.token_env, status: tokenSet ? 'set' : 'missing', required: false });
  }
  if (!urlSet) {
    return { id, type: channel.type, status: 'not configured', reason: `${channel.url_env} is not set`, env: envEntries };
  }
  return { id, type: channel.type, status: 'configured', env: envEntries };
}

function serializeWebhookBody(payload: NotifyPayload): string {
  return JSON.stringify({
    source: 'alba',
    host: payload.host,
    trigger: payload.trigger,
    key: payload.key,
    ...(payload.project !== undefined ? { project: payload.project } : {}),
    ...(payload.tag !== undefined ? { tag: payload.tag } : {}),
    ...(payload.worker !== undefined ? { worker: payload.worker } : {}),
    title: payload.title,
    text: payload.text,
    since: payload.since,
    at: payload.at,
    cleared: payload.cleared,
  });
}

function buildHttpRequest(
  channel: Exclude<NotifyChannelConfig, { type: 'windows-toast' }>,
  payload: NotifyPayload,
  token: string | undefined,
): { headers: Record<string, string>; body: string } {
  if (channel.type === 'webhook') {
    return {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: serializeWebhookBody(payload),
    };
  }
  if (channel.type === 'ntfy') {
    return {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        Title: headerSafeAscii(payload.title),
        Priority: ntfyPriority(payload.trigger),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: payload.text,
    };
  }
  return {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ text: payload.text }),
  };
}

export async function sendChannel(
  channel: NotifyChannelConfig,
  payload: NotifyPayload,
  options: ChannelSendOptions = {},
): Promise<SendResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const maxTries = Math.max(1, options.maxTries ?? DEFAULT_MAX_TRIES);
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  const sleep = options.sleep ?? defaultSleep;

  if (channel.type === 'windows-toast') {
    if (platform !== 'win32') {
      return { ok: false, error: `not available on ${platform}`, tries: 0, notAvailable: true };
    }
    const runner = options.toastRunner ?? defaultToastRunner;
    const command = buildToastCommand(payload, timeoutMs);
    let lastError = 'toast failed';
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        await runner(command);
        return { ok: true, tries: attempt };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = scrubSecrets(message);
        if (attempt < maxTries) await sleep(backoffMs(attempt));
      }
    }
    return { ok: false, error: lastError, tries: maxTries };
  }

  const url = env[channel.url_env]?.trim();
  if (!url) {
    return { ok: false, error: `not configured (${channel.url_env} is not set)`, tries: 0, notConfigured: true };
  }
  const token = 'token_env' in channel && channel.token_env ? env[channel.token_env]?.trim() || undefined : undefined;
  const secrets = [url, token];
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const { headers, body } = buildHttpRequest(channel, payload, token);

  let lastError = 'request failed';
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      await response.text().catch(() => '');
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status, tries: attempt };
      }
      lastStatus = response.status;
      lastError = `HTTP ${response.status}`;
      const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
      if (!retryable) return { ok: false, status: response.status, error: lastError, tries: attempt };
    } catch (err) {
      lastStatus = undefined;
      const cause = err instanceof Error && err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err instanceof Error ? err.message : String(err);
      lastError = controller.signal.aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : scrubSecrets(cause, secrets);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxTries) await sleep(backoffMs(attempt));
  }
  return { ok: false, ...(lastStatus !== undefined ? { status: lastStatus } : {}), error: lastError, tries: maxTries };
}

export function formatFailureLine(channelId: string, result: SendResult): string {
  return `notify (${channelId}): ${result.error ?? (result.status ? `HTTP ${result.status}` : 'send failed')}`;
}
