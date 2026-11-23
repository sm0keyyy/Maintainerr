import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PlexStoredWatchService } from './plex-stored-watch.service';

describe('Plex stored per-user watch state', () => {
  let directory: string;
  let oldPath: string | undefined;
  beforeEach(() => {
    directory = mkdtempSync(join(process.cwd(), 'review-watch-test-'));
    oldPath = process.env.PLEX_DATABASE_PATH;
    process.env.PLEX_DATABASE_PATH = join(directory, 'plex.db');
    const db = new DatabaseSync(process.env.PLEX_DATABASE_PATH);
    db.exec(`
      CREATE TABLE metadata_items (id INTEGER, guid TEXT, metadata_type INTEGER, parent_id INTEGER, deleted_at INTEGER);
      CREATE TABLE metadata_item_settings (guid TEXT, account_id INTEGER, view_count INTEGER, last_viewed_at INTEGER);
      CREATE TABLE accounts (id INTEGER, name TEXT);
      INSERT INTO accounts VALUES (1, 'Owner'), (2, 'Other user');
      INSERT INTO metadata_items VALUES (1, 'movie', 1, NULL, NULL), (10, 'show', 2, NULL, NULL), (11, 'season', 3, 10, NULL), (12, 'episode', 4, 11, NULL), (13, 'deleted-episode', 4, 11, 1);
      INSERT INTO metadata_item_settings VALUES ('movie', 2, 0, 1790000000), ('episode', 2, 1, 1780000000), ('deleted-episode', 1, 1, 1800000000);
    `);
    db.close();
  });
  afterEach(() => {
    if (oldPath === undefined) delete process.env.PLEX_DATABASE_PATH;
    else process.env.PLEX_DATABASE_PATH = oldPath;
    rmSync(directory, { recursive: true });
  });
  it('includes another account stored date even with zero views and rolls shows up from current episodes', () => {
    const service = new PlexStoredWatchService();
    expect(service.getItemIds('movie')).toEqual(['1']);
    expect(service.getItemIds('show')).toEqual(['10']);
    expect(service.getWatchers('1', 'movie')).toEqual([
      {
        userId: '2',
        name: 'Other user',
        lastWatchedAt: '2026-09-21T14:13:20.000Z',
      },
    ]);
    expect(service.getWatchers('10', 'show')).toEqual([
      {
        userId: '2',
        name: 'Other user',
        lastWatchedAt: '2026-05-28T20:26:40.000Z',
      },
    ]);
    expect(() => service.getWatchers('999', 'movie')).toThrow();
    const db = new DatabaseSync(process.env.PLEX_DATABASE_PATH!);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM metadata_items').get(),
    ).toEqual({ n: 5 });
    db.close();
  });
});
