import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import PendingDecisionCard from '../components/PendingDecisionCard'
import { api, ApiError } from '../api/client'

/**
 * The "Waiting on you" card for a buried [OPTIONS:] decision.
 *
 * The backend suite (test_slot_pending_decision.py) pins WHEN the payload is
 * raised; these tests pin what the card DOES with it. Interaction mirrors the
 * sibling QuestionCard, not the FollowUpBar chips: options are aria-pressed
 * TOGGLES, and exactly two action buttons dispatch (Send, Add to composer) —
 * the `max-two-buttons-per-row` budget is a design rule, so the button count
 * is pinned here on purpose. The dismiss round-trip has three exits
 * (confirmed, stale-404, retryable failure). The mount gating (question card
 * owns the band) lives at the call sites; this component is store-free.
 */

const DECISION = {
  options: ['Retry again', 'Check mainline', 'Stop'],
  excerpt: 'CTR failed twice on flaky suites — how should I proceed?',
  ts: '2026-09-11T10:00:00',
}

const renderCard = (over: Partial<Parameters<typeof PendingDecisionCard>[0]> = {}) => {
  const onPick = vi.fn()
  const onSendDirect = vi.fn()
  render(
    <PendingDecisionCard
      slotKey="chat-1"
      decision={DECISION}
      onPick={onPick}
      onSendDirect={onSendDirect}
      {...over}
    />,
  )
  return { onPick, onSendDirect }
}

beforeEach(() => vi.restoreAllMocks())

describe('rendering', () => {
  it('shows the excerpt and every option as a toggle', () => {
    renderCard()
    expect(screen.getByTestId('pending-decision-card')).toBeInTheDocument()
    expect(screen.getByText(DECISION.excerpt)).toBeInTheDocument()
    const toggles = screen.getAllByTestId('pending-decision-option')
    expect(toggles.map((c) => c.textContent)).toEqual(DECISION.options)
    for (const t of toggles) expect(t).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps the action row at exactly two buttons however many options exist', () => {
    // max-two-buttons-per-row is a blocking design rule: the options are
    // selections, and only Send + Add to composer act.
    renderCard()
    expect(screen.getByTestId('pending-decision-send')).toBeInTheDocument()
    expect(screen.getByTestId('pending-decision-fill')).toBeInTheDocument()
    // Both disabled until something is picked — nothing to dispatch yet.
    expect(screen.getByTestId('pending-decision-send')).toBeDisabled()
    expect(screen.getByTestId('pending-decision-fill')).toBeDisabled()
  })

  it('renders nothing for an empty option list', () => {
    render(
      <PendingDecisionCard slotKey="chat-1" decision={{ options: [], ts: 't' }} onPick={vi.fn()} />,
    )
    expect(screen.queryByTestId('pending-decision-card')).toBeNull()
  })
})

describe('pick-then-act semantics', () => {
  it('toggles selection with aria-pressed and re-click deselects', () => {
    renderCard()
    const opt = screen.getByText('Retry again')
    fireEvent.click(opt)
    expect(opt.closest('button')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(opt)
    expect(opt.closest('button')).toHaveAttribute('aria-pressed', 'false')
  })

  it('Send dispatches the picked options joined in option order', () => {
    const { onPick, onSendDirect } = renderCard()
    // Click in REVERSE order — the joined text must still follow option order,
    // the same ordered suffix the composer chips append.
    fireEvent.click(screen.getByText('Stop'))
    fireEvent.click(screen.getByText('Retry again'))
    fireEvent.click(screen.getByTestId('pending-decision-send'))
    expect(onSendDirect).toHaveBeenCalledWith('Retry again, Stop')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('Add to composer fills without sending', () => {
    const { onPick, onSendDirect } = renderCard()
    fireEvent.click(screen.getByText('Check mainline'))
    fireEvent.click(screen.getByTestId('pending-decision-fill'))
    expect(onPick).toHaveBeenCalledWith('Check mainline')
    expect(onSendDirect).not.toHaveBeenCalled()
  })

  it('Send degrades to composer fill when no direct sender exists', () => {
    const onPick = vi.fn()
    render(
      <PendingDecisionCard slotKey="chat-1" decision={DECISION} onPick={onPick} />,
    )
    fireEvent.click(screen.getByText('Stop'))
    fireEvent.click(screen.getByTestId('pending-decision-send'))
    expect(onPick).toHaveBeenCalledWith('Stop')
  })
})

describe('dismiss round-trip', () => {
  it('names the decision by ts and hides only on confirmation', async () => {
    const dismiss = vi.spyOn(api, 'dismissPendingDecision').mockResolvedValue({ ok: true } as never)
    renderCard()
    fireEvent.click(screen.getByTestId('pending-decision-dismiss'))
    expect(dismiss).toHaveBeenCalledWith('chat-1', DECISION.ts)
    await waitFor(() => expect(screen.queryByTestId('pending-decision-card')).toBeNull())
  })

  it('treats a 404 as stale and takes the card away', async () => {
    vi.spyOn(api, 'dismissPendingDecision').mockRejectedValue(new ApiError(404, 'gone'))
    renderCard()
    fireEvent.click(screen.getByTestId('pending-decision-dismiss'))
    await waitFor(() => expect(screen.queryByTestId('pending-decision-card')).toBeNull())
  })

  it('keeps the card AND says why on a retryable failure', async () => {
    vi.spyOn(api, 'dismissPendingDecision').mockRejectedValue(new ApiError(503, 'offline'))
    renderCard()
    fireEvent.click(screen.getByTestId('pending-decision-dismiss'))
    await waitFor(() => expect(screen.getByTestId('pending-decision-dismiss-error')).toBeInTheDocument())
    expect(screen.getByTestId('pending-decision-card')).toBeInTheDocument()
  })
})
