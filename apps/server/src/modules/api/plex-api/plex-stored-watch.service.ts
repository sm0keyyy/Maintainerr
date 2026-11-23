import { MediaItemType, ReviewWatcher } from '@maintainerr/contracts';
import { Injectable } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const watchRowSchema = z.object({
  userId: z.coerce.string(),
  name: z.string(),
  viewedAt: z.number().finite().positive(),
});

@Injectable()
export class PlexStoredWatchService {
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
