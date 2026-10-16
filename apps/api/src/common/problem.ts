import { HttpException, type HttpStatus } from '@nestjs/common';
import { STATUS_CODES } from 'node:http';

/** Machine-readable error codes the SPA switches on (the RFC 9457 `code` extension member). */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'IN_PROGRESS'
  | 'NO_DOCUMENTS'
  | 'UPLOAD_NOT_FOUND'
  | 'UNPROCESSABLE'
  | 'INVALID_FILE'
  | 'FILE_TOO_LARGE'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'BUDGET_EXCEEDED'
  | 'DUPLICATE_DOCUMENT'
  | 'UNAVAILABLE'
  | 'INTERNAL';

/** RFC 9457 problem details, as returned for every API error. */
export interface Problem {
  type: 'about:blank';
  title: string;
  status: number;
  code: ErrorCode;
  detail: string;
  [extension: string]: unknown;
}

/** Throw this to return a specific error code; any other HttpException gets a default code. */
export class ProblemException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ErrorCode,
    detail: string,
    readonly extensions: Record<string, unknown> = {},
    /** Response headers that belong to the error, e.g. Retry-After. */
    readonly headers: Record<string, string> = {},
  ) {
    super({ code, detail, ...extensions }, status);
  }
}

const DEFAULT_CODES: Partial<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  503: 'UNAVAILABLE',
};

const title = (status: number): string => STATUS_CODES[status] ?? 'Error';

function detailOf(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') {
    return body;
  }
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) {
    return message.join('; ');
  }
  return typeof message === 'string' ? message : exception.message;
}

export function toProblem(exception: unknown): Problem {
  if (exception instanceof ProblemException) {
    const status = exception.getStatus();
    return {
      ...exception.extensions,
      type: 'about:blank',
      title: title(status),
      status,
      code: exception.code,
      detail: (exception.getResponse() as { detail: string }).detail,
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return {
      type: 'about:blank',
      title: title(status),
      status,
      code: DEFAULT_CODES[status] ?? (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'),
      detail: detailOf(exception),
    };
  }
  // Unknown errors never leak their message to the client.
  return {
    type: 'about:blank',
    title: title(500),
    status: 500,
    code: 'INTERNAL',
    detail: 'Internal server error',
  };
}
