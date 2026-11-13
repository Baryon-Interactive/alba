import { UserError, fail, t } from '../i18n.ts';
import { optionAnswer } from '../orders/service.ts';
import { ownerOf } from '../usage/spend.ts';
import { startRun, type RunContext, type StartResult } from './launch.ts';
import { openQuestions } from './messages.ts';
import { sayToOrder } from './say.ts';
import { tick } from '../tick/gather.ts';

export interface AnswerResult {
  stage: string;
  /** The run that was started, when one was (the engine's own session continued, or a new run with the answer in its prompt). */
  started?: Extract<StartResult, { mode: 'start' }>;
  message: string;
}

/**
 * A person answers the question a worker ended its run with. The answer is recorded (the order goes back to queued, like a rework),
 * and the worker is started again at once: with an engine that can continue its conversation the original session is resumed and told
 * only the answer; any other engine gets a new run whose prompt carries the question and the answer.
 * If the worker cannot be started now (card-only, no launch template, none known), the answer stays recorded and the next tick starts it.
 */
export function answerOrder(ctx: RunContext, tag: string, text: string | undefined, options: { worker?: string; choice?: number; who?: string; question?: string } = {}): AnswerResult {
  const { orders, workers } = ctx;
  if (!text?.trim() && options.choice === undefined) fail('An answer needs its text (--text) or the number of an option (--choice).');
  const doc = orders.get(tag);
  const lastRun = [...doc.runs].sort((a, b) => b.seq - a.seq)[0];
  // A question the worker wrote to its outbox while its run goes on: the answer goes to that run's inbox as the reply (like
  // `alba say --reply`); recording an `answer` action would only queue the order behind the open run.
  const asked = doc.runs.some(r => r.ended === undefined) ? openQuestions(doc).at(-1) : undefined;
  if (asked && !options.question) {
    const opts = asked.options ?? [];
    if (options.choice !== undefined && (!Number.isInteger(options.choice) || options.choice < 1 || options.choice > opts.length)) fail(opts.length ? 'Choose an option from 1 to {n}.' : '{tag} is not waiting on a question with options.', { n: opts.length, tag: doc.order.tag });
    const body = options.choice !== undefined ? optionAnswer({ label: opts[options.choice - 1] }, options.choice, text) : text!.trim();
    const said = sayToOrder(ctx, tag, body, { reply: asked.id });
    return { stage: said.stage, message: t('Answer sent to the open run of {tag} (reply to: {question}). {said}', { tag: doc.order.tag, question: asked.text.length > 80 ? `${asked.text.slice(0, 79)}…` : asked.text, said: said.message }) };
  }
  if (options.choice !== undefined) {
    // The options are those of the report the order waits on.
    const waiting = [...doc.reports].sort((a, b) => b.seq - a.seq).find(r => r.question && r.options?.length);
    if (options.question && waiting?.question_id?.toLowerCase() !== options.question.toLowerCase()) fail('Question {id} of {tag} is not the one the order waits on now.', { id: options.question, tag: doc.order.tag });
    if (!waiting?.options || orders.stage(doc).stage !== 'awaiting-user' && orders.stage(doc).stage !== 'blocked') fail('{tag} is not waiting on a question with options.', { tag: doc.order.tag });
    if (!Number.isInteger(options.choice) || options.choice < 1 || options.choice > waiting.options.length) fail('Choose an option from 1 to {n}.', { n: waiting.options.length });
    if (waiting.question_id) orders.pick(doc.order.tag, waiting.question_id, { choice: options.choice, note: text, who: options.who });
    else orders.act(doc.order.tag, 'answer', { note: optionAnswer(waiting.options[options.choice - 1], options.choice, text), choice: options.choice });
  } else orders.act(doc.order.tag, 'answer', { note: text });
  const after = orders.stage(orders.get(tag));
  const worker = options.worker ? workers.workers.find(w => w.id === options.worker) ?? fail('Unknown worker "{id}". Known: {known}.', { id: options.worker, known: workers.workers.map(w => w.id).join(', ') }) : doc.order.next_worker ? workers.workers.find(w => w.id === doc.order.next_worker) : ownerOf(workers.workers, lastRun?.worker);
  if (after.stage !== 'queued' || !worker || worker.card_only || !worker.launch) {
    return { stage: after.stage, message: t('Answer recorded; {tag} is {stage}. {why}', { tag: doc.order.tag, stage: after.stage, why: !worker || worker.card_only || !worker.launch ? t('The worker cannot be started by the tool, so a person starts the next round.') : t('It starts when its needs are met.') }) };
  }
  // Answers are a start request too: use the same cap, memory, worker and resource decision as a tick.
  // The answer action is already durable, so a blocked decision simply leaves the order queued for a later tick.
  const decision = tick(ctx.project, orders, workers, ctx.probes, { record: false });
  if (!decision.report.moves.some(m => m.tag.toLowerCase() === doc.order.tag.toLowerCase())) {
    const held = decision.report.heldBack.filter(h => h.tag.toLowerCase() === doc.order.tag.toLowerCase());
    const resumedSession = !!lastRun?.session && lastRun.worker === worker.id && !!worker.launch?.session;
    const blocked = held.some(h => !resumedSession || !/concurrency/.test(h.why))
      || decision.report.problems.some(p => p.tag?.toLowerCase() === doc.order.tag.toLowerCase() && ['quota', 'no-worker', 'no-fit', 'spend', 'usage-budget'].includes(p.kind));
    if (blocked) return { stage: 'queued', message: t('Answer recorded; {tag} is queued, waiting for a free slot.', { tag: doc.order.tag }) };
  }
  let started: StartResult;
  try { started = startRun(ctx, doc.order.tag, worker.id, { explicitWorker: options.worker !== undefined }); } catch (e) {
    // The answer is recorded whatever happens next: say what stopped the start, the next tick or a person can try again.
    if (!(e instanceof UserError)) throw e;
    return { stage: orders.stage(orders.get(tag)).stage, message: t('Answer recorded, but the worker could not be started: {why}', { why: e.message.split(/\r?\n/)[0] }) };
  }
  if (started.mode !== 'start') return { stage: orders.stage(orders.get(tag)).stage, message: started.text };
  return {
    stage: orders.stage(orders.get(tag)).stage, started,
    message: started.resumed ? t('Answer sent: the session of run {prev} continues as run {run} on {worker}.', { prev: lastRun?.id ?? '-', run: started.run ?? '-', worker: worker.id }) : t('Answer recorded and run {run} started on {worker} as a new session (the engine cannot continue the old one); its prompt carries the question and the answer.', { run: started.run ?? '-', worker: worker.id }),
  };
}
