import { Box, CircularProgress, Container } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from 'react-oidc-context';
import { api, type Me } from './api';
import { useSignOut } from './auth/useSignOut';
import { ChatPlaceholder } from './chat/ChatPlaceholder';
import { AppHeader } from './components/AppHeader';
import { SignInScreen } from './components/SignInScreen';
import { DocumentsPanel } from './documents/DocumentsPanel';
import { useDocuments } from './documents/useDocuments';

export function App() {
  const auth = useAuth();

  if (auth.isLoading) {
    return (
      <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress aria-label="Loading" />
      </Box>
    );
  }
  if (!auth.isAuthenticated || !auth.user) {
    return <SignInScreen error={auth.error?.message} onSignIn={() => void auth.signinRedirect()} />;
  }
  return <SignedIn accessToken={auth.user.access_token} />;
}

function SignedIn({ accessToken }: { accessToken: string }) {
  const signOut = useSignOut();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('GET', '/me', accessToken),
    refetchInterval: 60_000,
  });
  const documents = useDocuments(accessToken);
  const ready = documents.data?.filter((d) => d.status === 'ready').length ?? 0;

  return (
    <>
      <AppHeader me={me.data} onSignOut={() => void signOut()} />
      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Box
          sx={{
            display: 'grid',
            gap: 3,
            gridTemplateColumns: { xs: '1fr', md: '5fr 7fr' },
            alignItems: 'start',
          }}
        >
          <DocumentsPanel accessToken={accessToken} documents={documents} />
          <Box sx={{ minHeight: { md: 480 }, height: '100%' }}>
            <ChatPlaceholder readyDocuments={ready} />
          </Box>
        </Box>
      </Container>
    </>
  );
}
