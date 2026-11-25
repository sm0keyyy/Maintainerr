import {
  LEAVING_SOON_DAYS,
  MediaItemType,
  ReviewPendingItem,
  ReviewPendingStatus,
} from '@maintainerr/contracts';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { MediaServerFactory } from '../api/media-server/media-server.factory';
import { MaintainerrLogger } from '../logging/logs.service';
import { ReviewTarget } from '../actions/review-deletion';
import { Collection } from './entities/collection.entities';
import { ReviewPending } from './entities/review-pending.entities';

export const LEAVING_SOON_TITLE = 'Leaving soon';
const DAY_MS = 86400000;
const ACTIVE: ReviewPendingStatus[] = ['pending', 'deleting'];

export interface LeavingSoonEntry {
  mediaServerId: string;
  title: string;
  year: number | null;
  sizeBytes: number;
  plexIds: string[];
  target: ReviewTarget;
}

export const toPendingItem = (row: ReviewPending): ReviewPendingItem => ({
  id: row.id,
  collectionId: row.collectionId,
  mediaServerId: row.mediaServerId,
  title: row.title,
  year: row.year ?? null,
  arrService: row.arrService,
  arrId: row.arrId,
  providerId: row.providerId,
  path: row.path,
  sizeBytes: Number(row.sizeBytes),
  approvedAt: new Date(row.approvedAt).toISOString(),
  deleteAt: new Date(row.deleteAt).toISOString(),
  status: row.status,
  resolvedAt: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
  note: row.note ?? null,
  seerr: row.seerr ?? null,
});

/**
 * Owns the approved-title queue and the Plex "Leaving soon" collection that
 * shows it to every user. It never deletes media; the deletion job does, and
 * only for rows still pending at their date.
 */
@Injectable()
export class ReviewLeavingSoonService {
  constructor(
    @InjectRepository(ReviewPending)
    private readonly pending: Repository<ReviewPending>,
    private readonly mediaServerFactory: MediaServerFactory,
    private readonly logger: MaintainerrLogger,
  ) {
    logger.setContext(ReviewLeavingSoonService.name);
  }

  /** Titles of this collection with an approval still in flight. */
  async activeIds(collectionId: number): Promise<Set<string>> {
    const rows = await this.pending.find({
      where: { collectionId, status: In(ACTIVE) },
    });
    return new Set(rows.map((row) => row.mediaServerId));
  }

  async list(options: {
    collectionId?: number;
    all?: boolean;
  }): Promise<ReviewPendingItem[]> {
    const rows = await this.pending.find({
      where: {
        ...(options.collectionId != null
          ? { collectionId: options.collectionId }
          : {}),
        ...(options.all ? {} : { status: In(ACTIVE) }),
      },
      order: { deleteAt: 'ASC', id: 'ASC' },
    });
    return rows.map(toPendingItem);
  }

  /** Every row that can still be saved, cancelled or deleted. */
  async pendingRows(): Promise<ReviewPending[]> {
    return this.pending.find({
      where: { status: 'pending' },
      order: { deleteAt: 'ASC', id: 'ASC' },
    });
  }

  /** Rows a previous run left mid-delete, e.g. after a crash or restart. */
  async interruptedRows(): Promise<ReviewPending[]> {
    return this.pending.find({ where: { status: 'deleting' } });
  }

  /** Deleted rows whose removal from Plex has not been checked yet. */
  async unverifiedDeletedRows(): Promise<ReviewPending[]> {
    return this.pending.find({
      where: { status: 'deleted', verifiedAt: IsNull() },
    });
  }

  /** Marks a deleted row as checked gone from Plex. */
  async verified(row: ReviewPending, at: Date): Promise<void> {
    await this.pending.update(
      { id: row.id, status: 'deleted' },
      { verifiedAt: at },
    );
    row.verifiedAt = at;
  }

  /** Plex ids currently in one "Leaving soon" collection. Throws when unread. */
  async children(plexCollectionId: string): Promise<Set<string>> {
    const server = await this.mediaServerFactory.getService();
    return new Set(
      (await server.getCollectionChildren(plexCollectionId)).map(
        (child) => child.id,
      ),
    );
  }

  /** Cancels every pending approval of one Plex title, e.g. on keep forever. */
  async cancelTitle(
    mediaServerId: string,
    note: string,
  ): Promise<ReviewPending[]> {
    const cancelled: ReviewPending[] = [];
    for (const row of await this.pending.find({
      where: { mediaServerId, status: 'pending' },
    }))
      if (await this.release(row, 'cancelled', note)) cancelled.push(row);
    return cancelled;
  }

  /**
   * Finds or creates the library's "Leaving soon" collection and promotes it
   * to Library recommended, the owner's Home and every shared user's Home. A
   * failure throws before any title is added, so an approval never schedules a
   * delete that other users cannot see.
   */
  private async plexCollection(
    libraryId: string,
    type: MediaItemType,
  ): Promise<string> {
    const server = await this.mediaServerFactory.getService();
    const found = (await server.getCollections(libraryId, false)).filter(
      (collection) => collection.title === LEAVING_SOON_TITLE,
    );
    if (found.length > 1)
      throw new ConflictException(
        `Plex library ${libraryId} has more than one "${LEAVING_SOON_TITLE}" collection`,
      );
    const id =
      found[0]?.id ??
      (
        await server.createCollection({
          libraryId,
          title: LEAVING_SOON_TITLE,
          type,
          summary: this.summary(null),
        })
      ).id;
    await server.updateCollectionVisibility({
      libraryId,
      collectionId: id,
      recommended: true,
      ownHome: true,
      sharedHome: true,
    });
    return id;
  }

  private summary(next: Date | null): string {
    const base = `Titles here leave the server ${LEAVING_SOON_DAYS} days after they are added. Watch one to keep it.`;
    return next
      ? `${base} Next removal: ${next.toISOString().slice(0, 10)}.`
      : base;
  }

  /**
   * Adds each title to Plex "Leaving soon" and records it as pending. All or
   * nothing: when Plex or the database refuses one title, the titles already
   * scheduled by this call are cancelled again, so no title is ever deleted
   * without having been shown. A cancel that fails is named in the error.
   */
  async schedule(
    collection: Collection,
    entries: LeavingSoonEntry[],
    now = new Date(),
  ): Promise<ReviewPending[]> {
    const libraryId = String(collection.libraryId);
    const plexCollectionId = await this.plexCollection(
      libraryId,
      collection.type,
    );
    const server = await this.mediaServerFactory.getService();
    const deleteAt = new Date(now.getTime() + LEAVING_SOON_DAYS * DAY_MS);
    const saved: ReviewPending[] = [];
    try {
      for (const entry of entries) {
        try {
          await server.addToCollection(plexCollectionId, entry.mediaServerId);
          saved.push(
            await this.pending.save(
              this.pending.create({
                collectionId: collection.id,
                mediaServerId: entry.mediaServerId,
                title: entry.title,
                year: entry.year,
                arrService: entry.target.kind,
                arrSettingsId: entry.target.settingsId,
                arrId: entry.target.id,
                providerId: entry.target.providerId,
                path: entry.target.path,
                addedAt: entry.target.addedAt,
                sizeBytes: entry.sizeBytes,
                plexIds: entry.plexIds,
                libraryId,
                plexCollectionId,
                approvedAt: now,
                deleteAt,
                status: 'pending',
                resolvedAt: null,
                note: null,
                seerr: null,
              }),
            ),
          );
        } catch (error) {
          await this.removeFromPlex(plexCollectionId, entry.mediaServerId);
          throw error;
        }
      }
    } catch (error) {
      const leftOver: string[] = [];
      for (const row of saved) {
        try {
          if (
            !(await this.release(
              row,
              'cancelled',
              'Approval failed: another title in the same approval was refused',
            ))
          )
            leftOver.push(row.title);
        } catch (rollback) {
          this.logger.error(
            `Could not roll back the approval of ${row.title} (row ${row.id}): ${rollback instanceof Error ? rollback.message : String(rollback)}`,
          );
          leftOver.push(row.title);
        }
      }
      if (leftOver.length)
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; still pending after a failed rollback: ${leftOver.join(', ')}. Cancel them on the Leaving soon list.`,
        );
      throw error;
    }
    await this.refreshSummary(libraryId, plexCollectionId);
    return saved;
  }

  /**
   * Moves a row from `from` to a final or interim status. False when another
   * actor already moved it, so a cancel and a delete can never both win.
   */
  async transition(
    row: ReviewPending,
    from: ReviewPendingStatus,
    to: ReviewPendingStatus,
    changes: Partial<Pick<ReviewPending, 'note' | 'seerr' | 'verifiedAt'>> = {},
  ): Promise<boolean> {
    const result = await this.pending.update(
      { id: row.id, status: from },
      {
        status: to,
        resolvedAt: ACTIVE.includes(to) ? null : new Date(),
        ...changes,
      },
    );
    if (!result.affected) return false;
    Object.assign(row, { status: to }, changes);
    return true;
  }

  /** Records a note on a row that stays pending, e.g. a blocked delete. */
  async note(row: ReviewPending, note: string): Promise<void> {
    await this.pending.update({ id: row.id, status: 'pending' }, { note });
    row.note = note;
  }

  /** Ends an active row and takes the title out of Plex "Leaving soon". */
  async release(
    row: ReviewPending,
    to: 'saved' | 'cancelled' | 'not-deleted',
    note: string,
    from: 'pending' | 'deleting' = 'pending',
  ): Promise<boolean> {
    if (!(await this.transition(row, from, to, { note }))) return false;
    await this.removeFromPlex(row.plexCollectionId, row.mediaServerId);
    await this.refreshSummary(row.libraryId, row.plexCollectionId);
    return true;
  }

  async cancel(id: number): Promise<ReviewPendingItem> {
    const row = await this.pending.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Pending title not found');
    if (!(await this.release(row, 'cancelled', 'Cancelled before its date')))
      throw new ConflictException(
        'Only a pending title can be cancelled; it is being deleted or already resolved',
      );
    return toPendingItem(row);
  }

  async removeFromPlex(
    plexCollectionId: string,
    mediaServerId: string,
  ): Promise<void> {
    try {
      const server = await this.mediaServerFactory.getService();
      await server.removeFromCollection(plexCollectionId, mediaServerId);
    } catch (error) {
      // The daily reconcile removes any child without a pending row.
      this.logger.warn(
        `Could not remove ${mediaServerId} from Plex "${LEAVING_SOON_TITLE}" ${plexCollectionId}; the next daily run retries`,
      );
      this.logger.debug(error);
    }
  }

  /**
   * Removes Plex "Leaving soon" children that have no pending or deleting row,
   * e.g. after a failed removal, and refreshes each summary date.
   */
  async reconcile(): Promise<void> {
    const rows = await this.pending.find({ where: { status: In(ACTIVE) } });
    const known = await this.pending
      .createQueryBuilder('row')
      .select(['row.libraryId', 'row.plexCollectionId'])
      .distinct(true)
      .getRawMany<{ row_libraryId: string; row_plexCollectionId: string }>();
    const server = await this.mediaServerFactory.getService();
    for (const {
      row_libraryId: libraryId,
      row_plexCollectionId: collectionId,
    } of known) {
      try {
        const children = await server.getCollectionChildren(collectionId);
        const keep = new Set(
          rows
            .filter((row) => row.plexCollectionId === collectionId)
            .map((row) => row.mediaServerId),
        );
        for (const child of children) {
          if (!keep.has(child.id))
            await this.removeFromPlex(collectionId, child.id);
        }
        await this.refreshSummary(libraryId, collectionId);
      } catch (error) {
        this.logger.warn(
          `Could not reconcile Plex "${LEAVING_SOON_TITLE}" ${collectionId}`,
        );
        this.logger.debug(error);
      }
    }
  }

  private async refreshSummary(
    libraryId: string,
    plexCollectionId: string,
  ): Promise<void> {
    try {
      const next = await this.pending.findOne({
        where: { plexCollectionId, status: 'pending' },
        order: { deleteAt: 'ASC' },
      });
      const server = await this.mediaServerFactory.getService();
      await server.updateCollection({
        libraryId,
        collectionId: plexCollectionId,
        summary: this.summary(next ? new Date(next.deleteAt) : null),
      });
    } catch (error) {
      this.logger.warn(
        `Could not update the Plex "${LEAVING_SOON_TITLE}" summary for ${plexCollectionId}`,
      );
      this.logger.debug(error);
    }
  }
}
