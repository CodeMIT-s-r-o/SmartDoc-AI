import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import HistoryIcon from '@mui/icons-material/History';
import { IconButton, ListItemText, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import type { ConversationDto } from './api';

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(iso: string, now: number = Date.now()): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (Math.abs(minutes) < 60) {
    return relative.format(minutes, 'minute');
  }
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) {
    return relative.format(hours, 'hour');
  }
  return relative.format(Math.round(hours / 24), 'day');
}

export function HistoryMenu({
  conversations,
  currentId,
  onSelect,
  onDelete,
}: {
  conversations: ConversationDto[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (conversation: ConversationDto) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Tooltip title="Previous chats">
        <IconButton aria-label="Previous chats" onClick={(e) => setAnchor(e.currentTarget)}>
          <HistoryIcon />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 340, maxHeight: 420 } } }}
      >
        {conversations.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }}>
            No previous chats yet.
          </Typography>
        )}
        {conversations.map((c) => (
          <MenuItem
            key={c.id}
            selected={c.id === currentId}
            onClick={() => {
              setAnchor(null);
              onSelect(c.id);
            }}
            sx={{ gap: 1 }}
          >
            <ListItemText
              primary={c.title ?? 'Untitled chat'}
              secondary={timeAgo(c.updatedAt)}
              slotProps={{ primary: { noWrap: true } }}
              sx={{ minWidth: 0 }}
            />
            <IconButton
              size="small"
              edge="end"
              aria-label={`Delete ${c.title ?? 'chat'}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(c);
              }}
            >
              <DeleteOutlinedIcon fontSize="small" />
            </IconButton>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
