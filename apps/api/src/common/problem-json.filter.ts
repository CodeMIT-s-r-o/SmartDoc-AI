import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ProblemException, toProblem } from './problem.js';

/** The parts of the Express response the filter uses. */
interface ProblemResponse {
  setHeader(name: string, value: string): void;
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
    const res = host.switchToHttp().getResponse<ProblemResponse>();
    if (exception instanceof ProblemException) {
      for (const [name, value] of Object.entries(exception.headers)) {
        res.setHeader(name, value);
      }
    }
    res.status(problem.status).type('application/problem+json').json(problem);
  }
}
