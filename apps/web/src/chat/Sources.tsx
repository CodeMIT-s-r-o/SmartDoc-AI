import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { Box, Button, Chip, Popover, Stack, Tooltip, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useState } from 'react';
import type { Citation } from './api';

export const pagesLabel = (s: Pick<Citation, 'pageStart' | 'pageEnd'>) =>
  s.pageStart === s.pageEnd ? `p. ${s.pageStart}` : `pp. ${s.pageStart}–${s.pageEnd}`;

type Anchor = { element: HTMLElement; source: Citation } | null;

/** Details of one source: where it is, what it says, and a link to that page of the PDF. */
export function SourcePopover({
  anchor,
  onClose,
  onOpen,
}: {
  anchor: Anchor;
  onClose: () => void;
  onOpen: (source: Citation) => void;
}) {
  const source = anchor?.source;
  return (
    <Popover
      open={anchor !== null}
      anchorEl={anchor?.element}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slotProps={{ paper: { sx: { maxWidth: 400, p: 2 } } }}
    >
      {source && (
        <>
          <Typography variant="overline" color="text.secondary">
            Source {source.n}
          </Typography>
          <Typography variant="subtitle2">{source.title}</Typography>
          <Typography variant="caption" color="text.secondary">
            {source.section ? `${source.section} · ` : ''}
            {pagesLabel(source)}
          </Typography>
          {source.snippet && (
            <Typography
              variant="body2"
              sx={{
                mt: 1,
                pl: 1.5,
                borderLeft: 3,
                borderColor: 'divider',
                color: 'text.secondary',
                whiteSpace: 'pre-line',
                display: '-webkit-box',
                WebkitLineClamp: 10,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {source.snippet}
            </Typography>
          )}
          <Box sx={{ mt: 1.5 }}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<OpenInNewIcon />}
              onClick={() => {
                onOpen(source);
                onClose();
              }}
            >
              Open PDF {pagesLabel({ pageStart: source.pageStart, pageEnd: source.pageStart })}
            </Button>
          </Box>
        </>
      )}
    </Popover>
  );
}

/** Inline marker for [n] in the answer text. */
export function CitationMarker({
  source,
  onSelect,
}: {
  source: Citation;
  onSelect: (element: HTMLElement, source: Citation) => void;
}) {
  return (
    <Tooltip title={`${source.title}, ${pagesLabel(source)}`}>
      <Box
        component="button"
        type="button"
        aria-label={`Source ${source.n}: ${source.title}, ${pagesLabel(source)}`}
        onClick={(e: React.MouseEvent<HTMLElement>) => onSelect(e.currentTarget, source)}
        sx={(theme) => ({
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 20,
          height: 18,
          px: 0.5,
          mx: 0.25,
          border: 0,
          borderRadius: 9,
          verticalAlign: 'text-top',
          font: 'inherit',
          fontSize: 11,
          fontWeight: 700,
          lineHeight: 1,
          cursor: 'pointer',
          color: 'primary.main',
          bgcolor: alpha(theme.palette.primary.main, 0.12),
          '&:hover, &:focus-visible': { bgcolor: alpha(theme.palette.primary.main, 0.24) },
        })}
      >
        {source.n}
      </Box>
    </Tooltip>
  );
}

/** The sources under an answer: cited ones first, the other retrieved passages on request. */
export function SourceList({
  citations,
  onSelect,
  expanded = false,
  label = 'Sources',
}: {
  citations: Citation[];
  onSelect: (element: HTMLElement, source: Citation) => void;
  expanded?: boolean;
  label?: string;
}) {
  const [showAll, setShowAll] = useState(expanded);
  const cited = citations.filter((c) => c.cited);
  const primary = cited.length > 0 ? cited : citations;
  const others = cited.length > 0 ? citations.filter((c) => !c.cited) : [];
  const shown = showAll ? [...primary, ...others] : primary;
  if (citations.length === 0) {
    return null;
  }
  return (
    <Box sx={{ mt: 1.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        {label}
      </Typography>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {shown.map((source) => (
          <Chip
            key={source.n}
            size="small"
            icon={<DescriptionOutlinedIcon />}
            variant="outlined"
            color={source.cited ? 'primary' : 'default'}
            label={`${source.n} · ${source.title} · ${pagesLabel(source)}`}
            onClick={(e) => onSelect(e.currentTarget, source)}
            sx={{ maxWidth: 300 }}
          />
        ))}
        {others.length > 0 && (
          <Chip
            size="small"
            variant="outlined"
            label={showAll ? 'Show fewer' : `+${others.length} more passages`}
            onClick={() => setShowAll((v) => !v)}
            sx={{ borderStyle: 'dashed' }}
          />
        )}
      </Stack>
    </Box>
  );
}

export type { Anchor as SourceAnchor };
