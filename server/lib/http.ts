/**
 * Consistent JSON errors: every error response is `{ error, code?, ...extra }`.
 *
 *   throw httpError(404, 'Show not found', 'not_found');
 *   throw httpError(409, 'Slot is taken', 'slot_taken', { bookingId });
 *   return jsonError(c, 400, 'Bad things', 'bad');
 *
 * Thrown HttpErrors are rendered by the app's onError handler.
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiErrorBody } from '../../shared/types';

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
    readonly code?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toBody(): ApiErrorBody {
    return { error: this.message, ...(this.code ? { code: this.code } : {}), ...this.extra };
  }
}

export function httpError(
  status: ContentfulStatusCode,
  error: string,
  code?: string,
  extra?: Record<string, unknown>,
): HttpError {
  return new HttpError(status, error, code, extra);
}

export function jsonError(
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  code?: string,
  extra?: Record<string, unknown>,
) {
  return c.json(new HttpError(status, error, code, extra).toBody(), status);
}

/** Parse a positive integer path param or throw 400 `invalid_id`. */
export function parseId(value: string | undefined, label = 'id'): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `Invalid ${label}`, 'invalid_id');
  return n;
}

/** Throw 404 `not_found` when `value` is null/undefined; otherwise return it narrowed. */
export function orNotFound<T>(value: T | null | undefined, what = 'Resource'): T {
  if (value == null) throw httpError(404, `${what} not found`, 'not_found');
  return value;
}
