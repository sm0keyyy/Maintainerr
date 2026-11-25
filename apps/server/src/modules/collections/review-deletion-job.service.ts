import {
  ECollectionLogType,
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
import { PlexApiService } from '../api/plex-api/plex-api.service';
import { SeerrApiService } from '../api/seerr-api/seerr-api.service';
import { MaintainerrLogger } from '../logging/logs.service';
import { MetadataService } from '../metadata/metadata.service';
import { ArrLookupCache } from '../rules/helpers/arr-lookup-cache';
import {
  ExecutionLockService,
  RULES_COLLECTIONS_EXECUTION_LOCK_KEY,
} from '../tasks/execution-lock.service';
import { CollectionHandler } from './collection-handler';
import { CollectionReviewService } from './collection-review.service';
import { CollectionsService } from './collections.service';
import { Collection } from './entities/collection.entities';
import { CollectionMedia } from './entities/collection_media.entities';
import { ReviewPending } from './entities/review-pending.entities';
import { ReviewLeavingSoonService } from './review-leaving-soon.service';
import { ReviewWatchActivityService } from './review-watch-activity.service';

export interface ReviewJobLine {
  title: string;
  detail: string;
}

export interface ReviewJobSummary {
  ran: boolean;
  saved: ReviewJobLine[];
  deleted: ReviewJobLine[];
  notDeleted: ReviewJobLine[];
  waiting: ReviewJobLine[];
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Runs the Plex "Leaving soon" queue once a day. A pending title that anyone
 * watched, started or is playing since its approval is saved. A title still
 * pending at its date is deleted through Radarr or Sonarr with its files and
 * without an import-list exclusion; its Seerr entry is cleared, Plex rescans
 * the folder, and the outcome is audited. Nothing else is ever deleted here: a
 * review collection's members without a pending row are never touched.
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
    private readonly plex: PlexApiService,
    private readonly handler: CollectionHandler,
    private readonly seerr: SeerrApiService,
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
      notDeleted: [],
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
          await this.process(row, now, playing, summary);
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

  private async process(
    row: ReviewPending,
    now: Date,
    playing: Set<string> | null,
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
    if (watched) {
      if (await this.leavingSoon.release(row, 'saved', watched))
        summary.saved.push({ title: row.title, detail: watched });
      return;
    }
    if (due) await this.deleteDue(row, collection, summary);
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

  private async deleteDue(
    row: ReviewPending,
    collection: Collection,
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
    if (!membership) {
      const note = 'Not deleted: no longer in the review collection';
      if (await this.leavingSoon.release(row, 'not-deleted', note))
        summary.notDeleted.push({ title: row.title, detail: note });
      return;
    }
    const target: ReviewTarget = {
      kind: row.arrService,
      settingsId: row.arrSettingsId,
      id: row.arrId,
      providerId: row.providerId,
      path: row.path,
      addedAt: row.addedAt,
    };
    const identity: ReviewTitleIdentity = {
      id: row.mediaServerId,
      title: row.title,
      year: row.year ?? null,
      sizeBytes: Number(row.sizeBytes),
      arrService: row.arrService,
      arrSettingsId: row.arrSettingsId,
      arrId: row.arrId,
      plexIds: [...row.plexIds],
    };
    try {
      identity.plexIds = await this.review.validateTarget(
        collection,
        membership,
        target,
      );
    } catch (error) {
      return this.wait(row, true, errorText(error), summary);
    }
    // The Plex item still exists here; after the delete it may not.
    const tmdbId = await this.tmdbId(row, membership);
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
      // No arr request left: the title is intact and stays pending.
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
    const note =
      status === 'deleted'
        ? `Deleted through ${arr} with files; Seerr ${seerr}`
        : status === 'deleted-with-cleanup-failure'
          ? `Deleted through ${arr} with files; cleanup failed${failure ? `: ${errorText(failure)}` : ''}; Seerr ${seerr}`
          : status === 'uncertain'
            ? `${arr} delete outcome uncertain; check ${arr} before acting`
            : `${arr} refused the delete`;
    await this.leavingSoon.transition(row, 'deleting', status, {
      note,
      seerr: seerr ?? null,
    });
    (status === 'deleted' || status === 'deleted-with-cleanup-failure'
      ? summary.deleted
      : summary.notDeleted
    ).push({ title: row.title, detail: note });
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
      ['Kept, someone watched', summary.saved],
      ['Deleted (7-day recycle bin)', summary.deleted],
      ['Not deleted', summary.notDeleted],
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
