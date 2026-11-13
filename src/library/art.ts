import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { ArtRef, ArtSetting, ArtView, SettingApproveRequest, SettingConfirmation } from '../api/types.ts';
import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import type { Orders } from '../orders/service.ts';
import { appendStateJsonl, cleanRel, isObject, isText, readJsonl, readStateJsonl, relTo, safeFile, sha256 } from './files.ts';
import { markdownSection } from './markdown.ts';
import { cacheDir, cacheFailures, refCards } from './refs.ts';
import { sameFingerprint } from './picks.ts';

const STANDARD = ['text-draft', 'text-approved', 'sheets', 'final'];
/** Words projects use for a setting whose text is still being written. They are not the four statuses, but they mean the first one. */
const DRAFT_WORDS = ['text-draft', 'draft', 'concept', 'proposed', 'idea'];
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const NOTE_MAX = 4000;

/** Words that make a status mean "the text is not confirmed yet". */
export const isDraftStatus = (status: string): boolean => DRAFT_WORDS.includes(status.toLowerCase());

interface Confirmation { at: string; setting: string; textSha256: string; note?: string; by: string; who?: string; source: 'alba' | 'external' }

/** Confirmations of setting texts: the external tool's (read only, `art.records`) and alba's own (`_settings.jsonl`), oldest first. */
export function settingRecords(project: ProjectConfig): { records: Confirmation[]; problems: string[] } {
  const records: Confirmation[] = [];
  const problems: string[] = [];
  const external = readJsonl(project.art?.records);
  problems.push(...external.problems);
  for (const { line, value: v } of external.items) {
    if (v.project !== undefined && v.project !== project.art?.project_id) continue;
    if (!isText(v.setting) || !isText(v.textSha256) || !/^[a-f0-9]{64}$/.test(v.textSha256) || !isText(v.at) || !Number.isFinite(Date.parse(v.at))) { problems.push(`${path.basename(project.art!.records!)}: line ${line} is not a confirmation (setting, textSha256, at)`); continue; }
    records.push({ at: v.at, setting: v.setting, textSha256: v.textSha256, ...(typeof v.note === 'string' && v.note.trim() ? { note: v.note } : {}), by: typeof v.by === 'string' ? v.by : 'external', source: 'external' });
  }
  const own = readStateJsonl(project, 'settings');
  problems.push(...own.problems);
  for (const { line, value: v } of own.items) {
    if (!isText(v.setting) || !isText(v.textSha256) || !isText(v.at)) { problems.push(`_settings.jsonl: line ${line} is not a confirmation`); continue; }
    records.push({ at: v.at, setting: v.setting, textSha256: v.textSha256, ...(typeof v.note === 'string' && v.note.trim() ? { note: v.note } : {}), by: typeof v.by === 'string' ? v.by : 'cli', ...(typeof v.who === 'string' ? { who: v.who } : {}), source: 'alba' });
  }
  return { records: records.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), problems };
}

function settingOf(project: ProjectConfig, file: string, cards: Map<string, ArtRef>, records: Confirmation[], seen: Map<string, string>): ArtSetting | { file: string; reason: string } {
  const art = project.art!;
  const name = path.basename(file);
  let value: unknown;
  try { value = parse(readFileSync(file, 'utf8')); } catch (e) { return { file: name, reason: t('not valid YAML: {error}', { error: (e as Error).message.split('\n')[0] }) }; }
  if (!isObject(value) || !isText(value.id)) return { file: name, reason: t('"id" is missing') };
  const id = value.id.trim();
  if (seen.has(id)) return { file: name, reason: t('the id "{id}" is the one of {file} too', { id, file: seen.get(id)! }) };
  seen.set(id, name);
  const problems: string[] = [];
  if (path.parse(name).name !== id) problems.push(t('the id "{id}" is not the name of the file', { id }));
  const status = isText(value.status) ? value.status.trim() : '';
  if (!status) problems.push(t('"status" is missing'));
  else if (!STANDARD.includes(status)) problems.push(t('the status "{status}" is not one of {list}', { status, list: STANDARD.join(', ') }));
  const textRef = isText(value.text) ? value.text.trim() : '';
  const refList = Array.isArray(value.refs) ? value.refs.filter(isText).map(r => r.trim()) : [];
  const refCardsOf: ArtRef[] = [];
  for (const r of refList) {
    const card = cards.get(r);
    if (card) { refCardsOf.push(card); continue; }
    problems.push(/[/\\]|\.(png|jpe?g|webp|gif)$/i.test(r) ? t('"refs" names a picture file ({ref}); it takes the ids of reference cards', { ref: r }) : t('the reference {ref} is not on the board', { ref: r }));
  }
  const images = (Array.isArray(value.images) ? value.images.filter(isText) : []).map(p => {
    const rel = p.trim();
    if (!cleanRel(rel)) { problems.push(t('the picture path "{path}" is not a path inside the project', { path: rel })); return { path: rel, exists: false }; }
    const exists = safeFile(project.root, rel) !== undefined;
    if (!exists) problems.push(t('the picture {path} is missing', { path: rel }));
    const prefix = `${relTo(project.root, art.dir)}/settings/${id}/`;
    if (!rel.startsWith(prefix)) problems.push(t('the picture {path} is not under {prefix}', { path: rel, prefix }));
    else if (!IMAGE_FILE.test(rel)) problems.push(t('{path} is not a picture file', { path: rel }));
    return { path: rel, exists };
  });
  const decision = isText(value.decision) ? value.decision.trim() : undefined;
  if (isDraftStatus(status) && images.length) problems.push(t('a setting whose text is a draft has pictures'));
  if (status && !isDraftStatus(status) && !decision) problems.push(t('no "decision" for a setting past the draft'));
  if (['sheets', 'final'].includes(status) && !images.length) problems.push(t('the status is "{status}" but there are no pictures', { status }));
  let body: string | undefined;
  let textSha256: string | undefined;
  if (!textRef) problems.push(t('"text" is missing'));
  else {
    const [rel, anchor, ...extra] = textRef.split('#');
    if (extra.length || anchor === '') problems.push(t('"text" is not a file and an anchor: {text}', { text: textRef }));
    else {
      const full = safeFile(project.root, rel);
      if (!full) problems.push(t('the text file {path} is not there', { path: rel }));
      else {
        const section = markdownSection(readFileSync(full, 'utf8'), anchor);
        if (section === undefined) problems.push(t('the anchor #{anchor} is not in {path}', { anchor, path: rel }));
        else { body = section; textSha256 = sha256(section); }
      }
    }
  }
  const record = [...records].reverse().find(r => r.setting === id);
  let confirmation: SettingConfirmation | undefined;
  if (record) {
    const valid = body !== undefined && sameFingerprint(record.textSha256, body);
    confirmation = { at: record.at, by: record.by, ...(record.who ? { who: record.who } : {}), ...(record.note ? { note: record.note } : {}), source: record.source, textSha256: record.textSha256, valid };
    if (!valid && body !== undefined) problems.push(t('the text changed after it was confirmed'));
  }
  const confirmed = Boolean(confirmation?.valid);
  if (!confirmed && ['text-approved', 'sheets', 'final'].includes(status)) problems.push(t('the status says "{status}" but no confirmation of this text is on record', { status }));
  return {
    id, title: isText(value.title) ? value.title : id, ...(isText(value.kind) ? { kind: value.kind } : {}), status, standard: STANDARD.includes(status), text: textRef,
    ...(body !== undefined ? { body, textSha256 } : {}), refs: refList, refCards: refCardsOf, images, ...(decision ? { decision } : {}), ...(confirmation ? { confirmation } : {}), confirmed, problems,
  };
}

/** The art page: reference board, setting cards with their texts and confirmations, and the names in `compare/`. */
export function artView(project: ProjectConfig): ArtView {
  const empty: ArtView = { project: project.id, enabled: false, refs: [], tags: [], settings: [], compare: [], problems: [], cache: { cached: 0, failures: [] } };
  if (!project.art) return empty;
  const art = project.art;
  const out: ArtView = { ...empty, enabled: true };
  if (!existsSync(art.dir)) { out.problems.push(t('The folder {dir} is not there.', { dir: relTo(project.root, art.dir) })); return out; }
  const { refs, problems } = refCards(project);
  out.refs = refs;
  out.problems.push(...problems);
  const counts = new Map<string, number>();
  for (const r of refs) for (const tag of r.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  out.tags = [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const cards = new Map(refs.map(r => [r.id, r]));
  const { records, problems: recordProblems } = settingRecords(project);
  out.problems.push(...recordProblems);
  const dir = path.join(art.dir, 'settings');
  const seen = new Map<string, string>();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter(x => /\.ya?ml$/i.test(x)).sort()) {
      const s = settingOf(project, path.join(dir, f), cards, records, seen);
      if ('reason' in s) out.problems.push(`settings/${s.file}: ${s.reason}`);
      else out.settings.push(s);
    }
  }
  const compare = path.join(art.dir, 'compare');
  if (existsSync(compare)) out.compare = readdirSync(compare, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort();
  out.cache = { dir: cacheDir(project), cached: refs.filter(r => r.cached).length, failures: cacheFailures(cacheDir(project), project).map(f => ({ id: f.id, image: f.image, reason: f.reason })) };
  return out;
}

/** Confirms the text of a setting: a record of its fingerprint, who, when and why. The setting's file is not touched; no picture is made before this. */
export function approveSetting(project: ProjectConfig, orders: Orders, id: string, req: SettingApproveRequest): ArtSetting {
  const view = artView(project);
  if (!view.enabled) fail('The project file has no "art" section.');
  const s = view.settings.find(x => x.id.toLowerCase() === id.toLowerCase());
  if (!s) fail('There is no setting "{id}".', { id });
  if (s.body === undefined || !s.textSha256) fail('The text of "{id}" cannot be read: {why}', { id: s.id, why: s.problems.join('; ') });
  if (!isDraftStatus(s.status)) fail('"{id}" has the status "{status}"; only a setting whose text is a draft is confirmed.', { id: s.id, status: s.status });
  if (req.fingerprint !== undefined && req.fingerprint !== s.textSha256) fail('The text of "{id}" changed; read it again before confirming.', { id: s.id });
  if (req.note !== undefined && (typeof req.note !== 'string' || req.note.length > NOTE_MAX)) fail('The note is text of at most {n} characters.', { n: NOTE_MAX });
  const note = req.note?.trim() || undefined;
  const who = req.who?.trim() || undefined;
  appendStateJsonl(project, 'settings', { at: orders.now(), setting: s.id, textSha256: s.textSha256, ...(note ? { note } : {}), by: orders.actor, ...(who ? { who } : {}) });
  orders.record('*', 'setting-approved', { setting: s.id, textSha256: s.textSha256, ...(note ? { note } : {}), by: orders.actor, ...(who ? { who } : {}) });
  return artView(project).settings.find(x => x.id === s.id)!;
}
