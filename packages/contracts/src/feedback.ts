import { z } from 'zod';

/** Why an answer got a thumbs-down: fixed codes, so the triage table can group them. */
export const FEEDBACK_REASONS = [
  'incorrect',
  'not_in_documents',
  'wrong_citation',
  'incomplete',
  'other',
] as const;

export const feedbackReasonSchema = z.enum(FEEDBACK_REASONS);

/** `POST /api/messages/:id/feedback`. Reasons and comment only make sense with a thumbs-down. */
export const feedbackRequestSchema = z
  .object({
    rating: z.union([z.literal(1), z.literal(-1)]),
    reasons: z.array(feedbackReasonSchema).max(FEEDBACK_REASONS.length).optional(),
    comment: z.string().trim().max(1000).optional(),
  })
  .refine((f) => f.rating === -1 || (!f.reasons?.length && !f.comment), {
    message: 'Reasons and comment are only accepted with rating -1',
  });

export type FeedbackReason = z.infer<typeof feedbackReasonSchema>;
export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;
