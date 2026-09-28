/** Same-origin API calls with the caller's access token. */
export async function apiGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`GET /api${path} failed with ${res.status}`);
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
