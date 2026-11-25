import type { ReviewPendingItem } from '@maintainerr/contracts'
import { useQuery } from '@tanstack/react-query'
import GetApiHandler, { PostApiHandler } from '../utils/ApiHandler'

export const LEAVING_SOON_QUERY_KEY = ['review', 'leaving-soon'] as const

/** Approved titles still in Plex "Leaving soon" (pending or being deleted). */
export const useLeavingSoon = (collectionId?: string) =>
  useQuery({
    queryKey: [...LEAVING_SOON_QUERY_KEY, collectionId ?? 'all'],
    queryFn: () =>
      GetApiHandler<ReviewPendingItem[]>(
        collectionId
          ? `/review/leaving-soon?collectionId=${encodeURIComponent(collectionId)}`
          : '/review/leaving-soon',
      ),
  })

export const cancelLeavingSoon = (id: number) =>
  PostApiHandler<ReviewPendingItem>(`/review/leaving-soon/${id}/cancel`, {})
