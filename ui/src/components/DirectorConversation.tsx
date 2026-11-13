import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ProducerChatView, ProducerWorkspace } from '@api';
import { api } from '@/lib/api';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Badge } from './ui/badge';
import { ProducerMessage } from './ProducerMessage';
import { ProducerCards, type Decide } from './ProducerCards';
import { candidateTitle } from './ProducerConstraints';
import { dateTime } from '@/lib/format';
import { t } from '@/i18n';

export function DirectorThread({ data, project = '', tagPattern, facts, retry }: {
  data: ProducerChatView; project?: string; tagPattern?: string; facts?: Record<string, string>; retry?: (text: string) => void;
}) {
  return <ol className="grid w-full gap-4" aria-label={t('Director conversation')}>
    {data.messages.map(message => <li key={message.id} className="min-w-0">
      <div className="mb-2 ml-auto max-w-[90%] rounded-lg border bg-primary/5 p-3">
        <div className="mb-1 flex justify-between gap-2 text-xs text-muted-foreground"><span>{t('Director')}</span><time dateTime={message.at}>{message.at && dateTime(message.at)}</time></div>
        <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
      </div>
      <Card className="w-full p-4"><div className="mb-3 flex justify-between gap-2 text-xs text-muted-foreground"><span>{t('Producer reply')} · {t(message.status)}</span><time dateTime={message.completedAt ?? message.at}>{(message.completedAt || message.at) && dateTime(message.completedAt ?? message.at)}</time></div>
        <ProducerMessage answer={message.answer} tools={message.tools} narration={message.narration} running={message.status === 'running'} project={project} tagPattern={tagPattern} facts={facts} />
        {message.error && <p role="alert" className="mt-2 text-sm text-destructive">{t(message.error)}</p>}
        {message.status === 'error' && <Button size="sm" variant="outline" className="mt-2" onClick={() => retry?.(message.text)}>{t('Retry')}</Button>}
        {message.warnings.length > 0 && <details className="mt-3 text-xs text-warning"><summary className="cursor-pointer">{t('{count} numbers without a fact id', { count: message.warnings.length })}</summary><ul className="mt-2 space-y-1">{message.warnings.map((warning, i) => <li key={i}>{warning.startsWith('Unknown fact id: ') ? t('Unknown fact id: {id}', { id: warning.slice(17) }) : warning.startsWith('Uncited number: ') ? t('Uncited number: {text}', { text: warning.slice(16) }) : warning}</li>)}</ul></details>}
      </Card>
    </li>)}
  </ol>;
}

export function ProducerRail({ project, data, busy, decide, pause, analysis }: { project: string; data: ProducerWorkspace; busy?: boolean; decide?: Decide; pause?: () => void; analysis?: () => void }) {
  const pending = data.actions.filter(a => ['proposed', 'would-do'].includes(a.status)).length + data.directionProposals.filter(p => p.status === 'proposed').length + data.questions.length;
  const constraint = data.constraint;
  return <aside className="producer-rail min-h-0 overflow-y-auto rounded-lg border bg-muted/15 p-3" aria-label={t('Producer workspace rail')}>
    <section><h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">{t('Needs you')}<Badge tone={pending ? 'warning' : 'neutral'}>{pending}</Badge></h2>
      {!pending && <p className="mb-3 text-xs text-muted-foreground">{t('Nothing needs your decision.')}</p>}
      <ProducerCards project={project} data={data} questions={data.questions} busy={busy} decide={decide} />
    </section>
    <section className="mt-4 border-t pt-3"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">{t('Producer session')}</h2><Button size="sm" variant="outline" disabled={busy} onClick={pause}>{data.paused ? t('Resume') : t('Pause')}</Button></div>
      <dl className="grid grid-cols-2 gap-2 text-xs"><dt className="text-muted-foreground">{t('State')}</dt><dd>{data.paused ? t('paused') : data.messages.some(m => m.status === 'running') || data.session.active ? t('running') : t('idle')}</dd>
        <dt className="text-muted-foreground">{t('Model')}</dt><dd>{data.session.model ?? '—'}</dd>
        <dt className="text-muted-foreground">{t('Engine')}</dt><dd>{data.session.engine ?? 'claude'}{data.session.mode ? ` · ${data.session.mode}` : ''}</dd>
        <dt className="text-muted-foreground">{t('Last turn')}</dt><dd>{(data.session.lastTurnAt ?? data.messages.at(-1)?.at) ? dateTime(data.session.lastTurnAt ?? data.messages.at(-1)!.at) : '—'}</dd>
        <dt className="text-muted-foreground">{t('Session wanted')}</dt><dd>{data.session.wanted ? t('yes') : t('no')}</dd>
        <dt className="text-muted-foreground">{t('Last automatic restart')}</dt><dd>{data.session.lastRestartedAt ? dateTime(data.session.lastRestartedAt) : t('Not recorded')}</dd>
        <dt className="text-muted-foreground">{t('Turns today')}</dt><dd>{data.daily.turns}</dd>
        <dt className="text-muted-foreground">{t('Tokens today')}</dt><dd>{data.daily.tokens.toLocaleString()} / {data.budget?.toLocaleString() ?? '—'}</dd>
      </dl>
      {data.session.modelUsage && <dl className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-xs" data-testid="session-model-usage">{([['Requests', data.session.modelUsage.requests], ['Uncached input', data.session.modelUsage.uncachedInput], ['Cache read', data.session.modelUsage.cacheRead], ['Cache write', data.session.modelUsage.cacheWrite], ['Output', data.session.modelUsage.output]] as const).map(([label, n]) => <div key={label} className="contents"><dt className="text-muted-foreground">{t(label)}</dt><dd>{n.toLocaleString()}</dd></div>)}<dt className="text-muted-foreground">{t('Cache hit rate')}</dt><dd>{(data.session.modelUsage.cacheHitRate * 100).toFixed(1)}%</dd><dt className="text-muted-foreground">{t('Priced usage')}</dt><dd>{data.session.modelUsage.unpricedTokens ? t('Unpriced tokens') + ': ' + data.session.modelUsage.unpricedTokens.toLocaleString() : '$' + data.session.modelUsage.costUsd.toFixed(4)}</dd></dl>}
      {data.budget !== undefined && data.budget > 0 && <progress aria-label={t('Tokens today')} className="mt-2 h-1.5 w-full accent-primary" value={data.daily.tokens} max={data.budget} />}
      <div className="mt-3 flex flex-wrap gap-1.5">{data.rules.map(r => <Badge key={r.id} tone="outline" title={r.instruction}>{t(r.action)} · {t(r.mode)}</Badge>)}</div>
      {data.session.lastError && <p className="mt-2 text-xs text-destructive">{data.session.lastError}</p>}
    </section>
    <section className="mt-4 border-t pt-3"><h2 className="text-sm font-semibold">{t('Constraint now')}</h2><p className="mt-2 line-clamp-2 text-sm">{constraint ? constraint.type === 'none' ? t('no clear constraint') : constraint.candidates[0] ? candidateTitle(constraint.candidates[0]) : t(constraint.title) : t('Constraint analysis will appear after the next fact snapshot.')}</p><Button size="sm" variant="link" className="mt-1 px-0" onClick={analysis}>{t('Open analysis')}</Button></section>
  </aside>;
}

function mergeMessages(older: ProducerChatView['messages'], newer: ProducerChatView['messages']) {
  const rows = new Map(older.map(m => [m.id, m]));
  for (const m of newer) rows.set(m.id, m);
  return [...rows.values()];
}
function mergeFacts(older: ProducerWorkspace['facts'], newer?: ProducerChatView['facts']) {
  return [...new Map([...older, ...(newer ?? [])].map(f => [f.id, f])).values()];
}

export function DirectorConversation({ project, workspace, refresh, analysis }: { project: string; workspace: ProducerWorkspace; refresh: () => void; analysis: () => void }) {
  const [data, setData] = useState(workspace);
  const draftKey = `alba-producer-draft:${project}`;
  const [text, setText] = useState(() => { try { return localStorage.getItem(draftKey) ?? ''; } catch { return ''; } });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true), olderLoaded = useRef(false), loading = useRef(false);
  const running = data.messages.some(m => m.status === 'queued' || m.status === 'running');
  useEffect(() => { try { localStorage.setItem(draftKey, text); } catch { /* storage can be disabled */ } }, [draftKey, text]);
  useEffect(() => { setData(old => ({ ...workspace, facts: mergeFacts(old.facts, workspace.facts), messages: mergeMessages(old.messages, workspace.messages), nextCursor: olderLoaded.current ? old.nextCursor : workspace.nextCursor })); }, [workspace]);
  useLayoutEffect(() => { if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [data.messages]);
  useEffect(() => {
    const stream = new EventSource(`/api/producer/chat/stream?project=${encodeURIComponent(project)}`);
    stream.onmessage = event => {
      const next = JSON.parse(event.data) as ProducerChatView;
      setData(old => ({ ...old, ...next, session: next.session ?? old.session, facts: mergeFacts(old.facts, next.facts), messages: mergeMessages(old.messages, next.messages), nextCursor: olderLoaded.current ? old.nextCursor : next.nextCursor }));
      setError('');
    };
    stream.onerror = () => setError(t('Conversation connection interrupted; reconnecting…'));
    return () => stream.close();
  }, [project]);
  const loadOlder = async () => {
    if (!data.nextCursor || loading.current) return;
    loading.current = true; setLoadingOlder(true);
    const pane = scroller.current, height = pane?.scrollHeight ?? 0, top = pane?.scrollTop ?? 0;
    try {
      const page = await api.producerChat(project, data.nextCursor);
      olderLoaded.current = true; follow.current = false;
      setData(old => ({ ...old, facts: mergeFacts(old.facts, page.facts), messages: mergeMessages(page.messages, old.messages), nextCursor: page.nextCursor }));
      requestAnimationFrame(() => { if (pane) pane.scrollTop = top + pane.scrollHeight - height; });
    } catch (e) { setError(String(e)); } finally { loading.current = false; setLoadingOlder(false); }
  };
  const decide: Decide = async (kind, id, accept, edit) => {
    setBusy(true); setError('');
    try {
      if (kind === 'direction') await api.producerDirectionDecision(project, id, accept, edit?.reason);
      else await api.producerChatDecision(project, id, !accept, edit);
      const next = await api.producerWorkspace(project);
      setData(old => ({ ...next, facts: mergeFacts(old.facts, next.facts), messages: mergeMessages(old.messages, next.messages), nextCursor: olderLoaded.current ? old.nextCursor : next.nextCursor })); refresh();
      return true;
    } catch (e) { setError(String(e)); return false; } finally { setBusy(false); }
  };
  const send = async (value: string) => {
    if (!value.trim() || busy || running) return;
    setBusy(true); setError('');
    try { await api.producerChatSend(project, value); setText(''); follow.current = true; refresh(); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void send(text); };
  const facts = Object.fromEntries(data.facts.map(f => [f.id, `${f.value ?? t('unknown')} ${t(f.unit)}`]));
  const prompts = data.quickPrompts ?? [t('Full check'), t('Stalled runs'), t('What to dispatch next'), t('Brief')];
  return <div className="producer-workspace min-h-0 flex-1">
    <section className="producer-conversation flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border" aria-label={t('Director conversation')}>
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2"><h2 className="text-sm font-semibold">{t('Director conversation')}</h2><Badge tone={running ? 'primary' : 'neutral'}>{running ? t('running') : t('idle')}</Badge></div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-4" onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (el.scrollTop < 48) void loadOlder(); }}>
        {data.nextCursor && <Button size="sm" variant="ghost" className="mb-3 w-full" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? t('Loading…') : t('Older messages')}</Button>}
        {data.direction.version > 0 && <details className="mb-4 rounded border p-3 text-sm"><summary>{t('Standing direction')} · v{data.direction.version}</summary>{Object.values(data.direction).slice(2).map((v, i) => <p key={i}>{v}</p>)}</details>}
        <DirectorThread data={data} project={project} tagPattern={data.tagPattern} facts={facts} retry={value => void send(value)} />
      </div>
      <form onSubmit={submit} className="shrink-0 border-t bg-card p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">{prompts.map(prompt => <Button key={prompt} type="button" size="sm" variant="outline" onClick={() => setText(prompt)}>{prompt}</Button>)}</div>
        <label className="sr-only" htmlFor="director-message">{t('Message the producer')}</label>
        <textarea id="director-message" className="h-20 w-full resize-none rounded-md border bg-background p-3 text-sm" value={text} maxLength={16000} placeholder={t('Message the producer')} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(text); } }} />
        <div className="mt-2 flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{t('Enter to send · Shift+Enter for a new line')}</span><div className="flex gap-2">{running && <Button type="button" size="sm" variant="destructive" onClick={() => { void api.producerChatStop(project).then(refresh).catch(e => setError(String(e))); }}>{t('Stop')}</Button>}<Button type="submit" size="sm" disabled={busy || running || !text.trim()}>{t('Send')}</Button></div></div>
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      </form>
    </section>
    <ProducerRail project={project} data={data} busy={busy} decide={decide} analysis={analysis} pause={() => { void api.producerPause(project, !data.paused).then(refresh).catch(e => setError(String(e))); }} />
  </div>;
}
