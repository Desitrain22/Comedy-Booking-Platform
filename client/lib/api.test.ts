import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, apiUrl, errorMessage, isApiError } from './api';

describe('apiUrl', () => {
  it('prefixes /api once', () => {
    expect(apiUrl('/shows')).toBe('/api/shows');
    expect(apiUrl('shows')).toBe('/api/shows');
    expect(apiUrl('/api/shows')).toBe('/api/shows');
  });

  it('serializes query params: arrays comma-joined, booleans 1/0, nullish and empty arrays dropped', () => {
    expect(
      apiUrl('/shows', { from: '2026-11-01', to: '2026-11-30', locationIds: [1, 2], upcoming: true, archived: false }),
    ).toBe('/api/shows?from=2026-11-01&to=2026-11-30&locationIds=1%2C2&upcoming=1&archived=0');
    expect(apiUrl('/comedians', { search: undefined, tagIds: [], x: null })).toBe('/api/comedians');
  });
});

describe('api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: unknown, contentType = 'application/json') {
    const fetchMock = vi.fn(async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': contentType },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('sends JSON and parses JSON', async () => {
    const fetchMock = stubFetch(201, { id: 7 });
    await expect(api.post('/bookings', { showId: 1 })).resolves.toEqual({ id: 7 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/bookings');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"showId":1}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('sends {} for body-less writes and nothing for GET/DELETE', async () => {
    const fetchMock = stubFetch(200, { ok: true });
    await api.post('/auth/logout');
    await api.get('/auth/me');
    await api.del('/bookings/3');
    const bodies = fetchMock.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].body);
    expect(bodies).toEqual(['{}', undefined, undefined]);
  });

  it('throws ApiError with status, code and the full body', async () => {
    stubFetch(409, { error: 'Jason is not available', code: 'unavailable', submittedMonth: true });
    const err = await api.post('/bookings', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isApiError(err, 'unavailable')).toBe(true);
    expect(err).toMatchObject({ status: 409, code: 'unavailable', message: 'Jason is not available' });
    expect((err as ApiError).body.submittedMonth).toBe(true);
    expect(errorMessage(err)).toBe('Jason is not available');
  });

  it('wraps non-JSON errors', async () => {
    stubFetch(502, 'Bad gateway', 'text/plain');
    const err = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.code).toBeUndefined();
    expect(err.message).toBe('Bad gateway');
  });
});
