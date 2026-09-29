import { Box, Link } from '@mui/material';
import { createContext, type ReactNode, useContext } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { CITATION_HREF, remarkCitations, safeUrl } from './citations';

const CitationRenderer = createContext<(n: number) => ReactNode>((n) => `[${n}]`);

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const renderCitation = useContext(CitationRenderer);
  const citation = href ? CITATION_HREF.exec(href) : null;
  if (citation) {
    return renderCitation(Number(citation[1]));
  }
  if (!href) {
    return <span>{children}</span>; // a link the allowlist removed: keep the text only
  }
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </Link>
  );
}

// Module-level, so element types stay stable across renders (a new `a` component on every
// render would remount the citation markers and detach any popover anchored to one).
const COMPONENTS: Components = { a: MarkdownLink };
const REMARK_PLUGINS = [remarkCitations];

/**
 * Model output is untrusted: no raw HTML, no images (no exfiltration via image URLs), and links
 * only to our own origin. Citation markers render through `renderCitation`.
 */
export function Markdown({
  text,
  renderCitation,
}: {
  text: string;
  renderCitation: (n: number) => ReactNode;
}) {
  return (
    <Box
      sx={{
        '& > :first-of-type': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& p': { my: 1 },
        '& ul, & ol': { my: 1, pl: 3 },
        '& code': {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '0.875em',
          bgcolor: 'action.hover',
          px: 0.5,
          borderRadius: 0.5,
        },
      }}
    >
      <CitationRenderer.Provider value={renderCitation}>
        <ReactMarkdown
          skipHtml
          remarkPlugins={REMARK_PLUGINS}
          urlTransform={safeUrl}
          disallowedElements={['img']}
          components={COMPONENTS}
        >
          {text}
        </ReactMarkdown>
      </CitationRenderer.Provider>
    </Box>
  );
}
