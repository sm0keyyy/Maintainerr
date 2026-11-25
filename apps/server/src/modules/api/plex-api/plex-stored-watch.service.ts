import { MediaItemType, ReviewWatcher } from '@maintainerr/contracts';
import { Injectable } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const watchRowSchema = z.object({
  userId: z.coerce.string(),
  name: z.string(),
  viewedAt: z.number().finite().positive(),
});

const reviewStateRowSchema = z.object({
  itemId: z.coerce.string(),
  userId: z.coerce.string(),
  name: z.string(),
  viewedAt: z.number().finite().nonnegative(),
  viewOffset: z.number().finite().nonnegative(),
});

const showSizeRowSchema = z.object({
  itemId: z.coerce.string(),
  size: z.number().finite().nonnegative(),
});

export interface StoredReviewState {
  /** Every account that viewed the title, newest first. */
  watchers: ReviewWatcher[];
  /** Some account stopped part-way through the movie or an episode. */
  inProgress: boolean;
}

export interface StoredReviewSnapshot {
  /** Titles with no stored view or offset are absent. */
  states: Map<string, StoredReviewState>;
  /** Whole-show file sizes from the episode parts; empty for movies. */
  showSizes: Map<string, number>;
}

// One row per title and account, from the stored per-account state (view
// date and resume offset) and the play history, for every title at once.
const REVIEW_STATE_SQL = {
  movie: `
    WITH events AS (
      SELECT m.id AS itemId, s.account_id AS accountId,
             COALESCE(s.last_viewed_at, 0) AS viewedAt, COALESCE(s.view_offset, 0) AS viewOffset
      FROM metadata_items m
      JOIN metadata_item_settings s ON s.guid = m.guid
      WHERE m.metadata_type = 1 AND m.deleted_at IS NULL
        AND (s.last_viewed_at > 0 OR s.view_offset > 0)
      UNION ALL
      SELECT m.id, v.account_id, v.viewed_at, 0
      FROM metadata_items m
      JOIN metadata_item_views v ON v.guid = m.guid
      WHERE m.metadata_type = 1 AND m.deleted_at IS NULL AND v.viewed_at > 0
    )`,
  show: `
    WITH episodes AS (
      SELECT show.id AS showId, ep.guid AS guid
      FROM metadata_items show
      JOIN metadata_items season ON season.parent_id = show.id AND season.deleted_at IS NULL
      JOIN metadata_items ep ON ep.parent_id = season.id AND ep.deleted_at IS NULL AND ep.metadata_type = 4
      WHERE show.metadata_type = 2 AND show.deleted_at IS NULL
    ), events AS (
      SELECT e.showId AS itemId, s.account_id AS accountId,
             COALESCE(s.last_viewed_at, 0) AS viewedAt, COALESCE(s.view_offset, 0) AS viewOffset
      FROM episodes e
      JOIN metadata_item_settings s ON s.guid = e.guid
      WHERE s.last_viewed_at > 0 OR s.view_offset > 0
      UNION ALL
      SELECT show.id, v.account_id, v.viewed_at, 0
      FROM metadata_items show
      JOIN metadata_item_views v ON v.grandparent_guid = show.guid
      WHERE show.metadata_type = 2 AND show.deleted_at IS NULL AND v.viewed_at > 0
    )`,
};

@Injectable()
export class PlexStoredWatchService {
  /**
   * Watch state of every movie or whole show in one read-only pass, for the
   * review list. Fresh per call; a failed read throws so callers fail closed.
   */
  getReviewSnapshot(type: 'movie' | 'show'): StoredReviewSnapshot {
    const path = process.env.PLEX_DATABASE_PATH;
    if (!path)
      throw new Error(
        'PLEX_DATABASE_PATH is required for all-user stored watch state',
      );
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA query_only = ON');
      const states = new Map<string, StoredReviewState>();
      const rows = db
        .prepare(
          `${REVIEW_STATE_SQL[type]}
          SELECT e.itemId AS itemId, e.accountId AS userId,
                 COALESCE(a.name, CAST(e.accountId AS TEXT)) AS name,
                 MAX(e.viewedAt) AS viewedAt, MAX(e.viewOffset) AS viewOffset
          FROM events e
          LEFT JOIN accounts a ON a.id = e.accountId
          GROUP BY e.itemId, e.accountId, a.name
          ORDER BY e.itemId, viewedAt DESC, e.accountId`,
        )
        .all();
      for (const raw of rows) {
        const row = reviewStateRowSchema.parse(raw);
        let state = states.get(row.itemId);
        if (!state) {
          state = { watchers: [], inProgress: false };
          states.set(row.itemId, state);
        }
        if (row.viewOffset > 0) state.inProgress = true;
        if (row.viewedAt > 0)
          state.watchers.push({
            userId: row.userId,
            name: row.name,
            lastWatchedAt: new Date(row.viewedAt * 1000).toISOString(),
          });
      }
      const showSizes = new Map<string, number>();
      if (type === 'show') {
        for (const raw of db
          .prepare(
            `SELECT show.id AS itemId, SUM(COALESCE(p.size, 0)) AS size
            FROM metadata_items show
            JOIN metadata_items season ON season.parent_id = show.id AND season.deleted_at IS NULL
            JOIN metadata_items ep ON ep.parent_id = season.id AND ep.deleted_at IS NULL AND ep.metadata_type = 4
            JOIN media_items mi ON mi.metadata_item_id = ep.id AND mi.deleted_at IS NULL
            JOIN media_parts p ON p.media_item_id = mi.id AND p.deleted_at IS NULL
            WHERE show.metadata_type = 2 AND show.deleted_at IS NULL
            GROUP BY show.id`,
          )
          .all()) {
          const row = showSizeRowSchema.parse(raw);
          showSizes.set(row.itemId, row.size);
        }
      }
      return { states, showSizes };
    } finally {
      db.close();
    }
  }

  getItemIds(type: 'movie' | 'show'): string[] {
    const path = process.env.PLEX_DATABASE_PATH;
    if (!path)
      throw new Error('PLEX_DATABASE_PATH is required for target validation');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA query_only = ON');
      return db
        .prepare(
          'SELECT id FROM metadata_items WHERE metadata_type = ? AND deleted_at IS NULL ORDER BY id',
        )
        .all(type === 'movie' ? 1 : 2)
        .map((row) => z.coerce.string().parse(row.id));
    } finally {
      db.close();
    }
  }

  getWatchers(itemId: string, type: MediaItemType): ReviewWatcher[] {
    const path = process.env.PLEX_DATABASE_PATH;
    if (!path)
      throw new Error(
        'PLEX_DATABASE_PATH is required for all-user stored watch state',
      );
    if (type !== 'movie' && type !== 'show') {
      throw new Error(
        'Stored watch state supports movies and whole shows only',
      );
    }
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
      // Session history can omit another account's stored view. A zero current
      // view_count must not erase that account's last_viewed_at protection.
      const rows = db
        .prepare(
          `
        SELECT s.account_id AS userId, COALESCE(a.name, CAST(s.account_id AS TEXT)) AS name,
               MAX(s.last_viewed_at) AS viewedAt
        FROM metadata_items m
        JOIN metadata_item_settings s ON s.guid = m.guid
        LEFT JOIN accounts a ON a.id = s.account_id
        LEFT JOIN metadata_items season ON season.id = m.parent_id AND season.deleted_at IS NULL
        WHERE m.deleted_at IS NULL AND s.last_viewed_at > 0
          AND ((? = 'movie' AND m.id = ? AND m.metadata_type = 1)
            OR (? = 'show' AND m.metadata_type = 4 AND season.parent_id = ?))
        GROUP BY s.account_id, a.name
        ORDER BY viewedAt DESC, s.account_id
      `,
        )
        .all(type, itemId, type, itemId);
      return rows.map((row) => {
        const parsed = watchRowSchema.parse(row);
        return {
          userId: parsed.userId,
          name: parsed.name,
          lastWatchedAt: new Date(parsed.viewedAt * 1000).toISOString(),
        };
      });
    } finally {
      db.close();
    }
  }
}
