import SendIcon from '@mui/icons-material/Send';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import { Box, IconButton, TextField, Tooltip } from '@mui/material';
import { useState } from 'react';

export const MAX_QUESTION_CHARS = 2000;

export function Composer({
  disabled,
  running,
  onSend,
  onStop,
}: {
  disabled: boolean;
  running: boolean;
  onSend: (question: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const question = text.trim();
  const submit = () => {
    if (!question || running || disabled) {
      return;
    }
    onSend(question);
    setText('');
  };
  return (
    <Box
      component="form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      sx={{ p: 1.5, display: 'flex', gap: 1, alignItems: 'flex-end' }}
    >
      <TextField
        fullWidth
        multiline
        maxRows={6}
        size="small"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter adds a line; never while an IME is composing.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={
          disabled
            ? 'Upload a PDF to start asking questions'
            : 'Ask a question about your documents…'
        }
        helperText={
          text.length > MAX_QUESTION_CHARS - 200
            ? `${text.length} / ${MAX_QUESTION_CHARS}`
            : undefined
        }
        slotProps={{ htmlInput: { maxLength: MAX_QUESTION_CHARS, 'aria-label': 'Question' } }}
      />
      {running ? (
        <Tooltip title="Stop answering">
          <IconButton aria-label="Stop answering" color="primary" onClick={onStop}>
            <StopCircleIcon />
          </IconButton>
        </Tooltip>
      ) : (
        <Tooltip title="Send (Enter)">
          <span>
            <IconButton
              type="submit"
              aria-label="Send"
              color="primary"
              disabled={disabled || !question}
            >
              <SendIcon />
            </IconButton>
          </span>
        </Tooltip>
      )}
    </Box>
  );
}
