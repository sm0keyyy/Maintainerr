import { ServarrAction } from '@maintainerr/contracts';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Mocked, TestBed } from '@suites/unit';
import { Repository } from 'typeorm';
import {
  createCollection,
  createCollectionMedia,
} from '../../../test/utils/data';
import { PlexLibraryItem } from '../api/plex-api/interfaces/library.interfaces';
import { PlexApiService } from '../api/plex-api/plex-api.service';
import { SeerrApiService } from '../api/seerr-api/seerr-api.service';
import { MetadataService } from '../metadata/metadata.service';
import { ExecutionLockService } from '../tasks/execution-lock.service';
import { CollectionHandler } from './collection-handler';
import { CollectionReviewService } from './collection-review.service';
import { CollectionsService } from './collections.service';
import { Collection } from './entities/collection.entities';
import { CollectionMedia } from './entities/collection_media.entities';
import { ReviewPending } from './entities/review-pending.entities';
import { ReviewDeletionJobService } from './review-deletion-job.service';
import { ReviewLeavingSoonService } from './review-leaving-soon.service';
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
      ...overrides,
    });

  let job: ReviewDeletionJobService;
  let leavingSoon: Mocked<ReviewLeavingSoonService>;
  let activity: Mocked<ReviewWatchActivityService>;
  let plex: Mocked<PlexApiService>;
  let handler: Mocked<CollectionHandler>;
  let seerr: Mocked<SeerrApiService>;
  let review: Mocked<CollectionReviewService>;
  let media: Mocked<Repository<CollectionMedia>>;
  let collectionService: Mocked<CollectionsService>;
  let arrDelete: jest.Mock;

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
    activity = unitRef.get(ReviewWatchActivityService);
    activity.activitySince.mockReturnValue([]);
    plex = unitRef.get(PlexApiService);
    plex.getActiveSessions.mockResolvedValue([]);
    plex.getWatchHistory.mockResolvedValue([]);
    review = unitRef.get(CollectionReviewService);
    review.validateTarget.mockResolvedValue(['777']);
    seerr = unitRef.get(SeerrApiService);
    seerr.isConfigured.mockReturnValue(true);
    seerr.removeMediaByTmdbId.mockResolvedValue(true);
    unitRef
      .get(MetadataService)
      .resolveIdsForService.mockResolvedValue({ tmdb: 603, type: 'movie' });
    collectionService = unitRef.get(CollectionsService);
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
    // Re-checked before the decision and again at the delete boundary.
    expect(review.validateTarget).toHaveBeenCalledTimes(2);
    expect(seerr.removeMediaByTmdbId).toHaveBeenCalledWith(603, 'movie');
    expect(leavingSoon.removeFromPlex).toHaveBeenCalledWith('9001', '777');
    expect(leavingSoon.transition).toHaveBeenLastCalledWith(
      row,
      'deleting',
      'deleted',
      {
        note: 'Deleted through Radarr with files; Seerr cleared',
        seerr: 'cleared',
      },
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
      expect.objectContaining({ title: 'The Matrix' }),
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
    );
  });

  it('puts the title back to pending when the final check fails before any arr request', async () => {
    const row = pendingRow();
    leavingSoon.pendingRows.mockResolvedValue([row]);
    review.validateTarget
      .mockResolvedValueOnce(['777'])
      .mockRejectedValueOnce(new Error('Affected Plex item is playing'));
    await job.run(now);
    expect(arrDelete).not.toHaveBeenCalled();
    expect(leavingSoon.transition).toHaveBeenLastCalledWith(
      row,
      'deleting',
      'pending',
      { note: 'Waiting: Affected Plex item is playing' },
    );
    expect(seerr.removeMediaByTmdbId).not.toHaveBeenCalled();
  });

  it('records an uncertain arr answer as final and never retries it', async () => {
    const row = pendingRow();
    leavingSoon.pendingRows.mockResolvedValue([row]);
    arrDelete.mockResolvedValue('uncertain');
    await job.run(now);
    expect(leavingSoon.transition).toHaveBeenLastCalledWith(
      row,
      'deleting',
      'uncertain',
      expect.objectContaining({ seerr: null }),
    );
    expect(seerr.removeMediaByTmdbId).not.toHaveBeenCalled();
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
    expect(summary.deleted).toHaveLength(1);
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
});
