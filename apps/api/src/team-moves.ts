import type pg from "pg";
import { fw } from "@fireweaveai/server-sdk/start";

export async function teamSharedMovesEnabled(userId: string): Promise<boolean> {
  // @fireweave-controlpoint team-shared-moves
  return fw.controlPoints.getBooleanValue("team-shared-moves", false, { targetingKey: userId });
}

export async function sharesTeam(client: pg.Pool | pg.PoolClient, userId: string, authorId: string): Promise<boolean> {
  try {
    const found = await client.query(
      `SELECT 1
       FROM team_members mine
       JOIN team_members theirs ON theirs.team_id = mine.team_id
       WHERE mine.user_id = $1 AND theirs.user_id = $2
       LIMIT 1`,
      [userId, authorId],
    );
    return (found.rowCount ?? 0) > 0;
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return false;
    throw error;
  }
}
