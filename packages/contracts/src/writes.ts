import { z } from "zod";
import { cardSchema, columnSchema } from "./board.ts";

export const createCardBody = z
  .object({
    boardId: z.string(),
    title: z.string(),
    column: columnSchema,
  })
  .strict();

export const patchCardBody = z
  .object({
    title: z.string().optional(),
    column: columnSchema.optional(),
  })
  .strict()
  .refine((body) => body.title !== undefined || body.column !== undefined);

export const assignCardBody = z
  .object({
    userId: z.string(),
  })
  .strict();

export const commentBody = z
  .object({
    body: z.string(),
  })
  .strict();

export const commentSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  body: z.string(),
  authorId: z.string(),
  createdAt: z.string(),
});

export const cardEnvelope = z.object({ card: cardSchema });

export const patchCardResponse = z.object({
  card: cardSchema,
  shifted: z.array(cardSchema),
});

export const commentResponse = z.object({
  comment: commentSchema,
  card: cardSchema,
});

export const cardDetailResponse = z.object({
  card: cardSchema,
  comments: z.array(commentSchema),
});

export const searchResponse = z.object({
  query: z.string(),
  cards: z.array(cardSchema),
});

export const changesResponse = z.object({
  revision: z.number(),
  cards: z.array(cardSchema),
  comments: z.array(commentSchema),
  removedCardIds: z.array(z.string()),
});

export type Comment = z.infer<typeof commentSchema>;
