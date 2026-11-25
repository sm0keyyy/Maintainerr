import { setTimeout as sleep } from 'node:timers/promises';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Mocked, TestBed } from '@suites/unit';
import { Repository } from 'typeorm';
import { PlexApiService } from '../api/plex-api/plex-api.service';
import {
  PlexStoredWatchService,
  StoredReviewState,
} from '../api/plex-api/plex-stored-watch.service';
import { SeerrApiService, SeerrRequest } from '../api/seerr-api/seerr-api.service';
import { ServarrService } from '../api/servarr-api/servarr.service';
import { Exclusion } from '../rules/entities/exclusion.entities';
import { ExecutionLockService } from '../tasks/execution-lock.service';
import {
  createCollection,
  createCollectionMedia,
  createPlexMetadata,
} from '../../../test/utils/data';
import { CollectionReviewService } from './collection-review.service';
import { CollectionsService } from './collections.service';
import { Collection } from './entities/collection.entities';
import { CollectionMedia } from './entities/collection_media.entities';

const old = '2020-01-01T00:00:00.000Z';
const recent = new Date(Date.now() - 30 * 86400000).toISOString();
const twoYearsAgo = new Date(Date.now() - 730 * 86400000).toISOString();

/**
 * The review list against fake Plex, Radarr, Seerr and stored state. Each
 * network fake can add latency, so a per-title read pattern shows up as time.
 */
describe('Collection review list', () => {
  let service: CollectionReviewService;
  let stored: Mocked<PlexStoredWatchService>;
  let plex: Mocked<PlexApiService>;
  let seerr: Mocked<SeerrApiService>;
  let exclusions: Mocked<Repository<Exclusion>>;
  let rowsRepo: Mocked<Repository<CollectionMedia>>;
  let latency = 0;
  let count = 5;
  let states: Map<string, StoredReviewState>;
  let requests: SeerrRequest[];
  let seerrWatchlist: Map<string, string[]>;
  let plexWatchlists: Record<string, { id: string }[] | null | undefined>;
  let radarrCollections: Record<number, { tmdbId: number; title: string }>;
  let heights: Record<number, number>;
  let getMovies: jest.Mock;
  let getMovieByTmdbId: jest.Mock;
  const collection = Object.assign(
    createCollection({
      id: 7,
      type: 'movie',
      radarrSettingsId: 1,
      sonarrSettingsId: null,
      sportarrSettingsId: null,
      listExclusions: true,
    }),
    { reviewRequired: true },
  );
  const ids = () => Array.from({ length: count }, (_, at) => String(at + 1));

  beforeEach(async () => {
    latency = 0;
    count = 5;
    states = new Map();
    requests = [];
    seerrWatchlist = new Map();
    plexWatchlists = {};
    radarrCollections = {};
    heights = {};
    const { unit, unitRef } = await TestBed.solitary(
      CollectionReviewService,
    ).compile();
    service = unit;
    unitRef
      .get<Repository<Collection>>(getRepositoryToken(Collection) as string)
      .findOne.mockResolvedValue(collection);
    rowsRepo = unitRef.get(getRepositoryToken(CollectionMedia) as string);
    rowsRepo.find.mockImplementation(async () =>
      ids().map((mediaServerId) =>
        createCollectionMedia(collection, {
          mediaServerId,
          tmdbId: Number(mediaServerId),
          ruleEvaluationFailed: false,
        }),
      ),
    );
    exclusions = unitRef.get(getRepositoryToken(Exclusion) as string);
    exclusions.find.mockResolvedValue([]);
    stored = unitRef.get(PlexStoredWatchService);
    stored.getItemIds.mockImplementation(() => ids());
    stored.getReviewSnapshot.mockImplementation(() => ({
      states,
      showSizes: new Map(),
    }));
    plex = unitRef.get(PlexApiService);
    plex.getActiveSessions.mockImplementation(async () => {
      await sleep(latency);
      return [];
    });
    plex.getCorrectedUsers.mockImplementation(async () => {
      await sleep(latency);
      return [
        { plexId: 1, username: 'owner', uuid: 'u1' },
        { plexId: 2, username: 'friend', uuid: 'u2' },
      ];
    });
    plex.getWatchlistIdsForUser.mockImplementation(async (uuid) => {
      await sleep(latency);
      return (plexWatchlists[uuid] ?? []) as never;
    });
    plex.getMetadataBatch.mockImplementation(async (keys) => {
      await sleep(latency);
      return keys.map((id) =>
        createPlexMetadata({
          ratingKey: id,
          type: 'movie',
          title: `Movie ${id}`,
          librarySectionID: 1,
          guid: `plex://movie/agent${id}`,
          Guid: [{ id: `tmdb://${id}` }],
          addedAt: new Date(old).getTime() / 1000,
          Media: [
            {
              id: 1,
              duration: 1,
              bitrate: 1,
              width: 1,
              height: heights[Number(id)] ?? 1080,
              aspectRatio: 1,
              audioChannels: 1,
              audioCodec: '',
              videoCodec: '',
              videoResolution: heights[Number(id)] >= 2160 ? '4k' : '1080',
              container: '',
              videoFrameRate: '',
              videoProfile: '',
              Part: [
                {
                  id: 1,
                  container: '',
                  size: Number(id) * 1000,
                  file: `/movies/${id}/movie.mkv`,
                },
              ],
            },
          ],
        }),
      );
    });
    plex.getMetadata.mockImplementation(async () => {
      await sleep(latency);
      return createPlexMetadata({
        Rating: [{ image: 'imdb://image.rating', value: 7.1, type: 'audience' }],
      });
    });
    getMovies = jest.fn(async () => {
      await sleep(latency);
      return ids().map((id) => ({
        id: Number(id),
        tmdbId: Number(id),
        path: `/movies/${id}`,
        movieFile: { dateAdded: old },
        ratings: { imdb: { votes: 100, value: Number(id) % 2 ? 5.5 : 7.5 } },
        collection: radarrCollections[Number(id)],
      }));
    });
    getMovieByTmdbId = jest.fn();
    unitRef.get(ServarrService).getRadarrApiClient.mockResolvedValue({
      getMovies,
      getMovieByTmdbId,
    } as never); // Network client boundary.
    seerr = unitRef.get(SeerrApiService);
    seerr.isConfigured.mockReturnValue(true);
    seerr.getRequests.mockImplementation(async () => {
      await sleep(latency);
      return requests;
    });
    seerr.getFreshWatchlistIndex.mockImplementation(async () => {
      await sleep(latency);
      return seerrWatchlist;
    });
    unitRef.get(ExecutionLockService).tryAcquire.mockReturnValue(jest.fn());
    unitRef.get(CollectionsService).CollectionLogRecordForChild.mockResolvedValue(
      undefined,
    );
  });

  const listed = async () =>
    (await service.list(7)).candidates.map((item) => item.id);

  it('lists every unprotected title biggest first with IMDb rating, low rating and nothing else', async () => {
    const review = await service.list(7);
    expect(review.candidates.map((item) => item.id)).toEqual([
      '5',
      '4',
      '3',
      '2',
      '1',
    ]);
    expect(review.candidates[0]).toMatchObject({
      sizeBytes: 5000,
      imdbRating: 5.5,
      lowRated: true,
      addedAt: old,
      lastWatchedAt: null,
      watchers: [],
      group: null,
      is4k: false,
    });
    expect(review.candidates[1]).toMatchObject({ imdbRating: 7.5, lowRated: false });
    expect(review.unavailableIds).toEqual([]);
  });

  it('hides a title requested in Seerr in the past year, but not one requested earlier', async () => {
    requests = [
      { type: 'movie', createdAt: recent, media: { tmdbId: 2 } },
      { type: 'movie', createdAt: twoYearsAgo, media: { tmdbId: 3 } },
    ] as SeerrRequest[];
    expect(await listed()).toEqual(['5', '4', '3', '1']);
  });

  it('fails the list rather than hide a protection when Seerr cannot be read', async () => {
    seerr.getRequests.mockResolvedValue(undefined);
    await expect(service.list(7)).rejects.toThrow();
  });

  it("hides a title on any Plex user's watchlist or any Seerr watchlist", async () => {
    plexWatchlists = { u2: [{ id: 'agent4' }], u1: null };
    seerrWatchlist = new Map([['movie:1', ['friend']]]);
    expect(await listed()).toEqual(['5', '3', '2']);
  });

  it('fails the list when a Plex watchlist read fails', async () => {
    plexWatchlists = { u2: undefined };
    plex.getWatchlistIdsForUser.mockImplementation(async (uuid) =>
      uuid === 'u2' ? undefined : [],
    );
    await expect(service.list(7)).rejects.toThrow();
  });

  it('hides a title any user stopped part-way through, however long ago', async () => {
    states.set('3', {
      inProgress: true,
      watchers: [{ userId: '9', name: 'friend', lastWatchedAt: twoYearsAgo }],
    });
    states.set('2', {
      inProgress: false,
      watchers: [{ userId: '9', name: 'friend', lastWatchedAt: twoYearsAgo }],
    });
    const review = await service.list(7);
    expect(review.candidates.map((item) => item.id)).toEqual(['5', '4', '2', '1']);
    expect(review.candidates[2]).toMatchObject({
      lastWatchedAt: twoYearsAgo,
      watchers: [{ name: 'friend', lastWatchedAt: twoYearsAgo }],
    });
  });

  it('hides a title watched by anyone in the last year', async () => {
    states.set('4', {
      inProgress: false,
      watchers: [{ userId: '9', name: 'friend', lastWatchedAt: recent }],
    });
    expect(await listed()).toEqual(['5', '3', '2', '1']);
  });

  it('keeps a title forever: a global exclusion, and the list no longer shows it', async () => {
    exclusions.findOne.mockResolvedValue(null);
    await service.keep(7, ['5']);
    expect(exclusions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaServerId: '5',
        ruleGroupId: null,
        type: 'movie',
      }),
    );
    exclusions.find.mockResolvedValue([
      { id: 1, mediaServerId: '5', ruleGroupId: null, parent: '5', type: 'movie' },
    ] as Exclusion[]);
    expect(await listed()).toEqual(['4', '3', '2', '1']);
  });

  it('refuses to keep a title outside the collection', async () => {
    await expect(service.keep(7, ['99'])).rejects.toThrow();
    expect(exclusions.save).not.toHaveBeenCalled();
  });

  it('marks movies of one TMDB collection with the same group and keeps each its own row', async () => {
    radarrCollections = {
      1: { tmdbId: 500, title: 'Saga Collection' },
      4: { tmdbId: 500, title: 'Saga Collection' },
    };
    const review = await service.list(7);
    const byId = new Map(review.candidates.map((item) => [item.id, item]));
    expect(byId.get('1')!.group).toEqual({ id: 'tmdb:500', title: 'Saga Collection' });
    expect(byId.get('4')!.group).toEqual({ id: 'tmdb:500', title: 'Saga Collection' });
    expect(byId.get('2')!.group).toBeNull();
    expect(review.candidates).toHaveLength(5);
  });

  it('lists a 4K copy as a candidate and flags it', async () => {
    heights = { 3: 2160 };
    const review = await service.list(7);
    expect(review.candidates.find((item) => item.id === '3')).toMatchObject({
      is4k: true,
    });
  });

  it('fills a rating Radarr lacks from Plex', async () => {
    getMovies.mockImplementation(async () =>
      ids().map((id) => ({
        id: Number(id),
        tmdbId: Number(id),
        path: `/movies/${id}`,
        movieFile: { dateAdded: old },
        ratings: {},
      })),
    );
    const review = await service.list(7);
    expect(review.candidates[0]).toMatchObject({ imdbRating: 7.1, lowRated: false });
  });

  it('answers 1,300 titles quickly with batched reads, even at 25 ms per call', async () => {
    count = 1300;
    latency = 25;
    const started = performance.now();
    const review = await service.list(7);
    const cold = performance.now() - started;
    expect(review.candidates).toHaveLength(1300);
    expect(review.candidates[0].id).toBe('1300');
    // 13 Plex batches of 100, 4 at a time; one Radarr, Seerr and session read.
    expect(plex.getMetadataBatch.mock.calls.length).toBe(13);
    expect(getMovies).toHaveBeenCalledTimes(1);
    expect(getMovieByTmdbId).not.toHaveBeenCalled();
    expect(plex.getWatchHistory).not.toHaveBeenCalled();
    expect(plex.getMetadata).not.toHaveBeenCalled();
    expect(cold).toBeLessThan(3000);

    const again = performance.now();
    await service.list(7);
    const warm = performance.now() - again;
    // Inventory and Radarr come from the cache; watch state, sessions,
    // requests and watchlists are read again.
    expect(plex.getMetadataBatch.mock.calls.length).toBe(13);
    expect(stored.getReviewSnapshot).toHaveBeenCalledTimes(2);
    expect(seerr.getRequests).toHaveBeenCalledTimes(2);
    expect(warm).toBeLessThan(1000);
    // eslint-disable-next-line no-console
    console.log(
      `review list, 1300 titles, 25 ms/call: cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms`,
    );
  });
});
