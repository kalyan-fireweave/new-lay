import { z } from "zod";
import { roleSchema } from "./session.ts";

export const directoryUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
});

export const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  memberIds: z.array(z.string()),
});

export const usersResponse = z.object({
  users: z.array(directoryUserSchema),
});

export const teamsResponse = z.object({
  teams: z.array(teamSchema),
});

export const teamResponse = z.object({
  team: teamSchema,
});

export const createTeamBody = z
  .object({
    name: z.string(),
  })
  .strict();

export const addMembersBody = z
  .object({
    userIds: z.array(z.string()).min(1),
  })
  .strict();

export type DirectoryUser = z.infer<typeof directoryUserSchema>;
export type Team = z.infer<typeof teamSchema>;
