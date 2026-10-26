import { Box, CircularProgress, Container } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useAuth } from 'react-oidc-context';
import { api, type Me } from './api';
import { useSignOut } from './auth/useSignOut';
import { ChatPanel } from './chat/ChatPanel';
import { AppHeader } from './components/AppHeader';
import { CostPage } from './cost/CostPage';
import { SignInScreen } from './components/SignInScreen';
import { DocumentsPanel } from './documents/DocumentsPanel';
import { useDocuments } from './documents/useDocuments';

const subscribeHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

/** Two pages, so a hash is all the routing needed: `#/cost` is the admin Cost page. */
function usePage(): ['chat' | 'cost', (page: 'chat' | 'cost') => void] {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return [
    hash === '#/cost' ? 'cost' : 'chat',
    (page) => (window.location.hash = page === 'cost' ? '/cost' : ''),
  ];
}

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
  const [page, setPage] = usePage();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('GET', '/me', accessToken),
    refetchInterval: 60_000,
  });
  const documents = useDocuments(accessToken);
  const ready = documents.data?.filter((d) => d.status === 'ready').length ?? 0;

  return (
    <>
      <AppHeader me={me.data} onSignOut={() => void signOut()} onOpenCost={() => setPage('cost')} />
      <Container maxWidth="lg" sx={{ py: 3 }}>
        {page === 'cost' && me.data?.isAdmin ? (
          <CostPage accessToken={accessToken} onBack={() => setPage('chat')} />
        ) : (
          <Box
            sx={{
              display: 'grid',
              gap: 3,
              gridTemplateColumns: { xs: '1fr', md: '5fr 7fr' },
              alignItems: 'start',
            }}
          >
            <DocumentsPanel accessToken={accessToken} documents={documents} />
            <ChatPanel accessToken={accessToken} readyDocuments={ready} />
          </Box>
        )}
      </Container>
    </>
  );
}
