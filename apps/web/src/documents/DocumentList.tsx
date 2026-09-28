import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import {
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Stack,
  Tooltip,
} from '@mui/material';
import { type DocumentDto, failureMessage, isInterruptedUpload } from './api';
import { StatusChip } from './StatusChip';

const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

export const formatSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function details(doc: DocumentDto): string {
  if (doc.status === 'failed') {
    return failureMessage(doc.errorCode);
  }
  if (isInterruptedUpload(doc)) {
    return 'Upload interrupted. Delete it and upload the file again.';
  }
  const parts = [formatSize(doc.sizeBytes)];
  if (doc.pageCount !== null) {
    parts.unshift(`${doc.pageCount} pages`);
  }
  parts.push(dateFormat.format(new Date(doc.createdAt)));
  return parts.join(' · ');
}

export function DocumentList({
  documents,
  onOpen,
  onDelete,
}: {
  documents: DocumentDto[];
  onOpen: (doc: DocumentDto) => void;
  onDelete: (doc: DocumentDto) => void;
}) {
  return (
    <List disablePadding>
      {documents.map((doc) => (
        <ListItem
          key={doc.id}
          divider
          secondaryAction={
            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <StatusChip doc={doc} />
              {doc.status === 'ready' && (
                <Tooltip title="Open PDF">
                  <IconButton aria-label={`Open ${doc.title}`} onClick={() => onOpen(doc)}>
                    <OpenInNewIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip title="Delete">
                <IconButton aria-label={`Delete ${doc.title}`} onClick={() => onDelete(doc)}>
                  <DeleteOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          }
          sx={{ pr: 22 }}
        >
          <ListItemIcon sx={{ minWidth: 40 }}>
            <PictureAsPdfIcon color={doc.status === 'failed' ? 'disabled' : 'error'} />
          </ListItemIcon>
          <ListItemText
            primary={doc.title}
            secondary={details(doc)}
            slotProps={{
              primary: { noWrap: true, title: doc.originalFilename },
              secondary: { noWrap: true },
            }}
          />
        </ListItem>
      ))}
    </List>
  );
}
