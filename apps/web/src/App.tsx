import { useEffect, useState } from 'react';
import { useAuth } from 'react-oidc-context';
import { api, type Me } from './api';
import { useSignOut } from './auth/useSignOut';
import { DocumentsPanel } from './documents/DocumentsPanel';

type MeState =
  { kind: 'loading' } | { kind: 'loaded'; me: Me } | { kind: 'failed'; message: string };

const page = { fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '4rem auto' } as const;

/** App shell: sign in, the caller's profile from /api/me, documents, sign out. */
export function App() {
  const auth = useAuth();

  if (auth.isLoading) {
    return <main style={page}>Loading…</main>;
  }
  if (auth.error) {
    return (
      <main style={page}>
        <h1>SmartDoc AI</h1>
        <p>Sign-in failed: {auth.error.message}</p>
        <button onClick={() => void auth.signinRedirect()}>Try again</button>
      </main>
    );
  }
  if (!auth.isAuthenticated || !auth.user) {
    return (
      <main style={page}>
        <h1>SmartDoc AI</h1>
        <p>Production-grade RAG with measured cost controls. Access is by invitation.</p>
        <button onClick={() => void auth.signinRedirect()}>Sign in</button>
      </main>
    );
  }
  return <SignedIn accessToken={auth.user.access_token} />;
}

function SignedIn({ accessToken }: { accessToken: string }) {
  const signOut = useSignOut();
  const [state, setState] = useState<MeState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    api<Me>('GET', '/me', accessToken)
      .then((me) => active && setState({ kind: 'loaded', me }))
      .catch((error: unknown) => active && setState({ kind: 'failed', message: String(error) }));
    return () => {
      active = false;
    };
  }, [accessToken]);

  return (
    <main style={page}>
      <h1>SmartDoc AI</h1>
      {state.kind === 'loading' && <p>Loading profile…</p>}
      {state.kind === 'failed' && <p>Could not load your profile: {state.message}</p>}
      {state.kind === 'loaded' && (
        <ul>
          <li>Signed in as {state.me.email}</li>
          <li>Role: {state.me.isAdmin ? 'admin' : 'member'}</li>
          <li>
            Spent today: ${state.me.spentTodayUsd.toFixed(4)} of $
            {state.me.dailyLimitUsd.toFixed(2)}
          </li>
        </ul>
      )}
      <button onClick={() => void signOut()}>Sign out</button>
      <DocumentsPanel accessToken={accessToken} />
    </main>
  );
}
