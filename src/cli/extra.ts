import type { ProjectConfig } from '../config.ts';
import { applyClean, formatClean, planClean, systemClean } from '../clean/clean.ts';
import { gate, formatQuotes, quoteList, toQuote } from '../credits/credits.ts';
import { formatLessons, lessonsFor, lessonsForOrder, readLessons } from '../lessons/lessons.ts';
import { formatLessonStats, lessonStats } from '../lessons/stats.ts';
import { checkOptionImages } from '../evidence/evidence.ts';
import { fail, t } from '../i18n.ts';
import { systemProbes } from '../tick/gather.ts';
import { addDecision, decisionList, formatDecisions } from '../ledger/decisions.ts';
import type { OptionInput } from '../orders/model.ts';
import { normalizeOptions } from '../orders/report.ts';
import type { Orders } from '../orders/service.ts';

/** The command-line values the commands of this file read. */
export interface ExtraValues {
  text?: string; note?: string; source?: string; who?: string; json?: boolean; choice?: string; id?: string; order?: string; date?: string;
  default?: boolean; option?: string[]; apply?: boolean; check?: boolean; topic?: string; all?: boolean;
  tag?: string; status?: string; service?: string; unit?: string; 'unit-price'?: string; quantity?: string; cap?: string; amount?: string; what?: string; need?: string; key?: string;
  since?: string; kind?: string;
}

/** `label | note | image;image`: one option given on the command line. */
export function parseOption(text: string): OptionInput {
  const [label, note, images] = text.split('|').map(s => s.trim());
  return { label, ...(note ? { note } : {}), ...(images ? { images: images.split(';').map(s => s.trim()).filter(Boolean) } : {}) };
}

const num = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  if (!Number.isFinite(Number(v))) fail('--{name} must be a number.', { name });
  return Number(v);
};

/** The commands that came with the studio ports: decide, decisions, ask, pick. Returns undefined for a group that is not one of them. */
export function runExtra(group: string, command: string | undefined, rest: string[], values: ExtraValues, cfg: ProjectConfig, orders: Orders, setExitCode: (code: number) => void = () => {}): string | undefined {
  switch (group) {
    case 'decide': {
      // alba decide "<text>" (--source "<the user's words>" | --default) [--id D2031] [--order TAG] [--date YYYY-MM-DD]
      if (!command) fail('Usage: alba decide "<text>" (--source "<the user\'s words>" | --default) [--id D2031] [--order TAG] [--date YYYY-MM-DD]');
      const entry = addDecision(cfg, orders, { text: command, source: values.source, default: values.default === true, id: values.id, order: values.order, date: values.date });
      return values.json ? JSON.stringify(entry, null, 2) : `${entry.id}  ${entry.date}  ${entry.text}`;
    }
    case 'decisions': {
      const list = decisionList(cfg, orders);
      if (values.check) {
        if (values.json) return JSON.stringify(list.duplicates, null, 2);
        return list.duplicates.length ? [t('{n} number(s) appear in more than one place (the later one is kept):', { n: list.duplicates.length }), ...list.duplicates.map(d => `  ${d.id}: ${d.topics.map(x => x || '-').join(' / ')}`)].join('\n') : t('No number appears twice.');
      }
      if (values.topic) list.items = list.items.filter(e => e.topic === values.topic);
      if (values.json) return JSON.stringify(list, null, 2);
      const out = [formatDecisions(list.items)];
      if (list.reviewerRange) out.push('', t('Next: {id} (the reviewer\'s range is {a}-{b}).', { id: list.next, a: list.reviewerRange[0], b: list.reviewerRange[1] }));
      for (const r of list.reserved) out.push(t('Reserved on {tag}: {a}-{b}', { tag: r.tag, a: r.range[0], b: r.range[1] }));
      return out.join('\n');
    }
    case 'ask': {
      // alba ask <TAG> --text "<question>" --option "label | note | image;image" --option ...   (2 to 4, the recommended one first)
      if (!command) fail('Usage: alba ask <TAG> --text "<question>" --option "label | note | image;image" ... (2 to 4 options, the recommended one first)');
      if (!values.text) fail('alba ask needs --text <question>.');
      const options = checkOptionImages(cfg, orders, systemProbes, command, normalizeOptions((values.option ?? []).map(parseOption)));
      const { question } = orders.ask(command, { text: values.text, options });
      return t('{tag}: asked {id} with {n} options; it waits for an answer (alba pick {tag} {id} --choice N).', { tag: orders.get(command).order.tag, id: question.id, n: options.length });
    }
    case 'pick': {
      // alba pick <TAG> <Qn> --choice N [--note text] [--who name]
      if (!command || !rest[0]) fail('Usage: alba pick <TAG> <Q1> --choice N [--note text] [--who name]');
      const choice = num(values.choice, 'choice');
      if (choice === undefined) fail('alba pick needs --choice <option number>.');
      const { question } = orders.pick(command, rest[0], { choice, note: values.note, who: values.who });
      return t('{tag}: {id} answered, option {n}: {label}.', { tag: orders.get(command).order.tag, id: question.id, n: choice, label: question.options[choice - 1].label });
    }
    case 'lessons': {
      // alba lessons [--tag a,b] [--order TAG] [--all] [--json] | alba lessons stats [--since 30d] [--kind k] [--json]
      if (command && command !== 'stats') fail('Usage: alba lessons [--tag a,b] [--order TAG] [--all] [--json] | alba lessons stats [--since 30d] [--kind k] [--json]');
      if (!cfg.lessons) return t('{file} has no "lessons" section.', { file: cfg.file });
      const all = readLessons(cfg.lessons, cfg);
      if (command === 'stats') {
        const report = lessonStats(cfg, orders.all(), { since: values.since ?? '30d', kind: values.kind, lessons: all });
        return values.json ? JSON.stringify(report, null, 2) : formatLessonStats(report);
      }
      // --order TAG: what that order's prompt would carry; --tag: by tags; --all: also the lessons of other projects
      const items = values.order ? lessonsForOrder(cfg, orders.get(values.order), all) : values.tag ? lessonsFor(all.filter(l => l.appliesToProject), values.tag.split(',')) : values.all ? all : all.filter(l => l.appliesToProject);
      return values.json ? JSON.stringify({ project: cfg.id, count: items.length, items }, null, 2) : formatLessons(items);
    }
    case 'credits': {
      // alba credits list [--status s] | quote <TAG> --service s --cap N [--unit u] [--unit-price p --quantity n] [--note t] [--id C1]
      //             | approve <TAG> <C1> --cap N [--note t] | reject <TAG> <C1> [--note t] | spend <TAG> <C1> --amount N --what t | gate <TAG> <C1> --need N
      const [sub, tag, id] = [command, rest[0], rest[1]];
      const project = cfg.id;
      switch (sub) {
        case 'list': {
          const list = quoteList(project, orders, values.status);
          return values.json ? JSON.stringify(list, null, 2) : formatQuotes(list.items);
        }
        case 'quote': {
          if (!tag) fail('Usage: alba credits quote <TAG> --service <what> --cap <amount> [--unit credits] [--unit-price p --quantity n] [--note text]');
          const made = orders.quote(tag, { id: values.id, service: values.service ?? '', unit: values.unit, unit_price: num(values['unit-price'], 'unit-price'), quantity: num(values.quantity, 'quantity'), cap_requested: num(values.cap, 'cap') ?? 0, note: values.note });
          return t('{tag}: quote {id} for {service} made, asking {cap} {unit}; it waits for approval (the board, or alba credits approve {tag} {id} --cap N).', { tag: orders.get(tag).order.tag, id: made.quote.id, service: made.quote.service, cap: made.quote.cap_requested, unit: made.quote.unit });
        }
        case 'approve': {
          if (!tag || !id) fail('Usage: alba credits approve <TAG> <C1> --cap <amount> [--note text]');
          const made = orders.decideQuote(tag, id, { approve: true, cap: num(values.cap, 'cap') ?? 0, note: values.note });
          return t('{tag}: quote {id} approved with a cap of {cap} {unit}.', { tag: orders.get(tag).order.tag, id: made.quote.id, cap: made.quote.approval!.cap, unit: made.quote.unit });
        }
        case 'reject': {
          if (!tag || !id) fail('Usage: alba credits reject <TAG> <C1> [--note text]');
          const made = orders.decideQuote(tag, id, { approve: false, note: values.note });
          return t('{tag}: quote {id} rejected.', { tag: orders.get(tag).order.tag, id: made.quote.id });
        }
        case 'spend': {
          if (!tag || !id) fail('Usage: alba credits spend <TAG> <C1> --amount <n> --what <text> [--key <key>]');
          const made = orders.spend(tag, id, { amount: num(values.amount, 'amount') ?? 0, what: values.what ?? '', key: values.key });
          const q = toQuote(project, tag, made.quote);
          return t('{tag}: {amount} {unit} booked on quote {id}; {remaining} left.', { tag: made.doc.order.tag, amount: num(values.amount, 'amount')!, unit: q.unit, id: q.id, remaining: q.remaining ?? 0 });
        }
        case 'gate': {
          if (!tag || !id) fail('Usage: alba credits gate <TAG> <C1> --need <n> [--key <key>]');
          const need = num(values.need, 'need');
          if (need === undefined || !(need > 0)) fail('alba credits gate needs --need <amount above 0>.');
          const result = gate(orders, tag, id, need, { key: values.key });
          if (!result.ok) setExitCode(1);
          return result.why;
        }
        default: return fail('Usage: alba credits list|quote|approve|reject|spend|gate ... (see alba --help)');
      }
    }
    case 'clean': {
      // alba clean [--apply] [--json]: the plan by default; --apply carries it out
      const env = systemClean(systemProbes);
      const plan = planClean(cfg, orders, env);
      if (values.apply) applyClean(cfg, orders, plan, env);
      return values.json ? JSON.stringify(plan, null, 2) : formatClean(plan, values.apply === true);
    }
    default: return undefined;
  }
}
