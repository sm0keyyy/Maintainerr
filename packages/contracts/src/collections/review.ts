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
  candidates: ReviewCandidate[]
  unavailableIds: string[]
}

export interface ReviewApprovalResult {
  handledIds: string[]
  failedIds: string[]
}
