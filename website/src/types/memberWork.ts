export interface MemberWorkItem {
  item_id: string
  title: string
  acceptance: Record<string, unknown>
  state: 'open' | 'accepted' | 'rejected' | 'abandoned'
  status: 'progress' | 'done' | 'blocked' | 'question' | null
  verdict: 'pass' | 'fail' | 'pending' | 'refused' | 'error' | null
  decision: string
  worker_session_key: string | null
  summary: string
  artifacts: Record<string, string>
  pr: number | null
  created_at: string
  last_report_at: string | null
  closed_at: string | null
  stale?: boolean
  orphaned?: boolean
  events?: Array<{ id: string; ts: string; kind: string; text: string; status: string | null }>
}

export interface MemberWork {
  slot_key: string
  conductor: { goal: string; round: number } | null
  items: MemberWorkItem[]
  checkpoint: { goal?: string; phase?: string; next?: string; artifacts?: Record<string, string> }
  limits: { title: number; criteria: number }
}

export type MemberTaskLane = 'todo' | 'progress' | 'blocked' | 'review' | 'done' | 'closed'

export function memberTaskLane(item: MemberWorkItem): MemberTaskLane {
  if (item.state === 'accepted') return 'done'
  if (item.state === 'rejected' || item.state === 'abandoned') return 'closed'
  if (item.status === 'blocked' || item.status === 'question') return 'blocked'
  if (item.status === 'done' && item.verdict !== 'fail') return 'review'
  if (item.worker_session_key) return 'progress'
  return 'todo'
}

export interface MemberTaskDraft {
  title: string
  criteria: string
  selected: string | null
  instructions: Record<string, string>
  createError: string
  steerError: string
  sendNotice: string
}

export const emptyMemberTaskDraft = (): MemberTaskDraft => ({
  title: '', criteria: '', selected: null, instructions: {},
  createError: '', steerError: '', sendNotice: '',
})
