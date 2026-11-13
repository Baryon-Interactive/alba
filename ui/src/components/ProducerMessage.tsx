import type { ProducerSession } from '@api';
import { DocBody } from './DocBody';
import { t } from '@/i18n';

export function ProducerMessage({ answer, tools = [], narration = [], running, project = '', tagPattern = '[A-Za-z]+\\d+[A-Za-z]*', facts }: {
  answer: string; tools?: ProducerSession['turns'][number]['tools']; narration?: string[]; running?: boolean;
  project?: string; tagPattern?: string; facts?: Record<string, string>;
}) {
  const last = tools.at(-1);
  return <>
    {running && last && <p role="status" className="mb-2 truncate text-xs text-muted-foreground">{t('Working')}: {last.name} {last.input}</p>}
    {(tools.length > 0 || narration.length > 0) && <details className="mb-3 rounded-md border bg-muted/30 p-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">{t('Steps ({count} tool calls)', { count: tools.length })}</summary>
      {narration.map((text, i) => <p key={i} className="mt-2 whitespace-pre-wrap">{text}</p>)}
      <ol className="mt-2 grid gap-2">{tools.map(tool => <li key={tool.id} className="break-words font-mono"><strong>{tool.name}</strong> {tool.input} → {tool.error ? `${t('Tool error')}: ${tool.error.slice(0, 500)}` : tool.result?.slice(0, 500) ?? t('Tool running…')}</li>)}</ol>
    </details>}
    {answer ? <DocBody project={project} path="" markdown={answer} headings={[]} tagPattern={tagPattern} facts={facts} /> : <p className="text-sm text-muted-foreground">{t('Waiting for the session reply…')}</p>}
  </>;
}
