/**
 * The mobile bottom-float capsule (Settings' floating search) is `fixed` to
 * the viewport bottom — the same edge the bottom-docked terminal panel owns
 * while it is open. Issue #9251: the capsule rendered on top of the docked
 * terminal's lower rows. The fix suppresses the capsule while the terminal is
 * open AND docked at the bottom; a right-docked or closed terminal leaves the
 * capsule alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import SidePanelLayout, { type SidePanelTab } from '../components/SidePanelLayout'
import {
  openBottomTerminal,
  setTerminalPosition,
  __resetBottomTerminal,
} from '../hooks/useBottomTerminal'

// The capsule only exists on the mobile root list.
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => true }))

const TABS: SidePanelTab[] = [
  { key: 'overview', label: 'Overview', icon: null },
  { key: 'about', label: 'About', icon: null },
]

function renderRootList() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <SidePanelLayout
        title="Settings"
        tabs={TABS}
        headerRight={<div data-testid="capsule-content">search</div>}
        headerRightDock="bottom-float"
      >
        {tab => <div data-testid="pane">{tab}</div>}
      </SidePanelLayout>
    </MemoryRouter>,
  )
}

describe('bottom-float capsule vs bottom-docked terminal (#9251)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    __resetBottomTerminal()
  })
  afterEach(() => {
    cleanup()
    __resetBottomTerminal()
    vi.restoreAllMocks()
  })

  it('renders the capsule while the terminal is closed', () => {
    renderRootList()
    expect(screen.getByTestId('capsule-content')).toBeTruthy()
  })

  it('suppresses the capsule while the terminal is open and docked at the bottom', () => {
    renderRootList()
    act(() => {
      setTerminalPosition('bottom')
      openBottomTerminal()
    })
    expect(screen.queryByTestId('capsule-content')).toBeNull()
  })

  it('keeps the capsule while the terminal is open but docked on the right', () => {
    renderRootList()
    act(() => {
      setTerminalPosition('right')
      openBottomTerminal()
    })
    expect(screen.getByTestId('capsule-content')).toBeTruthy()
  })

  it('restores the capsule when the bottom-docked terminal moves to the right dock', () => {
    renderRootList()
    act(() => {
      setTerminalPosition('bottom')
      openBottomTerminal()
    })
    expect(screen.queryByTestId('capsule-content')).toBeNull()
    act(() => {
      setTerminalPosition('right')
    })
    expect(screen.getByTestId('capsule-content')).toBeTruthy()
  })
})
