import net from 'node:net';
import { t } from '../i18n.ts';
import type { WorkerConfig } from '../workers/config.ts';
import { eventErrors } from './transient.ts';

/** Deadline for a TCP probe, including DNS lookup. */
export const PROBE_TIMEOUT_MS = 3000;
export const PROBE_TTL_MS = 5000;

/** Host and port only. The userinfo, path and query of a base URL never leave this module. */
export interface EndpointRef {
  host: string;
  port: number;
  label: string;
}

const NAMED_URLS = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'];
const CONN = /\b(?:ECONNREFUSED|ENOTFOUND)\b|connection refused|actively refused|os error 10061|could not connect|fetch failed|\bgetaddrinfo\b/i;

export type EndpointVerdict =
  | { kind: 'unreachable'; endpoint: EndpointRef }
  | { kind: 'capacity' }
  | { kind: 'none' };

function expandDollar(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (match, name: string) => process.env[name] ?? match);
}

function fromUrl(raw: string): EndpointRef | undefined {
  const match = /https?:\/\/[^\s"'<>]+/i.exec(expandDollar(raw).trim());
  if (!match) return undefined;
  let url: URL;
  try { url = new URL(match[0]); } catch { return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return undefined;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port, label: host.includes(':') ? `[${host}]:${port}` : `${host}:${port}` };
}

/** The worker's model base URL: Anthropic, OpenAI, then any `base_url` override in env or args. */
export function endpointOf(worker: Pick<WorkerConfig, 'launch'> | undefined): EndpointRef | undefined {
  const launch = worker?.launch;
  if (!launch) return undefined;
  const env = launch.env ?? {};
  for (const key of NAMED_URLS) {
    const found = env[key] ? fromUrl(env[key]) : undefined;
    if (found) return found;
  }
  for (const [key, value] of Object.entries(env)) {
    if (NAMED_URLS.includes(key) || !/base[_-]?url/i.test(key)) continue;
    const found = fromUrl(value);
    if (found) return found;
  }
  for (const blob of [...launch.args, ...Object.values(env)]) {
    if (!/base[_-]?url/i.test(blob)) continue;
    const found = fromUrl(blob);
    if (found) return found;
  }
  return undefined;
}

function eventsOf(text: string, cut: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of text.split(/\r?\n/).slice(cut ? 1 : 0)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === 'object' && value !== null) out.push(value as Record<string, unknown>);
    } catch { /* not an event */ }
  }
  return out;
}

const isRetry = (event: Record<string, unknown>): boolean => event.type === 'api_retry' || event.subtype === 'api_retry';

function statusOf(event: Record<string, unknown>): number | null | undefined {
  const raw = event.error_status;
  if (raw === null || raw === 'null') return null;
  if (raw === undefined) return undefined;
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return undefined;
}

function tokensOf(event: Record<string, unknown>): number {
  const message = event.message;
  const bags = [event.usage, message && typeof message === 'object' ? (message as Record<string, unknown>).usage : undefined];
  let total = 0;
  for (const bag of bags) {
    if (!bag || typeof bag !== 'object') continue;
    const usage = bag as Record<string, unknown>;
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'total_tokens']) {
      if (typeof usage[key] === 'number' && usage[key] > 0) total += usage[key];
    }
  }
  return total;
}

/** A synthetic placeholder is not model output. Any other model, or text from a message with no model name, is. */
function realOutput(event: Record<string, unknown>): boolean {
  if (event.type !== 'assistant' && event.type !== 'result') return false;
  const message = (event.message && typeof event.message === 'object' ? event.message : event) as Record<string, unknown>;
  const model = typeof message.model === 'string' ? message.model : typeof event.model === 'string' ? event.model : undefined;
  if (model === '<synthetic>') return false;
  if (model) return true;
  const content = Array.isArray(message.content) ? message.content : [];
  return content.some(part => {
    if (!part || typeof part !== 'object') return false;
    const block = part as Record<string, unknown>;
    return block.type === 'tool_use' || (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0);
  });
}

function connectionFor(text: string, endpoint: EndpointRef): boolean {
  const errors = text.split(/\r?\n/).filter(line => !line.trim().startsWith('{')).join('\n') + '\n' + eventErrors(text);
  const lines = errors.split(/\r?\n/).filter(line => line.trim() && !/rmcp::transport/i.test(line));
  return lines.slice(-15).some(line => {
    if (!CONN.test(line)) return false;
    for (const match of line.matchAll(/https?:\/\/[^\s'"<>]+/gi)) {
      const found = fromUrl(match[0]);
      if (found?.host === endpoint.host && found.port === endpoint.port) return true;
    }
    return false;
  });
}

/**
 * A dead local gateway (nothing listening) versus a provider that answered "full".
 * A cut-off log is not treated as status-less: an earlier HTTP status may have been sliced away.
 * Only retries among the last log lines can force provider capacity; an earlier overload may have recovered.
 */
export function classifyEndpoint(input: { events: string; log: string; cut: boolean; usageTotal?: number; worker?: WorkerConfig }): EndpointVerdict {
  const endpoint = endpointOf(input.worker);
  const parsed = eventsOf(input.events, input.cut);
  const retries = parsed.filter(isRetry);
  const endingRetries = eventsOf(input.events.split(/\r?\n/).filter(line => line.trim()).slice(-15).join('\n'), false).filter(isRetry);
  if (endingRetries.some(event => { const status = statusOf(event); return typeof status === 'number' && (status === 429 || (status >= 500 && status <= 599)); })) return { kind: 'capacity' };
  if (retries.length) {
    const statuses = retries.map(statusOf);
    const tokens = (input.usageTotal ?? 0) + parsed.reduce((sum, event) => sum + tokensOf(event), 0);
    if (!input.cut && statuses.every(status => status === null || status === undefined) && tokens === 0 && !parsed.some(realOutput)) {
      return endpoint ? { kind: 'unreachable', endpoint } : { kind: 'capacity' };
    }
  }
  if (endpoint && connectionFor(`${input.events}\n${input.log}`, endpoint)) return { kind: 'unreachable', endpoint };
  return { kind: 'none' };
}

/** Why a run ended. Host and port only, never a token or a command line. */
export function unreachableWhy(endpoint?: EndpointRef): string {
  return endpoint ? t('endpoint {endpoint} is unreachable', { endpoint: endpoint.label }) : t('endpoint unreachable');
}

/** What the producer records when a run ends with no report of its own. */
export function endingCaseText(run: { outcome?: string; limit?: string }): string {
  if (run.limit === 'unreachable') return 'endpoint unreachable';
  return run.outcome === 'capacity' ? 'capacity error' : 'run ended without a report';
}

/** True when a TCP connection to host:port is accepted within the timeout. Host and port are arguments, not part of the script. */
export async function probeEndpoint(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!host || /[\r\n\0]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  return new Promise(resolve => {
    const socket = new net.Socket();
    const done = (answer: boolean) => { clearTimeout(timer); socket.destroy(); resolve(answer); };
    // A wall-clock deadline also bounds DNS lookup time.
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    try { socket.connect({ host, port }); } catch { done(false); }
  });
}

/** Per-worker answers, including failures, refreshed in the background even on the first read. */
export function cachedEndpointProbe(now: () => number, probe: (host: string, port: number, timeoutMs: number) => Promise<boolean> = probeEndpoint, ttlMs = PROBE_TTL_MS) {
  const memo = new Map<string, { at: number; value: boolean; pending: boolean }>();
  return (worker: string, host: string, port: number, timeoutMs: number): boolean => {
    const key = JSON.stringify([worker, host, port]);
    let hit = memo.get(key);
    if (!hit) { hit = { at: -Infinity, value: false, pending: false }; memo.set(key, hit); }
    if (!hit.pending && now() - hit.at >= ttlMs) {
      hit.pending = true;
      const entry = hit;
      void Promise.resolve().then(() => probe(host, port, timeoutMs)).catch(() => false).then(value => {
        entry.value = value; entry.at = now(); entry.pending = false;
      });
    }
    return hit.value;
  };
}
