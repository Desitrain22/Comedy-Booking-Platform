/**
 * The one fetch wrapper for the JSON API. Paths are relative to `/api`:
 *
 *   const shows = await api.get<ShowDto[]>('/shows', { query: { from, to, locationIds: [1, 2] } });
 *   const booking = await api.post<Booking>('/bookings', { showId, position, comedianId });
 *   await api.patch(`/shows/${id}`, { slotCount: 7 });
 *   await api.del(`/bookings/${id}`);
 *
 * Non-2xx responses throw `ApiError { status, code, body }` where `body` is the server's
 * `{ error, code?, ...extra }` (e.g. 409 `{ code: 'unavailable', availability, submittedMonth }`).
 */
import type { ApiErrorBody } from '../../shared/types';

export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable error code from the server, e.g. `slot_taken`. */
  readonly code: string | undefined;
  /** The full error body, including any extra fields. */
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.body = body;
  }
}

export function isApiError(err: unknown, code?: string): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}

/** A human message for any thrown value (for toasts and inline errors). */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) return 'Could not reach the server. Check your connection.';
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];
export type QueryParams = Record<string, QueryValue>;

/**
 * Build `/api<path>?<query>`. Arrays become comma-separated (`ids=1,2,3`), booleans `1`/`0`,
 * and null/undefined/empty-array values are dropped. Use for links too, e.g. a download href.
 */
export function apiUrl(path: string, query?: QueryParams): string {
  const base = path.startsWith('/api/') || path === '/api' ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','));
    } else if (typeof value === 'boolean') {
      params.set(key, value ? '1' : '0');
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${base}${base.includes('?') ? '&' : '?'}${qs}` : base;
}

export interface RequestOptions {
  query?: QueryParams;
  signal?: AbortSignal;
  headers?: HeadersInit;
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

async function request<T>(method: string, path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  // Always JSON for writes (even without a body) so the server's CSRF check treats
  // them as API calls rather than cross-site form posts.
  if (method !== 'GET') headers.set('content-type', 'application/json');

  // POST/PUT/PATCH without a body send `{}` so optional-field JSON validators still parse.
  const payload = body !== undefined ? JSON.stringify(body) : method === 'GET' || method === 'DELETE' ? undefined : '{}';

  const res = await fetch(apiUrl(path, options.query), {
    method,
    headers,
    body: payload,
    credentials: 'same-origin',
    signal: options.signal,
  });
  const data = await parseBody(res);
  if (!res.ok) {
    const errorBody: ApiErrorBody =
      data && typeof data === 'object' && 'error' in data
        ? (data as ApiErrorBody)
        : { error: typeof data === 'string' && data ? data : res.statusText || `Request failed (${res.status})` };
    throw new ApiError(res.status, errorBody);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, body, options),
  put: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PUT', path, body, options),
  patch: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, body, options),
  del: <T = unknown>(path: string, options?: RequestOptions) => request<T>('DELETE', path, undefined, options),
};
