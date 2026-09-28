import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';
import type { DocumentDto } from './api';

export function ConfirmDeleteDialog({
  doc,
  onCancel,
  onConfirm,
}: {
  doc: DocumentDto | null;
  onCancel: () => void;
  onConfirm: (doc: DocumentDto) => void;
}) {
  const inFlight = doc && ['uploading', 'queued', 'processing'].includes(doc.status);
  return (
    <Dialog open={doc !== null} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>Delete “{doc?.title}”?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {inFlight
            ? 'Processing stops, and the file and everything built from it are removed.'
            : 'The file and its search index are removed. Past answers keep the title and page numbers of their sources, but no text from it.'}{' '}
          This cannot be undone.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button color="error" variant="contained" onClick={() => doc && onConfirm(doc)}>
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}
