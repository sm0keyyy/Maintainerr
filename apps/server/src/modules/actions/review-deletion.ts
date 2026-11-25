import { ReviewArrOutcome } from '@maintainerr/contracts';
import { Collection } from '../collections/entities/collection.entities';
import { ServarrAction } from '../collections/interfaces/collection.interface';

export interface ReviewTarget {
  kind: 'radarr' | 'sonarr';
  settingsId: number;
  id: number;
  providerId: number;
  path: string;
  addedAt: string;
}

export interface ReviewDeletion {
  target: ReviewTarget;
  beforeDelete: () => Promise<void>;
  recordOutcome: (outcome: ReviewArrOutcome) => Promise<void>;
}

/**
 * Approved review titles are deleted whole, through Radarr or Sonarr, without
 * an import-list exclusion so a later Seerr request can bring them back (M10).
 * The collection must say so too: Delete with list exclusions off.
 */
export const allowsReviewDeletion = (collection: Collection): boolean =>
  collection.reviewRequired === true &&
  collection.arrAction === ServarrAction.DELETE &&
  collection.listExclusions === false &&
  !collection.sportarrSettingsId &&
  ((collection.type === 'movie' &&
    !!collection.radarrSettingsId &&
    !collection.sonarrSettingsId) ||
    (collection.type === 'show' &&
      !!collection.sonarrSettingsId &&
      !collection.radarrSettingsId));
