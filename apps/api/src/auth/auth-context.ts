/** The authenticated caller, attached to the request by AuthGuard. */
export interface AuthContext {
  /** Cognito `sub`: the tenant key for every query in v1. */
  tenantId: string;
  isAdmin: boolean;
  /** Kept only to call Cognito's userInfo endpoint for a first-seen user. */
  accessToken: string;
}

/** The parts of the HTTP request the auth layer reads or writes. */
export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  auth?: AuthContext;
}
