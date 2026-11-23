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

export const allowsReviewDeletion = (collection: Collection): boolean =>
  collection.reviewRequired === true &&
  collection.arrAction === ServarrAction.DELETE &&
  collection.listExclusions === true &&
  !collection.sportarrSettingsId &&
  ((collection.type === 'movie' &&
    !!collection.radarrSettingsId &&
    !collection.sonarrSettingsId) ||
    (collection.type === 'show' &&
      !!collection.sonarrSettingsId &&
      !collection.radarrSettingsId));
