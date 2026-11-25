import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PlexStoredWatchService } from './plex-stored-watch.service';

describe('Plex stored review snapshot', () => {
  let directory: string;
  let oldPath: string | undefined;
  beforeEach(() => {
    directory = mkdtempSync(join(process.cwd(), 'review-snapshot-test-'));
    oldPath = process.env.PLEX_DATABASE_PATH;
    process.env.PLEX_DATABASE_PATH = join(directory, 'plex.db');
    const db = new DatabaseSync(process.env.PLEX_DATABASE_PATH);
    db.exec(`
      CREATE TABLE metadata_items (id INTEGER, guid TEXT, metadata_type INTEGER, parent_id INTEGER, deleted_at INTEGER);
      CREATE TABLE metadata_item_settings (guid TEXT, account_id INTEGER, view_count INTEGER, last_viewed_at INTEGER, view_offset INTEGER);
      CREATE TABLE metadata_item_views (guid TEXT, grandparent_guid TEXT, account_id INTEGER, viewed_at INTEGER);
      CREATE TABLE accounts (id INTEGER, name TEXT);
      CREATE TABLE media_items (id INTEGER, metadata_item_id INTEGER, deleted_at INTEGER);
      CREATE TABLE media_parts (id INTEGER, media_item_id INTEGER, size INTEGER, deleted_at INTEGER);
      INSERT INTO accounts VALUES (1, 'Owner'), (2, 'Other user');
      INSERT INTO metadata_items VALUES
        (1, 'movie-watched', 1, NULL, NULL),
        (2, 'movie-paused', 1, NULL, NULL),
        (3, 'movie-history', 1, NULL, NULL),
        (4, 'movie-untouched', 1, NULL, NULL),
        (10, 'show', 2, NULL, NULL), (11, 'season', 3, 10, NULL),
        (12, 'episode-a', 4, 11, NULL), (13, 'episode-b', 4, 11, NULL),
        (14, 'episode-gone', 4, 11, 1);
      INSERT INTO metadata_item_settings VALUES
        ('movie-watched', 2, 0, 1790000000, 0),
        ('movie-watched', 1, 1, 1700000000, 0),
        ('movie-paused', 2, 0, NULL, 120000),
        ('episode-b', 1, 0, 1780000000, 5000),
        ('episode-gone', 2, 1, 1800000000, 0);
      INSERT INTO metadata_item_views VALUES
        ('movie-history', NULL, 2, 1795000000),
        ('episode-a', 'show', 2, 1785000000);
      INSERT INTO media_items VALUES (100, 12, NULL), (101, 13, NULL), (102, 14, NULL);
      INSERT INTO media_parts VALUES (200, 100, 1000, NULL), (201, 101, 2500, NULL), (202, 102, 9999, NULL);
    `);
    db.close();
  });
  afterEach(() => {
    if (oldPath === undefined) delete process.env.PLEX_DATABASE_PATH;
    else process.env.PLEX_DATABASE_PATH = oldPath;
    rmSync(directory, { recursive: true });
  });

  it('reads every movie: each account newest first, a resume point as in progress, and play history', () => {
    const { states, showSizes } =
      new PlexStoredWatchService().getReviewSnapshot('movie');
    expect(states.get('1')).toEqual({
      inProgress: false,
      watchers: [
        {
          userId: '2',
          name: 'Other user',
          lastWatchedAt: '2026-09-21T14:13:20.000Z',
        },
        {
          userId: '1',
          name: 'Owner',
          lastWatchedAt: '2023-11-14T22:13:20.000Z',
        },
      ],
    });
    expect(states.get('2')).toEqual({ inProgress: true, watchers: [] });
    expect(states.get('3')).toEqual({
      inProgress: false,
      watchers: [
        {
          userId: '2',
          name: 'Other user',
          lastWatchedAt: '2026-11-18T11:06:40.000Z',
        },
      ],
    });
    expect(states.has('4')).toBe(false);
    expect(showSizes.size).toBe(0);
  });

  it('rolls whole shows up from current episodes, history and resume points, with file sizes', () => {
    const { states, showSizes } =
      new PlexStoredWatchService().getReviewSnapshot('show');
    expect(states.get('10')).toEqual({
      inProgress: true,
      watchers: [
        {
          userId: '2',
          name: 'Other user',
          lastWatchedAt: '2026-07-25T17:20:00.000Z',
        },
        {
          userId: '1',
          name: 'Owner',
          lastWatchedAt: '2026-05-28T20:26:40.000Z',
        },
      ],
    });
    expect(showSizes.get('10')).toBe(3500);
  });
});
