import { z } from "zod";

export const columnSchema = z.enum(["todo", "doing", "done"]);

export const cardSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  title: z.string(),
  column: columnSchema,
  position: z.number(),
  authorId: z.string(),
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number(),
});

export const boardResponse = z.object({
  board: z.object({
    id: z.string(),
    name: z.string(),
    revision: z.number(),
  }),
  columns: z.tuple([z.literal("todo"), z.literal("doing"), z.literal("done")]),
  cards: z.array(cardSchema),
});

export type Card = z.infer<typeof cardSchema>;
export type BoardResponse = z.infer<typeof boardResponse>;
