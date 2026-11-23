import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../test-utils/render'
import GetApiHandler, { PostApiHandler } from '../utils/ApiHandler'
import CollectionReviewPage from './CollectionReviewPage'

const route = vi.hoisted(() => ({ id: '7' }))
vi.mock('react-router-dom', () => ({ useParams: () => route }))
vi.mock('../utils/ApiHandler', () => ({
  default: vi.fn(),
  PostApiHandler: vi.fn(),
  PutApiHandler: vi.fn(),
}))

const candidates = [5, 4, 3, 2, 1].map((id) => ({
  id: String(id),
  title: `Movie ${id}`,
  sizeBytes: 1000000000,
  imdbRating: 5.9,
  lowRated: true,
  addedAt: '2020-01-01T00:00:00Z',
  lastWatchedAt: null,
  watchers: [],
}))

describe('Collection review selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.id = '7'
    vi.mocked(GetApiHandler).mockResolvedValue({
      collectionId: 7,
      reviewRequired: true,
      action: 0,
      candidates,
      unavailableIds: [],
    })
    vi.mocked(PostApiHandler).mockResolvedValue({
      handledIds: ['2', '4'],
      failedIds: [],
    })
  })
  it('starts empty and requires a count and size confirmation before acting on exactly the ticked titles', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <CollectionReviewPage />
      </QueryClientProvider>,
    )
    const boxes = await screen.findAllByRole('checkbox')
    expect(boxes).toHaveLength(5)
    expect(boxes.every((box) => !(box as HTMLInputElement).checked)).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete Movie 2' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Delete Movie 4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    expect(PostApiHandler).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        /Selected titles: 2, total size: 2.00 GB. Run the configured collection action/,
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
    await waitFor(() =>
      expect(PostApiHandler).toHaveBeenCalledWith(
        '/collections/7/review/approve',
        { ids: ['4', '2'] },
      ),
    )
    client.clear()
  })
  it('does not carry checked titles into another collection with overlapping membership', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const view = () => (
      <QueryClientProvider client={client}>
        <CollectionReviewPage />
      </QueryClientProvider>
    )
    const { rerender } = render(view())
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Delete Movie 2' }),
    )
    route.id = '8'
    rerender(view())
    const box = await screen.findByRole('checkbox', { name: 'Delete Movie 2' })
    expect((box as HTMLInputElement).checked).toBe(false)
    client.clear()
  })
})
