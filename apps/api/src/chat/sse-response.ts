/** The parts of the Express response the chat stream uses. */
export interface SseResponse {
  headersSent: boolean;
  writableEnded: boolean;
  status(code: number): SseResponse;
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string | Uint8Array): boolean;
  end(): void;
  json(body: unknown): void;
  on(event: 'close', listener: () => void): void;
}

export function startSse(res: SseResponse): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  // no-transform: proxies must not compress or buffer the stream.
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

export function writeEvent(res: SseResponse, name: string, data: unknown): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}
