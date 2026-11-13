import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * Who may use the console. Each start of a board has a key: a random secret that is never part of an answer. The key lives in the
 * server process, in a file only this OS account can read (see `keyDir`) and in the sign-in link `alba serve` prints. A program of the
 * same account sends it in the `x-alba-token` header; a browser trades it once, at `/login`, for a session cookie (HttpOnly,
 * SameSite=Strict) and from then on sends the cookie. A page of another site, or another account on this machine, has neither.
 */

export const newKey = (): string => randomBytes(32).toString('hex');

/** Equal strings, compared in a time that does not depend on where they differ. */
export function sameSecret(given: string | undefined, secret: string): boolean {
  if (typeof given !== 'string' || !secret) return false;
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

/** The value the old board's forms carry: derived from the key, so a page holds no key, and the same in every thread of one board. */
export const formToken = (key: string): string => createHmac('sha256', key).update('legacy-form').digest('hex').slice(0, 32);

/**
 * The folder of the key files: one this account alone can read. `ALBA_RUNTIME_DIR` when set; else `%LOCALAPPDATA%\alba\run` on
 * Windows (the user profile is closed to other accounts), `$XDG_RUNTIME_DIR/alba` or `~/.alba/run` elsewhere (made with mode 0700).
 */
export function keyDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ALBA_RUNTIME_DIR) return path.resolve(env.ALBA_RUNTIME_DIR);
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'alba', 'run');
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'alba');
  return path.join(os.homedir(), '.alba', 'run');
}

export const keyFile = (port: number, env: NodeJS.ProcessEnv = process.env): string => path.join(keyDir(env), `console-${port}.json`);

export interface KeyRecord { port: number; pid: number; started: string; key: string }

/** Writes the key of the board on `port` for programs of this account; returns a function that removes it again. */
export function writeKeyFile(port: number, key: string, env: NodeJS.ProcessEnv = process.env): () => void {
  const dir = keyDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  const file = keyFile(port, env);
  const record: KeyRecord = { port, pid: process.pid, started: new Date().toISOString(), key };
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
  return () => {
    try { if ((JSON.parse(readFileSync(file, 'utf8')) as KeyRecord).pid === process.pid) rmSync(file, { force: true }); } catch { /* already gone */ }
  };
}

/** The key of the board on `port`, when its file exists and is whole. */
export function readKeyFile(port: number, env: NodeJS.ProcessEnv = process.env): KeyRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(keyFile(port, env), 'utf8')) as KeyRecord;
    return typeof record.key === 'string' && record.port === port ? record : undefined;
  } catch { return undefined; }
}

/** The cookies of a request, by name. */
export function cookiesOf(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return out;
}

const header = (req: IncomingMessage, name: string): string | undefined => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };

/**
 * `Sec-Fetch-Site` of a browser request: a request another site (or another port of this host) made is refused before anything is read
 * or done, including GETs that an `<img>` sends without an Origin header. Programs send no such header.
 */
export const fromOtherSite = (req: IncomingMessage): boolean => {
  const site = header(req, 'sec-fetch-site');
  return site === 'cross-site' || site === 'same-site';
};

const MAX_SESSIONS = 64;

/** Browser sessions of one board: random ids in memory, gone when the board stops. */
export class Sessions {
  private readonly ids = new Map<string, number>();
  /** Cookies ignore ports: each board's cookie carries its port, so two boards on one machine do not sign each other out. */
  private readonly portOf: () => number;
  constructor(portOf: () => number) { this.portOf = portOf; }
  get cookie(): string { return `alba_session_${this.portOf()}`; }

  create(): string {
    const id = randomBytes(32).toString('base64url');
    this.ids.set(id, Date.now());
    while (this.ids.size > MAX_SESSIONS) this.ids.delete(this.ids.keys().next().value!);
    return id;
  }
  has(id: string | undefined): boolean { return !!id && this.ids.has(id); }
  idOf(req: IncomingMessage): string | undefined { const id = cookiesOf(req).get(this.cookie); return this.has(id) ? id : undefined; }
  revoke(id: string | undefined): void { if (id) this.ids.delete(id); }

  setCookie(id: string): string { return `${this.cookie}=${id}; Path=/; HttpOnly; SameSite=Strict`; }
  clearCookie(): string { return `${this.cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`; }
}

/** How a request proved it may use the console: the key itself (a program) or a browser session; undefined when it did not. */
export function credentialOf(req: IncomingMessage, key: string, sessions: Sessions): 'key' | 'session' | undefined {
  if (sameSecret(header(req, 'x-alba-token'), key)) return 'key';
  return sessions.idOf(req) ? 'session' : undefined;
}

/** A local path to go to after signing in: only a path of this server, never another host. */
export const safeNext = (next: string | null | undefined): string => (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/');

/** Requests the board let in (key or session, from an allowed site); the interface's write calls check this. */
const admittedRequests = new WeakSet<IncomingMessage>();
export const admit = (req: IncomingMessage): void => { admittedRequests.add(req); };
export const admitted = (req: IncomingMessage): boolean => admittedRequests.has(req);
