import { useEffect } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { DocBody } from '@/components/DocBody';
import { Skeleton } from '@/components/ui/misc';
import { Empty, ErrorBox, PageHeader } from '@/components/common';
import { useDoc, useProjectId } from '@/lib/queries';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

/** One document: a sticky table of contents, and the Markdown with its links rewritten. */
export function DocumentReaderPage() {
  const project = useProjectId();
  const [params] = useSearchParams();
  const location = useLocation();
  const path = params.get('path') ?? '';
  const doc = useDoc(project, path);

  useEffect(() => {
    if (!doc.data) return;
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (!raw) { window.scrollTo(0, 0); return; }
    let id = raw;
    try { id = decodeURIComponent(raw); } catch { /* keep the raw hash */ }
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  }, [doc.data, location.hash, path]);

  if (!path) return <Empty>{t('Open a document from the list.')}</Empty>;
  if (doc.isError) return <ErrorBox error={doc.error} />;
  if (!doc.data) return <div className="grid gap-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-64" /></div>;

  const headings = doc.data.headings;
  return (
    <div>
      <Link to={`/p/${encodeURIComponent(project)}/docs`} className="text-sm text-primary hover:underline">{t('Back to documents')}</Link>
      <PageHeader title={doc.data.title}><span className="font-mono text-xs">{doc.data.path}</span></PageHeader>
      <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start lg:gap-8">
        {headings.length > 0 && (
          <nav aria-label={t('Contents')} className="mb-4 lg:sticky lg:top-3 lg:mb-0 lg:max-h-[calc(100vh-1.5rem)] lg:overflow-y-auto">
            <div className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{t('Contents')}</div>
            {headings.map(h => (
              <a key={h.slug} href={`#${h.slug}`} className={cn('block truncate py-0.5 text-sm hover:underline', h.level === 2 && 'pl-3', h.level === 3 && 'pl-6')}>{h.text}</a>
            ))}
          </nav>
        )}
        <article className="min-w-0">
          <DocBody project={project} path={doc.data.path} markdown={doc.data.markdown} headings={headings} />
        </article>
      </div>
    </div>
  );
}
