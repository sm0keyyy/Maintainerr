import { getRepositoryToken } from '@nestjs/typeorm';
import { Mocked, TestBed } from '@suites/unit';
import { Repository } from 'typeorm';
import { Exclusion } from '../rules/entities/exclusion.entities';
import { CollectionReviewService } from './collection-review.service';
import { Collection } from './entities/collection.entities';
import { CollectionMedia } from './entities/collection_media.entities';
import { ReviewPending } from './entities/review-pending.entities';
import {
  LeavingSoonEntry,
  ReviewLeavingSoonService,
} from './review-leaving-soon.service';
import { PlexApiService } from '../api/plex-api/plex-api.service';
import { PlexStoredWatchService } from '../api/plex-api/plex-stored-watch.service';
import { SeerrApiService } from '../api/seerr-api/seerr-api.service';
import { ServarrService } from '../api/servarr-api/servarr.service';
import { ExecutionLockService } from '../tasks/execution-lock.service';
import {
  createCollection,
  createCollectionMedia,
  createPlexMetadata,
} from '../../../test/utils/data';
import { CollectionsService } from './collections.service';

describe('Collection review', () => {
  const old = '2020-01-01T00:00:00.000Z';
  const recent = new Date(Date.now() - 30 * 86400000).toISOString();
  const collection = Object.assign(
    createCollection({
      id: 7,
      type: 'movie',
      radarrSettingsId: 1,
      sonarrSettingsId: null,
      sportarrSettingsId: null,
      listExclusions: false,
    }),
    { reviewRequired: true },
  );
  const rows = ['1', '2', '3', '4', '5'].map((mediaServerId) =>
    createCollectionMedia(collection, {
      mediaServerId,
      tmdbId: Number(mediaServerId),
      sizeBytes: Number(mediaServerId) * 1000,
    }),
  );
  let service: CollectionReviewService;
  let leavingSoon: Mocked<ReviewLeavingSoonService>;
  let stored: Mocked<PlexStoredWatchService>;
  let plex: Mocked<PlexApiService>;
  let getMovie: jest.Mock;
  let collectionService: Mocked<CollectionsService>;
  beforeEach(async () => {
    const { unit, unitRef } = await TestBed.solitary(
      CollectionReviewService,
    ).compile();
    service = unit;
    collectionService = unitRef.get(CollectionsService);
    unitRef
      .get<Repository<Collection>>(getRepositoryToken(Collection) as string)
      .findOne.mockResolvedValue(collection);
    unitRef
      .get<Repository<CollectionMedia>>(
        getRepositoryToken(CollectionMedia) as string,
      )
      .find.mockResolvedValue(rows);
    unitRef
      .get<Repository<Exclusion>>(getRepositoryToken(Exclusion) as string)
      .find.mockResolvedValue([]);
    leavingSoon = unitRef.get(ReviewLeavingSoonService);
    leavingSoon.activeIds.mockResolvedValue(new Set());
    leavingSoon.schedule.mockImplementation(
      async (_collection, entries: LeavingSoonEntry[]) =>
        entries.map((entry, index) =>
          Object.assign(new ReviewPending(), {
            id: index + 1,
            mediaServerId: entry.mediaServerId,
            title: entry.title,
            year: entry.year,
            sizeBytes: entry.sizeBytes,
            plexIds: entry.plexIds,
            arrService: entry.target.kind,
            arrSettingsId: entry.target.settingsId,
            arrId: entry.target.id,
            providerId: entry.target.providerId,
            path: entry.target.path,
            approvedAt: new Date('2026-11-24T12:00:00Z'),
            deleteAt: new Date('2026-12-08T12:00:00Z'),
          }),
        ),
    );
    stored = unitRef.get(PlexStoredWatchService);
    stored.getWatchers.mockReturnValue([
      { userId: '2', name: 'Other user', lastWatchedAt: old },
    ]);
    stored.getItemIds.mockReturnValue(rows.map((row) => row.mediaServerId));
    // The list reads every title's stored state in one pass; this fixture
    // derives it from the per-title reads approve() uses, so one mock drives
    // both. An unreadable title fails the whole pass, as one SQL read does.
    stored.getReviewSnapshot.mockImplementation((type) => ({
      states: new Map(
        stored
          .getItemIds(type)
          .map((id) => [
            id,
            { watchers: stored.getWatchers(id, type), inProgress: false },
          ]),
      ),
      showSizes: new Map(),
    }));
    plex = unitRef.get(PlexApiService);
    plex.getWatchHistory.mockResolvedValue([]);
    plex.getCorrectedUsers.mockResolvedValue([]);
    plex.getActiveSessions.mockResolvedValue([]);
    plex.getMetadataBatch.mockImplementation(async (ids) =>
      ids.map((id) =>
        createPlexMetadata({
          ratingKey: id,
          type: 'movie',
          librarySectionID: 1,
          title: `Movie ${id}`,
          guid: `plex://movie/agent${id}`,
          Guid: [{ id: `tmdb://${id}` }],
          addedAt: new Date(old).getTime() / 1000,
          Media: [
            {
              id: 1,
              duration: 1,
              bitrate: 1,
              width: 1,
              height: 1,
              aspectRatio: 1,
              audioChannels: 1,
              audioCodec: '',
              videoCodec: '',
              videoResolution: '',
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
      ),
    );
    plex.getMetadata.mockResolvedValue(
      createPlexMetadata({
        Rating: [
          { image: 'imdb://image.rating', value: 5.9, type: 'audience' },
        ],
      }),
    );
    getMovie = jest.fn().mockImplementation(async (id: number) => ({
      id,
      tmdbId: id,
      path: `/movies/${id}`,
      movieFile: { dateAdded: old },
    }));
    const radarr = {
      getMovieByTmdbId: getMovie,
      getMovies: jest.fn(async () =>
        Promise.all(rows.map((row) => getMovie(row.tmdbId))),
      ),
    } as unknown as Awaited<ReturnType<ServarrService['getRadarrApiClient']>>; // Network client boundary.
    unitRef.get(ServarrService).getRadarrApiClient.mockResolvedValue(radarr);
    unitRef.get(ExecutionLockService).tryAcquire.mockReturnValue(jest.fn());
    const seerr = unitRef.get(SeerrApiService);
    seerr.isConfigured.mockReturnValue(true);
    seerr.getRequests.mockResolvedValue([]);
    seerr.getFreshWatchlistIndex.mockResolvedValue(new Map());
  });
  it('lists largest first with size, IMDb rating, added date, last watched and each watcher', async () => {
    const result = await service.list(7);
    expect(result.candidates.map((item) => item.id)).toEqual([
      '5',
      '4',
      '3',
      '2',
      '1',
    ]);
    expect(result.candidates[0]).toMatchObject({
      id: '5',
      sizeBytes: 5000,
      imdbRating: 5.9,
      lowRated: true,
      addedAt: old,
      lastWatchedAt: old,
      watchers: [{ userId: '2', name: 'Other user', lastWatchedAt: old }],
    });
  });
  it('schedules exactly two of five into Leaving soon and deletes nothing', async () => {
    await expect(service.approve(7, ['2', '4'])).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: '2',
          status: 'scheduled',
          arrId: 2,
          sizeBytes: 2000,
          plexIds: ['2'],
          deleteAt: '2026-12-08T12:00:00.000Z',
        }),
        expect.objectContaining({ id: '4', status: 'scheduled' }),
      ],
    });
    expect(leavingSoon.schedule).toHaveBeenCalledTimes(1);
    const [scheduledCollection, entries] = leavingSoon.schedule.mock.calls[0];
    expect(scheduledCollection).toBe(collection);
    expect(entries.map((entry) => [entry.mediaServerId, entry.target])).toEqual(
      ['2', '4'].map((id) => [
        id,
        {
          kind: 'radarr',
          settingsId: 1,
          id: Number(id),
          providerId: Number(id),
          path: `/movies/${id}`,
          addedAt: old,
        },
      ]),
    );
    expect(collectionService.addLogRecord).toHaveBeenCalledWith(
      collection,
      expect.stringContaining('scheduled'),
      expect.anything(),
      expect.objectContaining({
        type: 'review_deletion',
        data: expect.objectContaining({ id: '2', status: 'scheduled' }),
      }),
    );
    leavingSoon.schedule.mockClear();
    await expect(service.approve(7, ['1', 'unknown'])).rejects.toThrow();
    expect(leavingSoon.schedule).not.toHaveBeenCalled();
  });
  it('names the title whose fresh per-title check fails', async () => {
    let reads = 0;
    getMovie.mockImplementation(async (id: number) => ({
      id,
      tmdbId: id,
      path: `/movies/${id}`,
      // The list reads every movie once; approve's own reads of 4 see a
      // replacement file.
      movieFile: { dateAdded: id === 4 && ++reads > 1 ? recent : old },
    }));
    await expect(service.approve(7, ['2', '4'])).rejects.toThrow(
      /"Movie 4" failed its fresh check/,
    );
    expect(leavingSoon.schedule).not.toHaveBeenCalled();
  });
  it('refuses a title that is already leaving soon', async () => {
    leavingSoon.activeIds.mockResolvedValue(new Set(['4']));
    await expect(service.approve(7, ['2', '4'])).rejects.toThrow(
      'already leaving soon',
    );
    expect(leavingSoon.schedule).not.toHaveBeenCalled();
  });
  it('never admits another account recent stored view, a recent file, or an unread watch state', async () => {
    stored.getWatchers.mockImplementation((id: string) => {
      return id === '1'
        ? [{ userId: '2', name: 'Other user', lastWatchedAt: recent }]
        : [];
    });
    getMovie.mockImplementation(async (id: number) => ({
      id,
      tmdbId: id,
      path: `/movies/${id}`,
      movieFile: { dateAdded: id === 2 ? recent : old },
    }));
    expect((await service.list(7)).candidates.map((item) => item.id)).toEqual([
      '5',
      '4',
      '3',
    ]);
    await expect(service.approve(7, ['1'])).rejects.toThrow();
    stored.getWatchers.mockImplementation((id: string) => {
      if (id === '3') throw new Error('unread');
      return [];
    });
    await expect(service.list(7)).rejects.toThrow();
    await expect(service.approve(7, ['4'])).rejects.toThrow();
    expect(leavingSoon.schedule).not.toHaveBeenCalled();
  });
  it('fails closed when the strict Plex session read fails', async () => {
    plex.getActiveSessions.mockRejectedValue(new Error('Plex unavailable'));
    await expect(service.approve(7, ['2'])).rejects.toThrow();
    expect(leavingSoon.schedule).not.toHaveBeenCalled();
  });

  it.each([
    { arrAction: 4, listExclusions: false },
    { arrAction: 0, listExclusions: true },
  ])('refuses an unsafe collection action %j', async (settings) => {
    const original = { ...collection };
    Object.assign(collection, settings);
    try {
      await expect(service.approve(7, ['2'])).rejects.toThrow();
      expect(leavingSoon.schedule).not.toHaveBeenCalled();
    } finally {
      Object.assign(collection, original);
    }
  });
  it('rejects mismatched resolved arr identity before scheduling', async () => {
    getMovie.mockResolvedValue({
      id: 999,
      tmdbId: 999,
      path: '/movies/wrong',
      movieFile: { dateAdded: old },
    });
    await expect(service.approve(7, ['2'])).rejects.toThrow();
    expect(leavingSoon.schedule).not.toHaveBeenCalled();
  });

  it('rejects two selected ids resolving to one canonical arr target', async () => {
    getMovie.mockImplementation(async (tmdbId: number) => ({
      id: 1,
      tmdbId,
      path: '/movies/shared',
      movieFile: { dateAdded: old },
    }));
    await expect(service.approve(7, ['2', '4'])).rejects.toThrow();
    expect(leavingSoon.schedule).not.toHaveBeenCalled();
  });
  it('protects an unselected Plex copy mapped to the same physical arr target', async () => {
    const original = plex.getMetadataBatch.getMockImplementation()!;
    stored.getItemIds.mockReturnValue(['1', '2', '3', '4', '5', '99']);
    plex.getMetadataBatch.mockImplementation(async (ids, useCache) => {
      const metadata = await original(ids, useCache);
      return metadata.map((item) =>
        item.ratingKey === '99'
          ? { ...item, Guid: [{ id: 'tmdb://2' }] }
          : item,
      );
    });
    stored.getWatchers.mockImplementation((id) =>
      id === '99'
        ? [{ userId: '2', name: 'Other user', lastWatchedAt: recent }]
        : [],
    );
    expect(
      (await service.list(7)).candidates.map((item) => item.id),
    ).not.toContain('2');
    await expect(service.approve(7, ['2'])).rejects.toThrow();
    expect(leavingSoon.schedule).not.toHaveBeenCalled();
  });
  // The Leaving soon job runs validateTarget at the arr delete boundary.
  it.each(['watch', 'replacement import'])(
    'the delete-boundary check blocks a %s that lands during the final inventory discovery',
    async (change) => {
      let changed = false;
      const readMetadata = plex.getMetadataBatch.getMockImplementation()!;
      stored.getItemIds.mockReturnValue(
        Array.from({ length: 101 }, (_, index) => String(index + 1)),
      );
      plex.getMetadataBatch.mockImplementation(async (ids, useCache) => {
        const result = await readMetadata(ids, useCache);
        if (ids.includes('101')) changed = true;
        return result;
      });
      stored.getWatchers.mockImplementation((id) =>
        change === 'watch' && changed && id === '2'
          ? [{ userId: '2', name: 'Other user', lastWatchedAt: recent }]
          : [],
      );
      getMovie.mockImplementation(async (id: number) => ({
        id,
        tmdbId: id,
        path: `/movies/${id}`,
        movieFile: {
          dateAdded: change === 'replacement import' && changed ? recent : old,
        },
      }));
      await expect(
        service.validateTarget(collection, rows[1], {
          kind: 'radarr',
          settingsId: 1,
          id: 2,
          providerId: 2,
          path: '/movies/2',
          addedAt: old,
        }),
      ).rejects.toThrow();
      expect(changed).toBe(true);
    },
  );
});
