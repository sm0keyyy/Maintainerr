import {
  CollectionReview,
  ECollectionLogType,
  MediaItem,
  MediaServerType,
  ReviewApprovalItem,
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
import { IsNull, Not, Repository } from 'typeorm';
import cacheManager from '../api/lib/cache';
import { PlexApiService } from '../api/plex-api/plex-api.service';
import { PlexStoredWatchService } from '../api/plex-api/plex-stored-watch.service';
import { SeerrApiService } from '../api/seerr-api/seerr-api.service';
import { RadarrMovie } from '../api/servarr-api/interfaces/radarr.interface';
import { ServarrService } from '../api/servarr-api/servarr.service';
import { MaintainerrLogger } from '../logging/logs.service';
import { Exclusion } from '../rules/entities/exclusion.entities';
import {
  buildExclusionCascadeSets,
  isMediaItemExcluded,
} from '../rules/helpers/exclusion-cascade.helper';
import {
  LeavingSoonEntry,
  ReviewLeavingSoonService,
} from './review-leaving-soon.service';
import {
  ExecutionLockService,
  RULES_COLLECTIONS_EXECUTION_LOCK_KEY,
} from '../tasks/execution-lock.service';
import { Collection } from './entities/collection.entities';
import { CollectionMedia } from './entities/collection_media.entities';
import { CollectionsService } from './collections.service';
import { PlexMapper } from '../api/media-server/plex/plex.mapper';
import { allowsReviewDeletion, ReviewTarget } from '../actions/review-deletion';
import {
  evaluateReviewRow,
  indexInventory,
  mapLimit,
  ReviewArrEntry,
  ReviewProtections,
  validImdbRating,
} from './review-list';

const REVIEW_WINDOW_MS = 365 * 86400000;
// Identity, paths and sizes change rarely, and approve() re-reads them fresh.
const INVENTORY_TTL_MS = 10 * 60000;
const ARR_TTL_MS = 10 * 60000;
const RATING_TTL_MS = 24 * 3600000;
const READ_CONCURRENCY = 4;
const RATING_CONCURRENCY = 8;

@Injectable()
export class CollectionReviewService {
  private readonly inventoryCache = new Map<
    'movie' | 'show',
    { readAt: number; items: Map<string, MediaItem> }
  >();
  private readonly arrCache = new Map<
    string,
    { readAt: number; entries: Map<number, ReviewArrEntry> }
  >();
  private readonly ratingCache = new Map<
    string,
    { readAt: number; value: number | null }
  >();

  constructor(
    @InjectRepository(Collection)
    private readonly collections: Repository<Collection>,
    @InjectRepository(CollectionMedia)
    private readonly media: Repository<CollectionMedia>,
    @InjectRepository(Exclusion)
    private readonly exclusions: Repository<Exclusion>,
    private readonly plex: PlexApiService,
    private readonly storedWatch: PlexStoredWatchService,
    private readonly servarr: ServarrService,
    private readonly leavingSoon: ReviewLeavingSoonService,
    private readonly executionLock: ExecutionLockService,
    private readonly events: EventEmitter2,
    private readonly logger: MaintainerrLogger,
    private readonly collectionService: CollectionsService,
    private readonly seerr: SeerrApiService,
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

  private async target(
    collection: Collection,
    row: CollectionMedia,
    item: MediaItem,
  ): Promise<ReviewTarget> {
    const movie = collection.type === 'movie';
    const providerId = Number(
      (movie ? item.providerIds.tmdb : item.providerIds.tvdb)?.[0],
    );
    const cached = movie ? row.tmdbId : row.tvdbId;
    if (
      !Number.isSafeInteger(providerId) ||
      providerId <= 0 ||
      (cached != null && cached !== providerId)
    )
      throw new Error('Plex and membership identity disagree');
    let id: number;
    let path: string;
    let date: string;
    let settingsId: number;
    if (movie && collection.radarrSettingsId) {
      settingsId = collection.radarrSettingsId;
      const api = await this.servarr.getRadarrApiClient(settingsId);
      const entry = await api.getMovieByTmdbId(providerId);
      if (!entry || entry.tmdbId !== providerId)
        throw new Error('Radarr identity mismatch');
      ({ id, path } = entry);
      date = entry.movieFile?.dateAdded;
    } else if (!movie && collection.sonarrSettingsId) {
      settingsId = collection.sonarrSettingsId;
      const api = await this.servarr.getSonarrApiClient(settingsId);
      const entry = await api.getSeriesByTvdbId(providerId);
      if (!entry || entry.tvdbId !== providerId)
        throw new Error('Sonarr identity mismatch');
      ({ id, path } = entry);
      date = entry.added;
    } else throw new Error('Missing review arr configuration');
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !path ||
      !date ||
      !Number.isFinite(new Date(date).getTime())
    )
      throw new Error('Unread arr target or age');
    return {
      kind: movie ? 'radarr' : 'sonarr',
      settingsId,
      id,
      providerId,
      path,
      addedAt: new Date(date).toISOString(),
    };
  }

  private async freshItems(ids: string[]): Promise<MediaItem[]> {
    const metadata = await this.plex.getMetadataBatch(ids, false);
    if (
      metadata.length !== ids.length ||
      ids.some((id) => !metadata.some((item) => item.ratingKey === id))
    )
      throw new Error('Incomplete Plex metadata read');
    return metadata.map((item) => PlexMapper.metadataToMediaItem(item));
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

  private async inventory(collection: Collection): Promise<MediaItem[]> {
    const type = collection.type === 'movie' ? 'movie' : 'show';
    const ids = this.storedWatch.getItemIds(type);
    const items: MediaItem[] = [];
    for (let start = 0; start < ids.length; start += 100) {
      const batch = await this.freshItems(ids.slice(start, start + 100));
      if (batch.some((item) => item.type !== type))
        throw new Error('Unexpected Plex inventory type');
      items.push(...batch);
    }
    return items;
  }

  /**
   * Fails unless the bound arr target still maps to the selected Plex item, no
   * affected Plex item is excluded, watched in the last year or playing, and
   * the arr file is over a year old. The Leaving soon job runs it again right
   * before the arr delete.
   */
  async validateTarget(
    collection: Collection,
    row: CollectionMedia,
    bound: ReviewTarget,
    inventory?: MediaItem[],
  ): Promise<string[]> {
    const items = inventory ?? (await this.inventory(collection));
    const exclusions = await this.exclusions.find();
    const cascade = buildExclusionCascadeSets(
      exclusions.filter(
        (exclusion) =>
          exclusion.ruleGroupId == null ||
          exclusion.ruleGroupId === collection.ruleGroup?.id,
      ),
    );
    const affectedIds: string[] = [];
    const folder = bound.path.replace(/[\\/]+$/, '');
    for (const item of items) {
      const providerIds =
        bound.kind === 'radarr' ? item.providerIds.tmdb : item.providerIds.tvdb;
      if (!item.path && !providerIds?.length)
        throw new Error('Unread Plex inventory identity');
      const sameProvider = providerIds?.includes(String(bound.providerId));
      const samePath =
        item.path === folder ||
        item.path?.startsWith(`${folder}/`) ||
        item.path?.startsWith(`${folder}\\`);
      if (!sameProvider && !samePath) continue;
      affectedIds.push(item.id);
      if (isMediaItemExcluded(cascade, item))
        throw new Error('Affected Plex item is excluded');
    }
    if (!affectedIds.includes(row.mediaServerId))
      throw new Error('Selected Plex item does not map to target');

    // Discovery is complete. Only bounded target reads follow, never another
    // library scan between these safety checks and the arr delete request.
    const affected: MediaItem[] = [];
    for (let start = 0; start < affectedIds.length; start += 100) {
      affected.push(
        ...(await this.freshItems(affectedIds.slice(start, start + 100))),
      );
    }
    const lastWatchedByItem = new Map<string, number>();
    for (const item of affected) {
      if (item.type !== collection.type || isMediaItemExcluded(cascade, item))
        throw new Error('Affected Plex item changed or is excluded');
      const watchers = await this.watchers(collection, item);
      lastWatchedByItem.set(
        item.id,
        Math.max(
          item.lastViewedAt?.getTime() ?? 0,
          ...watchers.map((watcher) =>
            new Date(watcher.lastWatchedAt).getTime(),
          ),
        ),
      );
    }
    const selected = affected.find((item) => item.id === row.mediaServerId)!;
    const fresh = await this.target(collection, row, selected);
    if (
      fresh.id !== bound.id ||
      fresh.providerId !== bound.providerId ||
      fresh.path !== bound.path ||
      fresh.kind !== bound.kind ||
      fresh.settingsId !== bound.settingsId
    )
      throw new Error('Canonical arr target changed');
    const cutoff = Date.now() - REVIEW_WINDOW_MS;
    if (new Date(fresh.addedAt).getTime() >= cutoff)
      throw new Error('Target is too recent');
    // History/user lookups can await network I/O. Re-read all affected stored
    // dates together after those reads and the fresh arr-age lookup finish.
    for (const item of affected) {
      const lastWatched = Math.max(
        lastWatchedByItem.get(item.id)!,
        ...this.storedWatch
          .getWatchers(item.id, item.type)
          .map((watcher) => new Date(watcher.lastWatchedAt).getTime()),
      );
      if (!Number.isFinite(lastWatched) || lastWatched >= cutoff)
        throw new Error('Affected Plex item was watched recently');
    }
    const playing = await this.playing();
    if (affectedIds.some((id) => playing.has(id)))
      throw new Error('Affected Plex item is playing');
    return affectedIds;
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
      item.library?.id || collection.libraryId,
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

  /**
   * Plex metadata for every movie or show, refreshed whole after
   * INVENTORY_TTL_MS and topped up with ids added since. Only identity, paths
   * and sizes come from it: watch state, sessions, requests, watchlists and
   * exclusions are read fresh on every list.
   */
  private async reviewInventory(type: 'movie' | 'show'): Promise<MediaItem[]> {
    const ids = this.storedWatch.getItemIds(type);
    const cached = this.inventoryCache.get(type);
    const fresh = !cached || Date.now() - cached.readAt >= INVENTORY_TTL_MS;
    const entry = fresh ? { readAt: Date.now(), items: new Map() } : cached;
    const missing = ids.filter((itemId) => !entry.items.has(itemId));
    const batches: string[][] = [];
    for (let start = 0; start < missing.length; start += 100)
      batches.push(missing.slice(start, start + 100));
    for (const batch of await mapLimit(batches, READ_CONCURRENCY, (batch) =>
      this.freshItems(batch),
    )) {
      for (const item of batch) {
        if (item.type !== type)
          throw new Error('Unexpected Plex inventory type');
        entry.items.set(item.id, item);
      }
    }
    this.inventoryCache.set(type, entry);
    return ids.map((itemId) => entry.items.get(itemId)!);
  }

  /** The whole arr library in one read, cached for ARR_TTL_MS. */
  private async reviewArr(
    collection: Collection,
  ): Promise<Map<number, ReviewArrEntry>> {
    const movie = collection.type === 'movie';
    const settingsId = movie
      ? collection.radarrSettingsId
      : collection.sonarrSettingsId;
    if (!settingsId) throw new Error('Missing review arr configuration');
    const key = `${movie ? 'radarr' : 'sonarr'}:${settingsId}`;
    const cached = this.arrCache.get(key);
    if (cached && Date.now() - cached.readAt < ARR_TTL_MS)
      return cached.entries;
    const readAt = Date.now();
    const entries = new Map<number, ReviewArrEntry>();
    if (movie) {
      const api = await this.servarr.getRadarrApiClient(settingsId);
      // Radarr sends each movie's TMDB collection; the shared typing omits it.
      const movies = (await api.getMovies()) as
        | (RadarrMovie & { collection?: { tmdbId?: number; title?: string } })[]
        | undefined;
      if (!Array.isArray(movies)) throw new Error('Unread Radarr library');
      for (const entry of movies) {
        if (entries.has(entry.tmdbId)) continue;
        const imdb = entry.ratings?.imdb;
        entries.set(entry.tmdbId, {
          kind: 'radarr',
          settingsId,
          id: entry.id,
          providerId: entry.tmdbId,
          tmdbId: entry.tmdbId,
          path: entry.path,
          addedAt: entry.movieFile?.dateAdded,
          imdbRating: imdb?.votes ? validImdbRating(imdb.value) : null,
          group: entry.collection?.tmdbId
            ? {
                id: `tmdb:${entry.collection.tmdbId}`,
                title: entry.collection.title || '',
              }
            : null,
        });
      }
    } else {
      const api = await this.servarr.getSonarrApiClient(settingsId);
      const series = await api.getSeries();
      if (!Array.isArray(series)) throw new Error('Unread Sonarr library');
      for (const entry of series) {
        if (entries.has(entry.tvdbId)) continue;
        entries.set(entry.tvdbId, {
          kind: 'sonarr',
          settingsId,
          id: entry.id,
          providerId: entry.tvdbId,
          tmdbId: entry.tmdbId,
          path: entry.path,
          addedAt: entry.added,
          // Sonarr's rating is not IMDb's; the Plex rating fills it in.
          imdbRating: null,
          group: null,
        });
      }
    }
    this.arrCache.set(key, { readAt, entries });
    return entries;
  }

  /**
   * M18: Seerr requests from the last year, and every Plex and Seerr
   * watchlist. Read fresh each time; an unreadable source fails the list
   * rather than hiding a protection.
   */
  private async reviewProtections(cutoff: number): Promise<ReviewProtections> {
    const protections: ReviewProtections = {
      requested: new Set(),
      requestedTvdb: new Set(),
      plexWatchlist: new Set(),
      seerrWatchlist: new Set(),
    };
    const readSeerr = async () => {
      if (!this.seerr.isConfigured()) return;
      const [requests, watchlists] = await Promise.all([
        this.seerr.getRequests(),
        this.seerr.getFreshWatchlistIndex(),
      ]);
      if (!requests || !watchlists)
        throw new Error('Seerr requests or watchlists unread');
      for (const request of requests) {
        // An unreadable date protects, like a recent one.
        const requestedAt = Date.parse(request.createdAt);
        if (Number.isFinite(requestedAt) && requestedAt < cutoff) continue;
        if (request.media?.tmdbId)
          protections.requested.add(`${request.type}:${request.media.tmdbId}`);
        if (request.type === 'tv' && request.media?.tvdbId)
          protections.requestedTvdb.add(request.media.tvdbId);
      }
      for (const key of watchlists.keys()) protections.seerrWatchlist.add(key);
    };
    const readPlex = async () => {
      const users = await this.plex.getCorrectedUsers();
      const readable = users.filter((user) => user.uuid);
      if (users.length > 0 && readable.length === 0)
        throw new Error('Plex watchlists unread: no plex.tv user ids');
      // The community client caches answers for minutes; a title added to a
      // watchlist since must protect now.
      cacheManager.getCache('plexcommunity')?.flush();
      await mapLimit(readable, READ_CONCURRENCY, async (user) => {
        const watchlist = await this.plex.getWatchlistIdsForUser(
          user.uuid,
          user.username,
        );
        if (watchlist === undefined)
          throw new Error(`Plex watchlist of ${user.username} unread`);
        // null: Plex does not share this user's watchlist (Seerr may).
        for (const entry of watchlist ?? [])
          protections.plexWatchlist.add(entry.id);
      });
    };
    await Promise.all([readSeerr(), readPlex()]);
    return protections;
  }

  /** IMDb rating from Plex's own ratings, for titles the arr has none for. */
  private async plexImdbRating(itemId: string): Promise<number | null> {
    const cached = this.ratingCache.get(itemId);
    if (cached && Date.now() - cached.readAt < RATING_TTL_MS)
      return cached.value;
    const native = await this.plex.getMetadata(itemId);
    if (!native) return null;
    const value = validImdbRating(
      native.Rating?.find((entry) =>
        entry.image?.toLowerCase().includes('imdb'),
      )?.value,
    );
    this.ratingCache.set(itemId, { readAt: Date.now(), value });
    return value;
  }

  /**
   * Every title in the collection that may be reviewed, biggest first. One
   * read per source for the whole list; approve() repeats its own fresh
   * per-title checks before anything is acted on.
   */
  async list(id: number): Promise<CollectionReview> {
    const collection = await this.collection(id);
    const result: CollectionReview = {
      collectionId: id,
      reviewRequired: collection.reviewRequired,
      action: collection.arrAction,
      approvalAllowed: allowsReviewDeletion(collection),
      candidates: [],
      unavailableIds: [],
    };
    if (!collection.reviewRequired) return result;
    const type = collection.type === 'movie' ? 'movie' : 'show';
    const cutoff = Date.now() - REVIEW_WINDOW_MS;
    const [rows, exclusions, playing, inventory, arr, protections] =
      await Promise.all([
        this.media.find({ where: { collectionId: id } }),
        this.exclusions.find(),
        this.playing(),
        this.reviewInventory(type),
        this.reviewArr(collection),
        this.reviewProtections(cutoff),
      ]);
    // Read after every network read finished, so it is the newest input.
    const { states, showSizes } = this.storedWatch.getReviewSnapshot(type);
    const cascade = buildExclusionCascadeSets(
      exclusions.filter(
        (exclusion) =>
          exclusion.ruleGroupId == null ||
          exclusion.ruleGroupId === collection.ruleGroup?.id,
      ),
    );
    const index = indexInventory(
      inventory,
      type === 'movie' ? 'radarr' : 'sonarr',
    );
    const unrated: ReviewCandidate[] = [];
    for (const row of rows) {
      if (row.ruleEvaluationFailed) continue;
      const outcome = evaluateReviewRow({
        type,
        row,
        inventory: index,
        arr,
        states,
        showSizes,
        cascade,
        playing,
        protections,
        cutoff,
      });
      if (outcome.kind === 'unavailable')
        result.unavailableIds.push(row.mediaServerId);
      if (outcome.kind !== 'candidate') continue;
      result.candidates.push(outcome.candidate);
      if (outcome.needsRating) unrated.push(outcome.candidate);
    }
    await mapLimit(unrated, RATING_CONCURRENCY, async (candidate) => {
      candidate.imdbRating = await this.plexImdbRating(candidate.id);
      candidate.lowRated =
        candidate.imdbRating !== null && candidate.imdbRating < 6;
    });
    result.candidates.sort(
      (a, b) => b.sizeBytes - a.sizeBytes || a.id.localeCompare(b.id),
    );
    return result;
  }

  /**
   * Keep forever: a global exclusion, so no rule, review or approval acts on
   * the title again. Remove it from Maintainerr's exclusions to undo.
   */
  async keep(id: number, ids: string[]): Promise<void> {
    // Same guard as the stock exclusion endpoint: never race a rule run.
    const release = this.executionLock.tryAcquire(
      RULES_COLLECTIONS_EXECUTION_LOCK_KEY,
    );
    if (!release)
      throw new ConflictException('A collection or rule run is in progress');
    try {
      const collection = await this.collection(id);
      const members = new Set(
        (await this.media.find({ where: { collectionId: id } })).map(
          (row) => row.mediaServerId,
        ),
      );
      if (ids.some((itemId) => !members.has(itemId)))
        throw new BadRequestException(
          'Selection contains titles outside this collection. Reload the review.',
        );
      for (const itemId of ids) {
        const existing = await this.exclusions.findOne({
          where: { mediaServerId: itemId, ruleGroupId: IsNull() },
        });
        if (!existing)
          await this.exclusions.save({
            mediaServerId: itemId,
            ruleGroupId: null,
            parent: itemId,
            type: collection.type,
          });
        // A global exclusion subsumes scoped ones, as the stock endpoint does.
        await this.exclusions.delete({
          mediaServerId: itemId,
          ruleGroupId: Not(IsNull()),
        });
        this.logger.log(`Review keep forever: global exclusion for ${itemId}`);
        try {
          await this.collectionService.CollectionLogRecordForChild(
            itemId,
            collection.id,
            'exclude',
          );
        } catch {
          this.logger.warn(`Could not write the keep log record for ${itemId}`);
        }
      }
    } finally {
      release();
    }
  }

  private async recordScheduled(
    collection: Collection,
    item: ReviewApprovalItem,
  ): Promise<void> {
    const message = `Review approval scheduled: ${JSON.stringify(item)}`;
    this.logger.log(message);
    try {
      await this.collectionService.addLogRecord(
        collection,
        message,
        ECollectionLogType.MEDIA,
        { type: 'review_deletion', data: item },
      );
    } catch {
      this.logger.error(
        `Could not persist approval audit; retained in application log: ${JSON.stringify(item)}`,
      );
    }
  }

  /**
   * Approval never deletes. It binds each ticked title to its arr target, puts
   * it in the Plex "Leaving soon" collection and records it as pending; the
   * daily job deletes it at its date unless someone watches it first.
   */
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
      if (!allowsReviewDeletion(collection))
        throw new BadRequestException(
          'Review deletion requires whole-title Delete without list exclusions',
        );
      const active = await this.leavingSoon.activeIds(id);
      if (ids.some((itemId) => active.has(itemId)))
        throw new ConflictException(
          'A selected title is already leaving soon. Reload the review.',
        );
      const rows = await this.media.find({ where: { collectionId: id } });
      const byId = new Map(rows.map((row) => [row.mediaServerId, row]));
      if (ids.some((itemId) => !byId.has(itemId)))
        throw new ConflictException('Collection membership changed');
      const entries: LeavingSoonEntry[] = [];
      const canonical = new Set<string>();
      for (const itemId of ids) {
        const row = byId.get(itemId)!;
        const [item] = await this.freshItems([itemId]);
        const target = await this.target(collection, row, item);
        const key = `${target.kind}:${target.settingsId}:${target.id}`;
        if (canonical.has(key))
          throw new BadRequestException(
            'Selection contains duplicate arr targets',
          );
        canonical.add(key);
        const plexIds = await this.validateTarget(collection, row, target);
        entries.push({
          mediaServerId: itemId,
          title: item.title,
          year: item.year ?? null,
          sizeBytes: review.candidates.find(
            (candidate) => candidate.id === itemId,
          )!.sizeBytes,
          plexIds,
          target,
        });
      }
      const scheduled = await this.leavingSoon.schedule(collection, entries);
      const result: ReviewApprovalResult = { items: [] };
      for (const row of scheduled) {
        const item: ReviewApprovalItem = {
          id: row.mediaServerId,
          title: row.title,
          year: row.year ?? null,
          sizeBytes: Number(row.sizeBytes),
          arrService: row.arrService,
          arrSettingsId: row.arrSettingsId,
          arrId: row.arrId,
          plexIds: [...row.plexIds],
          providerId: row.providerId,
          path: row.path,
          status: 'scheduled',
          at: new Date(row.approvedAt).toISOString(),
          deleteAt: new Date(row.deleteAt).toISOString(),
        };
        await this.recordScheduled(collection, item);
        result.items.push(item);
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
