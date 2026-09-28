import { useAuth } from 'react-oidc-context';
import { cognitoLogoutUrl } from './oidc';

/** Revoke the refresh token, forget the local session, then end the Cognito session. */
export function useSignOut(): () => Promise<void> {
  const auth = useAuth();
  return async () => {
    try {
      await auth.revokeTokens(['refresh_token']);
    } catch {
      // Best effort: the session is cleared either way, and Cognito's logout still runs.
    }
    await auth.removeUser();
    window.location.assign(cognitoLogoutUrl());
  };
}
