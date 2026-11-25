import {
  MediaItem,
  ReviewCandidate,
  ReviewGroup,
  ReviewWatcher,
} from '@maintainerr/contracts';
import { PlexMapper } from '../api/media-server/plex/plex.mapper';
import { StoredReviewState } from '../api/plex-api/plex-stored-watch.service';
import {
  ExclusionCascadeSets,
  isMediaItemExcluded,
} from '../rules/helpers/exclusion-cascade.helper';

/**
 * Pure review-list evaluation. Every input is read once for the whole list
 * (no per-title network call), so the list scales with library size rather
 * than with one round trip per title. approve() keeps its own fresh per-title
 * checks; this only decides what the page shows.
 */

export interface ReviewArrEntry {
  kind: 'radarr' | 'sonarr';
  settingsId: number;
  id: number;
  /** tmdbId for movies, tvdbId for shows. */
  providerId: number;
  /** The show's tmdbId (Seerr keys tv by tmdb); the movie's own for movies. */
  tmdbId?: number;
  path: string;
  addedAt?: string;
  imdbRating: number | null;
  group: ReviewGroup | null;
}

/** M18 protections read once per list. */
export interface ReviewProtections {
  /** `movie:<tmdb>` / `tv:<tmdb>` requested in Seerr inside the window. */
  requested: Set<string>;
  /** tvdb ids of shows requested in Seerr inside the window. */
  requestedTvdb: Set<number>;
  /** Plex agent ids on any Plex user's watchlist. */
  plexWatchlist: Set<string>;
  /** `movie:<tmdb>` / `tv:<tmdb>` on any Seerr user's watchlist. */
  seerrWatchlist: Set<string>;
}

export interface ReviewInventoryIndex {
  byId: Map<string, MediaItem>;
  byProvider: Map<string, MediaItem[]>;
  byFolder: Map<string, MediaItem[]>;
  /** An item without a path or provider id could be a copy of any target. */
  unidentified: boolean;
}

export type ReviewRowOutcome =
  | { kind: 'candidate'; candidate: ReviewCandidate; needsRating: boolean }
  | { kind: 'protected'; reason: ReviewProtectionReason }
  | { kind: 'unavailable' };

export type ReviewProtectionReason =
  | 'excluded'
  | 'playing'
  | 'recent-watch'
  | 'recent-add'
  | 'in-progress'
  | 'seerr-request'
  | 'watchlist';

const add = (map: Map<string, MediaItem[]>, key: string, item: MediaItem) => {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
};

export function indexInventory(
  items: MediaItem[],
  kind: 'radarr' | 'sonarr',
): ReviewInventoryIndex {
  const index: ReviewInventoryIndex = {
    byId: new Map(),
    byProvider: new Map(),
    byFolder: new Map(),
    unidentified: false,
  };
  for (const item of items) {
    index.byId.set(item.id, item);
    const providers =
      (kind === 'radarr' ? item.providerIds.tmdb : item.providerIds.tvdb) ?? [];
    if (!item.path && providers.length === 0) index.unidentified = true;
    for (const provider of new Set(providers)) add(index.byProvider, provider, item);
    if (item.path) {
      // The item itself and every ancestor folder, so a target folder finds
      // the files beneath it in one lookup.
      const folders = new Set([item.path]);
      for (let at = 1; at < item.path.length; at++) {
        const char = item.path[at];
        if (char === '/' || char === '\\') folders.add(item.path.slice(0, at));
      }
      for (const folder of folders) add(index.byFolder, folder, item);
    }
  }
  return index;
}

/** Every Plex item one arr target covers: same provider id or under its folder. */
export function affectedItems(
  index: ReviewInventoryIndex,
  target: ReviewArrEntry,
): MediaItem[] {
  const folder = target.path.replace(/[\\/]+$/, '');
  const found = new Map<string, MediaItem>();
  for (const item of index.byProvider.get(String(target.providerId)) ?? [])
    found.set(item.id, item);
  for (const item of index.byFolder.get(folder) ?? []) found.set(item.id, item);
  return [...found.values()];
}

export function lastWatchedMs(
  item: MediaItem,
  state: StoredReviewState | undefined,
): number {
  return Math.max(
    item.lastViewedAt?.getTime() ?? 0,
    ...(state?.watchers ?? []).map((watcher) =>
      new Date(watcher.lastWatchedAt).getTime(),
    ),
  );
}

export function validImdbRating(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 10
    ? value
    : null;
}

export interface ReviewRowInput {
  type: 'movie' | 'show';
  row: { mediaServerId: string; tmdbId?: number | null; tvdbId?: number | null };
  inventory: ReviewInventoryIndex;
  arr: Map<number, ReviewArrEntry>;
  states: Map<string, StoredReviewState>;
  showSizes: Map<string, number>;
  cascade: ExclusionCascadeSets;
  playing: Set<string>;
  protections: ReviewProtections;
  cutoff: number;
}

export function evaluateReviewRow(input: ReviewRowInput): ReviewRowOutcome {
  const { type, row, inventory, cutoff, protections } = input;
  const item = inventory.byId.get(row.mediaServerId);
  if (!item || item.type !== type || inventory.unidentified)
    return { kind: 'unavailable' };
  const movie = type === 'movie';
  const providerId = Number((movie ? item.providerIds.tmdb : item.providerIds.tvdb)?.[0]);
  const cached = movie ? row.tmdbId : row.tvdbId;
  if (
    !Number.isSafeInteger(providerId) ||
    providerId <= 0 ||
    (cached != null && cached !== providerId)
  )
    return { kind: 'unavailable' };
  const target = input.arr.get(providerId);
  if (
    !target ||
    !Number.isSafeInteger(target.id) ||
    target.id <= 0 ||
    !target.path ||
    !target.addedAt ||
    !Number.isFinite(new Date(target.addedAt).getTime())
  )
    return { kind: 'unavailable' };
  const affected = affectedItems(inventory, target);
  if (!affected.some((candidate) => candidate.id === item.id))
    return { kind: 'unavailable' };

  if (new Date(target.addedAt).getTime() >= cutoff)
    return { kind: 'protected', reason: 'recent-add' };
  // Every Plex copy of the target protects the whole target: deleting the arr
  // entry removes them all.
  for (const copy of affected) {
    if (isMediaItemExcluded(input.cascade, copy))
      return { kind: 'protected', reason: 'excluded' };
    if (input.playing.has(copy.id))
      return { kind: 'protected', reason: 'playing' };
    const state = input.states.get(copy.id);
    const watched = lastWatchedMs(copy, state);
    if (!Number.isFinite(watched)) return { kind: 'unavailable' };
    if (watched >= cutoff) return { kind: 'protected', reason: 'recent-watch' };
    if (state?.inProgress) return { kind: 'protected', reason: 'in-progress' };
  }
  const seerrType = movie ? 'movie' : 'tv';
  const tmdbIds = new Set<number>();
  if (target.tmdbId) tmdbIds.add(target.tmdbId);
  for (const copy of affected)
    for (const id of copy.providerIds.tmdb ?? [])
      if (Number(id) > 0) tmdbIds.add(Number(id));
  if (
    [...tmdbIds].some((id) => protections.requested.has(`${seerrType}:${id}`)) ||
    (!movie && protections.requestedTvdb.has(providerId))
  )
    return { kind: 'protected', reason: 'seerr-request' };
  if (
    [...tmdbIds].some((id) =>
      protections.seerrWatchlist.has(`${seerrType}:${id}`),
    ) ||
    affected.some((copy) => {
      const agentId = PlexMapper.extractPlexAgentId(copy.guid);
      return agentId !== undefined && protections.plexWatchlist.has(agentId);
    })
  )
    return { kind: 'protected', reason: 'watchlist' };

  const sizeBytes = movie
    ? item.mediaSources.reduce((sum, source) => sum + (source.sizeBytes ?? 0), 0)
    : (input.showSizes.get(item.id) ?? 0);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0)
    return { kind: 'unavailable' };
  const state = input.states.get(item.id);
  const watchers = state?.watchers ?? [];
  const watched = lastWatchedMs(item, state);
  const candidate: ReviewCandidate = {
    id: item.id,
    title: item.title,
    sizeBytes,
    imdbRating: target.imdbRating,
    lowRated: target.imdbRating !== null && target.imdbRating < 6,
    addedAt: new Date(target.addedAt).toISOString(),
    lastWatchedAt: watched > 0 ? new Date(watched).toISOString() : null,
    watchers,
    group: target.group,
    is4k: item.mediaSources.some(
      (source) =>
        (source.height ?? 0) >= 2000 ||
        source.videoResolution?.toLowerCase() === '4k',
    ),
  };
  return { kind: 'candidate', candidate, needsRating: target.imdbRating === null };
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await fn(items[at]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
