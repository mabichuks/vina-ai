import { AuthError, ConflictError, NotFoundError, ValidationError, VinaError } from '@vina/shared';
import { getToken, useAuthStore } from '../store/auth-store.js';
import { useUiStore } from '../store/ui-store.js';

interface ErrorEnvelope {
  code?: string;
  message?: string;
  details?: unknown;
}

interface RequestInitWithBody extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

const STATUS_TO_CTOR: Record<number, new (msg?: string, details?: unknown) => VinaError> = {
  400: ValidationError,
  401: AuthError,
  404: NotFoundError,
  409: ConflictError,
};

/**
 * Throw a typed VinaError matching the server envelope. Falls back to a
 * generic VinaError if the server returned an unrecognised shape.
 */
async function parseErrorAndThrow(res: Response): Promise<never> {
  let envelope: ErrorEnvelope = {};
  try {
    envelope = (await res.json()) as ErrorEnvelope;
  } catch {
    // body was not JSON — leave envelope empty
  }
  const message = envelope.message ?? `Request failed: ${res.status}`;
  const Ctor = STATUS_TO_CTOR[res.status];
  const err = Ctor
    ? new Ctor(message, envelope.details)
    : new VinaError(envelope.code ?? 'request_failed', message, envelope.details);
  // Surface auth failures and 5xx errors via the toast system. 4xx validation
  // errors are usually shown inline next to the offending field — leave those
  // to the caller.
  if (err instanceof AuthError || res.status >= 500) {
    useUiStore.getState().pushToast({ kind: 'error', message });
  }
  throw err;
}

interface BootstrapShape {
  version: string;
  token: string;
  onboarded: boolean;
}

/**
 * Refresh the bearer token from `/api/bootstrap`. Used when an API call gets
 * 401 — the daemon may have restarted with a new token while the page stayed
 * open. Returns the fresh token, or null if bootstrap itself fails.
 */
let inflightBootstrap: Promise<string | null> | null = null;
async function refreshTokenViaBootstrap(): Promise<string | null> {
  if (inflightBootstrap) return inflightBootstrap;
  inflightBootstrap = (async () => {
    try {
      const res = await fetch('/api/bootstrap', { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const data = (await res.json()) as BootstrapShape;
      useAuthStore.getState().setToken(data.token);
      return data.token;
    } catch {
      return null;
    } finally {
      inflightBootstrap = null;
    }
  })();
  return inflightBootstrap;
}

export async function api<T = unknown>(path: string, init: RequestInitWithBody = {}): Promise<T> {
  return apiOnce<T>(path, init, true);
}

async function apiOnce<T>(
  path: string,
  init: RequestInitWithBody,
  allowReauth: boolean,
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (token && !path.startsWith('/api/bootstrap')) {
    headers.authorization = `Bearer ${token}`;
  }
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    useUiStore.getState().pushToast({ kind: 'error', message: 'Could not reach the Vina daemon.' });
    throw err;
  }

  // 401 on a non-bootstrap request usually means the daemon restarted and
  // issued a fresh token. Try one silent re-bootstrap, then retry the call.
  if (res.status === 401 && allowReauth && !path.startsWith('/api/bootstrap')) {
    const fresh = await refreshTokenViaBootstrap();
    if (fresh) return apiOnce<T>(path, init, false);
  }

  if (!res.ok) {
    await parseErrorAndThrow(res);
  }

  if (res.status === 204) return undefined as T;

  return (await res.json()) as T;
}
