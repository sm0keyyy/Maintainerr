import { getRepositoryToken } from '@nestjs/typeorm';
import { Mocked, TestBed } from '@suites/unit';
import { Repository } from 'typeorm';
import { IMediaServerService } from '../api/media-server/media-server.interface';
import { Exclusion } from '../rules/entities/exclusion.entities';
import { CollectionReviewService } from './collection-review.service';
import { Collection } from './entities/collection.entities';
import { CollectionMedia } from './entities/collection_media.entities';
import { CollectionHandler } from './collection-handler';
import { MediaServerFactory } from '../api/media-server/media-server.factory';
import { PlexApiService } from '../api/plex-api/plex-api.service';
import { PlexStoredWatchService } from '../api/plex-api/plex-stored-watch.service';
import { ServarrService } from '../api/servarr-api/servarr.service';
import { ExecutionLockService } from '../tasks/execution-lock.service';
import {
  createCollection,
  createCollectionMedia,
  createMediaItem,
  createPlexMetadata,
} from '../../../test/utils/data';

describe('Collection review', () => {
  const old = '2020-01-01T00:00:00.000Z';
  const recent = new Date(Date.now() - 30 * 86400000).toISOString();
  const collection = Object.assign(
    createCollection({ id: 7, type: 'movie', radarrSettingsId: 1 }),
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
  let handler: Mocked<CollectionHandler>;
  let stored: Mocked<PlexStoredWatchService>;
  let plex: Mocked<PlexApiService>;
  let getMovie: jest.Mock;
  beforeEach(async () => {
    const { unit, unitRef } = await TestBed.solitary(
      CollectionReviewService,
    ).compile();
    service = unit;
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
    handler = unitRef.get(CollectionHandler);
    handler.handleMedia.mockResolvedValue('handled');
    stored = unitRef.get(PlexStoredWatchService);
    stored.getWatchers.mockReturnValue([
      { userId: '2', name: 'Other user', lastWatchedAt: old },
    ]);
    plex = unitRef.get(PlexApiService);
    plex.getWatchHistory.mockResolvedValue([]);
    plex.getCorrectedUsers.mockResolvedValue([]);
    plex.getMetadata.mockResolvedValue(
      createPlexMetadata({
        Rating: [
          { image: 'imdb://image.rating', value: 5.9, type: 'audience' },
        ],
      }),
    );
    const mediaServer = {
      getMetadata: jest.fn(async (id: string) =>
        createMediaItem({
          id,
          type: 'movie',
          addedAt: new Date(old),
          ratings: [{ source: 'audience', value: 9 }],
          mediaSources: [
            { id: 'file', duration: 0, sizeBytes: Number(id) * 1000 },
          ],
        }),
      ),
      getActiveSessions: jest.fn().mockResolvedValue(new Set()),
    } as unknown as IMediaServerService; // Only the read boundary used by this fixture.
    unitRef.get(MediaServerFactory).getService.mockResolvedValue(mediaServer);
    getMovie = jest.fn().mockResolvedValue({ movieFile: { dateAdded: old } });
    const radarr = { getMovieByTmdbId: getMovie } as unknown as Awaited<
      ReturnType<ServarrService['getRadarrApiClient']>
    >; // Network client boundary.
    unitRef.get(ServarrService).getRadarrApiClient.mockResolvedValue(radarr);
    unitRef.get(ExecutionLockService).tryAcquire.mockReturnValue(jest.fn());
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
  it('approves exactly two of five and rejects an out-of-collection selection before any action', async () => {
    await expect(service.approve(7, ['2', '4'])).resolves.toEqual({
      handledIds: ['2', '4'],
      failedIds: [],
    });
    expect(
      handler.handleMedia.mock.calls.map((call) => call[1].mediaServerId),
    ).toEqual(['2', '4']);
    handler.handleMedia.mockClear();
    await expect(service.approve(7, ['1', 'unknown'])).rejects.toThrow();
    expect(handler.handleMedia).not.toHaveBeenCalled();
  });
  it('never admits another account recent stored view, a recent file, or an unread watch state', async () => {
    stored.getWatchers.mockImplementation((id: string) => {
      if (id === '3') throw new Error('unread');
      return id === '1'
        ? [{ userId: '2', name: 'Other user', lastWatchedAt: recent }]
        : [];
    });
    getMovie.mockImplementation(async (id: number) => ({
      movieFile: { dateAdded: id === 2 ? recent : old },
    }));
    expect((await service.list(7)).candidates.map((item) => item.id)).toEqual([
      '5',
      '4',
    ]);
    await expect(service.approve(7, ['1'])).rejects.toThrow();
    expect(handler.handleMedia).not.toHaveBeenCalled();
  });
});
