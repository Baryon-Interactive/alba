import type { ProducerSession } from '@api';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Empty, Section } from '@/components/common';
import { dateTime } from '@/lib/format';
import { t } from '@/i18n';
import { ProducerMessage } from './ProducerMessage';

export function ProducerConversation({ turns = [] }: { turns?: ProducerSession['turns'] }) {
  return <Section title={t('Session conversation')} count={turns.length}>
    {turns.length ? <ol className="grid gap-4" aria-label={t('Session conversation')}>
      {turns.map(turn => <li key={turn.number} className="min-w-0">
        <div className="mb-1.5 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>{t('Turn {number}', { number: turn.number })} · {dateTime(turn.at)}</span>
          <span>{t('{count} tokens', { count: turn.usage.total_tokens })}</span>
        </div>
        <div className="ml-auto max-w-[95%] rounded-lg border bg-muted/50 p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">{t('Sent to session')}</div>
          <div className="flex flex-wrap gap-1.5">
            {turn.sent.cards?.map(card => <Badge key={card.key} tone="outline" title={card.key}>{card.key} · {card.trigger} · r{card.revision}</Badge>)}
          </div>
          {turn.sent.note && <p className="whitespace-pre-wrap break-words text-sm">{turn.sent.note}</p>}
        </div>
        <Card className="mr-auto mt-2 max-w-[95%] p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">{t('Producer reply')}</div>
          <ProducerMessage answer={turn.answer} tools={turn.tools} narration={turn.narration} />
          {turn.error && <p className="mt-2 break-words text-sm text-destructive">{turn.error}</p>}
        </Card>
      </li>)}
    </ol> : <Empty>{t('No session turns yet.')}</Empty>}
  </Section>;
}
