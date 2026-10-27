import type { INestApplication } from '@nestjs/common';

export interface Route {
  method: string;
  path: string;
}

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Every route mounted on the underlying Express 5 app, with the global prefix applied. */
export function mountedRoutes(app: INestApplication): Route[] {
  const express = app.getHttpAdapter().getInstance() as { router: { stack: ExpressLayer[] } };
  return express.router.stack.flatMap(({ route }) =>
    route
      ? Object.keys(route.methods).map((m) => ({ method: m.toUpperCase(), path: route.path }))
      : [],
  );
}

export const key = (r: Route) => `${r.method} ${r.path}`;
