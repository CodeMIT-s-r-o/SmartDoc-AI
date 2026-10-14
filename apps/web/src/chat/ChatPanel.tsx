import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import {
  Alert,
  Box,
  Card,
  CardHeader,
  Divider,
  IconButton,
  Skeleton,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { openDocument } from '../documents/api';
import { type ConversationDto, deleteConversation, listConversations } from './api';
import { AssistantMessage } from './AssistantMessage';
import { BudgetBanner } from './BudgetBanner';
import { Composer } from './Composer';
import { HistoryMenu } from './HistoryMenu';
import { useChat } from './useChat';

/** Keep following new tokens only while the reader is at (or near) the bottom. */
const STICK_TO_BOTTOM_PX = 80;

function QuestionBubble({ text }: { text: string }) {
  return (
    <Box
      sx={{
        alignSelf: 'flex-end',
        maxWidth: '85%',
        px: 2,
        py: 1,
        borderRadius: 3,
        borderBottomRightRadius: 4,
        bgcolor: 'primary.main',
        color: 'primary.contrastText',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      }}
    >
      {text}
    </Box>
  );
}

function EmptyState({ readyDocuments }: { readyDocuments: number }) {
  return (
    <Stack
      spacing={1}
      sx={{ m: 'auto', alignItems: 'center', textAlign: 'center', color: 'text.secondary', px: 2 }}
    >
      <ForumOutlinedIcon sx={{ fontSize: 48 }} />
      <Typography color="text.primary">
        {readyDocuments > 0
          ? `Ask anything about your ${readyDocuments} ready document${readyDocuments === 1 ? '' : 's'}.`
          : 'Upload a PDF to get started.'}
      </Typography>
      {readyDocuments > 0 && (
        <Typography variant="body2">
          Answers cite the pages they come from. Click a number to see the passage.
        </Typography>
      )}
    </Stack>
  );
}

export function ChatPanel({
  accessToken,
  readyDocuments,
}: {
  accessToken: string;
  readyDocuments: number;
}) {
  const queryClient = useQueryClient();
  const chat = useChat(accessToken);
  const [notice, setNotice] = useState<string | null>(null);
  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: () => listConversations(accessToken),
  });
  const remove = useMutation({
    mutationFn: (c: ConversationDto) => deleteConversation(accessToken, c.id),
    onSuccess: (_, c) => {
      if (c.id === chat.conversationId) {
        chat.select(null);
      }
    },
    onError: () => setNotice('Could not delete the chat. Try again.'),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['conversations'] }),
  });

  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastText = chat.live?.text.length ?? 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chat.items.length, lastText, chat.live?.sources.length, chat.live?.running]);

  const title = chat.conversation.data?.conversation.title ?? 'New chat';
  const loading = chat.conversationId !== null && chat.conversation.isPending;
  const lastKey = chat.items.at(-1)?.key;

  return (
    <Card
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: { xs: '75dvh', md: 'calc(100dvh - 112px)' },
        minHeight: 480,
        position: { md: 'sticky' },
        top: { md: 88 },
      }}
    >
      <CardHeader
        title={title}
        subheader="Answers cite the pages they come from"
        slotProps={{ title: { noWrap: true } }}
        sx={{ '& .MuiCardHeader-content': { minWidth: 0 } }}
        action={
          <>
            <HistoryMenu
              conversations={conversations.data ?? []}
              currentId={chat.conversationId}
              onSelect={chat.select}
              onDelete={(c) => remove.mutate(c)}
            />
            <Tooltip title="New chat">
              <span>
                <IconButton
                  aria-label="New chat"
                  disabled={chat.conversationId === null && !chat.live}
                  onClick={() => chat.select(null)}
                >
                  <AddCommentOutlinedIcon />
                </IconButton>
              </span>
            </Tooltip>
          </>
        }
      />
      <Divider />
      <Box
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
        }}
        sx={{ flexGrow: 1, overflowY: 'auto', p: 2, display: 'flex', flexDirection: 'column' }}
      >
        {loading && (
          <Stack spacing={2}>
            <Skeleton variant="rounded" height={40} width="60%" sx={{ alignSelf: 'flex-end' }} />
            <Skeleton variant="rounded" height={96} />
          </Stack>
        )}
        {!loading && chat.items.length === 0 && <EmptyState readyDocuments={readyDocuments} />}
        <Stack spacing={2.5}>
          {chat.items.map((item) =>
            item.kind === 'question' ? (
              <QuestionBubble key={item.key} text={item.text} />
            ) : (
              <AssistantMessage
                key={item.key}
                answer={item.answer}
                // Retrying while the budget is used up would only be refused again.
                canRetry={item.key === lastKey && !chat.running && !chat.budget}
                onRetry={() => {
                  stick.current = true;
                  chat.retry(item.question);
                }}
                onOpenSource={(source) =>
                  void openDocument(accessToken, source.documentId, source.pageStart).catch(
                    (error: unknown) =>
                      setNotice(
                        error instanceof ApiError && error.status === 404
                          ? `“${source.title}” is no longer available.`
                          : `Could not open “${source.title}”. Try again in a minute.`,
                      ),
                  )
                }
                onRate={(messageId, feedback) =>
                  chat.rate.mutate(
                    { messageId, feedback },
                    { onError: () => setNotice('Could not save your rating. Try again.') },
                  )
                }
              />
            ),
          )}
        </Stack>
      </Box>
      <Divider />
      <BudgetBanner budget={chat.budget} />
      <Composer
        disabled={readyDocuments === 0}
        running={chat.running}
        onSend={(question) => {
          stick.current = true;
          void chat.send(question);
        }}
        onStop={chat.stop}
      />
      <Snackbar
        open={notice !== null}
        autoHideDuration={5000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {notice ? (
          <Alert severity="error" variant="filled" onClose={() => setNotice(null)}>
            {notice}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Card>
  );
}
