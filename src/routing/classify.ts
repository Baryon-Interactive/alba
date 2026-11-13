import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ClassifierConfig, KindDef, ProjectConfig } from '../config.ts';
import { t } from '../i18n.ts';
import type { OrderDoc, StoredRouting } from '../orders/model.ts';
import type { Orders } from '../orders/service.ts';
import { findOrderFile } from '../run/prompt.ts';
import { isGenericKind } from './kinds.ts';
import { parseStreamLog } from '../workers/adapters/index.ts';
import type { Probes } from '../tick/gather.ts';
import { expandArgs } from '../run/prompt.ts';
import type { WorkerConfig, WorkersFile } from '../workers/config.ts';


const textCache = new Map<string, { stamp: string; text: string }>();

/** The work-order file of an order as text (the part the classifier looks at), '' when it has none. Cached by file time and size. */
export function orderText(project: ProjectConfig, tag: string): string {
  let file: string;
  try { file = findOrderFile(project.work_orders, tag); } catch { return ''; }
  try {
    const s = statSync(file);
    const stamp = `${s.mtimeMs}:${s.size}`;
    const hit = textCache.get(file);
    if (hit?.stamp === stamp) return hit.text;
    const text = readFileSync(file, 'utf8');
    textCache.set(file, { stamp, text });
    return text;
  } catch { return ''; }
}

const maxChars = (project: ProjectConfig): number => project.classifier?.max_chars ?? 4000;

/** A short fingerprint of what the rules and the model look at: the title and the start of the work-order text. */
export function textHash(project: ProjectConfig, title: string, text: string): string {
  return createHash('sha1').update(title).update('\n').update(text.slice(0, maxChars(project))).digest('hex').slice(0, 16);
}

export interface RuleHit { kind: string; text: string }

/** Which kinds of the vocabulary match, in the order they are declared. */
export function matchKinds(kinds: readonly KindDef[], title: string, text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const def of kinds) {
    const hay = def.title_only ? title : `${title}\n${text}`;
    for (const source of def.match) {
      const m = new RegExp(source, def.ignore_case ? 'iu' : 'u').exec(hay);
      if (m) { hits.push({ kind: def.id, text: m[0].slice(0, 30) }); break; }
    }
  }
  return hits;
}

const quoted = (hits: readonly RuleHit[]) => hits.map(h => `"${h.text}" (${h.kind})`).join(', ');
const unique = (xs: readonly string[]) => [...new Set(xs)];

/**
 * What the order is, from what is already known and the project's rules; no model is asked.
 * A kind the table row or a person gave wins; the rules still add extra tags. Without one the first matching rule that is
 * not `tag_only` gives the kind. The result is what is stored on the order.
 */
export function classifyByRules(project: ProjectConfig, doc: OrderDoc, text: string, at: string): StoredRouting {
  const o = doc.order;
  const kinds = project.kinds ?? [];
  const hits = matchKinds(kinds, o.title, text);
  const tagOnly = new Set(kinds.filter(k => k.tag_only).map(k => k.id));
  const hash = textHash(project, o.title, text);
  // words the order already carries (a table rule's tags, or a person's) that are kinds of the vocabulary count as tags too
  const given = (o.tags ?? []).filter(x => kinds.some(k => k.id === x));
  if (!isGenericKind(o.kind)) {
    const tags = unique([...given, ...hits.map(h => h.kind)]).filter(k => k !== o.kind);
    const from = o.source ? t('the dispatch table gave the kind') : t('the kind was given');
    return { kind: o.kind, tags, source: o.source ? 'table' : 'manual', why: tags.length ? `${from}; ${t('rules add')}: ${quoted(hits.filter(h => h.kind !== o.kind))}` : from, at, text_hash: hash };
  }
  const main = hits.find(h => !tagOnly.has(h.kind));
  if (main) {
    const tags = unique([...given, ...hits.map(h => h.kind)]).filter(k => k !== main.kind);
    return { kind: main.kind, tags, source: 'rules', why: t('matched {hits}', { hits: quoted(hits) }), at, text_hash: hash };
  }
  return { kind: '', tags: unique([...given, ...hits.map(h => h.kind)]), source: 'none', why: kinds.length ? t('no rule matched this order') : t('the project defines no kinds'), at, text_hash: hash };
}

/**
 * The routing to use for an order now. The rules are cheap and always read again, so a change to the project's `kinds` takes
 * effect at once. A model's answer is kept while the text it was made from is unchanged and its kind is still in the
 * vocabulary, and is used only while the rules decide nothing. Nothing is stored here.
 */
export function routingOf(project: ProjectConfig, doc: OrderDoc, at: string = new Date().toISOString()): StoredRouting {
  const o = doc.order;
  const text = orderText(project, o.tag);
  const rules = classifyByRules(project, doc, text, at);
  const stored = o.routing;
  if (rules.source === 'none' && stored?.source === 'model' && stored.text_hash === textHash(project, o.title, text) && (project.kinds ?? []).some(k => k.id === stored.kind && !k.tag_only)) {
    return { ...stored, tags: [...new Set([...stored.tags, ...rules.tags])] };
  }
  return rules;
}

const same = (a: StoredRouting | undefined, b: StoredRouting): boolean => !!a && a.kind === b.kind && a.source === b.source && a.why === b.why && JSON.stringify(a.tags) === JSON.stringify(b.tags) && a.text_hash === b.text_hash;

/** Stores the rules' classification on an order (only when it changed). Returns the routing. */
export function classifyAndStore(project: ProjectConfig, orders: Orders, tag: string): StoredRouting {
  const doc = orders.get(tag);
  const routing = routingOf(project, doc);
  if (!project.kinds?.length && !project.classifier?.worker) return routing;     // no vocabulary: nothing to keep, the kind is the order's own
  if (!same(doc.order.routing, routing)) orders.update(tag, { routing });
  return routing;
}

// ------------------------------------------------------------------------------------------------------------------ the model

/** The prompt that asks a worker to classify one order. */
export function classifierPrompt(project: ProjectConfig, doc: OrderDoc, text: string): string {
  const cfg: ClassifierConfig | undefined = project.classifier;
  const kinds = project.kinds ?? [];
  return [
    'You sort one work order into a kind. Do not run commands, do not read or change files: answer from the text below.',
    '',
    'Kinds (the main kind is the one that decides who should do the work; "tag only" kinds can only be extra tags):',
    ...kinds.map(k => `- ${k.id}${k.tag_only ? ' (tag only)' : ''}: ${k.description}`),
    '',
    `Order ${doc.order.tag}: ${doc.order.title}`,
    '',
    'Start of its text:',
    '',
    text.slice(0, cfg?.max_chars ?? 4000),
    '',
    'Answer with exactly one line of JSON and nothing else:',
    '{"kind":"<one kind above>","tags":["<other kinds that also apply>"],"why":"<one short sentence>"}',
  ].join('\n') + '\n';
}

/** Reads the last JSON object with a "kind" out of what a worker said. */
export function parseClassifierAnswer(project: ProjectConfig, said: string): { kind: string; tags: string[]; why: string } | { problem: string } {
  const objects = [...said.matchAll(/\{[^{}]*"kind"[^{}]*\}/g)].map(m => m[0]);
  const last = objects.at(-1);
  if (!last) return { problem: t('the classifier answered no JSON') };
  let v: { kind?: unknown; tags?: unknown; why?: unknown };
  try { v = JSON.parse(last) as typeof v; } catch { return { problem: t('the classifier answered invalid JSON') }; }
  const vocab = project.kinds ?? [];
  const kind = typeof v.kind === 'string' ? v.kind.trim() : '';
  if (!vocab.some(k => k.id === kind && !k.tag_only)) return { problem: t('the classifier answered kind "{kind}", which the project does not have', { kind }) };
  const tags = Array.isArray(v.tags) ? v.tags.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(x => x !== kind && vocab.some(k => k.id === x)) : [];
  return { kind, tags: unique(tags), why: typeof v.why === 'string' ? v.why.trim().replace(/\s+/g, ' ').slice(0, 200) : '' };
}

export interface ClassifyContext { project: ProjectConfig; orders: Orders; workers: WorkersFile; probes: Probes }

/** What asking the classifier worker once came to. */
export type ModelAnswer = { ok: true; routing: StoredRouting } | { ok: false; problem: string };

/** Asks the project's classifier worker about one order. Never throws: a failure is a result. */
export async function askClassifier(ctx: ClassifyContext, doc: OrderDoc): Promise<ModelAnswer> {
  const { project, workers, probes } = ctx;
  const id = project.classifier?.worker;
  const worker: WorkerConfig | undefined = id ? workers.workers.find(w => w.id === id) : undefined;
  if (!id) return { ok: false, problem: t('the project has no classifier worker') };
  if (!worker) return { ok: false, problem: t('classifier worker "{id}" is not in the workers file', { id }) };
  if (!worker.launch) return { ok: false, problem: t('classifier worker "{id}" has no launch template', { id }) };
  if (!probes.runWorkerOnce) return { ok: false, problem: t('this build cannot run a worker once') };
  const tag = doc.order.tag;
  const dir = path.join(project.state_dir, 'routing');
  const cwd = dir;          // the prompt file lives in the worker's own folder: some engines refuse to read a file outside it
  mkdirSync(cwd, { recursive: true });
  const slash = (p: string) => p.replace(/\\/g, '/');
  const promptFile = slash(path.join(dir, `${tag}.prompt.md`)), lastFile = slash(path.join(dir, `${tag}.last.txt`)), log = slash(path.join(dir, `${tag}.log`));
  const text = orderText(project, tag);
  writeFileSync(promptFile, classifierPrompt(project, doc, text), 'utf8');
  writeFileSync(lastFile, '', 'utf8');
  const sessionId = createHash('sha1').update(`${tag}${Date.now()}`).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
  const values = { cwd: slash(cwd), prompt_file: promptFile, last_file: lastFile, model: worker.launch.model ?? '', log, git_dir: slash(cwd), worktree_git_dir: slash(cwd), session_id: sessionId };
  const spliced = worker.launch.args.flatMap(a => (a === '{session_args}' ? worker.launch!.session?.new ?? [] : [a]));
  const result = await probes.runWorkerOnce({ program: worker.launch.program, args: expandArgs(spliced, values), cwd, env: worker.launch.env, envUnset: worker.launch.env_unset, logFile: log, timeoutSeconds: project.classifier?.timeout_seconds ?? 180 });
  if (result.timedOut) return { ok: false, problem: t('the classifier did not answer in time') };
  const raw = (probes.readText(lastFile) ?? '').trim();
  const logText = probes.readText(log) ?? '';
  const stream = parseStreamLog(logText);
  const said = raw || (stream.events ? stream.finalText : logText.slice(-4000));
  const parsed = parseClassifierAnswer(project, said);
  if ('problem' in parsed) return { ok: false, problem: parsed.problem };
  const at = probes.now().toISOString();
  return { ok: true, routing: { kind: parsed.kind, tags: parsed.tags, source: 'model', why: `${worker.id}: ${parsed.why || t('no reason given')}`, at, text_hash: textHash(project, doc.order.title, text) } };
}

export interface ClassifyOutcome { tag: string; routing: StoredRouting; asked?: boolean; problem?: string }

/**
 * Classifies orders and stores the result on them. Rules first (cheap, always); then, when `model` is on and the project has a
 * classifier worker, orders that are still unplaced are given to it, at most `max_per_pass` of them, `parallel` at a time (one by default: some engines keep their state in one database that two runs at once lock).
 * A failed question leaves the order unclassified (the rules' result stays) and is reported, never thrown.
 */
export async function classifyOrders(ctx: ClassifyContext, options: { tags?: string[]; model?: boolean } = {}): Promise<ClassifyOutcome[]> {
  const { project, orders } = ctx;
  const tags = options.tags ?? orders.store.tags();
  const out: ClassifyOutcome[] = tags.map(tag => ({ tag: orders.get(tag).order.tag, routing: classifyAndStore(project, orders, tag) }));
  if (!options.model || !project.classifier?.worker) return out;
  const open = out.filter(o => o.routing.source === 'none' && !['merged', 'cancelled'].includes(orders.stage(orders.get(o.tag)).stage)).slice(0, project.classifier.max_per_pass);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const item = open[next++];
      if (!item) return;
      const doc = orders.get(item.tag);
      item.asked = true;
      const answer = await askClassifier(ctx, doc);
      if (answer.ok) { orders.update(item.tag, { routing: answer.routing }); item.routing = answer.routing; } else item.problem = answer.problem;
    }
  };
  await Promise.all(Array.from({ length: project.classifier.parallel }, worker));
  return out;
}

