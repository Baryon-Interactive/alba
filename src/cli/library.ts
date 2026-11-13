import type { ProjectConfig } from '../config.ts';
import { fail, t } from '../i18n.ts';
import { approveSetting, artView } from '../library/art.ts';
import { choosePick, listPicks } from '../library/picks.ts';
import { RefClient, addRef, fetchRefs, httpsUrl, pageImage, refCards } from '../library/refs.ts';
import { approveQuote, spendView } from '../library/spend.ts';
import { ledgersOf, usageView } from '../library/usage.ts';
import type { Orders } from '../orders/service.ts';
import type { WorkersFile } from '../workers/config.ts';
import { table } from './format.ts';

/** The command-line values these commands read. */
export interface LibraryValues { json?: boolean; note?: string; who?: string; choice?: string; cap?: string; tag?: string; title?: string; tags?: string; page?: string; image?: string; learn?: string; work?: string; days?: string }

export const LIBRARY_GROUPS = ['picks', 'art', 'refs', 'settings', 'spend', 'usage'];

const short = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * `alba picks|art|refs|settings|spend|usage`: the art library of the project (document 015). Returns undefined for a group that is not one of them.
 * Nothing here reaches the network except `refs add` (the page it is given) and `refs fetch` (the pictures on the board).
 */
export function runLibrary(group: string, command: string | undefined, rest: string[], values: LibraryValues, cfg: ProjectConfig, orders: Orders, workers: () => WorkersFile | undefined, setExitCode: (code: number) => void = () => {}): string | Promise<string> | undefined {
  if (!LIBRARY_GROUPS.includes(group)) return undefined;
  if (group === 'refs' && !['list', 'add', 'fetch'].includes(command ?? '')) return undefined;      // `refs adopt` is the check command of the same name
  const json = (v: unknown) => JSON.stringify(v, null, 2);

  if (group === 'picks') {
    if (command === 'choose') {
      if (!rest[0] || !values.choice) fail('Usage: alba picks choose <id> --choice <key>[,<key>...] [--note text] [--who name]');
      const r = choosePick(cfg, orders, rest[0], { choice: values.choice.split(',').map(s => s.trim()).filter(Boolean), note: values.note, who: values.who });
      const text = t('{id}: chosen {choice}.', { id: r.set.id, choice: r.set.choice!.choice.join(', ') }) + (r.answeredOrder ? ' ' + t('{tag} was answered.', { tag: r.answeredOrder }) : '') + (r.set.decisionDraft ? `\n${t('To record the decision:')} alba decide "${r.set.decisionDraft}" --source "<the user's words>"` : '');
      return values.json ? json(r) : text;
    }
    if (command !== undefined && command !== 'list') fail('Usage: alba picks [list] [--json] | alba picks choose <id> --choice <key>[,<key>...] [--note text] [--who name]');
    const list = listPicks(cfg, orders);
    if (values.json) return json(list);
    if (!list.enabled) return t('This project has no pick sets ("picks:" in the project file, or a report with scope "project").');
    const lines = [table(['ID', 'STATE', 'TITLE', 'OPTIONS', 'CHOICE'], list.sets.map(s => [s.id, s.state + (s.staleChoice ? ' (stale choice)' : ''), short(s.title), s.options.map(o => o.key).join('/'), s.choice ? s.choice.choice.join(',') : '']))];
    for (const s of list.sets) for (const p of s.problems) lines.push(`${s.id}: ${p}`);
    for (const u of list.unreadable) lines.push(t('{file}: not read: {reason}', { file: u.file, reason: u.reason }));
    for (const p of list.recordProblems) lines.push(p);
    lines.push(t('{p} pending, {c} chosen, {d} decided, {u} files not read', { p: list.counts.pending, c: list.counts.chosen, d: list.counts.decided, u: list.counts.unreadable }));
    return lines.join('\n');
  }

  if (group === 'refs') {
    if (!cfg.art) fail('The project file has no "art" section.');
    if (command === 'list') {
      const { refs, problems } = refCards(cfg);
      const shown = refs.filter(r => !values.tag || r.tags.includes(values.tag));
      if (values.json) return json({ refs: shown, problems });
      return [table(['ID', 'WORK', 'TITLE', 'TAGS', 'KEPT', 'LEARN'], shown.map(r => [r.id, short(r.work ?? '', 20), short(r.title, 30), r.tags.join(','), r.cached ? (r.cacheFrom === 'external' ? 'studio' : 'yes') : r.failure ? 'failed' : 'no', short(r.learn ?? '', 40)])), ...problems].join('\n');
    }
    if (command === 'fetch') {
      return fetchRefs(cfg, new RefClient()).then(r => {
        if (r.failed) setExitCode(1);
        const head = t('{f} fetched, {u} used from the studio cache, {s} already kept, {x} failed', { f: r.fetched, u: r.reused, s: r.skipped, x: r.failed });
        return values.json ? json(r) : [head, ...r.failures.map(f => `  ${f.id}  ${f.image}  ${f.reason}`)].join('\n');
      });
    }
    if (command === 'add') {
      if (!values.page || !values.title || !values.tags || !values.learn) fail('Usage: alba refs add --page <url> [--image <url>] --title t --work w --tags a,b --learn "what to take from it"');
      const page = httpsUrl(values.page).href;
      const tags = values.tags.split(',').map(s => s.trim()).filter(Boolean);
      const make = (image: string) => addRef(cfg.art!, { image, page, title: values.title!, ...(values.work ? { work: values.work } : {}), tags, learn: values.learn });
      if (values.image) { const ref = make(httpsUrl(values.image).href); return values.json ? json(ref) : t('{id} added to the board.', { id: ref.id }); }
      return new RefClient().get(page, { image: false }).then(res => { const ref = make(pageImage(res.bytes.toString('utf8'), page)); return values.json ? json(ref) : t('{id} added to the board ({image}).', { id: ref.id, image: ref.image }); });
    }
    return fail('Usage: alba refs list [--tag t] | alba refs add --page <url> [--image <url>] --title t --work w --tags a,b --learn text | alba refs fetch');
  }

  if (group === 'art') {
    const view = artView(cfg);
    if (values.json) return json(view);
    if (!view.enabled) return t('This project has no art section ("art:" in the project file).');
    const lines = [t('{n} references ({c} kept), {s} settings, {k} files in compare/', { n: view.refs.length, c: view.refs.filter(r => r.cached).length, s: view.settings.length, k: view.compare.length })];
    if (view.tags.length) lines.push(`${t('tags')}: ${view.tags.map(x => `${x.tag} (${x.count})`).join(', ')}`);
    lines.push(table(['ID', 'STATUS', 'TEXT CONFIRMED', 'TITLE', 'PICTURES', 'PROBLEMS'], view.settings.map(s => [s.id, s.status + (s.standard ? '' : ' (not standard)'), s.confirmed ? 'yes' : s.confirmation ? 'changed' : 'no', short(s.title, 30), String(s.images.length), String(s.problems.length)])));
    for (const s of view.settings) for (const p of s.problems) lines.push(`${s.id}: ${p}`);
    lines.push(...view.problems);
    return lines.join('\n');
  }

  if (group === 'settings') {
    if (command === 'approve') {
      if (!rest[0]) fail('Usage: alba settings approve <id> [--note text] [--who name]');
      const s = approveSetting(cfg, orders, rest[0], { note: values.note, who: values.who });
      return values.json ? json(s) : t('{id}: the text is confirmed (sha256 {sha}).', { id: s.id, sha: s.textSha256!.slice(0, 12) });
    }
    if (command !== undefined && command !== 'list') fail('Usage: alba settings [list] | alba settings approve <id> [--note text] [--who name]');
    return runLibrary('art', undefined, [], values, cfg, orders, workers);
  }

  if (group === 'spend') {
    if (command === 'approve') {
      if (!rest[0] || values.cap === undefined) fail('Usage: alba spend approve <quote id> --cap N [--note text] [--who name]');
      const cap = Number(values.cap);
      if (!Number.isFinite(cap) || cap <= 0) fail('--cap must be a number above 0.');
      const q = approveQuote(cfg, orders, rest[0], { cap, note: values.note, who: values.who });
      return values.json ? json(q) : t('{id}: approved up to {cap}; {spent} spent, {left} left.', { id: q.id, cap, spent: q.spent, left: q.remaining ?? 0 });
    }
    if (command !== undefined && command !== 'list') fail('Usage: alba spend [list] [--json] | alba spend approve <quote id> --cap N [--note text] [--who name]');
    const view = spendView(cfg);
    if (values.json) return json(view);
    if (!view.enabled) return t('This project has no credits section ("credits:" in the project file).');
    const lines = [table(['ID', 'STATE', 'STATUS', 'SERVICE', 'TOTAL', 'CAP', 'SPENT', 'PROBLEMS'], view.quotes.map(q => [q.id, q.state, q.status ?? '', short(q.service ?? '', 24), q.total === null ? 'unknown' : String(q.total ?? ''), q.approval && !q.approval.stale ? String(q.approval.cap) : q.capRequested !== undefined ? `(${q.capRequested})` : '', String(q.spent), String(q.problems.length)]))];
    for (const q of view.quotes) for (const p of q.problems) lines.push(`${q.id}: ${p}`);
    for (const u of view.unreadable) lines.push(t('{file}: not read: {reason}', { file: u.file, reason: u.reason }));
    lines.push(...view.recordProblems);
    return lines.join('\n');
  }

  // usage
  const days = values.days === undefined ? 7 : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) fail('--days must be a whole number from 1 to 90.');
  const view = usageView(cfg, orders, ledgersOf(cfg, workers()), new Date(), days);
  if (values.json) return json(view);
  if (!view.enabled) return t('No usage ledgers are configured ("usage_ledgers:" in the project or workers file).');
  const lines = [t('Calls by other tools, last {days} days: {ok} ok, {failed} failed', { days, ok: view.total.ok, failed: view.total.failed })];
  lines.push(table(['LEDGER', 'FILE', 'CALLS', 'LINES', 'UNREADABLE', 'PROBLEM'], view.ledgers.map(l => [l.id, short(l.file, 50), String(l.calls), String(l.lines), String(l.unreadable), l.problem ?? ''])));
  lines.push(table(['DAY', 'LEDGER', 'MODEL', 'OK', 'FAILED'], view.byDay.map(r => [r.day, r.ledger, r.model, String(r.ok), String(r.failed)])));
  return lines.join('\n');
}
