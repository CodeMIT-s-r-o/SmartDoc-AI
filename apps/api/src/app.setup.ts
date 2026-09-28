import { type INestApplication, RequestMethod } from '@nestjs/common';

/** App-level HTTP setup shared by main.ts and the tests, so both expose the same routes. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api', {
    // Service-to-service routes live outside /api; the edge proxy only ever forwards /api/*.
    exclude: [{ path: 'internal/documents/:id/download-url', method: RequestMethod.POST }],
  });
}
