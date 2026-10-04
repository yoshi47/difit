import { useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Mirror the diff viewer's link safety: never render javascript:/data: URLs.
const isSafeUrl = (url: string) => /^(https?:|mailto:|#|\.{0,2}\/|\/)/i.test(url.trim());

// Compact markdown styling tuned for a banner (smaller headings, tight spacing)
// rather than the full-page document styling used by the markdown diff viewer.
const markdownComponents = {
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className="text-base font-semibold mt-3 mb-1 first:mt-0 text-github-text-primary">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="text-sm font-semibold uppercase tracking-wide mt-3 mb-1 text-github-text-secondary">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="text-sm font-semibold mt-2 mb-1 text-github-text-secondary">{children}</h3>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="text-sm leading-6 my-1 text-github-text-primary">{children}</p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="list-disc pl-5 text-sm space-y-0.5 my-1 text-github-text-primary">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="list-decimal pl-5 text-sm space-y-0.5 my-1 text-github-text-primary">
      {children}
    </ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li>{children}</li>,
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold text-github-text-primary">{children}</strong>
  ),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    const safeHref = href ?? '';
    if (!safeHref || !isSafeUrl(safeHref)) {
      return <span>{children}</span>;
    }
    return (
      <a
        href={safeHref}
        target={safeHref.startsWith('http') ? '_blank' : undefined}
        rel={safeHref.startsWith('http') ? 'noreferrer' : undefined}
        className="text-sky-400 hover:text-sky-300 underline underline-offset-4"
      >
        {children}
      </a>
    );
  },
  code: ({ children }: { children?: ReactNode }) => (
    <code className="px-1 py-0.5 rounded bg-github-bg-tertiary border border-github-border text-xs font-mono">
      {children}
    </code>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="px-2 py-1 text-left font-semibold border border-github-border">{children}</th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="px-2 py-1 border border-github-border align-top">{children}</td>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="border-l-4 border-github-border pl-3 text-github-text-muted italic">
      {children}
    </blockquote>
  ),
};

// Pull the first markdown heading as a one-line summary for the collapsed bar.
const deriveTitle = (markdown: string): string | null => {
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue; // a `#` line inside a code fence is not a real heading
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line.trim())?.[1];
    if (heading) {
      return heading.replace(/[*_`]/g, '').trim();
    }
  }
  return null;
};

interface PrOverviewBannerProps {
  markdown: string;
}

/**
 * Collapsible "PR Overview" banner shown above the diff. Surfaces the
 * AI-gathered PR intent (from `--overview`) so the reviewer sees what the PR is
 * trying to do — and what was already reviewed — before reading any code.
 */
export function PrOverviewBanner({ markdown }: PrOverviewBannerProps) {
  const [isOpen, setIsOpen] = useState(true);
  const trimmed = markdown.trim();
  const title = useMemo(() => deriveTitle(trimmed), [trimmed]);

  if (!trimmed) {
    return null;
  }

  return (
    <section className="bg-github-bg-secondary border-b border-github-border shrink-0">
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        aria-expanded={isOpen}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-github-bg-tertiary transition-colors"
      >
        <span className="text-github-text-muted text-xs">{isOpen ? '▼' : '▶'}</span>
        <span className="text-xs font-semibold uppercase tracking-wide text-github-text-secondary">
          PR Overview
        </span>
        {!isOpen && title && (
          <span className="text-xs text-github-text-muted truncate">{title}</span>
        )}
      </button>
      {isOpen && (
        <div className="px-4 pb-3 max-h-[40vh] overflow-y-auto">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(url) => (isSafeUrl(url) ? url : '')}
            components={markdownComponents}
          >
            {trimmed}
          </ReactMarkdown>
        </div>
      )}
    </section>
  );
}
