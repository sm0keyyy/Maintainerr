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

const review = (items: unknown[] = candidates) => ({
  collectionId: 7,
  reviewRequired: true,
  action: 0,
  approvalAllowed: true,
  candidates: items,
  unavailableIds: [],
})

// The page also reads the Leaving soon list; it is empty unless a test sets it.
const mockReview = (body: unknown, leavingSoon: unknown[] = []) =>
  vi
    .mocked(GetApiHandler)
    .mockImplementation(async (url: string) =>
      url.startsWith('/review/leaving-soon') ? leavingSoon : body,
    )

const renderPage = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <CollectionReviewPage />
    </QueryClientProvider>,
  )
  return { client, view }
}

describe('Collection review selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.id = '7'
    mockReview(review())
    vi.mocked(PostApiHandler).mockResolvedValue({
      items: [
        { id: '2', title: 'Movie 2', status: 'scheduled' },
        { id: '4', title: 'Movie 4', status: 'scheduled' },
      ],
    })
  })
  it('starts empty and requires a count and size confirmation before moving exactly the ticked titles', async () => {
    const { client } = renderPage()
    const boxes = await screen.findAllByRole('checkbox')
    expect(boxes).toHaveLength(5)
    expect(boxes.every((box) => !(box as HTMLInputElement).checked)).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Movie 2' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Movie 4' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'Move to Leaving soon' }),
    )
    expect(PostApiHandler).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        /2 titles, 2.00 GB. They go to a 'Leaving soon' row in Plex for 14 days. Anyone watching one keeps it. The rest are deleted, with 7 days to undo./,
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
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
      await screen.findByRole('checkbox', { name: 'Select Movie 2' }),
    )
    route.id = '8'
    rerender(view())
    const box = await screen.findByRole('checkbox', { name: 'Select Movie 2' })
    expect((box as HTMLInputElement).checked).toBe(false)
    client.clear()
  })
  it('does not permit approval when whole-title delete with list exclusions is not configured', async () => {
    mockReview({
      ...review(),
      approvalAllowed: false,
      action: 1,
    })
    const { client } = renderPage()
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select Movie 2' }),
    )
    expect(
      (
        screen.getByRole('button', {
          name: 'Move to Leaving soon',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(PostApiHandler).not.toHaveBeenCalled()
    client.clear()
  })
  it('shows a scheduled title with its leaving date and distinguishes every other outcome', async () => {
    const deleteAt = '2026-12-08T09:00:00.000Z'
    vi.mocked(PostApiHandler).mockResolvedValue({
      items: [
        { id: '5', title: 'Movie 5', status: 'scheduled', deleteAt },
        { id: '4', title: 'Movie 4', status: 'deleted-with-cleanup-failure' },
        { id: '3', title: 'Movie 3', status: 'not-deleted' },
        { id: '2', title: 'Movie 2', status: 'uncertain' },
        { id: '1', title: 'Movie 1', status: 'deleted' },
      ],
    })
    const { client } = renderPage()
    await screen.findAllByRole('checkbox')
    for (const id of [1, 2, 3, 4, 5]) {
      fireEvent.click(
        screen.getByRole('checkbox', { name: `Select Movie ${id}` }),
      )
    }
    fireEvent.click(
      screen.getByRole('button', { name: 'Move to Leaving soon' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
    expect(
      await screen.findByText(
        `Movie 5: Leaving soon until ${new Date(deleteAt).toLocaleDateString('en')}; watching it keeps it`,
      ),
    ).toBeTruthy()
    expect(screen.getByText('Movie 4: Deleted; cleanup failed')).toBeTruthy()
    expect(screen.getByText('Movie 3: Not deleted')).toBeTruthy()
    expect(
      screen.getByText(
        'Movie 2: Outcome uncertain; reload and review before trying again',
      ),
    ).toBeTruthy()
    expect(screen.getByText('Movie 1: Deleted')).toBeTruthy()
    client.clear()
  })
  it('shows a pending title as leaving soon beside its row and blocks ticking it again', async () => {
    const deleteAt = '2026-12-08T09:00:00.000Z'
    mockReview(review(), [
      {
        id: 11,
        collectionId: 7,
        mediaServerId: '3',
        title: 'Movie 3',
        status: 'pending',
        deleteAt,
      },
    ])
    const { client } = renderPage()
    expect(
      await screen.findByText(
        `Leaving soon: deleted on ${new Date(deleteAt).toLocaleDateString('en')} unless someone watches it`,
      ),
    ).toBeTruthy()
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Select Movie 3',
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true)
    expect(screen.getByRole('button', { name: 'Keep Movie 3' })).toBeTruthy()
    client.clear()
  })
  it('shows movies of one series together under the series name, each ticked on its own, with 4K marked', async () => {
    const series = { id: 'tmdb:500', title: 'Saga Collection' }
    mockReview(
      review([
        {
          ...candidates[0],
          id: 'a',
          title: 'Saga Part 2',
          group: series,
          is4k: true,
        },
        { ...candidates[0], id: 'b', title: 'Lonely Movie', group: null },
        {
          ...candidates[0],
          id: 'c',
          title: 'Other One',
          group: { id: 'tmdb:9', title: 'Solo Saga' },
        },
        { ...candidates[0], id: 'd', title: 'Saga Part 1', group: series },
      ]),
    )
    const { client } = renderPage()
    const heading = await screen.findByRole('heading', {
      name: 'Saga Collection',
    })
    const block = heading.closest('li')!
    const titles = Array.from(block.querySelectorAll('input')).map((box) =>
      box.getAttribute('aria-label'),
    )
    expect(titles).toEqual(['Select Saga Part 2', 'Select Saga Part 1'])
    expect(block.textContent).toContain('4K')
    expect(screen.queryByRole('heading', { name: 'Solo Saga' })).toBeNull()
    const order = screen
      .getAllByRole('checkbox')
      .map((box) => box.getAttribute('aria-label'))
    expect(order).toEqual([
      'Select Saga Part 2',
      'Select Saga Part 1',
      'Select Lonely Movie',
      'Select Other One',
    ])
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Saga Part 1' }),
    )
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Select Saga Part 2',
        }) as HTMLInputElement
      ).checked,
    ).toBe(false)
    expect(screen.getByText(/Selected titles: 1, total size/)).toBeTruthy()
    client.clear()
  })
  it('keeps a title forever from its row and removes it from the page', async () => {
    vi.mocked(PostApiHandler).mockResolvedValue(undefined)
    const { client } = renderPage()
    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select Movie 3' }),
    )
    mockReview(
      review(candidates.filter((item) => item.id !== '3')),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Keep Movie 3 forever' }),
    )
    await waitFor(() =>
      expect(PostApiHandler).toHaveBeenCalledWith(
        '/collections/7/review/keep',
        { ids: ['3'] },
      ),
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('checkbox', { name: 'Select Movie 3' }),
      ).toBeNull(),
    )
    expect(screen.getByText(/Selected titles: 0, total size/)).toBeTruthy()
    client.clear()
  })
  it('renders a long list in pages', async () => {
    mockReview(
      review(
        Array.from({ length: 130 }, (_, at) => ({
          ...candidates[0],
          id: String(at + 1),
          title: `Bulk ${at + 1}`,
        })),
      ),
    )
    const { client } = renderPage()
    expect(await screen.findAllByRole('checkbox')).toHaveLength(60)
    fireEvent.click(screen.getByRole('button', { name: 'Show more (70 left)' }))
    expect(screen.getAllByRole('checkbox')).toHaveLength(120)
    fireEvent.click(screen.getByRole('button', { name: 'Show more (10 left)' }))
    expect(screen.getAllByRole('checkbox')).toHaveLength(130)
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull()
    client.clear()
  })
})
