import type { ReviewPendingItem } from '@maintainerr/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../test-utils/render'
import { PostApiHandler } from '../../utils/ApiHandler'
import LeavingSoonBadge from './LeavingSoonBadge'

vi.mock('../../utils/ApiHandler', () => ({
  default: vi.fn(),
  PostApiHandler: vi.fn(),
}))

const pending: ReviewPendingItem = {
  id: 12,
  collectionId: 1,
  mediaServerId: '777',
  title: 'The Matrix',
  year: 1999,
  arrService: 'radarr',
  arrId: 42,
  providerId: 603,
  path: '/data/library/movies/The Matrix (1999)',
  sizeBytes: 12000000000,
  approvedAt: '2026-11-24T12:00:00.000Z',
  deleteAt: '2026-12-08T12:00:00.000Z',
  status: 'pending',
  resolvedAt: null,
  note: null,
  seerr: null,
}

const renderBadge = (
  item: ReviewPendingItem,
  onCancelled?: (item: ReviewPendingItem) => void,
) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LeavingSoonBadge item={item} onCancelled={onCancelled} />
    </QueryClientProvider>,
  )

describe('Leaving soon badge', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the delete date and cancels the pending title', async () => {
    vi.mocked(PostApiHandler).mockResolvedValue({
      ...pending,
      status: 'cancelled',
    })
    const onCancelled = vi.fn()
    renderBadge(pending, onCancelled)
    expect(
      screen.getByText(
        `Leaving soon: deleted on ${new Date(pending.deleteAt).toLocaleDateString('en')} unless someone watches it`,
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep The Matrix' }))
    await waitFor(() =>
      expect(PostApiHandler).toHaveBeenCalledWith(
        '/review/leaving-soon/12/cancel',
        {},
      ),
    )
    await waitFor(() =>
      expect(onCancelled).toHaveBeenCalledWith(
        expect.objectContaining({ id: 12, status: 'cancelled' }),
      ),
    )
  })

  it('reports a refused cancel', async () => {
    vi.mocked(PostApiHandler).mockRejectedValue(new Error('409'))
    renderBadge(pending)
    fireEvent.click(screen.getByRole('button', { name: 'Keep The Matrix' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('offers no cancel while the title is being deleted', () => {
    renderBadge({ ...pending, status: 'deleting' })
    expect(screen.getByRole('status').textContent).toBe('Deleting now')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
