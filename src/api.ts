import type { SessionState } from '../shared/schema';

// The session token proves a request comes from a tab that unlocked the vault. It is in
// sessionStorage so a reload keeps the session. That storage is per tab and per origin, so other
// local servers can't read it, unlike cookies, which browsers share across ports.
const TOKEN_KEY = 'allin.session-token';
function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}
let token = readToken();
function storeToken(value: string) {
  token = value;
  try {
    sessionStorage.setItem(TOKEN_KEY, value);
  } catch {
    // Without storage the token lasts until the page reloads, then the vault asks to unlock.
  }
}
let authChanges = 0;
/** Records a login or lock, so a status response already in flight can't overwrite the result. */
export function setAuthenticatedToken(value: string) {
  authChanges++;
  storeToken(value);
}
export class APIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'X-AllIn-CSRF': token,
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('allin-locked'));
    throw new APIError(response.status, data.error ?? 'Something went wrong. Please try again.');
  }
  return data as T;
}
export async function fetchStatus(): Promise<SessionState> {
  for (;;) {
    const before = authChanges;
    const status = await api<SessionState>('/status');
    if (before === authChanges) {
      storeToken(status.csrf);
      return status;
    }
  }
}
