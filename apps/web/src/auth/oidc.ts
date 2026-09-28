import { WebStorageStateStore } from 'oidc-client-ts';
import type { AuthProviderProps } from 'react-oidc-context';
import { config } from '../config';

export const oidcConfig: AuthProviderProps = {
  authority: config.oidcAuthority,
  client_id: config.oidcClientId,
  redirect_uri: config.oidcRedirectUri,
  // Authorization code + PKCE (oidc-client-ts default); public client, no secret.
  response_type: 'code',
  scope: 'openid email',
  // Refresh-token based renewal before the 1-hour access token expires.
  automaticSilentRenew: true,
  // sessionStorage: gone when the tab closes; XSS exposure is mitigated by CSP (plan §9).
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  // Drop ?code=&state= from the address bar once the callback has been processed.
  onSigninCallback: () => window.history.replaceState({}, document.title, '/'),
};

/**
 * Cognito's /logout ends the managed-login session; it expects client_id and logout_uri
 * (an allowed sign-out URL), not the generic OIDC post_logout_redirect_uri.
 */
export function cognitoLogoutUrl(origin: string = window.location.origin): string {
  const params = new URLSearchParams({ client_id: config.oidcClientId, logout_uri: `${origin}/` });
  return `${config.cognitoDomain}/logout?${params.toString()}`;
}
