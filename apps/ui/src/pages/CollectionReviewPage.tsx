import { Trans, useLingui } from '@lingui/react/macro'
import type {
  ReviewApprovalResult,
  ReviewCandidate,
} from '@maintainerr/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  approveCollectionReview,
  enableCollectionReview,
  invalidateCollectionQueries,
  keepCollectionReviewItems,
  useCollectionReview,
} from '../api/collections'
import Button from '../components/Common/Button'
import ConfirmActionButton from '../components/Common/ConfirmActionButton'
import { groupReviewCandidates } from '../utils/reviewGroups'

// Rows rendered at first, and per "Show more": a phone renders 1,000+ rows slowly.
const PAGE_SIZE = 60

const formatSize = (bytes: number) =>
  bytes >= 1e12
    ? `${(bytes / 1e12).toFixed(2)} TB`
    : `${(bytes / 1e9).toFixed(2)} GB`

const CollectionReviewPage = ({ id }: { id: string }) => {
  const { t, i18n } = useLingui()
  const queryClient = useQueryClient()
  const { data, isPending, error, refetch } = useCollectionReview(id)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [outcome, setOutcome] = useState<ReviewApprovalResult>()
  const [shown, setShown] = useState(PAGE_SIZE)
  // Kept titles leave the page at once; the reload confirms it.
  const [kept, setKept] = useState<Set<string>>(() => new Set())
  const enable = useMutation({
    mutationFn: () => enableCollectionReview(id),
    onSuccess: () => invalidateCollectionQueries(queryClient),
  })
  const keep = useMutation({
    mutationFn: (itemId: string) => keepCollectionReviewItems(id, [itemId]),
    onSuccess: async (_result, itemId) => {
      setKept((previous) => new Set(previous).add(itemId))
      setSelected((previous) => {
        const next = new Set(previous)
        next.delete(itemId)
        return next
      })
      await invalidateCollectionQueries(queryClient)
    },
  })
  const candidates = useMemo(
    () => (data?.candidates ?? []).filter((item) => !kept.has(item.id)),
    [data?.candidates, kept],
  )
  const entries = useMemo(() => groupReviewCandidates(candidates), [candidates])
  const remaining = entries.length - shown
  const chosen = candidates.filter((item) => selected.has(item.id))
  const count = chosen.length
  const size = formatSize(chosen.reduce((sum, item) => sum + item.sizeBytes, 0))
  const unavailableCount = data?.unavailableIds.length ?? 0
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleDateString(i18n.locale) : t`Never watched`
  // Read as plain values: the approval flow may add statuses and fields.
  const outcomeLabel = (item: { status: string; deleteAt?: string }) => {
    switch (item.status) {
      case 'scheduled':
        return item.deleteAt
          ? t`Leaving ${{ date: date(item.deleteAt) }}`
          : t`Leaving soon`
      case 'deleted':
        return t`Deleted`
      case 'deleted-with-cleanup-failure':
        return t`Deleted; cleanup failed`
      case 'not-deleted':
        return t`Not deleted`
      default:
        return t`Outcome uncertain; reload and review before trying again`
    }
  }
  const toggle = (itemId: string, checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous)
      if (checked) next.add(itemId)
      else next.delete(itemId)
      return next
    })

  if (isPending)
    return (
      <p role="status">
        <Trans>Loading review...</Trans>
      </p>
    )
  if (error || !data)
    return (
      <div role="alert">
        <p>
          <Trans>Review could not be loaded. Nothing was acted on.</Trans>
        </p>
        <Button onClick={() => void refetch()}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    )

  const row = (item: ReviewCandidate) => (
    <li key={item.id} className="rounded-lg bg-zinc-800 p-4 text-zinc-200">
      <label className="mb-3 flex min-h-11 cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="h-6 w-6 shrink-0 rounded focus-visible:ring-2"
          checked={selected.has(item.id)}
          onChange={(event) => toggle(item.id, event.currentTarget.checked)}
          aria-label={t`Select ${{ title: item.title }}`}
        />
        <span className="min-w-0 text-lg font-semibold break-words">
          {item.title}
        </span>
        {item.is4k ? (
          <span className="shrink-0 rounded bg-zinc-600 px-2 text-sm">4K</span>
        ) : null}
      </label>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div>
          <dt className="text-zinc-400">
            <Trans>Size</Trans>
          </dt>
          <dd>{formatSize(item.sizeBytes)}</dd>
        </div>
        <div>
          <dt className="text-zinc-400">IMDb</dt>
          <dd>
            {item.imdbRating ?? t`Unknown`}
            {item.lowRated ? (
              <span className="ms-2 text-amber-300">
                <Trans>Low rating (&lt;6.0)</Trans>
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-400">
            <Trans>Added</Trans>
          </dt>
          <dd>{date(item.addedAt)}</dd>
        </div>
        <div>
          <dt className="text-zinc-400">
            <Trans>Last watched</Trans>
          </dt>
          <dd>{date(item.lastWatchedAt)}</dd>
        </div>
      </dl>
      <div className="mt-3">
        <p className="text-zinc-400">
          <Trans>Watched by</Trans>
        </p>
        {item.watchers.length ? (
          <ul>
            {item.watchers.map((watcher) => (
              <li key={watcher.userId}>
                {watcher.name}: {date(watcher.lastWatchedAt)}
              </li>
            ))}
          </ul>
        ) : (
          <p>
            <Trans>No recorded viewers</Trans>
          </p>
        )}
      </div>
      <Button
        className="mt-3 min-h-11"
        disabled={keep.isPending}
        onClick={() => keep.mutate(item.id)}
        aria-label={t`Keep ${{ title: item.title }} forever`}
      >
        <Trans>Keep forever</Trans>
      </Button>
    </li>
  )

  return (
    <section
      className="mx-auto max-w-6xl pb-8 tabular-nums"
      aria-labelledby="review-heading"
    >
      <h2
        id="review-heading"
        className="mb-3 text-xl font-semibold text-zinc-100"
      >
        <Trans>Review before deletion</Trans>
      </h2>
      {!data.reviewRequired ? (
        <div className="space-y-4 text-zinc-200">
          <p>
            <Trans>
              Enable review to stop this collection from taking any scheduled
              action. Only titles you select and confirm here can be acted on.
            </Trans>
          </p>
          <Button
            className="min-h-11"
            disabled={enable.isPending}
            onClick={() => enable.mutate()}
          >
            <Trans>Enable review mode</Trans>
          </Button>
          {enable.error ? (
            <p role="alert">
              <Trans>
                Could not enable review mode. Try again after the current rule
                or collection run.
              </Trans>
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <p className="mb-4 text-zinc-300">
            <Trans>
              Biggest first, movie series together. Nothing is selected
              automatically. Titles watched or added in the last year, requested
              in the last year, on a watchlist, partly watched, or kept forever
              are not listed.
            </Trans>
          </p>
          <div className="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-4 bg-zinc-900 py-2">
            <p className="text-zinc-200">
              <Trans>
                Selected titles: {count}, total size: {size}
              </Trans>
            </p>
            <ConfirmActionButton
              buttonLabel={t`Move to Leaving soon`}
              buttonType="danger"
              buttonClassName="min-h-11"
              confirmButtonType="danger"
              modalTitle={t`Move to Leaving soon`}
              confirmLabel={t`Confirm move`}
              pendingLabel={t`Moving to Leaving soon...`}
              disabled={count === 0 || count > 500 || !data.approvalAllowed}
              errorMessage={t`Could not move the titles. Reload the review before trying again.`}
              errorLogSummary="Review approval failed"
              errorContext="CollectionReviewPage.approve"
              onConfirm={async () => {
                const result = await approveCollectionReview(
                  id,
                  chosen.map((item) => item.id),
                )
                setSelected(new Set())
                setOutcome(result)
                await invalidateCollectionQueries(queryClient)
              }}
            >
              <p className="mb-3">
                <Trans>
                  Selected titles: {count}, total size: {size}. These titles go
                  to a 'Leaving soon' row for 14 days. Anyone watching one saves
                  it. After that they're deleted, with 7 days to undo.
                </Trans>
              </p>
              <ul className="list-inside list-disc">
                {chosen.map((item) => (
                  <li key={item.id}>{item.title}</li>
                ))}
              </ul>
            </ConfirmActionButton>
          </div>
          {!data.approvalAllowed ? (
            <p className="mb-4 text-amber-300">
              <Trans>
                Approval requires whole-title Delete in Radarr or Sonarr with
                list exclusions enabled. Other actions remain disabled.
              </Trans>
            </p>
          ) : null}
          {count > 500 ? (
            <p role="alert">
              <Trans>Select at most 500 titles per approval.</Trans>
            </p>
          ) : null}
          {keep.error ? (
            <p role="alert" className="mb-4 text-amber-300">
              <Trans>Could not keep the title. Reload and try again.</Trans>
            </p>
          ) : null}
          {outcome ? (
            <ul
              role={
                outcome.items.some(
                  (item) =>
                    !['scheduled', 'deleted'].includes(item.status as string),
                )
                  ? 'alert'
                  : 'status'
              }
              className="mb-4 text-zinc-200"
            >
              {outcome.items.map((item) => (
                <li key={item.id}>
                  {item.title}: {outcomeLabel(item)}
                </li>
              ))}
            </ul>
          ) : null}
          {data.unavailableIds.length ? (
            <p role="alert" className="mb-4 text-amber-300">
              <Trans>
                Unverified titles: {unavailableCount}. These titles are not
                selectable. Check Plex watch-state access and arr connections.
              </Trans>
            </p>
          ) : null}
          {entries.length === 0 ? (
            <p role="status">
              <Trans>No eligible titles to review.</Trans>
            </p>
          ) : (
            <>
              <ol className="space-y-3">
                {entries.slice(0, shown).map((entry) =>
                  entry.series ? (
                    <li
                      key={entry.key}
                      className="rounded-lg border border-zinc-600 p-2"
                    >
                      <h3 className="mb-2 px-2 font-semibold text-zinc-300">
                        {entry.series}
                      </h3>
                      <ol className="space-y-3">{entry.items.map(row)}</ol>
                    </li>
                  ) : (
                    row(entry.items[0])
                  ),
                )}
              </ol>
              {shown < entries.length ? (
                <Button
                  className="mt-4 min-h-11 w-full"
                  onClick={() => setShown((value) => value + PAGE_SIZE)}
                >
                  <Trans>Show more ({remaining} left)</Trans>
                </Button>
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  )
}

const CollectionReviewRoute = () => {
  const { id = '' } = useParams<{ id: string }>()
  return <CollectionReviewPage key={id} id={id} />
}

export default CollectionReviewRoute
