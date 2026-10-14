/** RFC 9457 problem details returned by the API for every error. */
export interface Problem {
  status: number;
  code: string;
  detail: string;
  /** Extension members, e.g. `scope` and `resetsAt` on BUDGET_EXCEEDED. */
  [extension: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
    readonly problem: Partial<Problem> = {},
  ) {
    super(detail);
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  const problem = (await res.json().catch(() => undefined)) as Partial<Problem> | undefined;
  return new ApiError(
    res.status,
    problem?.code ?? 'UNKNOWN',
    problem?.detail ?? res.statusText,
    problem ?? {},
  );
}

/** Same-origin API call with the caller's access token. */
export async function api<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  accessToken: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw await toApiError(res);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export interface Me {
  id: string;
  email: string;
  isAdmin: boolean;
  dailyLimitUsd: number;
  spentTodayUsd: number;
}
