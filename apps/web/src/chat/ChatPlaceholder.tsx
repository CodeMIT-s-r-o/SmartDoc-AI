import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import SendIcon from '@mui/icons-material/Send';
import {
  Box,
  Card,
  CardContent,
  CardHeader,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

/** Layout slot for the chat (built in the next step), so the page already has its final shape. */
export function ChatPlaceholder({ readyDocuments }: { readyDocuments: number }) {
  return (
    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardHeader title="Ask your documents" subheader="Answers cite the pages they come from" />
      <CardContent sx={{ flexGrow: 1, display: 'grid', placeItems: 'center' }}>
        <Stack
          spacing={1}
          sx={{ alignItems: 'center', textAlign: 'center', color: 'text.secondary' }}
        >
          <ForumOutlinedIcon sx={{ fontSize: 48 }} />
          <Typography>
            {readyDocuments > 0
              ? `Chat over your ${readyDocuments} ready document${readyDocuments === 1 ? '' : 's'} is coming soon.`
              : 'Upload a PDF to get started.'}
          </Typography>
        </Stack>
      </CardContent>
      <Box sx={{ p: 2, pt: 0, display: 'flex', gap: 1 }}>
        <TextField fullWidth size="small" placeholder="Ask a question…" disabled />
        <IconButton aria-label="Send" disabled>
          <SendIcon />
        </IconButton>
      </Box>
    </Card>
  );
}
