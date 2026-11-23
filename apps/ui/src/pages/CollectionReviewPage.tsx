import { Trans, useLingui } from '@lingui/react/macro'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  approveCollectionReview,
  enableCollectionReview,
  invalidateCollectionQueries,
  useCollectionReview,
} from '../api/collections'
import Button from '../components/Common/Button'
import ConfirmActionButton from '../components/Common/ConfirmActionButton'

const formatSize = (bytes: number) =>
  bytes >= 1e12
    ? `${(bytes / 1e12).toFixed(2)} TB`
    : `${(bytes / 1e9).toFixed(2)} GB`

const CollectionReviewPage = ({ id }: { id: string }) => {
  const { t, i18n } = useLingui()
  const queryClient = useQueryClient()
  const { data, isPending, error, refetch } = useCollectionReview(id)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [outcome, setOutcome] = useState<{ handled: number; failed: number }>()
  const enable = useMutation({
    mutationFn: () => enableCollectionReview(id),
    onSuccess: () => invalidateCollectionQueries(queryClient),
  })
  const chosen = data?.candidates.filter((item) => selected.has(item.id)) ?? []
  const count = chosen.length
  const size = formatSize(chosen.reduce((sum, item) => sum + item.sizeBytes, 0))
  const handledCount = outcome?.handled ?? 0
  const failedCount = outcome?.failed ?? 0
  const unavailableCount = data?.unavailableIds.length ?? 0
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleDateString(i18n.locale) : t`Never watched`

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
              Biggest first. Nothing is selected automatically. Titles watched
              by anyone or added in the last 365 days are protected.
            </Trans>
          </p>
          <div className="mb-4 flex flex-wrap items-center gap-4">
            <p className="text-zinc-200">
              <Trans>
                Selected titles: {count}, total size: {size}
              </Trans>
            </p>
            <ConfirmActionButton
              buttonLabel={t`Delete selected`}
              buttonType="danger"
              buttonClassName="min-h-11"
              confirmButtonType="danger"
              modalTitle={t`Confirm collection action`}
              confirmLabel={t`Confirm delete`}
              pendingLabel={t`Applying collection action...`}
              disabled={count === 0 || count > 500 || !data.approvalAllowed}
              errorMessage={t`Deletion failed. Reload the review before trying again.`}
              errorLogSummary="Review approval failed"
              errorContext="CollectionReviewPage.approve"
              onConfirm={async () => {
                const result = await approveCollectionReview(
                  id,
                  chosen.map((item) => item.id),
                )
                setSelected(new Set())
                setOutcome({
                  handled: result.handledIds.length,
                  failed: result.failedIds.length,
                })
                await invalidateCollectionQueries(queryClient)
              }}
            >
              <p className="mb-3">
                <Trans>
                  Selected titles: {count}, total size: {size}. Run the
                  configured collection action? Deleted files cannot be
                  recovered.
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
          {outcome ? (
            <p
              role={outcome.failed ? 'alert' : 'status'}
              className="mb-4 text-zinc-200"
            >
              <Trans>
                Handled titles: {handledCount}. Failed titles: {failedCount}.
                Failed titles were not reported as deleted.
              </Trans>
            </p>
          ) : null}
          {data.unavailableIds.length ? (
            <p role="alert" className="mb-4 text-amber-300">
              <Trans>
                Unverified titles: {unavailableCount}. These titles are not
                selectable. Check Plex watch-state access and arr connections.
              </Trans>
            </p>
          ) : null}
          {data.candidates.length === 0 ? (
            <p role="status">
              <Trans>No eligible titles to review.</Trans>
            </p>
          ) : (
            <ol className="space-y-3">
              {data.candidates.map((item) => (
                <li
                  key={item.id}
                  className="rounded-lg bg-zinc-800 p-4 text-zinc-200"
                >
                  <label className="mb-3 flex min-h-11 cursor-pointer items-center gap-3">
                    <input
                      type="checkbox"
                      className="h-6 w-6 shrink-0 rounded focus-visible:ring-2"
                      checked={selected.has(item.id)}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked
                        setSelected((previous) => {
                          const next = new Set(previous)
                          if (checked) next.add(item.id)
                          else next.delete(item.id)
                          return next
                        })
                      }}
                      aria-label={t`Delete ${{ title: item.title }}`}
                    />
                    <span className="min-w-0 text-lg font-semibold break-words">
                      {item.title}
                    </span>
                  </label>
                  <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
                </li>
              ))}
            </ol>
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
