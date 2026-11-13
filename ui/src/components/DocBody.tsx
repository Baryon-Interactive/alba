import type { ReactNode } from 'react';
import { Link } from 'react-router';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { DocHeading } from '@api';
import { classifyDocHref, docFileUrl, docReaderTo, isVideoPath } from '@/lib/docs';

const keepUrl = (url: string) => url;

function Heading({ level, id, children }: { level: 1 | 2 | 3; id?: string; children?: ReactNode }) {
  const Tag = `h${level}` as 'h1' | 'h2' | 'h3';
  return <Tag id={id} className="scroll-mt-4">{children}</Tag>;
}

function DocAnchor({ project, from, href, children, facts }: { project: string; from: string; href?: string; children?: ReactNode; facts?: Record<string, string> }) {
  if (href?.startsWith('alba-order:')) return <Link to={`/p/${encodeURIComponent(project)}/orders/${encodeURIComponent(href.slice('alba-order:'.length))}`}>{children}</Link>;
  if (href?.startsWith('alba-fact:')) return <a href={`#${encodeURIComponent(href.slice('alba-fact:'.length))}`} title={facts?.[href.slice('alba-fact:'.length)] ?? href.slice('alba-fact:'.length)}>{children}</a>;
  const link = classifyDocHref(from, href);
  if (link.kind === 'external') return <a href={link.href} target="_blank" rel="noreferrer">{children}</a>;
  if (link.kind === 'hash') return <a href={`#${link.id}`}>{children}</a>;
  if (link.kind === 'doc') return <Link to={docReaderTo(project, link.path, link.hash)}>{children}</Link>;
  if (link.kind === 'file') return <a href={docFileUrl(project, link.path)}>{children}</a>;
  return <span>{children}</span>;
}

function DocImage({ project, from, src, alt }: { project: string; from: string; src?: string; alt?: string }) {
  const link = classifyDocHref(from, src);
  if (link.kind === 'file' && isVideoPath(link.path)) return <video src={docFileUrl(project, link.path)} controls preload="metadata" />;
  if (link.kind === 'file') return <img src={docFileUrl(project, link.path)} alt={alt ?? ''} />;
  return <span>{alt || (link.kind === 'external' ? link.href : '')}</span>;
}

/**
 * GitHub-flavoured Markdown for one document.
 * Heading ids are the API slugs, in order, so the table of contents and a search hit land on the same anchor.
 * Raw HTML is not rendered: the renderer turns those nodes into text, and React escapes the text.
 * `urlTransform` is the identity so a `javascript:` or `mailto:` href is still visible to the classifier, which then drops it.
 */
type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };
/** Link prose only: never rewrite code, existing links, HTML or Markdown syntax. */
function mentions(tagPattern: string) {
  return () => (tree: MdNode) => {
    const pattern = new RegExp(`F:[\\w%./:-]*[\\w%/-]|(?<![\\w])(?:${tagPattern})(?![\\w])`, 'g');
    const walk = (node: MdNode) => {
      if (['link', 'code', 'inlineCode', 'html'].includes(node.type) || !node.children) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { walk(child); return [child]; }
        const parts: MdNode[] = []; let start = 0;
        for (const match of child.value.matchAll(pattern)) {
          parts.push({ type: 'text', value: child.value.slice(start, match.index) });
          parts.push({ type: 'link', url: `${match[0].startsWith('F:') ? 'alba-fact:' : 'alba-order:'}${match[0]}`, children: [{ type: 'text', value: match[0] }] });
          start = match.index + match[0].length;
        }
        parts.push({ type: 'text', value: child.value.slice(start) }); return parts;
      });
    }; walk(tree);
  };
}
export function DocBody({ project, path, markdown, headings, tagPattern, facts }: { project: string; path: string; markdown: string; headings: DocHeading[]; tagPattern?: string; facts?: Record<string, string> }) {
  let n = 0;
  const take = (level: 1 | 2 | 3): string | undefined => {
    const heading = headings[n];
    if (!heading || heading.level !== level) return undefined;
    n += 1;
    return heading.slug;
  };
  const components: Components = {
    a: ({ href, children }) => <DocAnchor project={project} from={path} href={href} facts={facts}>{children}</DocAnchor>,
    img: ({ src, alt }) => <DocImage project={project} from={path} src={typeof src === 'string' ? src : undefined} alt={alt} />,
    h1: ({ children }) => <Heading level={1} id={take(1)}>{children}</Heading>,
    h2: ({ children }) => <Heading level={2} id={take(2)}>{children}</Heading>,
    h3: ({ children }) => <Heading level={3} id={take(3)}>{children}</Heading>,
  };
  return (
    <div className="doc-body">
      <Markdown remarkPlugins={tagPattern ? [remarkGfm, mentions(tagPattern)] : [remarkGfm]} urlTransform={keepUrl} disallowedElements={['script', 'style', 'iframe', 'object', 'embed']} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
}
