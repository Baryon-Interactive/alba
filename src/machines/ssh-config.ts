import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { t } from '../i18n.ts';
import { backupFile, EditRefused } from '../yamledit.ts';
import { sshDir } from './edit.ts';

// Reading and changing one `Host` block of the SSH config of the user running alba.
// Only HostName, User and Port are ever written; every other line (IdentityFile, comments, other hosts, Match and
// Include lines) is left byte for byte. Key files are never opened: an IdentityFile line is text like any other.

const HOST = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252})$/;
const USER = /^[A-Za-z0-9._][A-Za-z0-9._$-]{0,63}$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const OPTION = /^(\s*)([A-Za-z][A-Za-z0-9]*)(\s*=\s*|\s+)(.*?)\s*$/;

export interface SshAddress { hostname?: string; user?: string; port?: number }
/** A change of address: a field left out stays as it is; `port: null` removes the Port line (back to 22). */
export interface SshAddressChange { hostname?: string; user?: string; port?: number | null }

export interface SshHostView {
  file: string; alias: string; found: boolean;
  /** The block as written (from its Host line to its last option line), when found. */
  block?: string;
  /** 1-based line of the Host line. */
  line?: number;
  /** What the block itself sets. */
  address: SshAddress;
  /** Other names on the same Host line: a change applies to them too, so it is refused. */
  shared: string[];
  /** Arguments of the Include lines of the file; an alias defined only there cannot be changed by alba. */
  includes: string[];
  /** Why a change of this block would not take effect or is not allowed (empty when it is fine). */
  problems: string[];
}

interface Line { text: string; indent: string; key: string; sep: string; value: string }
const lineOf = (text: string): Line => {
  const m = OPTION.exec(text);
  return m && !text.trimStart().startsWith('#') ? { text, indent: m[1], key: m[2].toLowerCase(), sep: m[3], value: m[4] } : { text, indent: '', key: '', sep: '', value: '' };
};
const words = (value: string): string[] => [...value.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
const glob = (pattern: string, name: string): boolean => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(name);
/** Does a Host line apply to this name (negated patterns win)? */
const hostApplies = (patterns: string[], name: string): boolean => {
  if (patterns.some(p => p.startsWith('!') && glob(p.slice(1), name))) return false;
  return patterns.some(p => !p.startsWith('!') && glob(p, name));
};
const FIELDS: { key: 'hostname' | 'user' | 'port'; word: string }[] = [{ key: 'hostname', word: 'HostName' }, { key: 'user', word: 'User' }, { key: 'port', word: 'Port' }];

interface Parsed { lines: Line[]; start: number; end: number; patterns: string[]; includes: string[]; earlier: Map<string, number>; matchBefore: boolean }

/** Finds the first Host block naming `alias` exactly. `end` is one past its last option line (trailing blanks and comments are not part of it). */
function parse(text: string, alias: string): Parsed {
  const lines = text.split('\n').map(lineOf);
  const includes: string[] = [];
  const earlier = new Map<string, number>();
  let start = -1, end = -1, patterns: string[] = [], matchBefore = false;
  // `applies` is whether the section being read applies to the alias: the global part before any Host or Match does.
  let applies: boolean | 'unknown' = true;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.key === 'include') includes.push(l.value);
    if (l.key === 'host' || l.key === 'match') {
      if (start >= 0) { end = i; break; }
      if (l.key === 'match') { applies = 'unknown'; matchBefore = true; continue; }
      const ps = words(l.value);
      if (ps.some(p => p.toLowerCase() === alias.toLowerCase())) { start = i; patterns = ps; continue; }
      applies = hostApplies(ps, alias);
      continue;
    }
    if (start < 0 && applies === true && l.key) for (const f of FIELDS) if (l.key === f.word.toLowerCase() && !earlier.has(f.key)) earlier.set(f.key, i + 1);
  }
  if (start >= 0 && end < 0) end = lines.length;
  if (start >= 0) while (end > start + 1 && (!lines[end - 1].text.trim() || lines[end - 1].text.trimStart().startsWith('#'))) end--;
  return { lines, start, end, patterns, includes, earlier, matchBefore };
}

/** What the SSH config text says about `alias`. Pure: the caller reads the file. */
export function sshHostInfo(text: string, alias: string, file = 'config'): SshHostView {
  const p = parse(text.replace(/^﻿/, '').replace(/\r\n/g, '\n'), alias);
  const view: SshHostView = { file, alias, found: p.start >= 0, address: {}, shared: [], includes: p.includes, problems: [] };
  if (p.start < 0) {
    view.problems.push(p.includes.length
      ? t('"Host {alias}" is not in {file}. It may come from an Include ({includes}); alba changes only {file}, so edit the right file by hand.', { alias, file, includes: p.includes.join(', ') })
      : t('"Host {alias}" is not in {file}. Write a Host block for it first (the add-machine guide can), or edit the file by hand.', { alias, file }));
    return view;
  }
  const block = p.lines.slice(p.start, p.end);
  view.block = block.map(l => l.text).join('\n') + '\n';
  view.line = p.start + 1;
  for (const l of block.slice(1)) {
    if (l.key === 'hostname' && view.address.hostname === undefined) view.address.hostname = words(l.value)[0];
    if (l.key === 'user' && view.address.user === undefined) view.address.user = words(l.value)[0];
    if (l.key === 'port' && view.address.port === undefined && /^\d+$/.test(l.value)) view.address.port = Number(l.value);
  }
  view.shared = p.patterns.filter(x => x.toLowerCase() !== alias.toLowerCase());
  if (view.shared.length) view.problems.push(t('The Host line names {others} too; a change would apply to them as well. Give {alias} its own Host block by hand first.', { others: view.shared.join(', '), alias }));
  for (const [key, line] of p.earlier) view.problems.push(t('Line {line} sets {option} for {alias} before its Host block, and SSH uses the first value it reads: a change here would not take effect.', { line: String(line), option: FIELDS.find(f => f.key === key)!.word, alias }));
  return view;
}

function checkChange(change: SshAddressChange): void {
  const problems: { field: string; message: string }[] = [];
  if (change.hostname !== undefined && !HOST.test(change.hostname)) problems.push({ field: 'hostname', message: 'Enter an IP address or a host name.' });
  if (change.user !== undefined && !USER.test(change.user)) problems.push({ field: 'user', message: 'Enter the login name on that machine.' });
  if (change.port !== undefined && change.port !== null && (!Number.isInteger(change.port) || change.port < 1 || change.port > 65535)) problems.push({ field: 'port', message: 'Port is 1–65535.' });
  if (problems.length) throw new EditRefused(problems[0].message, problems);
}

/**
 * Changes HostName, User and Port inside the first `Host <alias>` block of the text and nothing else. Lines that exist are
 * rewritten in place (indent, keyword spelling and separator kept); a missing one is added right after the Host line with
 * the block's indent. Refuses when the alias is not there, shares its Host line, or is overridden earlier in the file.
 */
export function rewriteSshHost(text: string, alias: string, change: SshAddressChange, file = 'config'): { text: string; before: string; after: string; changed: string[] } {
  if (!ALIAS.test(alias)) throw new EditRefused('Use letters, digits, hyphens or underscores for the alias.', [{ field: 'alias', message: 'Use letters, digits, hyphens or underscores for the alias.' }]);
  checkChange(change);
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const crlf = /\r\n/.test(text);
  const body = text.slice(bom.length).replace(/\r\n/g, '\n');
  const info = sshHostInfo(body, alias, file);
  if (info.problems.length) throw new EditRefused(info.problems[0], info.problems.map(message => ({ field: 'alias', message })));
  const p = parse(body, alias);
  const block = p.lines.slice(p.start, p.end);
  const indent = block.slice(1).find(l => l.key)?.indent ?? '    ';
  const changed: string[] = [];
  const inserts: string[] = [];
  for (const f of FIELDS) {
    const wanted = change[f.key];
    if (wanted === undefined) continue;
    const at = block.findIndex((l, i) => i > 0 && l.key === f.word.toLowerCase());
    if (wanted === null) {
      if (at > 0) { block.splice(at, 1); changed.push(f.key); }
      continue;
    }
    const value = String(wanted);
    if (at > 0) {
      const l = block[at];
      if (words(l.value)[0] === value) continue;
      const keyword = /^(\s*)(\S+?)(\s*=\s*|\s+)/.exec(l.text)!;
      block[at] = lineOf(`${keyword[1]}${keyword[2]}${keyword[3]}${value}`);
      changed.push(f.key);
    } else if (!(f.key === 'port' && value === '22')) {
      inserts.push(`${indent}${f.word} ${value}`);
      changed.push(f.key);
    }
  }
  block.splice(1, 0, ...inserts.map(lineOf));
  const before = p.lines.slice(p.start, p.end).map(l => l.text).join('\n') + '\n';
  const after = block.map(l => l.text).join('\n') + '\n';
  const lines = [...p.lines.slice(0, p.start).map(l => l.text), ...block.map(l => l.text), ...p.lines.slice(p.end).map(l => l.text)];
  let out = lines.join('\n');
  if (crlf) out = out.replace(/\n/g, '\r\n');
  return { text: bom + out, before, after, changed };
}

export const sshConfigFile = (dir = sshDir()) => path.join(dir, 'config');

/** The block of `alias` in the SSH config of the user running alba. */
export function readSshHost(alias: string, options: { dir?: string } = {}): SshHostView {
  const file = sshConfigFile(options.dir);
  if (!existsSync(file)) return { file, alias, found: false, address: {}, shared: [], includes: [], problems: [t('There is no SSH config at {file}.', { file })] };
  return sshHostInfo(readFileSync(file, 'utf8'), alias, file);
}

export interface SshEditOutcome { file: string; alias: string; before: string; after: string; changed: string[]; dryRun: boolean; backup?: string }

/** Changes the address of `alias` in the SSH config, keeping a backup of the old file. A dry run only says what would change. */
export function editSshHost(alias: string, change: SshAddressChange, options: { dir?: string; now?: Date; dryRun?: boolean } = {}): SshEditOutcome {
  const file = sshConfigFile(options.dir);
  if (!existsSync(file)) throw new EditRefused(t('There is no SSH config at {file}.', { file }), [{ field: 'alias', message: t('There is no SSH config at {file}.', { file }) }]);
  const original = readFileSync(file, 'utf8');
  const out = rewriteSshHost(original, alias, change, file);
  if (!out.changed.length || options.dryRun) return { file, alias, before: out.before, after: out.after, changed: out.changed, dryRun: !!options.dryRun };
  const backup = backupFile(file, options.now ?? new Date());
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, out.text, 'utf8');
  renameSync(tmp, file);
  return { file, alias, before: out.before, after: out.after, changed: out.changed, dryRun: false, backup };
}
