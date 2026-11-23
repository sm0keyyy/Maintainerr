import {
  CollectionReview,
  MediaItem,
  MediaServerType,
  ReviewApprovalResult,
  ReviewCandidate,
  ReviewWatcher,
} from '@maintainerr/contracts';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MediaServerFactory } from '../api/media-server/media-server.factory';
import { PlexApiService } from '../api/plex-api/plex-api.service';
import { PlexStoredWatchService } from '../api/plex-api/plex-stored-watch.service';
import { ServarrService } from '../api/servarr-api/servarr.service';
import { MaintainerrLogger } from '../logging/logs.service';
import { Exclusion } from '../rules/entities/exclusion.entities';
import {
  buildExclusionCascadeSets,
  isMediaItemExcluded,
} from '../rules/helpers/exclusion-cascade.helper';
import { ArrLookupCache } from '../rules/helpers/arr-lookup-cache';
import {
  ExecutionLockService,
  RULES_COLLECTIONS_EXECUTION_LOCK_KEY,
} from '../tasks/execution-lock.service';
import { CollectionHandler } from './collection-handler';
import { Collection } from './entities/collection.entities';
import { CollectionMedia } from './entities/collection_media.entities';
import { CollectionsService } from './collections.service';

const REVIEW_WINDOW_MS = 365 * 86400000;

@Injectable()
export class CollectionReviewService {
  constructor(
    @InjectRepository(Collection)
    private readonly collections: Repository<Collection>,
    @InjectRepository(CollectionMedia)
    private readonly media: Repository<CollectionMedia>,
    @InjectRepository(Exclusion)
    private readonly exclusions: Repository<Exclusion>,
    private readonly mediaServerFactory: MediaServerFactory,
    private readonly plex: PlexApiService,
    private readonly storedWatch: PlexStoredWatchService,
    private readonly servarr: ServarrService,
    private readonly handler: CollectionHandler,
    private readonly executionLock: ExecutionLockService,
    private readonly events: EventEmitter2,
    private readonly logger: MaintainerrLogger,
    private readonly collectionService: CollectionsService,
  ) {}

  private async collection(id: number): Promise<Collection> {
    const collection = await this.collections.findOne({
      where: { id },
      relations: { ruleGroup: true },
    });
    if (!collection) throw new NotFoundException('Collection not found');
    if (
      collection.mediaServerType !== MediaServerType.PLEX ||
      !['movie', 'show'].includes(collection.type)
    ) {
      throw new BadRequestException(
        'Review supports Plex movies and whole shows only',
      );
    }
    return collection;
  }

  async enable(id: number): Promise<void> {
    const release = this.executionLock.tryAcquire(
      RULES_COLLECTIONS_EXECUTION_LOCK_KEY,
    );
    if (!release)
      throw new ConflictException('A collection or rule run is in progress');
    try {
      await this.collection(id);
      await this.collections.update(id, { reviewRequired: true });
    } finally {
      release();
    }
  }

  private async addedAt(
    collection: Collection,
    row: CollectionMedia,
    item: MediaItem,
  ): Promise<string> {
    let date: string | undefined;
    if (collection.type === 'movie' && collection.radarrSettingsId) {
      const id = row.tmdbId ?? Number(item.providerIds.tmdb?.[0]);
      if (!Number.isFinite(id) || id <= 0)
        throw new Error('Missing Radarr identity');
      const api = await this.servarr.getRadarrApiClient(
        collection.radarrSettingsId,
      );
      date = (await api.getMovieByTmdbId(id))?.movieFile?.dateAdded;
    } else if (collection.type === 'show' && collection.sonarrSettingsId) {
      const id = row.tvdbId ?? Number(item.providerIds.tvdb?.[0]);
      if (!Number.isFinite(id) || id <= 0)
        throw new Error('Missing Sonarr identity');
      const api = await this.servarr.getSonarrApiClient(
        collection.sonarrSettingsId,
      );
      date = (await api.getSeriesByTvdbId(id))?.added;
    }
    if (!date || !Number.isFinite(new Date(date).getTime()))
      throw new Error('Missing arr age');
    return new Date(date).toISOString();
  }

  private async watchers(
    collection: Collection,
    item: MediaItem,
  ): Promise<ReviewWatcher[]> {
    const byUser = new Map(
      this.storedWatch
        .getWatchers(item.id, item.type)
        .map((watcher) => [watcher.userId, watcher]),
    );
    const history = await this.plex.getWatchHistory(
      item.id,
      false,
      item.type,
      collection.libraryId,
    );
    const users = await this.plex.getCorrectedUsers(false);
    for (const view of history) {
      if (!Number.isFinite(view.viewedAt) || view.viewedAt <= 0)
        throw new Error('Invalid Plex history timestamp');
      const userId = String(view.accountID);
      const lastWatchedAt = new Date(view.viewedAt * 1000).toISOString();
      const previous = byUser.get(userId);
      if (!previous || lastWatchedAt > previous.lastWatchedAt) {
        byUser.set(userId, {
          userId,
          name:
            users?.find((user) => String(user.plexId) === userId)?.username ??
            previous?.name ??
            userId,
          lastWatchedAt,
        });
      }
    }
    return [...byUser.values()].sort((a, b) =>
      b.lastWatchedAt.localeCompare(a.lastWatchedAt),
    );
  }

  async list(id: number): Promise<CollectionReview> {
    const collection = await this.collection(id);
    const result: CollectionReview = {
      collectionId: id,
      reviewRequired: collection.reviewRequired,
      action: collection.arrAction,
      candidates: [],
      unavailableIds: [],
    };
    if (!collection.reviewRequired) return result;
    const server = await this.mediaServerFactory.getService();
    const playing = await server.getActiveSessions();
    const rows = await this.media.find({ where: { collectionId: id } });
    const exclusions = await this.exclusions.find();
    const cascade = buildExclusionCascadeSets(
      exclusions.filter(
        (exclusion) =>
          exclusion.ruleGroupId == null ||
          exclusion.ruleGroupId === collection.ruleGroup?.id,
      ),
    );
    const cutoff = Date.now() - REVIEW_WINDOW_MS;
    for (const row of rows) {
      if (row.ruleEvaluationFailed || playing.has(row.mediaServerId)) continue;
      try {
        const item = await server.getMetadata(row.mediaServerId);
        if (!item || item.type !== collection.type)
          throw new Error('Unread collection member');
        if (isMediaItemExcluded(cascade, item)) continue;
        const watchers = await this.watchers(collection, item);
        const lastWatchedMs = Math.max(
          item.lastViewedAt?.getTime() ?? 0,
          ...watchers.map((watcher) =>
            new Date(watcher.lastWatchedAt).getTime(),
          ),
        );
        if (!Number.isFinite(lastWatchedMs))
          throw new Error('Invalid watch date');
        if (lastWatchedMs >= cutoff) continue;
        const addedAt = await this.addedAt(collection, row, item);
        if (new Date(addedAt).getTime() >= cutoff) continue;
        // Show metadata has no file size: sum the same leaf files as the
        // existing collection size resolver, never a season-level action.
        let sizeBytes = item.mediaSources.reduce(
          (sum, source) => sum + (source.sizeBytes ?? 0),
          0,
        );
        if (item.type === 'show') {
          sizeBytes =
            (await this.collectionService.resolveItemSize(server, item.id)) ??
            0;
        }
        if (!Number.isFinite(sizeBytes) || sizeBytes <= 0)
          throw new Error('Unread size');
        const native = await this.plex.getMetadata(item.id);
        const rating =
          native?.Rating?.find((entry) =>
            entry.image.toLowerCase().includes('imdb'),
          )?.value ??
          item.ratings?.find((entry) =>
            entry.source.toLowerCase().includes('imdb'),
          )?.value;
        const imdbRating =
          typeof rating === 'number' &&
          Number.isFinite(rating) &&
          rating >= 0 &&
          rating <= 10
            ? rating
            : null;
        const candidate: ReviewCandidate = {
          id: item.id,
          title: item.title,
          sizeBytes,
          imdbRating,
          lowRated: imdbRating !== null && imdbRating < 6,
          addedAt,
          lastWatchedAt:
            lastWatchedMs > 0 ? new Date(lastWatchedMs).toISOString() : null,
          watchers,
        };
        result.candidates.push(candidate);
      } catch {
        result.unavailableIds.push(row.mediaServerId);
      }
    }
    result.candidates.sort(
      (a, b) => b.sizeBytes - a.sizeBytes || a.id.localeCompare(b.id),
    );
    return result;
  }

  async approve(id: number, ids: string[]): Promise<ReviewApprovalResult> {
    const release = this.executionLock.tryAcquire(
      RULES_COLLECTIONS_EXECUTION_LOCK_KEY,
    );
    if (!release)
      throw new ConflictException('A collection or rule run is in progress');
    try {
      const review = await this.list(id);
      const eligible = new Set(review.candidates.map((item) => item.id));
      if (
        !review.reviewRequired ||
        ids.length === 0 ||
        ids.length > 500 ||
        new Set(ids).size !== ids.length ||
        ids.some((itemId) => !eligible.has(itemId))
      ) {
        throw new BadRequestException(
          'Selection is stale or contains ineligible ids. Reload the review.',
        );
      }
      const collection = await this.collection(id);
      const rows = await this.media.find({ where: { collectionId: id } });
      const byId = new Map(rows.map((row) => [row.mediaServerId, row]));
      if (ids.some((itemId) => !byId.has(itemId)))
        throw new ConflictException('Collection membership changed');
      const result: ReviewApprovalResult = { handledIds: [], failedIds: [] };
      const libraryReads = new ArrLookupCache();
      for (const itemId of ids) {
        try {
          const outcome = await this.handler.handleMedia(
            collection,
            byId.get(itemId)!,
            libraryReads,
            true,
          );
          (outcome === 'failed' ? result.failedIds : result.handledIds).push(
            itemId,
          );
        } catch {
          result.failedIds.push(itemId);
        }
      }
      return result;
    } finally {
      release();
    }
  }

  async notify(id: number): Promise<string[]> {
    const base = process.env.REVIEW_BASE_URL;
    if (!base)
      throw new BadRequestException('REVIEW_BASE_URL is not configured');
    const url = new URL(base);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new BadRequestException('Invalid review base URL');
    const review = await this.list(id);
    if (!review.reviewRequired || review.candidates.length === 0) return [];
    const basePath = url.pathname.endsWith('/')
      ? url.pathname.slice(0, -1)
      : url.pathname;
    url.pathname = `${basePath}/collections/${id}/review`;
    url.search = '';
    url.hash = '';
    const outcomes: unknown[] = await this.events.emitAsync(
      'collection.review-ready',
      {
        subject: 'Media review ready',
        message: `${review.candidates.length} titles are ready for review. Nothing is selected or deleted automatically.`,
        clickUrl: url.toString(),
      },
    );
    return outcomes
      .flat()
      .filter((outcome): outcome is string => typeof outcome === 'string');
  }

  @Cron('0 9 1 */3 *')
  async notifyQuarterly(): Promise<void> {
    for (const collection of await this.collections.find({
      where: { reviewRequired: true, isActive: true },
    })) {
      try {
        await this.notify(collection.id);
      } catch {
        this.logger.warn(
          `Review notification failed for collection ${collection.id}`,
        );
      }
    }
  }
}
