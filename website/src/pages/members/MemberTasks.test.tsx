import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../../../integration/mocks/server'
import { renderWithProviders } from '../../test/helpers'
import { useAppSelector, useAppStore } from '../../store'
import { setMemberTaskDraft } from '../../store/dashboardSlice'
import type { MemberWork, MemberWorkItem } from '../../types/memberWork'
import MemberTasks, { emptyMemberTaskDraft } from './MemberTasks'

const item = (overrides: Partial<MemberWorkItem> = {}): MemberWorkItem => ({
  item_id: 'w-one', title: 'Review checkout', acceptance: { kind: 'human_approval', description: 'Checks pass' },
  state: 'open', status: null, verdict: null, decision: '', worker_session_key: null,
  summary: '', artifacts: {}, pr: null, created_at: '2026-09-11T09:00:00Z',
  last_report_at: null, closed_at: null, ...overrides,
})
const payload = (items: MemberWorkItem[], slot = 'member-reviewer'): MemberWork => ({
  slot_key: slot, conductor: { goal: 'Ship checkout safely', round: 1 },
  checkpoint: {}, items, limits: { title: 200, criteria: 4000 },
})
function Harness({ member = 'Reviewer', slot = 'member-reviewer', visible = true, enabled = true, open = vi.fn() }) {
  const store = useAppStore()
  const draft = useAppSelector(state => state.dashboard.memberTaskDrafts?.[slot])
  return <MemberTasks key={slot} slug={member.toLowerCase()} member={member} slot={slot}
    visible={visible} enabled={enabled} draft={draft ?? emptyMemberTaskDraft()}
    updateDraft={change => store.dispatch(setMemberTaskDraft({
      key: slot,
      draft: change(store.getState().dashboard.memberTaskDrafts?.[slot] ?? emptyMemberTaskDraft()),
    }))} onOpenWorker={open} />
}
function serve(items: MemberWorkItem[]) {
  server.use(http.get('/api/members/:slug/work', ({ request }) =>
    HttpResponse.json(payload(items, new URL(request.url).searchParams.get('slot')!))))
}

describe('Member task board', () => {
  it.each(['fail', 'refused', 'error'] as const)('shows an acceptance %s through the error surface', async verdict => {
    serve([item({ verdict })])
    renderWithProviders(<Harness />)
    fireEvent.click(await screen.findByText('Review checkout'))
    expect(screen.getByRole('alert')).toHaveTextContent('Acceptance')
    expect(screen.getByRole('button', { name: /ask.*agent/i })).toBeInTheDocument()
  })

  it.each(['refused', 'uncertain', 'create'] as const)('retains a late %s result after leaving the route', async outcome => {
    serve([])
    let finish: (response: Response) => void = () => {}
    const pending = new Promise<Response>(resolve => { finish = resolve })
    const received = vi.fn()
    server.use(http.post(outcome === 'create' ? '/api/members/:slug/work' : '/api/chat', () => {
      received()
      return pending
    }))
    const { rerender, store } = renderWithProviders(<Harness />)
    await screen.findByText('No tasks yet. Create one to get started.')
    if (outcome === 'create') {
      fireEvent.click(screen.getByRole('button', { name: 'New task' }))
      fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Keep this task' } })
      fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'Keep this criteria' } })
      fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    } else {
      fireEvent.change(screen.getByLabelText('Instructions for the member'), { target: { value: 'Keep these instructions' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send instructions' }))
    }
    await waitFor(() => expect(received).toHaveBeenCalled())
    rerender(<div>Another route</div>)
    finish(outcome === 'uncertain'
      ? new HttpResponse('broken JSON', { status: 200 })
      : HttpResponse.json({ error: 'Member unavailable' }, { status: 409 }))
    await waitFor(() => expect(
      store.getState().dashboard.memberTaskDrafts?.['member-reviewer']?.[
        outcome === 'create' ? 'createError' : 'steerError'
      ],
    ).toContain(outcome === 'uncertain' ? 'Delivery could not be confirmed.' : 'Member unavailable'))
    rerender(<Harness />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      outcome === 'uncertain' ? 'Delivery could not be confirmed.' : 'Member unavailable',
    ))
    expect(screen.getByLabelText(outcome === 'create' ? 'Task title' : 'Instructions for the member'))
      .toHaveValue(outcome === 'create' ? 'Keep this task' : 'Keep these instructions')
  })

  it('separates worker completion from acceptance and opens the worker in the member page', async () => {
    const open = vi.fn()
    serve([
      item({ title: 'Awaiting review', status: 'done', worker_session_key: 'dashboard_worker-1', summary: 'Tests passed', artifacts: { report: 'javascript:alert(1)' } }),
      item({ item_id: 'w-two', title: 'Accepted task', state: 'accepted', status: 'done', verdict: 'pass' }),
      item({ item_id: 'w-three', title: 'Needs input', status: 'question', worker_session_key: 'dashboard_worker-2' }),
    ])
    renderWithProviders(<Harness open={open} />)
    expect(await screen.findByText('Awaiting review')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Review' })).getByText('Awaiting review')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Done' })).getByText('Accepted task')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Blocked' })).getByText('Needs input')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Awaiting review'))
    expect(screen.getByText('Checks pass')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open worker conversation' }))
    expect(open).toHaveBeenCalledWith('worker-1')
  })

  it('captures a task, explicitly starts it, then reads progress from the ledger', async () => {
    const rows: MemberWorkItem[] = []
    const capture = vi.fn()
    const sent = vi.fn()
    serve(rows)
    server.use(
      http.post('/api/members/:slug/work', async ({ request }) => {
        const body = await request.json() as { title: string; criteria: string }
        capture(body, new URL(request.url).searchParams.get('slot'))
        const task = item({ title: body.title, acceptance: { kind: 'human_approval', description: body.criteria } })
        rows.push(task)
        return HttpResponse.json({ item: task, slot_key: 'member-reviewer' }, { status: 201 })
      }),
      http.post('/api/chat', async ({ request }) => {
        sent(await request.json())
        return HttpResponse.json({ ok: true, queued: true })
      }),
    )
    renderWithProviders(<Harness />)
    await screen.findByText('No tasks yet. Create one to get started.')
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Add retry tests' } })
    fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'Verify timeout recovery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    expect(await screen.findByRole('button', { name: 'Send task' })).toBeInTheDocument()
    expect(capture).toHaveBeenCalledWith({ title: 'Add retry tests', criteria: 'Verify timeout recovery' }, 'member-reviewer')
    expect(sent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send task' }))
    await screen.findByText('Instructions queued. Progress updates when the member reports.')
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({
      slot: 'member-reviewer', steer: true,
      message: expect.stringContaining('Task w-one: Add retry tests'),
    }))
    expect(within(screen.getByRole('region', { name: 'To do' })).getByText('Add retry tests')).toBeInTheDocument()
    rows[0] = { ...rows[0], status: 'progress', worker_session_key: 'dashboard_worker-1', summary: 'Running recovery tests' }
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }))
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'In progress' })).getByText('Add retry tests')).toBeInTheDocument())
  })

  it.each([
    ['refused', () => HttpResponse.json({ error: 'Member is unavailable' }, { status: 409 }), 'Member is unavailable'],
    ['uncertain', () => new HttpResponse('broken JSON', { status: 200 }), 'Delivery could not be confirmed.'],
  ] as const)('retains instructions after %s delivery', async (_name, response, message) => {
    serve([item()])
    server.use(http.post('/api/chat', response))
    renderWithProviders(<Harness />)
    await screen.findByText('Review checkout')
    fireEvent.change(screen.getByLabelText('Instructions for the member'), { target: { value: 'Prioritize regression coverage' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send instructions' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message))
    expect(screen.getByLabelText('Instructions for the member')).toHaveValue('Prioritize regression coverage')
    expect(screen.queryByText('Instructions sent. Progress updates when the member reports.')).not.toBeInTheDocument()
  })

  it('keeps drafts separate across members and waits for a confirmed visible thread to fetch', async () => {
    const reads = vi.fn()
    server.use(http.get('/api/members/:slug/work', ({ request }) => {
      reads(new URL(request.url).searchParams.get('slot'))
      return HttpResponse.json(payload([], new URL(request.url).searchParams.get('slot')!))
    }))
    const { rerender } = renderWithProviders(<Harness visible={false} />)
    expect(reads).not.toHaveBeenCalled()
    rerender(<Harness enabled={false} />)
    expect(reads).not.toHaveBeenCalled()
    rerender(<Harness />)
    await screen.findByText('No tasks yet. Create one to get started.')
    fireEvent.change(screen.getByLabelText('Instructions for the member'), { target: { value: 'Reviewer draft' } })
    rerender(<Harness member="Writer" slot="member-writer" />)
    expect(screen.getByLabelText('Instructions for the member')).toHaveValue('')
    await waitFor(() => expect(reads).toHaveBeenCalledWith('member-writer'))
    rerender(<Harness />)
    expect(screen.getByLabelText('Instructions for the member')).toHaveValue('Reviewer draft')
  })

  it('keeps a rejected creation draft and never presents an unreadable ledger as empty', async () => {
    serve([])
    server.use(http.post('/api/members/:slug/work', () => HttpResponse.json({ error: 'Ledger is full' }, { status: 409 })))
    const { queryClient } = renderWithProviders(<Harness />)
    await screen.findByText('No tasks yet. Create one to get started.')
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Keep this draft' } })
    fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'Keep the criteria' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    await screen.findByText('Ledger is full')
    expect(screen.getByLabelText('Task title')).toHaveValue('Keep this draft')
    server.use(http.get('/api/members/:slug/work', () => HttpResponse.json({ error: 'Ledger unavailable' }, { status: 503 })))
    await queryClient.invalidateQueries({ queryKey: ['member-work'] })
    await screen.findByText('Ledger unavailable')
    expect(screen.queryByText('No tasks yet. Create one to get started.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create task' })).toBeDisabled()
  })
})
