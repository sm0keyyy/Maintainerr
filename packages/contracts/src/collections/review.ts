import { z } from 'zod'

export const reviewApprovalSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(500)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Duplicate ids are not allowed',
    ),
})

export interface ReviewWatcher {
  userId: string
  name: string
  lastWatchedAt: string
}

export interface ReviewCandidate {
  id: string
  title: string
  sizeBytes: number
  imdbRating: number | null
  lowRated: boolean
  addedAt: string
  lastWatchedAt: string | null
  watchers: ReviewWatcher[]
}

export interface CollectionReview {
  collectionId: number
  reviewRequired: boolean
  action: number
  approvalAllowed: boolean
  candidates: ReviewCandidate[]
  unavailableIds: string[]
}

export type ReviewArrOutcome = 'deleted' | 'not-deleted' | 'uncertain'

/**
 * `scheduled`: approval put the title in Plex "Leaving soon"; the arr delete
 * runs at `deleteAt` unless someone watches it or the approval is cancelled.
 */
export type ReviewDeletionStatus =
  ReviewArrOutcome | 'deleted-with-cleanup-failure' | 'scheduled'

export interface ReviewTitleIdentity {
  id: string
  title: string
  year: number | null
  sizeBytes: number
  arrService: 'radarr' | 'sonarr'
  arrSettingsId: number
  arrId: number
  plexIds: string[]
}

/** Seerr request/media cleanup after an arr delete. */
export type ReviewSeerrOutcome =
  'cleared' | 'no-entry' | 'failed' | 'not-configured' | 'no-tmdb-id'

export interface ReviewDeletionResult extends ReviewTitleIdentity {
  status: ReviewDeletionStatus
  /** Set on the scheduled delete's audit record. */
  providerId?: number
  path?: string
  seerr?: ReviewSeerrOutcome
  at?: string
}

export interface ReviewApprovalItem extends ReviewDeletionResult {
  deleteAt: string
}

export interface ReviewApprovalResult {
  items: ReviewApprovalItem[]
}

/** Days a title stays in Plex "Leaving soon" before the arr delete. */
export const LEAVING_SOON_DAYS = 14

export type ReviewPendingStatus =
  | 'pending'
  | 'deleting'
  | 'saved'
  | 'cancelled'
  | 'deleted'
  | 'deleted-with-cleanup-failure'
  | 'not-deleted'
  | 'uncertain'

export interface ReviewPendingItem {
  id: number
  collectionId: number
  mediaServerId: string
  title: string
  year: number | null
  arrService: 'radarr' | 'sonarr'
  arrId: number
  providerId: number
  path: string
  sizeBytes: number
  approvedAt: string
  deleteAt: string
  status: ReviewPendingStatus
  resolvedAt: string | null
  /** Why the title was saved, blocked or not deleted; null when none. */
  note: string | null
  seerr: ReviewSeerrOutcome | null
}
