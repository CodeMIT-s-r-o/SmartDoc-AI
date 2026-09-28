import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import { Chip, CircularProgress, Tooltip } from '@mui/material';
import type { DocumentDto } from './api';
import { failureMessage, isInterruptedUpload } from './api';

export function StatusChip({ doc }: { doc: DocumentDto }) {
  switch (doc.status) {
    case 'ready':
      return (
        <Chip
          size="small"
          color="success"
          variant="outlined"
          icon={<CheckCircleIcon />}
          label="Ready"
        />
      );
    case 'failed':
      return (
        <Tooltip title={failureMessage(doc.errorCode)}>
          <Chip
            size="small"
            color="error"
            variant="outlined"
            icon={<ErrorOutlinedIcon />}
            label="Failed"
          />
        </Tooltip>
      );
    case 'queued':
      return (
        <Chip
          size="small"
          color="info"
          variant="outlined"
          icon={<HourglassTopIcon />}
          label="Queued"
        />
      );
    case 'processing':
      return (
        <Chip
          size="small"
          color="info"
          variant="outlined"
          icon={<CircularProgress size={12} color="inherit" />}
          label="Processing"
        />
      );
    case 'uploading':
      return isInterruptedUpload(doc) ? (
        <Tooltip title="The upload did not finish. Delete it and upload the file again.">
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            icon={<ErrorOutlinedIcon />}
            label="Interrupted"
          />
        </Tooltip>
      ) : (
        <Chip
          size="small"
          variant="outlined"
          icon={<CircularProgress size={12} color="inherit" />}
          label="Uploading"
        />
      );
    case 'deleting':
      return <Chip size="small" variant="outlined" label="Deleting" />;
  }
}
