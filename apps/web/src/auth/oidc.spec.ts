import { describe, expect, it } from 'vitest';
import { cognitoLogoutUrl } from './oidc';

describe('cognitoLogoutUrl', () => {
  it('uses the Cognito parameters (client_id + logout_uri), not post_logout_redirect_uri', () => {
    const url = new URL(cognitoLogoutUrl('http://localhost:5173'));

    expect(`${url.origin}${url.pathname}`).toBe(
      'https://smartdoc-test.auth.eu-central-1.amazoncognito.com/logout',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'test-web-client',
      logout_uri: 'http://localhost:5173/',
    });
  });
});
