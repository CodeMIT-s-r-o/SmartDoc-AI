import type { Parent, PhrasingContent, Root, RootContent, Text } from 'mdast';

/** The model's citation markers: [1] or [1, 3] (the same pattern the AI service parses). */
const MARKER = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
export const CITATION_HREF = /^#cite-(\d+)$/;

function split(node: Text): PhrasingContent[] {
  const parts: PhrasingContent[] = [];
  let last = 0;
  for (const match of node.value.matchAll(MARKER)) {
    if (match.index > last) {
      parts.push({ type: 'text', value: node.value.slice(last, match.index) });
    }
    for (const n of match[1]!.split(',')) {
      parts.push({
        type: 'link',
        url: `#cite-${n.trim()}`,
        children: [{ type: 'text', value: n.trim() }],
      });
    }
    last = match.index + match[0].length;
  }
  if (last === 0) {
    return [node];
  }
  if (last < node.value.length) {
    parts.push({ type: 'text', value: node.value.slice(last) });
  }
  return parts;
}

function visit(node: Parent): void {
  node.children = node.children.flatMap((child: RootContent): RootContent[] => {
    if (child.type === 'text') {
      return split(child);
    }
    // Code keeps its brackets; existing links keep their text.
    if ('children' in child && child.type !== 'link' && child.type !== 'linkReference') {
      visit(child);
    }
    return [child];
  }) as Parent['children'];
}

/** Remark plugin: citation markers become `#cite-N` links, rendered as chips. */
export function remarkCitations() {
  return (tree: Root) => visit(tree);
}

/** Links are allowed only to our own origin; everything else loses its href. */
export function safeUrl(url: string): string | undefined {
  if (CITATION_HREF.test(url)) {
    return url;
  }
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
