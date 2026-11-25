import { Injectable } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export interface ReviewWatchActivity {
  userId: string;
  name: string;
  /** Epoch milliseconds of the newest activity at or after `since`. */
  at: number;
}

const activityRowSchema = z.object({
  userId: z.coerce.string(),
  name: z.string(),
  at: z.number().finite().positive(),
});

/**
 * Reads every Plex account's stored watch state for a movie or a whole show
 * from the Plex database, read-only. A pending "Leaving soon" title is saved by
 * any activity since its approval: a finished view, a partial view (Plex keeps
 * the offset and its update time), or a history row.
 */
@Injectable()
export class ReviewWatchActivityService {
  activitySince(
    itemId: string,
    type: 'movie' | 'show',
    sinceMs: number,
  ): ReviewWatchActivity[] {
    const path = process.env.PLEX_DATABASE_PATH;
    if (!path)
      throw new Error('PLEX_DATABASE_PATH is required for Leaving soon saves');
    const since = Math.floor(sinceMs / 1000);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA query_only = ON');
      const item = db
        .prepare(
          'SELECT id FROM metadata_items WHERE id = ? AND deleted_at IS NULL AND metadata_type = ?',
        )
        .get(itemId, type === 'movie' ? 1 : 2);
      if (!item)
        throw new Error('Plex item is missing from stored watch state');
      // Movies match their own guid; shows match every episode guid below them.
      const rows = db
        .prepare(
          `
        WITH guids AS (
          SELECT m.guid FROM metadata_items m
          WHERE ? = 'movie' AND m.id = ? AND m.metadata_type = 1 AND m.deleted_at IS NULL
          UNION
          SELECT e.guid FROM metadata_items e
          JOIN metadata_items season ON season.id = e.parent_id AND season.deleted_at IS NULL
          WHERE ? = 'show' AND e.metadata_type = 4 AND e.deleted_at IS NULL AND season.parent_id = ?
        ),
        activity AS (
          SELECT s.account_id AS accountId, s.last_viewed_at AS at
          FROM metadata_item_settings s JOIN guids g ON g.guid = s.guid
          WHERE s.last_viewed_at >= ?
          UNION ALL
          SELECT s.account_id, s.updated_at
          FROM metadata_item_settings s JOIN guids g ON g.guid = s.guid
          WHERE s.view_offset > 0 AND s.updated_at >= ?
          UNION ALL
          SELECT v.account_id, v.viewed_at
          FROM metadata_item_views v JOIN guids g ON g.guid = v.guid
          WHERE v.viewed_at >= ?
        )
        SELECT activity.accountId AS userId,
               COALESCE(a.name, CAST(activity.accountId AS TEXT)) AS name,
               MAX(activity.at) AS at
        FROM activity LEFT JOIN accounts a ON a.id = activity.accountId
        GROUP BY activity.accountId, a.name
        ORDER BY at DESC, activity.accountId
      `,
        )
        .all(type, itemId, type, itemId, since, since, since);
      return rows.map((row) => {
        const parsed = activityRowSchema.parse(row);
        return { ...parsed, at: parsed.at * 1000 };
      });
    } finally {
      db.close();
    }
  }
}
