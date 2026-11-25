import { Trans, useLingui } from '@lingui/react/macro'
import type { ReviewPendingItem } from '@maintainerr/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  cancelLeavingSoon,
  LEAVING_SOON_QUERY_KEY,
} from '../../api/leavingSoon'
import Button from '../Common/Button'

interface LeavingSoonBadgeProps {
  item: ReviewPendingItem
  onCancelled?: (item: ReviewPendingItem) => void
}

/**
 * Status of an approved review title: in Plex "Leaving soon" until its date,
 * with a button that pulls it back. Import it beside a review candidate whose
 * id matches `item.mediaServerId`.
 */
const LeavingSoonBadge = ({ item, onCancelled }: LeavingSoonBadgeProps) => {
  const { t, i18n } = useLingui()
  const queryClient = useQueryClient()
  const cancel = useMutation({
    mutationFn: () => cancelLeavingSoon(item.id),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: LEAVING_SOON_QUERY_KEY })
      onCancelled?.(updated)
    },
  })
  const date = new Date(item.deleteAt).toLocaleDateString(i18n.locale)

  if (item.status === 'deleting')
    return (
      <span role="status" className="text-sm text-amber-300">
        <Trans>Deleting now</Trans>
      </span>
    )

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="rounded bg-amber-600/20 px-2 py-1 text-sm text-amber-300">
        <Trans>Leaving soon: deleted on {date} unless someone watches it</Trans>
      </span>
      <Button
        buttonSize="sm"
        className="min-h-11"
        disabled={cancel.isPending}
        aria-label={t`Keep ${{ title: item.title }}`}
        onClick={() => cancel.mutate()}
      >
        <Trans>Keep</Trans>
      </Button>
      {cancel.error ? (
        <span role="alert" className="text-sm text-red-300">
          <Trans>Could not cancel. It may already be deleting; reload.</Trans>
        </span>
      ) : null}
    </span>
  )
}

export default LeavingSoonBadge
