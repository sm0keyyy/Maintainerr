import { ServarrAction } from '@maintainerr/contracts';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Mocked, TestBed } from '@suites/unit';
import { Repository } from 'typeorm';
import {
  createCollection,
  createCollectionMedia,
  createMediaItem,
} from '../../../test/utils/data';
import { PlexLibraryItem } from '../api/plex-api/interfaces/library.interfaces';
import { PlexApiService } from '../api/plex-api/plex-api.service';
import {
  PlexStoredWatchService,
  StoredReviewState,
} from '../api/plex-api/plex-stored-watch.service';
import { SeerrApiService } from '../api/seerr-api/seerr-api.service';
import { ServarrService } from '../api/servarr-api/servarr.service';
import { MetadataService } from '../metadata/metadata.service';
import { ExecutionLockService } from '../tasks/execution-lock.service';
import { CollectionHandler } from './collection-handler';
import {
  CollectionReviewService,
  ReviewTargetRefused,
} from './collection-review.service';
import { CollectionsService } from './collections.service';
import { Collection } from './entities/collection.entities';
import { CollectionMedia } from './entities/collection_media.entities';
import { ReviewPending } from './entities/review-pending.entities';
import { ReviewDeletionJobService } from './review-deletion-job.service';
import { ReviewLeavingSoonService } from './review-leaving-soon.service';
import { ReviewProtections } from './review-list';
import { ReviewWatchActivityService } from './review-watch-activity.service';

describe('Leaving soon daily job', () => {
  const day = 86400000;
  const now = new Date('2026-12-09T09:30:00Z');
  const approvedAt = new Date(now.getTime() - 15 * day);
  const collection = createCollection({
    id: 1,
    type: 'movie',
    libraryId: '1',
    reviewRequired: true,
    arrAction: ServarrAction.DELETE,
    listExclusions: false,
    radarrSettingsId: 1,
    sonarrSettingsId: null,
    sportarrSettingsId: null,
  });
  const membership = createCollectionMedia(collection, {
    mediaServerId: '777',
    tmdbId: 603,
  });
  const plexCopy = createMediaItem({
    id: '777',
    type: 'movie',
    guid: 'plex://movie/5d7768258801970020c96c58',
    providerIds: { tmdb: ['603'] },
  });
  const deletedNote =
    'Deleted through Radarr into its recycle bin /data/recycle-bin/radarr (7-day cleanup); Seerr cleared';
  const pendingRow = (overrides: Partial<ReviewPending> = {}): ReviewPending =>
    Object.assign(new ReviewPending(), {
      id: 10,
      collectionId: 1,
      mediaServerId: '777',
      title: 'The Matrix',
      year: 1999,
      arrService: 'radarr',
      arrSettingsId: 1,
      arrId: 42,
      providerId: 603,
      path: '/data/library/movies/The Matrix (1999)',
      addedAt: '2020-01-01T00:00:00.000Z',
      sizeBytes: 12_000_000_000,
      plexIds: ['777'],
      libraryId: '1',
      plexCollectionId: '9001',
      approvedAt,
      deleteAt: new Date(approvedAt.getTime() + 14 * day),
      status: 'pending',
      resolvedAt: null,
      note: null,
      seerr: null,
      verifiedAt: null,
      ...overrides,
    });

  let job: ReviewDeletionJobService;
  let leavingSoon: Mocked<ReviewLeavingSoonService>;
  let activity: Mocked<ReviewWatchActivityService>;
  let stored: Mocked<PlexStoredWatchService>;
  let plex: Mocked<PlexApiService>;
  let handler: Mocked<CollectionHandler>;
  let seerr: Mocked<SeerrApiService>;
  let review: Mocked<CollectionReviewService>;
  let media: Mocked<Repository<CollectionMedia>>;
  let collectionService: Mocked<CollectionsService>;
  let arrDelete: jest.Mock;
  let events: Mocked<EventEmitter2>;
  let getRecycleBin: jest.Mock;
  let getMovieByTmdbId: jest.Mock;
  let states: Map<string, StoredReviewState>;
  let protections: ReviewProtections;

  beforeEach(async () => {
    const { unit, unitRef } = await TestBed.solitary(
      ReviewDeletionJobService,
    ).compile();
    job = unit;
    unitRef
      .get<Repository<Collection>>(getRepositoryToken(Collection) as string)
      .findOne.mockResolvedValue(collection);
    media = unitRef.get(getRepositoryToken(CollectionMedia) as string);
    media.findOne.mockResolvedValue(membership);
    leavingSoon = unitRef.get(ReviewLeavingSoonService);
    leavingSoon.transition.mockResolvedValue(true);
    leavingSoon.release.mockResolvedValue(true);
    leavingSoon.interruptedRows.mockResolvedValue([]);
    leavingSoon.unverifiedDeletedRows.mockResolvedValue([]);
    leavingSoon.children.mockResolvedValue(new Set(['777']));
    activity = unitRef.get(ReviewWatchActivityService);
    activity.activitySince.mockReturnValue([]);
    states = new Map();
    stored = unitRef.get(PlexStoredWatchService);
    stored.getReviewSnapshot.mockImplementation(() => ({
      states,
      showSizes: new Map(),
    }));
    stored.getItemIds.mockReturnValue([]);
    stored.getPartFiles.mockReturnValue([
      '/movies/The Matrix (1999)/The Matrix (1999).mkv',
    ]);
    plex = unitRef.get(PlexApiService);
    plex.getActiveSessions.mockResolvedValue([]);
    plex.getWatchHistory.mockResolvedValue([]);
    protections = {
      requested: new Set(),
      requestedTvdb: new Set(),
      plexWatchlist: new Set(),
      seerrWatchlist: new Set(),
    };
    review = unitRef.get(CollectionReviewService);
    review.validateTarget.mockResolvedValue(['777']);
    review.inventory.mockResolvedValue([plexCopy]);
    review.reviewProtections.mockImplementation(async () => protections);
    seerr = unitRef.get(SeerrApiService);
    seerr.isConfigured.mockReturnValue(true);
    seerr.removeMediaByTmdbId.mockResolvedValue(true);
    getRecycleBin = jest
      .fn()
      .mockResolvedValue({ path: '/data/recycle-bin/radarr', cleanupDays: 7 });
    getMovieByTmdbId = jest.fn().mockResolvedValue({
      id: 42,
      tmdbId: 603,
      movieFile: { relativePath: 'The Matrix (1999).mkv' },
    });
    unitRef.get(ServarrService).getRadarrApiClient.mockResolvedValue({
      getRecycleBin,
      getMovieByTmdbId,
    } as never); // Network client boundary.
    unitRef
      .get(MetadataService)
      .resolveIdsForService.mockResolvedValue({ tmdb: 603, type: 'movie' });
    collectionService = unitRef.get(CollectionsService);
    events = unitRef.get(EventEmitter2);
    events.emitAsync.mockResolvedValue([]);
    unitRef.get(ExecutionLockService).tryAcquire.mockReturnValue(jest.fn());
    // The handler stands in for the Radarr action: it runs the final check,
    // sends the one delete, and reports what Radarr answered.
    arrDelete = jest.fn().mockResolvedValue('deleted');
    handler = unitRef.get(CollectionHandler);
    handler.handleMedia.mockImplementation(
      async (_collection, _row, _reads, approval) => {
        await approval!.beforeDelete();
        const outcome = await arrDelete(approval!.target.id);
        await approval!.recordOutcome(outcome);
        return outcome === 'deleted' ? 'handled' : 'failed';
      },
    );
  });

  it('saves a pending title that another user watched since approval', async () => {
    const row = pendingRow();
    leavingSoon.pendingRows.mockResolvedValue([row]);
    activity.activitySince.mockReturnValue([
      { userId: '5', name: 'kid', at: approvedAt.getTime() + 3 * day },
    ]);

    const summary = await job.run(now);

    expect(activity.activitySince).toHaveBeenCalledWith(
      '777',
      'movie',
      approvedAt.getTime(),
    );
    expect(leavingSoon.release).toHaveBeenCalledWith(
      row,
      'saved',
      expect.stringContaining('Watched by kid'),
      'pending',
    );
    expect(summary.saved).toHaveLength(1);
    expect(handler.handleMedia).not.toHaveBeenCalled();
    expect(arrDelete).not.toHaveBeenCalled();
  });

  it('saves a title that is playing right now', async () => {
    const row = pendingRow();
    leavingSoon.pendingRows.mockResolvedValue([row]);
    plex.getActiveSessions.mockResolvedValue([
      { ratingKey: '777' } as PlexLibraryItem,
    ]);
    await job.run(now);
    expect(leavingSoon.release).toHaveBeenCalledWith(
      row,
      'saved',
      'Playing on Plex',
      'pending',
    );
    expect(handler.handleMedia).not.toHaveBeenCalled();
  });

  it('deletes an unwatched title at its date through the bound arr target, clears Seerr and audits it', async () => {
    const row = pendingRow();
    leavingSoon.pendingRows.mockResolvedValue([row]);

    const summary = await job.run(now);

    expect(leavingSoon.transition).toHaveBeenNthCalledWith(
      1,
      row,
      'pending',
      'deleting',
    );
    expect(handler.handleMedia).toHaveBeenCalledTimes(1);
    const [usedCollection, usedRow, , approval] =
      handler.handleMedia.mock.calls[0];
    expect(usedCollection).toBe(collection);
    expect(usedRow).toBe(membership);
    expect(approval!.target).toEqual({
      kind: 'radarr',
      settingsId: 1,
      id: 42,
      providerId: 603,
      path: '/data/library/movies/The Matrix (1999)',
      addedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(arrDelete).toHaveBeenCalledWith(42);
    // Re-checked before the decision and again at the delete boundary, both
    // against the one inventory read of this run.
    expect(review.validateTarget).toHaveBeenCalledTimes(2);
    expect(review.inventory).toHaveBeenCalledTimes(1);
    expect(review.validateTarget.mock.calls[1][3]).toEqual([plexCopy]);
    expect(seerr.removeMediaByTmdbId).toHaveBeenCalledWith(603, 'movie');
    expect(leavingSoon.removeFromPlex).toHaveBeenCalledWith('9001', '777');
    expect(leavingSoon.transition).toHaveBeenLastCalledWith(
      row,
      'deleting',
      'deleted',
      { note: deletedNote, seerr: 'cleared' },
    );
    const audits = collectionService.addLogRecord.mock.calls.map(
      (call) => call[3],
    );
    expect(audits.at(-1)).toEqual({
      type: 'review_deletion',
      data: expect.objectContaining({
        id: '777',
        title: 'The Matrix',
        arrService: 'radarr',
        arrId: 42,
        providerId: 603,
        plexIds: ['777'],
        path: '/data/library/movies/The Matrix (1999)',
        sizeBytes: 12_000_000_000,
        status: 'deleted',
        seerr: 'cleared',
        at: expect.any(String),
      }),
    });
    expect(summary.deleted).toEqual([
      { title: 'The Matrix', detail: deletedNote },
    ]);
  });

  it('reports a Seerr failure without hiding the completed arr delete', async () => {
    leavingSoon.pendingRows.mockResolvedValue([pendingRow()]);
    seerr.removeMediaByTmdbId.mockResolvedValue(undefined);
    await job.run(now);
    expect(leavingSoon.transition).toHaveBeenLastCalledWith(
      expect.anything(),
      'deleting',
      'deleted',
      expect.objectContaining({ seerr: 'failed' }),
    );
  });

  it('never deletes a title before its date', async () => {
    leavingSoon.pendingRows.mockResolvedValue([
      pendingRow({ deleteAt: new Date(now.getTime() + 1000) }),
    ]);
    await job.run(now);
    expect(handler.handleMedia).not.toHaveBeenCalled();
    expect(leavingSoon.transition).not.toHaveBeenCalled();
  });

  it('never deletes an unapproved review member: only pending rows reach the arr', async () => {
    // The review collection has members, but nothing was approved.
    media.find.mockResolvedValue([membership]);
    leavingSoon.pendingRows.mockResolvedValue([]);
    await job.run(now);
    expect(handler.handleMedia).not.toHaveBeenCalled();
    expect(seerr.removeMediaByTmdbId).not.toHaveBeenCalled();
  });

  it('keeps a due title pending when watch state cannot be read', async () => {
    const row = pendingRow();
    leavingSoon.pendingRows.mockResolvedValue([row]);
    activity.activitySince.mockImplementation(() => {
      throw new Error('database locked');
    });
    const summary = await job.run(now);
    expect(handler.handleMedia).not.toHaveBeenCalled();
    expect(leavingSoon.note).toHaveBeenCalledWith(
      row,
      'Waiting: Watch state unread: database locked',
    );
    expect(summary.waiting).toHaveLength(1);
  });

  it('keeps every due title when Plex sessions cannot be read', async () => {
    leavingSoon.pendingRows.mockResolvedValue([pendingRow()]);
    plex.getActiveSessions.mockRejectedValue(new Error('Plex down'));
    await job.run(now);
    expect(handler.handleMedia).not.toHaveBeenCalled();
  });

  it('keeps a due title pending when the collection no longer allows deletion', async () => {
    const original = { ...collection };
    Object.assign(collection, { arrAction: ServarrAction.DO_NOTHING });
    try {
      leavingSoon.pendingRows.mockResolvedValue([pendingRow()]);
      await job.run(now);
      expect(handler.handleMedia).not.toHaveBeenCalled();
      expect(leavingSoon.note).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('no longer allows deletion'),
      );
    } finally {
      Object.assign(collection, original);
    }
  });

  it('does not delete a title that left the review collection', async () => {
    const row = pendingRow();
    leavingSoon.pendingRows.mockResolvedValue([row]);
    media.findOne.mockResolvedValue(null);
    await job.run(now);
    expect(handler.handleMedia).not.toHaveBeenCalled();
    expect(leavingSoon.release).toHaveBeenCalledWith(
      row,
      'not-deleted',
      'Not deleted: no longer in the review collection',
      'pending',
    );
  });

  it('puts the title back to pending when a transient final check fails before any arr request', async () => {
    const row = pendingRow();
    leavingSoon.pendingRows.mockResolvedValue([row]);
    review.validateTarget
      .mockResolvedValueOnce(['777'])
      .mockRejectedValueOnce(new Error('Incomplete Plex metadata read'));
    await job.run(now);
    expect(arrDelete).not.toHaveBeenCalled();
    expect(leavingSoon.transition).toHaveBeenLastCalledWith(
      row,
      'deleting',
      'pending',
      { note: 'Waiting: Incomplete Plex metadata read' },
    );
    expect(seerr.removeMediaByTmdbId).not.toHaveBeenCalled();
  });

  it('records an uncertain arr answer as final and never retries it', async () => {
    const row = pendingRow();
    leavingSoon.pendingRows.mockResolvedValue([row]);
    arrDelete.mockResolvedValue('uncertain');
    const summary = await job.run(now);
    expect(leavingSoon.transition).toHaveBeenLastCalledWith(
      row,
      'deleting',
      'uncertain',
      expect.objectContaining({ seerr: null }),
    );
    expect(seerr.removeMediaByTmdbId).not.toHaveBeenCalled();
    expect(summary.uncertain).toHaveLength(1);
  });

  it('records the arr delete before cleanup and keeps cleanup failure accounting', async () => {
    const row = pendingRow();
    leavingSoon.pendingRows.mockResolvedValue([row]);
    handler.handleMedia.mockImplementation(
      async (_collection, _row, _reads, approval) => {
        await approval!.beforeDelete();
        await approval!.recordOutcome('deleted');
        throw new Error('Plex rescan failed after arr deletion');
      },
    );
    const summary = await job.run(now);
    expect(
      collectionService.addLogRecord.mock.calls.map(
        (call) => call[3].type === 'review_deletion' && call[3].data.status,
      ),
    ).toEqual(['deleted', 'deleted-with-cleanup-failure']);
    expect(leavingSoon.transition).toHaveBeenLastCalledWith(
      row,
      'deleting',
      'deleted-with-cleanup-failure',
      expect.objectContaining({
        note: expect.stringContaining('Plex rescan failed'),
        seerr: 'cleared',
      }),
    );
    expect(summary.cleanupFailed).toHaveLength(1);
  });

  it('skips a title another actor claimed first, e.g. a cancel', async () => {
    leavingSoon.pendingRows.mockResolvedValue([pendingRow()]);
    leavingSoon.transition.mockResolvedValueOnce(false);
    await job.run(now);
    expect(handler.handleMedia).not.toHaveBeenCalled();
  });

  it('skips the whole run while a rule or collection run holds the lock', async () => {
    const lock = await TestBed.solitary(ReviewDeletionJobService).compile();
    lock.unitRef.get(ExecutionLockService).tryAcquire.mockReturnValue(null);
    await expect(lock.unit.run(now)).resolves.toMatchObject({ ran: false });
    expect(
      lock.unitRef.get(ReviewLeavingSoonService).pendingRows,
    ).not.toHaveBeenCalled();
  });

  describe('F1: the arr recycle bin must hold deletes for 7 days', () => {
    it.each([
      { bin: { path: '', cleanupDays: 7 }, label: 'no folder' },
      {
        bin: { path: '/data/recycle-bin/radarr', cleanupDays: 0 },
        label: 'no cleanup',
      },
      {
        bin: { path: '/data/recycle-bin/radarr', cleanupDays: 14 },
        label: '14-day cleanup',
      },
    ])('keeps a due title pending with $label', async ({ bin }) => {
      const row = pendingRow();
      leavingSoon.pendingRows.mockResolvedValue([row]);
      getRecycleBin.mockResolvedValue(bin);
      const summary = await job.run(now);
      expect(leavingSoon.note).toHaveBeenCalledWith(
        row,
        'Waiting: recycle bin not set',
      );
      expect(leavingSoon.transition).not.toHaveBeenCalled();
      expect(handler.handleMedia).not.toHaveBeenCalled();
      expect(summary.deleted).toEqual([]);
      expect(summary.waiting).toEqual([
        { title: 'The Matrix', detail: 'recycle bin not set' },
      ]);
    });

    it('keeps a due title pending when the settings cannot be read', async () => {
      leavingSoon.pendingRows.mockResolvedValue([pendingRow()]);
      getRecycleBin.mockResolvedValue(undefined);
      await job.run(now);
      expect(handler.handleMedia).not.toHaveBeenCalled();
      expect(leavingSoon.note).toHaveBeenCalledWith(
        expect.anything(),
        'Waiting: arr media-management settings unread',
      );
    });

    it('reads the settings once per arr per run and says where the files went', async () => {
      leavingSoon.pendingRows.mockResolvedValue([
        pendingRow(),
        pendingRow({ id: 11, mediaServerId: '778', title: 'Other' }),
      ]);
      media.findOne.mockImplementation(async () => membership);
      leavingSoon.children.mockResolvedValue(new Set(['777', '778']));
      const summary = await job.run(now);
      expect(getRecycleBin).toHaveBeenCalledTimes(1);
      expect(summary.deleted[0].detail).toContain(
        'recycle bin /data/recycle-bin/radarr (7-day cleanup)',
      );
    });
  });

  describe('F2: a delete is checked gone from Plex on the next run', () => {
    it('marks a delete whose Plex item remains as a cleanup failure and pushes it', async () => {
      const row = pendingRow({
        status: 'deleted',
        note: deletedNote,
        resolvedAt: new Date(now.getTime() - day),
      });
      leavingSoon.unverifiedDeletedRows.mockResolvedValue([row]);
      leavingSoon.pendingRows.mockResolvedValue([]);
      stored.getItemIds.mockReturnValue(['777', '900']);
      const summary = await job.run(now);
      expect(leavingSoon.transition).toHaveBeenCalledWith(
        row,
        'deleted',
        'deleted-with-cleanup-failure',
        {
          note: `${deletedNote}; files remain at /data/library/movies/The Matrix (1999) (Plex still lists 777)`,
          verifiedAt: now,
        },
      );
      expect(summary.cleanupFailed).toEqual([
        {
          title: 'The Matrix',
          detail: 'files remain at /data/library/movies/The Matrix (1999)',
        },
      ]);
      expect(collectionService.addLogRecord).toHaveBeenCalledWith(
        collection,
        expect.any(String),
        expect.anything(),
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'deleted-with-cleanup-failure',
          }),
        }),
      );
      expect(leavingSoon.verified).not.toHaveBeenCalled();
    });

    it('marks a delete verified once every Plex id is gone', async () => {
      const row = pendingRow({
        status: 'deleted',
        resolvedAt: new Date(now.getTime() - day),
      });
      leavingSoon.unverifiedDeletedRows.mockResolvedValue([row]);
      leavingSoon.pendingRows.mockResolvedValue([]);
      stored.getItemIds.mockReturnValue(['900']);
      const summary = await job.run(now);
      expect(leavingSoon.verified).toHaveBeenCalledWith(row, now);
      expect(summary.cleanupFailed).toEqual([]);
    });

    it('flags a Radarr file that matches no Plex file, but still deletes', async () => {
      leavingSoon.pendingRows.mockResolvedValue([pendingRow()]);
      stored.getPartFiles.mockReturnValue([
        '/movies/The Matrix (1999)/The.Matrix.1999.mkv',
      ]);
      const summary = await job.run(now);
      expect(arrDelete).toHaveBeenCalledWith(42);
      expect(summary.deleted[0].detail).toContain(
        'Radarr file The Matrix (1999).mkv matches no Plex file',
      );
    });
  });

  describe('F3: a run cut off mid-delete', () => {
    it('settles leftover deleting rows as uncertain and pushes them', async () => {
      const row = pendingRow({ status: 'deleting' });
      leavingSoon.interruptedRows.mockResolvedValue([row]);
      leavingSoon.pendingRows.mockResolvedValue([]);
      const summary = await job.run(now);
      expect(leavingSoon.transition).toHaveBeenCalledWith(
        row,
        'deleting',
        'uncertain',
        {
          note: 'Interrupted while deleting; check Radarr and Plex by hand before acting',
        },
      );
      expect(summary.uncertain).toEqual([
        {
          title: 'The Matrix',
          detail:
            'Interrupted while deleting; check Radarr and Plex by hand before acting',
        },
      ]);
      expect(handler.handleMedia).not.toHaveBeenCalled();
      expect(events.emitAsync).toHaveBeenCalledWith(
        'collection.review-leaving-soon',
        expect.objectContaining({
          message: expect.stringContaining(
            'Outcome uncertain, check by hand: The Matrix',
          ),
        }),
      );
    });
  });

  describe('F4: a permanent final-check failure releases the title', () => {
    it.each([
      {
        error: new ReviewTargetRefused(
          'saved',
          'Affected Plex item is excluded',
        ),
        to: 'saved',
      },
      {
        error: new ReviewTargetRefused(
          'saved',
          'Affected Plex item was watched recently',
        ),
        to: 'saved',
      },
      {
        error: new ReviewTargetRefused(
          'not-deleted',
          'Canonical arr target changed',
        ),
        to: 'not-deleted',
      },
    ])('$error.message makes it $to', async ({ error, to }) => {
      const row = pendingRow();
      leavingSoon.pendingRows.mockResolvedValue([row]);
      review.validateTarget.mockRejectedValue(error);
      const summary = await job.run(now);
      expect(leavingSoon.release).toHaveBeenCalledWith(
        row,
        to,
        error.message,
        'pending',
      );
      expect(leavingSoon.note).not.toHaveBeenCalled();
      expect(handler.handleMedia).not.toHaveBeenCalled();
      expect(
        (to === 'saved' ? summary.saved : summary.notDeleted).map(
          (line) => line.title,
        ),
      ).toEqual(['The Matrix']);
    });

    it('releases from deleting when the delete-boundary check finds a permanent change', async () => {
      const row = pendingRow();
      leavingSoon.pendingRows.mockResolvedValue([row]);
      review.validateTarget
        .mockResolvedValueOnce(['777'])
        .mockRejectedValueOnce(
          new ReviewTargetRefused('saved', 'Affected Plex item is playing'),
        );
      await job.run(now);
      expect(arrDelete).not.toHaveBeenCalled();
      expect(leavingSoon.release).toHaveBeenCalledWith(
        row,
        'saved',
        'Affected Plex item is playing',
        'deleting',
      );
    });
  });

  describe('F5: M18 protections hold during the 14 days', () => {
    it('saves a title requested in Seerr since approval', async () => {
      const row = pendingRow();
      leavingSoon.pendingRows.mockResolvedValue([row]);
      protections.requested.add('movie:603');
      await job.run(now);
      expect(leavingSoon.release).toHaveBeenCalledWith(
        row,
        'saved',
        'Requested in Seerr in the last year',
        'pending',
      );
      expect(handler.handleMedia).not.toHaveBeenCalled();
    });

    it('saves a title on a Plex watchlist', async () => {
      const row = pendingRow();
      leavingSoon.pendingRows.mockResolvedValue([row]);
      protections.plexWatchlist.add('5d7768258801970020c96c58');
      await job.run(now);
      expect(leavingSoon.release).toHaveBeenCalledWith(
        row,
        'saved',
        'On a watchlist',
        'pending',
      );
    });

    it('saves a title someone stopped part-way through', async () => {
      const row = pendingRow();
      leavingSoon.pendingRows.mockResolvedValue([row]);
      states.set('777', { watchers: [], inProgress: true });
      await job.run(now);
      expect(leavingSoon.release).toHaveBeenCalledWith(
        row,
        'saved',
        'Partly watched by someone',
        'pending',
      );
      expect(handler.handleMedia).not.toHaveBeenCalled();
    });

    it('keeps a due title pending when the protections cannot be read', async () => {
      leavingSoon.pendingRows.mockResolvedValue([pendingRow()]);
      review.reviewProtections.mockRejectedValue(new Error('Seerr unread'));
      await job.run(now);
      expect(handler.handleMedia).not.toHaveBeenCalled();
      expect(leavingSoon.note).toHaveBeenCalledWith(
        expect.anything(),
        'Waiting: Seerr unread',
      );
    });
  });

  describe('F7: only a title still shown in Plex Leaving soon is deleted', () => {
    it('treats a title removed from the Plex collection as cancelled', async () => {
      const row = pendingRow();
      leavingSoon.pendingRows.mockResolvedValue([row]);
      leavingSoon.children.mockResolvedValue(new Set(['555']));
      await job.run(now);
      expect(leavingSoon.release).toHaveBeenCalledWith(
        row,
        'cancelled',
        'Removed from Plex Leaving soon before its date; treated as cancelled',
        'pending',
      );
      expect(handler.handleMedia).not.toHaveBeenCalled();
    });

    it('keeps the title pending when the Plex collection cannot be read', async () => {
      const row = pendingRow();
      leavingSoon.pendingRows.mockResolvedValue([row]);
      leavingSoon.children.mockRejectedValue(new Error('Plex 500'));
      await job.run(now);
      expect(handler.handleMedia).not.toHaveBeenCalled();
      expect(leavingSoon.note).toHaveBeenCalledWith(
        row,
        'Waiting: Plex Leaving soon unread: Plex 500',
      );
    });
  });
});
