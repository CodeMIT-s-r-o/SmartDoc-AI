import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

export interface AiChatRequest {
  requestId: string;
  tenantId: string;
  conversationId: string;
  question: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  documentIds: string[];
}

export class UpstreamUnavailable extends Error {}

/** The internal AI service. Only NestJS calls it, with the shared internal token. */
@Injectable()
export class AiClient {
  private readonly url: string;
  private readonly token: string;

  constructor(config: ConfigService<Env, true>) {
    this.url = config.get('AI_URL', { infer: true });
    this.token = config.get('INTERNAL_TOKEN', { infer: true });
  }

  /** Opens the SSE stream. Aborting `signal` closes it, which cancels the OpenAI call too. */
  async openChat(body: AiChatRequest, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(`${this.url}/internal/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Internal-Token': this.token,
        'X-Request-Id': body.requestId,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new UpstreamUnavailable(`AI service answered ${res.status}`);
    }
    return res.body;
  }
}
