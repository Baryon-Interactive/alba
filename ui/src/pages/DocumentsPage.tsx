import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Files, Search } from 'lucide-react';
import type { DocEntry } from '@api';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Empty, EmptyState, ErrorBox, PageHeader, Section } from '@/components/common';
import { docReaderTo, splitSnippet } from '@/lib/docs';
import { ago } from '@/lib/format';
import { useDocs, useDocSearch, useProjectId } from '@/lib/queries';
import { t } from '@/i18n';

const EXAMPLE = `docs:
  files: ["docs/gdd.md", "docs/**/*.md"]
  research: "docs/research"`;

function DocCard({ project, doc }: { project: string; doc: DocEntry }) {
  const body = (
    <>
      <div className="font-medium">{doc.title}</div>
      <div className="mt-1 font-mono text-xs break-all text-muted-foreground">{doc.path}</div>
      <div className="mt-1 text-xs text-muted-foreground">{doc.exists ? (doc.modified ? ago(doc.modified) : '') : t('Not written yet')}</div>
    </>
  );
  if (!doc.exists) return <Card className="h-full p-4 opacity-60">{body}</Card>;
  return <Link to={docReaderTo(project, doc.path)} className="block h-full"><Card className="h-full p-4 transition-colors hover:bg-accent/50">{body}</Card></Link>;
}

function DocGroup({ project, title, items }: { project: string; title: string; items: DocEntry[] }) {
  if (items.length === 0) return null;
  return (
    <Section title={title} count={items.length}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map(doc => <DocCard key={doc.path} project={project} doc={doc} />)}
      </div>
    </Section>
  );
}

/** The project's Markdown: a card for each listed file, and a search that opens the reader at the heading. */
export function DocumentsPage() {
  const project = useProjectId();
  const list = useDocs(project);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) { setQ(''); return; }
    const id = window.setTimeout(() => setQ(trimmed), 250);
    return () => window.clearTimeout(id);
  }, [query]);
  const tooLong = q.length >= 200;
  const search = useDocSearch(project, tooLong ? '' : q);

  if (list.isError) return <ErrorBox error={list.error} />;
  if (!list.data) return <div className="grid gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-40" /></div>;

  const items = list.data.items;
  return (
    <div>
      <PageHeader title={t('Documents')} count={list.data.enabled ? items.length : undefined} />
      {!list.data.enabled ? (
        <EmptyState icon={<Files />} title={t('Documents are off')}>
          <p>{t('Documents are off. Add a docs section to the project file (docs.files, and optionally docs.research).')}</p>
          <pre className="mt-4 rounded-lg bg-muted px-4 py-3 text-left font-mono text-xs whitespace-pre-wrap text-foreground">{EXAMPLE}</pre>
        </EmptyState>
      ) : (
        <>
          <div className="relative mb-4 max-w-md">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
            <Input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Search documents')} aria-label={t('Search documents')} className="pl-8" />
          </div>
          {q && (
            <div className="mb-5 grid gap-2">
              {tooLong ? <p className="text-sm text-destructive">{t('A search of 200 characters or more is refused.')}</p>
                : search.isError ? <ErrorBox error={search.error} />
                  : search.isPending ? <Skeleton className="h-16" />
                    : search.data && search.data.items.length === 0 ? <Empty>{t('No document matches.')}</Empty>
                      : search.data?.items.map(hit => (
                        <Link key={`${hit.path}:${hit.line}:${hit.snippet}`} to={docReaderTo(project, hit.path, hit.heading.slug)} className="block">
                          <Card className="p-3 transition-colors hover:bg-accent/50">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span className="font-medium">{hit.title}</span>
                              {hit.heading.text && hit.heading.slug && <span className="text-sm text-muted-foreground">{hit.heading.text}</span>}
                              <span className="font-mono text-xs break-all text-muted-foreground">{hit.path}</span>
                              <span className="text-xs text-muted-foreground">{t('Line {n}', { n: hit.line })}</span>
                            </div>
                            <p className="doc-hit mt-1 text-sm">
                              {splitSnippet(hit.snippet).map((part, i) => part.mark ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>)}
                            </p>
                          </Card>
                        </Link>
                      ))}
            </div>
          )}
          {items.length === 0 ? <Empty>{t('No documents are listed.')}</Empty> : (
            <>
              <DocGroup project={project} title={t('Documents')} items={items.filter(d => d.group === 'docs')} />
              <DocGroup project={project} title={t('Research')} items={items.filter(d => d.group === 'research')} />
            </>
          )}
        </>
      )}
    </div>
  );
}
