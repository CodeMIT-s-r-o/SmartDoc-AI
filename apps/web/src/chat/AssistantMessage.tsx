import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { Alert, Avatar, Box, Button, LinearProgress, Stack, Typography } from '@mui/material';
import type { FeedbackRequest } from '@smartdoc/contracts';
import { useState } from 'react';
import { AnswerFooter } from './AnswerFooter';
import type { Citation } from './api';
import { Markdown } from './Markdown';
import { CitationMarker, type SourceAnchor, SourceList, SourcePopover } from './Sources';
import type { AnswerView } from './view';

const PHASE_TEXT = {
  searching: 'Searching your documents…',
  reading: (n: number) => `Reading ${n} passage${n === 1 ? '' : 's'}…`,
};

export function AssistantMessage({
  answer,
  canRetry,
  onRetry,
  onOpenSource,
  onRate,
}: {
  answer: AnswerView;
  canRetry: boolean;
  onRetry: () => void;
  onOpenSource: (source: Citation) => void;
  onRate: (messageId: string, feedback: FeedbackRequest | null) => void;
}) {
  const [anchor, setAnchor] = useState<SourceAnchor>(null);
  const select = (element: HTMLElement, source: Citation) => setAnchor({ element, source });
  const byNumber = new Map(answer.citations.map((c) => [c.n, c]));
  const { status, phase } = answer;

  const body = answer.text && (
    <Markdown
      text={answer.text}
      renderCitation={(n) => {
        const source = byNumber.get(n);
        return source ? <CitationMarker source={source} onSelect={select} /> : `[${n}]`;
      }}
    />
  );

  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
      <Avatar sx={{ width: 28, height: 28, bgcolor: 'secondary.main', mt: 0.25 }}>
        <AutoAwesomeIcon sx={{ fontSize: 16 }} />
      </Avatar>
      <Box sx={{ minWidth: 0, flexGrow: 1 }} aria-live={status === 'streaming' ? 'polite' : 'off'}>
        {(phase === 'searching' || phase === 'reading') && (
          <Box sx={{ maxWidth: 280, pt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              {phase === 'searching'
                ? PHASE_TEXT.searching
                : PHASE_TEXT.reading(answer.citations.length)}
            </Typography>
            <LinearProgress sx={{ mt: 1, borderRadius: 1 }} />
          </Box>
        )}

        {(status === 'complete' || status === 'cached' || status === 'streaming') && body && (
          <Box
            sx={
              phase === 'writing'
                ? {
                    '& > div > :last-child::after': {
                      content: '"▍"',
                      ml: 0.25,
                      color: 'primary.main',
                      animation: 'blink 1s steps(2) infinite',
                    },
                    '@keyframes blink': { '50%': { opacity: 0 } },
                  }
                : undefined
            }
          >
            {body}
          </Box>
        )}

        {status === 'no_answer' && (
          <Alert severity="info" variant="outlined">
            {body || 'I could not find this in your documents.'}
          </Alert>
        )}

        {status === 'degraded' && (
          <>
            <Alert severity="warning" variant="outlined">
              The AI answer is temporarily unavailable. These are the closest passages in your
              documents.
            </Alert>
            <SourceList
              citations={answer.citations}
              onSelect={select}
              expanded
              label="Closest passages"
            />
          </>
        )}

        {status === 'aborted' && (
          <>
            {body}
            <Typography variant="caption" color="text.secondary" sx={{ fontStyle: 'italic' }}>
              Stopped
            </Typography>
          </>
        )}

        {status === 'error' && (
          <>
            {body}
            <Alert
              severity="error"
              variant="outlined"
              sx={{ mt: body ? 1 : 0 }}
              action={
                canRetry ? (
                  <Button color="inherit" size="small" onClick={onRetry}>
                    Retry
                  </Button>
                ) : undefined
              }
            >
              {answer.error}
            </Alert>
          </>
        )}

        {(status === 'complete' || status === 'cached') && phase === null && (
          <SourceList citations={answer.citations} onSelect={select} />
        )}
        {status === 'no_answer' && answer.citations.length > 0 && (
          <SourceList citations={answer.citations} onSelect={select} label="Closest passages" />
        )}

        {phase === null && <AnswerFooter answer={answer} onRate={onRate} />}
      </Box>
      <SourcePopover anchor={anchor} onClose={() => setAnchor(null)} onOpen={onOpenSource} />
    </Stack>
  );
}
