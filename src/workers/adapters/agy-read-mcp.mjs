#!/usr/bin/env node
// A read-only MCP server (stdio, one JSON-RPC message per line) for read-only agy runs: agy's custom agents have no
// built-in directory listing or text search (agy 1.5 keeps only read_file), so Alba gives them these two tools.
// Usage: node agy-read-mcp.mjs --root <folder> [--root <folder> ...]. Every path must lie inside one of the roots;
// nothing is ever written, and symbolic links are not followed.
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILES = 2000;
const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 300;
const SEARCH_MS = 30_000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const real = p => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };
const roots = [];
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--root' && process.argv[i + 1]) roots.push(real(process.argv[++i]));

const inside = (root, p) => { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
/** The real path of an absolute folder or file under a root, or an error naming the roots. */
export function resolveInRoots(value, allowed = roots) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('path is required: an absolute folder or file path');
  if (!path.isAbsolute(value)) throw new Error(`path must be absolute; the readable folders are: ${allowed.map(r => r.replace(/\\/g, '/')).join(', ')}`);
  const p = real(value);
  if (!allowed.some(root => inside(root, p))) throw new Error(`path is outside the readable folders: ${allowed.map(r => r.replace(/\\/g, '/')).join(', ')}`);
  return p;
}

/** A glob as a regular expression on '/'-separated relative paths: `**` any folders, `*` and `?` within one name, `{a,b}` alternatives. */
export function globRegex(glob) {
  let re = '', i = 0, depth = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { i += 2; if (glob[i] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; continue; }
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; depth++; }
    else if (c === '}' && depth) { re += ')'; depth--; }
    else if (c === ',' && depth) re += '|';
    else re += c.replace(/[.+^$|()[\]\\]/g, '\\$&');
    i++;
  }
  // A pattern without a folder matches the name in any folder, as most search tools do.
  return new RegExp(glob.includes('/') ? `^${re}$` : `(?:^|/)${re}$`, process.platform === 'win32' ? 'i' : '');
}

/** Files under `dir` as '/'-separated paths relative to it: git's view (tracked and non-ignored untracked) when it is in a work tree, else a walk. */
function filesUnder(dir) {
  try {
    const out = execFileSync('git', ['--no-optional-locks', '-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--full-name', '--', '.'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const prefix = path.relative(real(top), dir).replace(/\\/g, '/');
    const seen = new Set();
    for (const name of out.split('\0')) {
      if (!name) continue;
      const rel = prefix ? (name.startsWith(`${prefix}/`) ? name.slice(prefix.length + 1) : undefined) : name;
      if (rel) seen.add(rel);
    }
    return [...seen].sort();
  } catch { /* not a git work tree */ }
  const files = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(abs, e.name), r); } else if (e.isFile()) files.push(r);
      if (files.length > 50 * MAX_FILES) return;
    }
  };
  walk(dir, '');
  return files.sort();
}

function listFiles(args) {
  const dir = resolveInRoots(args.path);
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new Error('path is not a folder');
  const glob = typeof args.glob === 'string' && args.glob.trim() ? globRegex(args.glob.trim()) : undefined;
  const all = filesUnder(dir).filter(f => !glob || glob.test(f));
  const limit = Math.min(Math.max(Number(args.max_results) || MAX_FILES, 1), MAX_FILES);
  const shown = all.slice(0, limit);
  return [`${all.length} file(s) under ${dir.replace(/\\/g, '/')}${glob ? ` matching ${args.glob}` : ''}${all.length > shown.length ? `; the first ${shown.length} are shown, narrow the folder or glob for the rest` : ''}:`, ...shown].join('\n');
}

function readText(file) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) return undefined;
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size);
    let read = 0, n;
    while (read < buffer.length && (n = readSync(fd, buffer, read, buffer.length - read, read)) > 0) read += n;
    const head = buffer.subarray(0, Math.min(read, 8000));
    if (head.includes(0)) return undefined;
    return buffer.subarray(0, read).toString('utf8');
  } finally { closeSync(fd); }
}

function searchText(args) {
  if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern is required: a JavaScript regular expression');
  let re;
  try { re = new RegExp(args.pattern, args.ignore_case ? 'i' : ''); } catch (error) { throw new Error(`invalid pattern: ${error.message}`); }
  const target = resolveInRoots(args.path);
  const stat = lstatSync(target);
  const base = stat.isDirectory() ? target : path.dirname(target);
  const glob = typeof args.glob === 'string' && args.glob.trim() ? globRegex(args.glob.trim()) : undefined;
  const files = stat.isDirectory() ? filesUnder(target).filter(f => !glob || glob.test(f)) : [path.basename(target)];
  const limit = Math.min(Math.max(Number(args.max_results) || MAX_MATCHES, 1), MAX_MATCHES);
  const out = [];
  let matches = 0, skipped = 0, searched = 0;
  // One broad search must not stall the run: it stops after SEARCH_MS and says how far it got.
  const until = Date.now() + SEARCH_MS;
  for (const rel of files) {
    if (Date.now() > until) break;
    searched++;
    const text = readText(path.join(base, rel));
    if (text === undefined) { skipped++; continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      matches++;
      if (out.length < limit) out.push(`${rel}:${i + 1}: ${lines[i].length > MAX_LINE ? `${lines[i].slice(0, MAX_LINE)}…` : lines[i]}`);
    }
  }
  const scope = searched < files.length ? `the first ${searched} of ${files.length} file(s) (stopped after ${SEARCH_MS / 1000} s; narrow the folder or glob)` : `${files.length} file(s)`;
  const head = `${matches} match(es) in ${scope} under ${base.replace(/\\/g, '/')}${matches > out.length ? `; the first ${out.length} are shown, narrow the pattern, folder or glob for the rest` : ''}${skipped ? `; ${skipped} binary or large file(s) skipped` : ''}`;
  return [head, ...out].join('\n');
}

export const TOOLS = [
  {
    name: 'list_files',
    description: 'List the files under a folder, recursively (for a git work tree: tracked and non-ignored untracked files). Paths in the answer are relative to that folder.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'Absolute path of the folder.' },
      glob: { type: 'string', description: 'Optional filter such as "**/*.cs", "src/**/*.{ts,tsx}" or "*.md" (a glob without a slash matches the file name in any folder).' },
      max_results: { type: 'integer', description: `At most this many paths (default and maximum ${MAX_FILES}).` },
    }, required: ['path'] },
  },
  {
    name: 'search_text',
    description: 'Search the text of the files under a folder (or of one file) line by line with a JavaScript regular expression. Answers "relative/path:line: text".',
    inputSchema: { type: 'object', properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression, matched against each line.' },
      path: { type: 'string', description: 'Absolute path of the folder or file to search.' },
      glob: { type: 'string', description: 'Optional file filter, as for list_files.' },
      ignore_case: { type: 'boolean', description: 'Match without regard to case.' },
      max_results: { type: 'integer', description: `At most this many matching lines (default and maximum ${MAX_MATCHES}).` },
    }, required: ['pattern', 'path'] },
  },
];

export function callTool(name, args) {
  if (name === 'list_files') return listFiles(args);
  if (name === 'search_text') return searchText(args);
  throw new Error(`unknown tool ${name}`);
}

function serve() {
  let buffer = '';
  const write = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); } catch { write({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
      const id = req.id;
      if (req.method === 'initialize') write({ id, result: { protocolVersion: typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'alba-read', version: '1' } } });
      else if (req.method === 'tools/list') write({ id, result: { tools: TOOLS } });
      else if (req.method === 'tools/call') {
        try { write({ id, result: { content: [{ type: 'text', text: callTool(req.params?.name, req.params?.arguments ?? {}) }] } }); }
        catch (error) { write({ id, result: { content: [{ type: 'text', text: error.message }], isError: true } }); }
      } else if (req.method === 'ping') write({ id, result: {} });
      else if (id !== undefined && id !== null) write({ id, error: { code: -32601, message: `Unknown method ${req.method}` } });
    }
  });
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  if (!roots.length) { process.stderr.write('agy-read-mcp: give at least one --root <folder>\n'); process.exit(2); }
  serve();
}
