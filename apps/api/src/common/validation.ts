import { HttpStatus, ParseUUIDPipe, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { ProblemException } from './problem.js';

/** Validates a request body against a zod schema; 400 VALIDATION_FAILED otherwise. */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        z.prettifyError(result.error),
      );
    }
    return result.data;
  }
}

/** A malformed id is reported like an unknown one: 404, never a hint about what exists. */
export const uuidParam = (resource: string) =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new ProblemException(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${resource} not found`),
  });
