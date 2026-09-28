import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { toProblem } from './problem.js';

/** The parts of the Express response the filter uses. */
interface ProblemResponse {
  status(code: number): ProblemResponse;
  type(contentType: string): ProblemResponse;
  json(body: unknown): void;
}

/** Every error leaves the API as `application/problem+json` (RFC 9457) with a machine `code`. */
@Catch()
export class ProblemJsonFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const problem = toProblem(exception);
    if (!(exception instanceof HttpException)) {
      this.logger.error(exception);
    }
    host
      .switchToHttp()
      .getResponse<ProblemResponse>()
      .status(problem.status)
      .type('application/problem+json')
      .json(problem);
  }
}
