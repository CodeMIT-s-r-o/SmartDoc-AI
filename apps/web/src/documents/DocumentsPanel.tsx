import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import {
  Alert,
  Box,
  Button,
  Card,
  CardHeader,
  LinearProgress,
  Skeleton,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import { type UseQueryResult, useMutation, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, type DragEvent, useRef, useState } from 'react';
import {
  deleteDocument,
  type DocumentDto,
  MAX_UPLOAD_BYTES,
  openDocument,
  uploadDocument,
  uploadErrorMessage,
} from './api';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { DocumentList } from './DocumentList';

interface UploadProgress {
  key: string;
  name: string;
  fraction: number;
}

type Notice = { severity: 'success' | 'error'; message: string };

const QUERY_KEY = ['documents'];

export function DocumentsPanel({
  accessToken,
  documents,
}: {
  accessToken: string;
  documents: UseQueryResult<DocumentDto[]>;
}) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [dragging, setDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentDto | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const uploadFiles = async (files: File[]) => {
    for (const file of files) {
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      if (!/\.pdf$/i.test(file.name)) {
        setNotice({ severity: 'error', message: `${file.name}: only PDF files can be uploaded.` });
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setNotice({ severity: 'error', message: `${file.name}: PDFs are limited to 20 MB.` });
        continue;
      }
      setUploads((current) => [...current, { key, name: file.name, fraction: 0 }]);
      try {
        await uploadDocument(accessToken, file, (fraction) =>
          setUploads((current) => current.map((u) => (u.key === key ? { ...u, fraction } : u))),
        );
      } catch (error) {
        setNotice({ severity: 'error', message: `${file.name}: ${uploadErrorMessage(error)}` });
      } finally {
        setUploads((current) => current.filter((u) => u.key !== key));
        void refresh();
      }
    }
  };

  const remove = useMutation({
    mutationFn: (doc: DocumentDto) => deleteDocument(accessToken, doc.id),
    // Optimistic: the row disappears at once and comes back only if the delete fails.
    onMutate: async (doc) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const previous = queryClient.getQueryData<DocumentDto[]>(QUERY_KEY);
      queryClient.setQueryData<DocumentDto[]>(QUERY_KEY, (docs) =>
        docs?.filter((d) => d.id !== doc.id),
      );
      return { previous };
    },
    onSuccess: (_, doc) => setNotice({ severity: 'success', message: `Deleted “${doc.title}”.` }),
    onError: (_, doc, context) => {
      queryClient.setQueryData(QUERY_KEY, context?.previous);
      setNotice({ severity: 'error', message: `Could not delete “${doc.title}”. Try again.` });
    },
    onSettled: () => void refresh(),
  });

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void uploadFiles(files);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void uploadFiles(Array.from(event.dataTransfer.files));
  };

  const onOpen = (doc: DocumentDto) =>
    openDocument(accessToken, doc.id).catch(() =>
      setNotice({ severity: 'error', message: `Could not open “${doc.title}”.` }),
    );

  const docs = documents.data ?? [];

  return (
    <Card
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      sx={{
        position: 'relative',
        outline: dragging ? 2 : 0,
        outlineColor: 'primary.main',
        outlineStyle: 'dashed',
      }}
    >
      <CardHeader
        title="Documents"
        subheader="PDFs up to 20 MB · drag and drop or upload"
        action={
          <Button
            variant="contained"
            startIcon={<UploadFileIcon />}
            onClick={() => input.current?.click()}
          >
            Upload PDF
          </Button>
        }
      />
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={onPick}
      />

      {uploads.map((u) => (
        <Box key={u.key} sx={{ px: 2, pb: 1.5 }}>
          <Typography variant="body2" noWrap>
            Uploading {u.name}… {Math.round(u.fraction * 100)}%
          </Typography>
          <LinearProgress variant="determinate" value={u.fraction * 100} sx={{ borderRadius: 1 }} />
        </Box>
      ))}

      {documents.isPending && (
        <Stack spacing={1} sx={{ px: 2, pb: 2 }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} variant="rounded" height={52} />
          ))}
        </Stack>
      )}
      {documents.isError && (
        <Alert severity="error" sx={{ m: 2 }}>
          Could not load your documents.
        </Alert>
      )}
      {documents.isSuccess && docs.length === 0 && uploads.length === 0 && (
        <Stack
          spacing={1}
          sx={{
            alignItems: 'center',
            textAlign: 'center',
            m: 2,
            p: 4,
            border: 1,
            borderStyle: 'dashed',
            borderColor: 'divider',
            borderRadius: 2,
          }}
        >
          <CloudUploadIcon color="action" sx={{ fontSize: 40 }} />
          <Typography>Drop PDFs here, or use Upload PDF.</Typography>
          <Typography variant="body2" color="text.secondary">
            Manuals, policies, handbooks: anything with selectable text.
          </Typography>
        </Stack>
      )}
      {docs.length > 0 && (
        <DocumentList documents={docs} onOpen={onOpen} onDelete={setPendingDelete} />
      )}

      <ConfirmDeleteDialog
        doc={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={(doc) => {
          setPendingDelete(null);
          remove.mutate(doc);
        }}
      />
      <Snackbar
        open={notice !== null}
        autoHideDuration={5000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {notice ? (
          <Alert severity={notice.severity} variant="filled" onClose={() => setNotice(null)}>
            {notice.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Card>
  );
}
