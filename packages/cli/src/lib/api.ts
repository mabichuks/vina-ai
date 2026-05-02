/**
 * Tiny HTTP helper for talking to a running daemon. Fetches the bearer token
 * via /api/bootstrap on each call — token is per-process, so caching across
 * commands isn't useful.
 */

interface BootstrapResponse {
  token: string;
  version: string;
  onboarded: boolean;
}

export class DaemonNotRunningError extends Error {
  constructor() {
    super('Vina is not running. Run `vina start` first.');
  }
}

export async function fetchToken(port: number): Promise<string> {
  const res = await fetchOrFail(`http://127.0.0.1:${port}/api/bootstrap`);
  const body = (await res.json()) as BootstrapResponse;
  return body.token;
}

export async function authedRequest<T>(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await fetchToken(port);
  const res = await fetchOrFail(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return (await res.json()) as T;
}

async function fetchOrFail(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new DaemonNotRunningError();
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${init?.method ?? 'GET'} ${url} failed: ${res.status} ${text}`);
  }
  return res;
}
