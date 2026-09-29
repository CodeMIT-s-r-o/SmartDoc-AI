import BoltIcon from '@mui/icons-material/Bolt';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import ThumbDownOutlinedIcon from '@mui/icons-material/ThumbDownOutlined';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbUpOutlinedIcon from '@mui/icons-material/ThumbUpOutlined';
import {
  Box,
  Button,
  Chip,
  IconButton,
  Popover,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { FEEDBACK_REASONS, type FeedbackReason, type FeedbackRequest } from '@smartdoc/contracts';
import { useState } from 'react';
import { type AnswerView, RATEABLE } from './view';

export const formatUsd = (value: number) =>
  value === 0 ? '$0' : `$${value < 0.001 ? value.toFixed(5) : value.toFixed(4)}`;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const REASON_LABELS: Record<FeedbackReason, string> = {
  incorrect: 'Incorrect',
  not_in_documents: 'Not in my documents',
  wrong_citation: 'Wrong citation',
  incomplete: 'Incomplete',
  other: 'Other',
};

function CostBadge({ answer }: { answer: AnswerView }) {
  const { costUsd, latencyMs, usage } = answer;
  if (answer.status === 'cached') {
    return <Chip size="small" variant="outlined" icon={<BoltIcon />} label="Cached · $0" />;
  }
  if (costUsd === null && !latencyMs?.total) {
    return null;
  }
  const lines = [
    costUsd !== null && `Cost of this answer: ${formatUsd(costUsd)} (question embedding + model)`,
    usage &&
      `Tokens: ${usage.input.toLocaleString()} in (${usage.cached.toLocaleString()} from the prompt cache), ${usage.output.toLocaleString()} out`,
    latencyMs?.ttft != null && `First token after ${seconds(latencyMs.ttft)}`,
    latencyMs?.total != null && `Finished after ${seconds(latencyMs.total)}`,
  ].filter(Boolean);
  const label = [
    costUsd !== null && formatUsd(costUsd),
    latencyMs?.total != null && seconds(latencyMs.total),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Tooltip title={<Box sx={{ whiteSpace: 'pre-line' }}>{lines.join('\n')}</Box>}>
      <Chip size="small" variant="outlined" label={label} aria-label={`Answer cost ${label}`} />
    </Tooltip>
  );
}

/** Asks what was wrong after a thumbs-down; the rating itself is already saved. */
function ReasonsPopover({
  anchor,
  onClose,
  onSubmit,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  onSubmit: (feedback: FeedbackRequest) => void;
}) {
  const [reasons, setReasons] = useState<FeedbackReason[]>([]);
  const [comment, setComment] = useState('');
  const toggle = (reason: FeedbackReason) =>
    setReasons((current) =>
      current.includes(reason) ? current.filter((r) => r !== reason) : [...current, reason],
    );
  return (
    <Popover
      open={anchor !== null}
      anchorEl={anchor}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { p: 2, width: 320 } } }}
    >
      <Typography variant="subtitle2" gutterBottom>
        What went wrong?
      </Typography>
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', mb: 1.5 }}>
        {FEEDBACK_REASONS.map((reason) => (
          <Chip
            key={reason}
            size="small"
            label={REASON_LABELS[reason]}
            color={reasons.includes(reason) ? 'primary' : 'default'}
            variant={reasons.includes(reason) ? 'filled' : 'outlined'}
            onClick={() => toggle(reason)}
            aria-pressed={reasons.includes(reason)}
          />
        ))}
      </Stack>
      <TextField
        fullWidth
        multiline
        minRows={2}
        size="small"
        placeholder="Optional: what should the answer have said?"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        slotProps={{ htmlInput: { maxLength: 1000, 'aria-label': 'Feedback comment' } }}
      />
      <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end', mt: 1.5 }}>
        <Button size="small" onClick={onClose}>
          Skip
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={reasons.length === 0 && !comment.trim()}
          onClick={() => {
            onSubmit({ rating: -1, reasons, comment: comment.trim() || undefined });
            onClose();
          }}
        >
          Send
        </Button>
      </Stack>
    </Popover>
  );
}

export function AnswerFooter({
  answer,
  onRate,
}: {
  answer: AnswerView;
  onRate: (messageId: string, feedback: FeedbackRequest | null) => void;
}) {
  const [reasonsAnchor, setReasonsAnchor] = useState<HTMLElement | null>(null);
  const { messageId, rating } = answer;
  const canRate = messageId !== null && RATEABLE.has(answer.status) && answer.phase === null;

  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 1, minHeight: 32 }}>
      <CostBadge answer={answer} />
      <Box sx={{ flexGrow: 1 }} />
      {canRate && (
        <>
          <Tooltip title={rating === 1 ? 'Remove rating' : 'Good answer'}>
            <IconButton
              size="small"
              aria-label="Good answer"
              aria-pressed={rating === 1}
              onClick={() => onRate(messageId, rating === 1 ? null : { rating: 1 })}
            >
              {rating === 1 ? (
                <ThumbUpIcon fontSize="small" color="primary" />
              ) : (
                <ThumbUpOutlinedIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
          <Tooltip title={rating === -1 ? 'Remove rating' : 'Bad answer'}>
            <IconButton
              size="small"
              aria-label="Bad answer"
              aria-pressed={rating === -1}
              onClick={(e) => {
                if (rating === -1) {
                  onRate(messageId, null);
                  return;
                }
                onRate(messageId, { rating: -1 });
                setReasonsAnchor(e.currentTarget);
              }}
            >
              {rating === -1 ? (
                <ThumbDownIcon fontSize="small" color="error" />
              ) : (
                <ThumbDownOutlinedIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
          {reasonsAnchor && (
            <ReasonsPopover
              anchor={reasonsAnchor}
              onClose={() => setReasonsAnchor(null)}
              onSubmit={(feedback) => onRate(messageId, feedback)}
            />
          )}
        </>
      )}
    </Stack>
  );
}
