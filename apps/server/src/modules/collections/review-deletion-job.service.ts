import {
  ECollectionLogType,
  MediaItem,
  ReviewArrOutcome,
  ReviewDeletionResult,
  ReviewDeletionStatus,
  ReviewSeerrOutcome,
  ReviewTitleIdentity,
} from '@maintainerr/contracts';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { allowsReviewDeletion, ReviewTarget } from '../actions/review-deletion';
import {
  PlexStoredWatchService,
  StoredReviewSnapshot,
} from '../api/plex-api/plex-stored-watch.service';
import { PlexApiService } from '../api/plex-api/plex-api.service';
import { SeerrApiService } from '../api/seerr-api/seerr-api.service';
import { ServarrService } from '../api/servarr-api/servarr.service';
import { MaintainerrLogger } from '../logging/logs.service';
import { MetadataService } from '../metadata/metadata.service';
import { ArrLookupCache } from '../rules/helpers/arr-lookup-cache';
import {
  ExecutionLockService,
  RULES_COLLECTIONS_EXECUTION_LOCK_KEY,
} from '../tasks/execution-lock.service';
import { CollectionHandler } from './collection-handler';
import {
  CollectionReviewService,
  ReviewTargetRefused,
} from './collection-review.service';
import { CollectionsService } from './collections.service';
import { Collection } from './entities/collection.entities';
import { CollectionMedia } from './entities/collection_media.entities';
import { ReviewPending } from './entities/review-pending.entities';
import { ReviewLeavingSoonService } from './review-leaving-soon.service';
import { requestOrWatchlistHit, ReviewProtections } from './review-list';
import { ReviewWatchActivityService } from './review-watch-activity.service';

export interface ReviewJobLine {
  title: string;
  detail: string;
}

export interface ReviewJobSummary {
  ran: boolean;
  saved: ReviewJobLine[];
  deleted: ReviewJobLine[];
  cleanupFailed: ReviewJobLine[];
  notDeleted: ReviewJobLine[];
  uncertain: ReviewJobLine[];
  waiting: ReviewJobLine[];
}

/** Days the arr Recycling Bin keeps deleted files (M21). */
export const REVIEW_RECYCLE_DAYS = 7;
const REVIEW_WINDOW_MS = 365 * 86400000;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Reads shared by every title of one run, each made at most once: the Plex
 * inventory, stored watch state, M18 protections, arr recycle-bin settings and
 * the Leaving soon children. A failed read stays failed for the run.
 */
class RunReads {
  private readonly reads = new Map<string, Promise<unknown>>();

  get<T>(key: string, read: () => Promise<T> | T): Promise<T> {
    let pending = this.reads.get(key);
    if (pending === undefined) {
      pending = Promise.resolve().then(read);
      // Mark it handled here; each caller still sees the rejection.
      pending.catch(() => undefined);
      this.reads.set(key, pending);
    }
    return pending as Promise<T>;
  }
}

/**
 * Runs the Plex "Leaving soon" queue once a day. Each run first settles what
 * earlier runs left: an interrupted delete becomes `uncertain`, and a delete
 * whose title Plex still lists becomes `deleted-with-cleanup-failure`. Then a
 * pending title that anyone watched, started or is playing since approval is
 * saved. A title still pending at its date is checked again (still in Leaving
 * soon, M18 protections, identity, age, watch, sessions, recycle bin) and
 * deleted through Radarr or Sonarr with its files and without an import-list
 * exclusion; its Seerr entry is cleared, Plex rescans the folder, and the
 * outcome is audited. Nothing else is ever deleted here.
 */
@Injectable()
export class ReviewDeletionJobService {
  constructor(
    @InjectRepository(Collection)
    private readonly collections: Repository<Collection>,
    @InjectRepository(CollectionMedia)
    private readonly media: Repository<CollectionMedia>,
    private readonly leavingSoon: ReviewLeavingSoonService,
    private readonly review: CollectionReviewService,
    private readonly activity: ReviewWatchActivityService,
    private readonly storedWatch: PlexStoredWatchService,
    private readonly plex: PlexApiService,
    private readonly handler: CollectionHandler,
    private readonly seerr: SeerrApiService,
    private readonly servarr: ServarrService,
    private readonly metadata: MetadataService,
    private readonly collectionService: CollectionsService,
    private readonly executionLock: ExecutionLockService,
    private readonly events: EventEmitter2,
    private readonly logger: MaintainerrLogger,
  ) {
    logger.setContext(ReviewDeletionJobService.name);
  }

  @Cron('30 4 * * *')
  async runDaily(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      this.logger.error(`Leaving soon run failed: ${errorText(error)}`);
    }
  }

  async run(now = new Date()): Promise<ReviewJobSummary> {
    const summary: ReviewJobSummary = {
      ran: false,
      saved: [],
      deleted: [],
      cleanupFailed: [],
      notDeleted: [],
      uncertain: [],
      waiting: [],
    };
    const release = this.executionLock.tryAcquire(
      RULES_COLLECTIONS_EXECUTION_LOCK_KEY,
    );
    if (!release) {
      this.logger.warn(
        'Leaving soon run skipped: a collection or rule run is in progress; the next daily run retries',
      );
      return summary;
    }
    try {
      summary.ran = true;
      const reads = new RunReads();
      await this.settleInterrupted(summary);
      await this.verifyDeleted(reads, now, summary);
      let playing: Set<string> | null = null;
      try {
        playing = await this.playing();
      } catch (error) {
        this.logger.warn(
          `Plex sessions unread; no title is deleted this run: ${errorText(error)}`,
        );
      }
      for (const row of await this.leavingSoon.pendingRows()) {
        try {
          await this.process(row, now, playing, reads, summary);
        } catch (error) {
          this.logger.error(
            `Leaving soon title ${row.id} (${row.title}) failed: ${errorText(error)}`,
          );
          summary.waiting.push({ title: row.title, detail: errorText(error) });
        }
      }
      await this.leavingSoon.reconcile();
      await this.notify(summary);
      return summary;
    } finally {
      release();
    }
  }

  /**
   * A row still `deleting` at the start of a run was cut off mid-delete (a
   * crash or restart): whether the arr request went out is unknown.
   */
  private async settleInterrupted(summary: ReviewJobSummary): Promise<void> {
    for (const row of await this.leavingSoon.interruptedRows()) {
      const arr = row.arrService === 'radarr' ? 'Radarr' : 'Sonarr';
      const note = `Interrupted while deleting; check ${arr} and Plex by hand before acting`;
      if (
        !(await this.leavingSoon.transition(row, 'deleting', 'uncertain', {
          note,
        }))
      )
        continue;
      summary.uncertain.push({ title: row.title, detail: note });
      const collection = await this.collections.findOne({
        where: { id: row.collectionId },
      });
      if (collection)
        await this.record(collection, {
          ...this.identity(row),
          status: 'uncertain',
          providerId: row.providerId,
          path: row.path,
          at: new Date().toISOString(),
        });
    }
  }

  /**
   * Every Plex id of a delete from an earlier run must be gone from Plex.
   * One that remains means the files were not removed (or Plex has not caught
   * up): the row becomes `deleted-with-cleanup-failure`.
   */
  private async verifyDeleted(
    reads: RunReads,
    now: Date,
    summary: ReviewJobSummary,
  ): Promise<void> {
    for (const row of await this.leavingSoon.unverifiedDeletedRows()) {
      if (row.resolvedAt && new Date(row.resolvedAt).getTime() >= now.getTime())
        continue;
      const type = row.arrService === 'radarr' ? 'movie' : 'show';
      let live: Set<string>;
      try {
        live = await reads.get(
          `live:${type}`,
          () => new Set(this.storedWatch.getItemIds(type)),
        );
      } catch (error) {
        this.logger.warn(
          `Could not check that ${row.title} left Plex: ${errorText(error)}; the next run retries`,
        );
        continue;
      }
      const remaining = row.plexIds.filter((id) => live.has(id));
      if (remaining.length === 0) {
        await this.leavingSoon.verified(row, now);
        continue;
      }
      const detail = `files remain at ${row.path}`;
      if (
        !(await this.leavingSoon.transition(
          row,
          'deleted',
          'deleted-with-cleanup-failure',
          {
            note: `${row.note ?? 'Deleted'}; ${detail} (Plex still lists ${remaining.join(', ')})`,
            verifiedAt: now,
          },
        ))
      )
        continue;
      summary.cleanupFailed.push({ title: row.title, detail });
      const collection = await this.collections.findOne({
        where: { id: row.collectionId },
      });
      if (collection)
        await this.record(collection, {
          ...this.identity(row),
          status: 'deleted-with-cleanup-failure',
          providerId: row.providerId,
          path: row.path,
          at: new Date().toISOString(),
        });
    }
  }

  private identity(row: ReviewPending): ReviewTitleIdentity {
    return {
      id: row.mediaServerId,
      title: row.title,
      year: row.year ?? null,
      sizeBytes: Number(row.sizeBytes),
      arrService: row.arrService,
      arrSettingsId: row.arrSettingsId,
      arrId: row.arrId,
      plexIds: [...row.plexIds],
    };
  }

  private async process(
    row: ReviewPending,
    now: Date,
    playing: Set<string> | null,
    reads: RunReads,
    summary: ReviewJobSummary,
  ): Promise<void> {
    const due = new Date(row.deleteAt).getTime() <= now.getTime();
    const collection = await this.collections.findOne({
      where: { id: row.collectionId },
      relations: { ruleGroup: true },
    });
    if (
      !collection ||
      (collection.type !== 'movie' && collection.type !== 'show')
    )
      return this.wait(row, due, 'Review collection unreadable', summary);
    let watched: string | null;
    try {
      watched = await this.watchedSince(row, collection, playing);
    } catch (error) {
      return this.wait(
        row,
        due,
        `Watch state unread: ${errorText(error)}`,
        summary,
      );
    }
    if (watched) return this.end(row, 'saved', watched, summary);
    if (due) await this.deleteDue(row, collection, reads, summary);
  }

  /** A due title that cannot be checked or deleted stays pending. */
  private async wait(
    row: ReviewPending,
    due: boolean,
    reason: string,
    summary: ReviewJobSummary,
  ): Promise<void> {
    if (!due) return;
    await this.leavingSoon.note(row, `Waiting: ${reason}`);
    summary.waiting.push({ title: row.title, detail: reason });
  }

  /** Ends an active row for a reason the next run cannot change. */
  private async end(
    row: ReviewPending,
    to: 'saved' | 'cancelled' | 'not-deleted',
    note: string,
    summary: ReviewJobSummary,
    from: 'pending' | 'deleting' = 'pending',
  ): Promise<void> {
    if (!(await this.leavingSoon.release(row, to, note, from))) return;
    (to === 'saved' ? summary.saved : summary.notDeleted).push({
      title: row.title,
      detail: note,
    });
  }

  private async playing(): Promise<Set<string>> {
    const sessions = await this.plex.getActiveSessions(true);
    return new Set(
      sessions.flatMap((session) =>
        [
          session.ratingKey,
          session.parentRatingKey,
          session.grandparentRatingKey,
        ]
          .filter((id) => id != null)
          .map(String),
      ),
    );
  }

  /** Why the title is saved, or null when nobody touched it since approval. */
  private async watchedSince(
    row: ReviewPending,
    collection: Collection,
    playing: Set<string> | null,
  ): Promise<string | null> {
    if (!playing) throw new Error('Plex sessions unread');
    if (playing.has(row.mediaServerId)) return 'Playing on Plex';
    const since = new Date(row.approvedAt).getTime();
    const type = collection.type as 'movie' | 'show';
    const [stored] = this.activity.activitySince(
      row.mediaServerId,
      type,
      since,
    );
    if (stored)
      return `Watched by ${stored.name} on ${new Date(stored.at).toISOString().slice(0, 10)}`;
    const history = await this.plex.getWatchHistory(
      row.mediaServerId,
      false,
      type,
      row.libraryId,
    );
    const view = history.find((entry) => {
      if (!Number.isFinite(entry.viewedAt) || entry.viewedAt <= 0)
        throw new Error('Invalid Plex history timestamp');
      return entry.viewedAt * 1000 >= since;
    });
    return view
      ? `Watched by Plex account ${view.accountID} on ${new Date(view.viewedAt * 1000).toISOString().slice(0, 10)}`
      : null;
  }

  /**
   * M18 during the 14 days: a Seerr request in the last year, any watchlist,
   * or a partly watched copy saves the title. Null when none applies.
   */
  private async protectedReason(
    row: ReviewPending,
    type: 'movie' | 'show',
    copies: MediaItem[],
    tmdbId: number | null,
    reads: RunReads,
  ): Promise<string | null> {
    const snapshot = await reads.get<StoredReviewSnapshot>(
      `snapshot:${type}`,
      () => this.storedWatch.getReviewSnapshot(type),
    );
    const partly = copies.find(
      (copy) => snapshot.states.get(copy.id)?.inProgress,
    );
    if (partly) return 'Partly watched by someone';
    const protections = await reads.get<ReviewProtections>('protections', () =>
      this.review.reviewProtections(Date.now() - REVIEW_WINDOW_MS),
    );
    const hit = requestOrWatchlistHit(
      protections,
      type,
      new Set(tmdbId ? [tmdbId] : []),
      row.providerId,
      copies,
    );
    if (hit === 'unverified')
      throw new Error(
        'watchlist state unverified: a Plex copy uses a legacy agent',
      );
    if (hit === 'seerr-request') return 'Requested in Seerr in the last year';
    if (hit === 'watchlist') return 'On a watchlist';
    return null;
  }

  /** The arr Recycling Bin must hold deletes for exactly 7 days (M21). */
  private async recycleBin(
    row: ReviewPending,
    reads: RunReads,
  ): Promise<string | null> {
    const bin = await reads.get(
      `recycle:${row.arrService}:${row.arrSettingsId}`,
      async () =>
        (row.arrService === 'radarr'
          ? await this.servarr.getRadarrApiClient(row.arrSettingsId)
          : await this.servarr.getSonarrApiClient(row.arrSettingsId)
        ).getRecycleBin(),
    );
    if (!bin) throw new Error('arr media-management settings unread');
    return bin.path && bin.cleanupDays === REVIEW_RECYCLE_DAYS
      ? bin.path
      : null;
  }

  /**
   * Radarr's file below the movie folder should be one of the files Plex
   * holds; a mismatch is flagged in the outcome, never refused.
   */
  private async fileFlag(row: ReviewPending): Promise<string | null> {
    if (row.arrService !== 'radarr') return null;
    try {
      const api = await this.servarr.getRadarrApiClient(row.arrSettingsId);
      const movie = await api.getMovieByTmdbId(row.providerId);
      const relative = movie?.movieFile?.relativePath?.replace(/\\/g, '/');
      if (!relative) return 'Radarr file unread; its Plex match is unchecked';
      const files = this.storedWatch
        .getPartFiles(row.plexIds)
        .map((file) => file.replace(/\\/g, '/'));
      return files.some((file) => file.endsWith(`/${relative}`))
        ? null
        : `Radarr file ${relative} matches no Plex file`;
    } catch (error) {
      return `Radarr file unread (${errorText(error)}); its Plex match is unchecked`;
    }
  }

  private async deleteDue(
    row: ReviewPending,
    collection: Collection,
    reads: RunReads,
    summary: ReviewJobSummary,
  ): Promise<void> {
    if (!allowsReviewDeletion(collection))
      return this.wait(
        row,
        true,
        'the review collection no longer allows deletion (needs whole-title Delete without list exclusions)',
        summary,
      );
    const membership = await this.media.findOne({
      where: {
        collectionId: row.collectionId,
        mediaServerId: row.mediaServerId,
      },
    });
    if (!membership)
      return this.end(
        row,
        'not-deleted',
        'Not deleted: no longer in the review collection',
        summary,
      );
    let shown: Set<string>;
    try {
      shown = await reads.get(`leaving:${row.plexCollectionId}`, () =>
        this.leavingSoon.children(row.plexCollectionId),
      );
    } catch (error) {
      return this.wait(
        row,
        true,
        `Plex Leaving soon unread: ${errorText(error)}`,
        summary,
      );
    }
    if (!shown.has(row.mediaServerId))
      return this.end(
        row,
        'cancelled',
        'Removed from Plex Leaving soon before its date; treated as cancelled',
        summary,
      );

    const type = collection.type as 'movie' | 'show';
    const target: ReviewTarget = {
      kind: row.arrService,
      settingsId: row.arrSettingsId,
      id: row.arrId,
      providerId: row.providerId,
      path: row.path,
      addedAt: row.addedAt,
    };
    const identity = this.identity(row);
    let inventory: MediaItem[];
    let tmdbId: number | null;
    let binPath: string | null;
    try {
      inventory = await reads.get(`inventory:${type}`, () =>
        this.review.inventory(collection),
      );
      identity.plexIds = await this.review.validateTarget(
        collection,
        membership,
        target,
        inventory,
      );
      // The Plex item still exists here; after the delete it may not.
      tmdbId = await this.tmdbId(row, membership);
      const copies = inventory.filter((item) =>
        identity.plexIds.includes(item.id),
      );
      const kept = await this.protectedReason(row, type, copies, tmdbId, reads);
      if (kept) return this.end(row, 'saved', kept, summary);
      binPath = await this.recycleBin(row, reads);
    } catch (error) {
      if (error instanceof ReviewTargetRefused)
        return this.end(row, error.outcome, error.message, summary);
      return this.wait(row, true, errorText(error), summary);
    }
    if (!binPath) return this.wait(row, true, 'recycle bin not set', summary);
    const flag = await this.fileFlag(row);
    if (!(await this.leavingSoon.transition(row, 'pending', 'deleting')))
      return;

    const audit = (status: ReviewDeletionStatus, seerr?: ReviewSeerrOutcome) =>
      ({
        ...identity,
        plexIds: [...identity.plexIds],
        status,
        providerId: row.providerId,
        path: row.path,
        ...(seerr ? { seerr } : {}),
        at: new Date().toISOString(),
      }) satisfies ReviewDeletionResult;
    const state: {
      arr: ReviewArrOutcome;
      sent: boolean;
      recorded?: ReviewDeletionStatus;
      auditFailed: boolean;
    } = { arr: 'not-deleted', sent: false, auditFailed: false };
    const recordOutcome = async (status: ReviewArrOutcome) => {
      state.sent = true;
      state.arr = status;
      state.auditFailed = !(await this.record(collection, audit(status)));
      state.recorded = status;
    };
    const beforeDelete = async () => {
      identity.plexIds = await this.review.validateTarget(
        collection,
        membership,
        target,
        inventory,
      );
    };
    let cleanupFailed = false;
    let failure: unknown;
    try {
      const outcome = await this.handler.handleMedia(
        collection,
        membership,
        new ArrLookupCache(),
        { target, beforeDelete, recordOutcome },
      );
      cleanupFailed = state.arr === 'deleted' && outcome !== 'handled';
    } catch (error) {
      failure = error;
      cleanupFailed = state.arr === 'deleted';
    }

    if (!state.sent) {
      // No arr request left: the title is intact.
      if (failure instanceof ReviewTargetRefused)
        return this.end(
          row,
          failure.outcome,
          failure.message,
          summary,
          'deleting',
        );
      const reason = failure
        ? errorText(failure)
        : 'the collection handler refused the delete';
      await this.leavingSoon.transition(row, 'deleting', 'pending', {
        note: `Waiting: ${reason}`,
      });
      summary.waiting.push({ title: row.title, detail: reason });
      return;
    }

    let seerr: ReviewSeerrOutcome | undefined;
    if (state.arr === 'deleted') {
      seerr = await this.clearSeerr(tmdbId, row.arrService);
      await this.leavingSoon.removeFromPlex(
        row.plexCollectionId,
        row.mediaServerId,
      );
    }
    const status: Exclude<ReviewDeletionStatus, 'scheduled'> =
      state.arr === 'deleted' && (cleanupFailed || state.auditFailed)
        ? 'deleted-with-cleanup-failure'
        : state.arr;
    if (state.recorded !== status || seerr)
      await this.record(collection, audit(status, seerr));
    const arr = row.arrService === 'radarr' ? 'Radarr' : 'Sonarr';
    const moved = `Deleted through ${arr} into its recycle bin ${binPath} (${REVIEW_RECYCLE_DAYS}-day cleanup)`;
    const flagged = flag ? `; ${flag}` : '';
    const note =
      status === 'deleted'
        ? `${moved}; Seerr ${seerr}${flagged}`
        : status === 'deleted-with-cleanup-failure'
          ? `${moved}; cleanup failed${failure ? `: ${errorText(failure)}` : ''}; Seerr ${seerr}${flagged}`
          : status === 'uncertain'
            ? `${arr} delete outcome uncertain; check ${arr} before acting`
            : `${arr} refused the delete`;
    await this.leavingSoon.transition(row, 'deleting', status, {
      note,
      seerr: seerr ?? null,
    });
    const line = { title: row.title, detail: note };
    if (status === 'deleted') summary.deleted.push(line);
    else if (status === 'deleted-with-cleanup-failure')
      summary.cleanupFailed.push(line);
    else if (status === 'uncertain') summary.uncertain.push(line);
    else summary.notDeleted.push(line);
  }

  private async tmdbId(
    row: ReviewPending,
    membership: CollectionMedia,
  ): Promise<number | null> {
    try {
      const ids = await this.metadata.resolveIdsForService(
        row.mediaServerId,
        'seerr',
      );
      const resolved = Number(ids?.tmdb);
      if (Number.isSafeInteger(resolved) && resolved > 0) return resolved;
    } catch (error) {
      this.logger.debug(error);
    }
    if (row.arrService === 'radarr') return row.providerId;
    return membership.tmdbId ?? null;
  }

  /** Clears the Seerr media entry and its requests so it can be re-requested. */
  private async clearSeerr(
    tmdbId: number | null,
    arr: 'radarr' | 'sonarr',
  ): Promise<ReviewSeerrOutcome> {
    if (!this.seerr.isConfigured()) return 'not-configured';
    if (!tmdbId) return 'no-tmdb-id';
    const removed = await this.seerr.removeMediaByTmdbId(
      tmdbId,
      arr === 'radarr' ? 'movie' : 'tv',
    );
    return removed === true
      ? 'cleared'
      : removed === false
        ? 'no-entry'
        : 'failed';
  }

  private async record(
    collection: Collection,
    outcome: ReviewDeletionResult,
  ): Promise<boolean> {
    const message = `Review deletion ${outcome.status}: ${JSON.stringify(outcome)}`;
    this.logger.log(message);
    try {
      await this.collectionService.addLogRecord(
        collection,
        message,
        ECollectionLogType.MEDIA,
        { type: 'review_deletion', data: outcome },
      );
      return true;
    } catch {
      this.logger.error(
        `Could not persist deletion audit; retained in application log: ${JSON.stringify(outcome)}`,
      );
      return false;
    }
  }

  private async notify(summary: ReviewJobSummary): Promise<void> {
    const sections: [string, ReviewJobLine[]][] = [
      ['Kept', summary.saved],
      ['Deleted', summary.deleted],
      ['Deleted, cleanup failed', summary.cleanupFailed],
      ['Not deleted', summary.notDeleted],
      ['Outcome uncertain, check by hand', summary.uncertain],
      ['Waiting', summary.waiting],
    ];
    const message = sections
      .filter(([, lines]) => lines.length)
      .map(
        ([label, lines]) =>
          `${label}: ${lines.map((line) => `${line.title} (${line.detail})`).join('; ')}`,
      )
      .join('\n');
    if (!message) return;
    try {
      await this.events.emitAsync('collection.review-leaving-soon', {
        subject: 'Leaving soon update',
        message,
      });
    } catch (error) {
      this.logger.warn(`Leaving soon notification failed: ${errorText(error)}`);
    }
  }
}
