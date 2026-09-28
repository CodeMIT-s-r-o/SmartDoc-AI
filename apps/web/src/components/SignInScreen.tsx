import AutoStoriesIcon from '@mui/icons-material/AutoStories';
import { Alert, Box, Button, Card, CardContent, Stack, Typography } from '@mui/material';

export function SignInScreen({ error, onSignIn }: { error?: string; onSignIn: () => void }) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Card sx={{ width: '100%', maxWidth: 420 }}>
        <CardContent sx={{ p: 4 }}>
          <Stack spacing={3} sx={{ alignItems: 'center', textAlign: 'center' }}>
            <AutoStoriesIcon color="primary" sx={{ fontSize: 48 }} />
            <Box>
              <Typography variant="h5" component="h1">
                SmartDoc AI
              </Typography>
              <Typography color="text.secondary" sx={{ mt: 1 }}>
                Chat with your company documents. Every answer cites its pages.
              </Typography>
            </Box>
            {error && (
              <Alert severity="error" sx={{ width: '100%', textAlign: 'left' }}>
                Sign-in failed: {error}
              </Alert>
            )}
            <Button variant="contained" size="large" fullWidth onClick={onSignIn}>
              {error ? 'Try again' : 'Sign in'}
            </Button>
            <Typography variant="caption" color="text.secondary">
              Access is by invitation only.
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
