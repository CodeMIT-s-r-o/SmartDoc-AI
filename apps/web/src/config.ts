/** Build-time config (VITE_*). Locally from .env.dev-aws (`make dev-config`); in CI from SSM. */
function required(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Run \`make dev-config\` and restart the web container.`);
  }
  return value;
}

export const config = {
  oidcAuthority: required('VITE_OIDC_AUTHORITY'),
  oidcClientId: required('VITE_OIDC_CLIENT_ID'),
  oidcRedirectUri: required('VITE_OIDC_REDIRECT_URI'),
  cognitoDomain: required('VITE_COGNITO_DOMAIN'),
};
