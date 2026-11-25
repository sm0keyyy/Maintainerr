import { MediaItem, ServarrAction } from '@maintainerr/contracts';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Mocked, TestBed } from '@suites/unit';
import { FindOperator, Repository } from 'typeorm';
import { createCollection } from '../../../test/utils/data';
import { MediaServerFactory } from '../api/media-server/media-server.factory';
import { IMediaServerService } from '../api/media-server/media-server.interface';
import { ReviewPending } from './entities/review-pending.entities';
import {
  LEAVING_SOON_TITLE,
  LeavingSoonEntry,
  ReviewLeavingSoonService,
} from './review-leaving-soon.service';

/** An in-memory review_pending table with the conditional update semantics. */
const fakeTable = () => {
  const rows: ReviewPending[] = [];
  let nextId = 1;
  const matches = (row: ReviewPending, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      const actual = row[key as keyof ReviewPending];
      if (value instanceof FindOperator && Array.isArray(value.value))
        return value.value.includes(actual);
      return actual === value;
    });
  return {
    rows,
    repo: {
      create: (data: Partial<ReviewPending>) =>
        Object.assign(new ReviewPending(), data),
      save: jest.fn(async (row: ReviewPending) => {
        row.id ??= nextId++;
        rows.push({ ...row });
        return row;
      }),
      find: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
      ),
      findOne: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((row) => matches(row, where)) ?? null,
      ),
      update: jest.fn(
        async (
          where: Record<string, unknown>,
          changes: Partial<ReviewPending>,
        ) => {
          const hit = rows.filter((row) => matches(row, where));
          hit.forEach((row) => Object.assign(row, changes));
          return { affected: hit.length };
        },
      ),
      createQueryBuilder: () => ({
        select: () => ({
          distinct: () => ({
            getRawMany: async () => [
              ...new Map(
                rows.map((row) => [
                  row.plexCollectionId,
                  {
                    row_libraryId: row.libraryId,
                    row_plexCollectionId: row.plexCollectionId,
                  },
                ]),
              ).values(),
            ],
          }),
        }),
      }),
    },
  };
};

describe('Leaving soon queue', () => {
  const collection = createCollection({
    id: 1,
    type: 'movie',
    libraryId: '1',
    reviewRequired: true,
    arrAction: ServarrAction.DELETE,
    listExclusions: false,
    radarrSettingsId: 1,
  });
  const entry = (id: string): LeavingSoonEntry => ({
    mediaServerId: id,
    title: `Movie ${id}`,
    year: 2001,
    sizeBytes: 1000,
    plexIds: [id],
    target: {
      kind: 'radarr',
      settingsId: 1,
      id: Number(id),
      providerId: Number(id) + 100,
      path: `/data/library/movies/${id}`,
      addedAt: '2020-01-01T00:00:00.000Z',
    },
  });
  let service: ReviewLeavingSoonService;
  let table: ReturnType<typeof fakeTable>;
  let server: Mocked<IMediaServerService>;

  beforeEach(async () => {
    table = fakeTable();
    const { unit, unitRef } = await TestBed.solitary(ReviewLeavingSoonService)
      .mock(getRepositoryToken(ReviewPending) as string)
      .impl(() => table.repo as unknown as Repository<ReviewPending>)
      .compile();
    service = unit;
    server = {
      getCollections: jest.fn().mockResolvedValue([]),
      createCollection: jest
        .fn()
        .mockResolvedValue({ id: '9001', title: LEAVING_SOON_TITLE }),
      updateCollectionVisibility: jest.fn().mockResolvedValue(undefined),
      updateCollection: jest.fn().mockResolvedValue({ id: '9001' }),
      addToCollection: jest.fn().mockResolvedValue(undefined),
      removeFromCollection: jest.fn().mockResolvedValue(undefined),
      getCollectionChildren: jest.fn().mockResolvedValue([]),
    } as unknown as Mocked<IMediaServerService>; // Collection calls only.
    unitRef.get(MediaServerFactory).getService.mockResolvedValue(server);
  });

  it('shows approved titles to every Plex user and schedules them 14 days out', async () => {
    const now = new Date('2026-11-24T12:00:00Z');
    const rows = await service.schedule(
      collection,
      [entry('2'), entry('4')],
      now,
    );
    expect(server.createCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        libraryId: '1',
        title: 'Leaving soon',
        type: 'movie',
      }),
    );
    expect(server.updateCollectionVisibility).toHaveBeenCalledWith({
      libraryId: '1',
      collectionId: '9001',
      recommended: true,
      ownHome: true,
      sharedHome: true,
    });
    expect(server.addToCollection.mock.calls).toEqual([
      ['9001', '2'],
      ['9001', '4'],
    ]);
    expect(rows.map((row) => row.deleteAt.toISOString())).toEqual([
      '2026-12-08T12:00:00.000Z',
      '2026-12-08T12:00:00.000Z',
    ]);
    expect(table.rows.map((row) => [row.mediaServerId, row.status])).toEqual([
      ['2', 'pending'],
      ['4', 'pending'],
    ]);
    expect(server.updateCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining('Next removal: 2026-12-08'),
      }),
    );
  });

  it('reuses the existing Leaving soon collection and refuses an ambiguous one', async () => {
    server.getCollections.mockResolvedValue([
      { id: '55', title: LEAVING_SOON_TITLE, childCount: 0 },
    ]);
    await service.schedule(collection, [entry('2')]);
    expect(server.createCollection).not.toHaveBeenCalled();
    expect(server.addToCollection).toHaveBeenCalledWith('55', '2');

    server.getCollections.mockResolvedValue([
      { id: '55', title: LEAVING_SOON_TITLE, childCount: 0 },
      { id: '56', title: LEAVING_SOON_TITLE, childCount: 0 },
    ]);
    await expect(service.schedule(collection, [entry('4')])).rejects.toThrow(
      ConflictException,
    );
  });

  it('schedules nothing when the collection cannot be promoted to Home', async () => {
    server.updateCollectionVisibility.mockRejectedValue(new Error('Plex 500'));
    await expect(service.schedule(collection, [entry('2')])).rejects.toThrow(
      'Plex 500',
    );
    expect(server.addToCollection).not.toHaveBeenCalled();
    expect(table.rows).toHaveLength(0);
  });

  it('cancels the whole approval when Plex refuses one title', async () => {
    server.addToCollection
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('refused'));
    await expect(
      service.schedule(collection, [entry('2'), entry('4')]),
    ).rejects.toThrow('refused');
    expect(table.rows.map((row) => [row.mediaServerId, row.status])).toEqual([
      ['2', 'cancelled'],
    ]);
    expect(server.removeFromCollection.mock.calls).toEqual([
      ['9001', '4'],
      ['9001', '2'],
    ]);
  });

  it('cancels a pending title before its date and takes it off Plex', async () => {
    const [row] = await service.schedule(collection, [entry('2')]);
    const cancelled = await service.cancel(row.id);
    expect(cancelled).toMatchObject({ id: row.id, status: 'cancelled' });
    expect(table.rows[0].status).toBe('cancelled');
    expect(table.rows[0].resolvedAt).toBeInstanceOf(Date);
    expect(server.removeFromCollection).toHaveBeenCalledWith('9001', '2');
    expect(await service.list({})).toEqual([]);
    expect(await service.list({ all: true })).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
  });

  it('refuses to cancel a title the job is already deleting', async () => {
    const [row] = await service.schedule(collection, [entry('2')]);
    expect(await service.transition(row, 'pending', 'deleting')).toBe(true);
    await expect(service.cancel(row.id)).rejects.toThrow(ConflictException);
    await expect(service.cancel(999)).rejects.toThrow(NotFoundException);
    expect(table.rows[0].status).toBe('deleting');
  });

  it('cancels every pending approval of a title kept forever', async () => {
    await service.schedule(collection, [entry('2'), entry('4')]);
    const cancelled = await service.cancelTitle('2', 'Kept forever');
    expect(cancelled.map((row) => row.mediaServerId)).toEqual(['2']);
    expect(table.rows.map((row) => [row.mediaServerId, row.status])).toEqual([
      ['2', 'cancelled'],
      ['4', 'pending'],
    ]);
    expect(server.removeFromCollection).toHaveBeenCalledWith('9001', '2');
  });

  it('names a title whose rollback failed', async () => {
    server.addToCollection
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('refused'));
    table.repo.update.mockRejectedValueOnce(new Error('database locked'));
    await expect(
      service.schedule(collection, [entry('2'), entry('4')]),
    ).rejects.toThrow(
      'refused; still pending after a failed rollback: Movie 2. Cancel them on the Leaving soon list.',
    );
  });

  it('removes Plex Leaving soon children without an active approval', async () => {
    const [kept] = await service.schedule(collection, [entry('2')]);
    server.getCollectionChildren.mockResolvedValue([
      { id: kept.mediaServerId } as MediaItem,
      { id: 'stray' } as MediaItem,
    ]);
    await service.reconcile();
    expect(server.removeFromCollection.mock.calls).toEqual([['9001', 'stray']]);
  });
});
