import { useId, useState } from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, ChevronDown, ChevronRight, ListTodo, Plus, RefreshCw, Send } from 'lucide-react'
import { api } from '../../api/client'
import { sendTurn } from '../../chat-core/transport/sendTurn'
import Clickable from '../../components/Clickable'
import ErrorNotice from '../../components/ErrorNotice'
import { Badge, Btn, ContentSkeleton, Input, PanelSectionHeader } from '../../components/ui'
import { fmtDateTimeNumeric, fmtNumber } from '../../i18n/format'
import { memberTaskLane, type MemberTaskDraft, type MemberTaskLane, type MemberWorkItem } from '../../types/memberWork'
export { emptyMemberTaskDraft, type MemberTaskDraft } from '../../types/memberWork'

const LANES: readonly MemberTaskLane[] = ['todo', 'progress', 'blocked', 'review', 'done', 'closed']
const LANE_LABELS = {
  todo: 'memberTasks.lanes.todo',
  progress: 'memberTasks.lanes.progress',
  blocked: 'memberTasks.lanes.blocked',
  review: 'memberTasks.lanes.review',
  done: 'memberTasks.lanes.done',
  closed: 'memberTasks.lanes.closed',
} as const satisfies Record<MemberTaskLane, string>
const VERDICT_LABELS = {
  pass: 'memberTasks.verdicts.pass',
  fail: 'memberTasks.verdicts.fail',
  pending: 'memberTasks.verdicts.pending',
  refused: 'memberTasks.verdicts.refused',
  error: 'memberTasks.verdicts.error',
} as const satisfies Record<NonNullable<MemberWorkItem['verdict']>, string>
const TEXTAREA_CLS = 'w-full min-w-0 resize-y rounded-md border border-border bg-bg-elevated px-3 py-2 text-sm text-text focus-ring'
export const memberWorkQueryKey = (slug: string, member: string, slot: string) =>
  ['member-work', slug, member, slot] as const

function criteriaText(item: MemberWorkItem): string {
  const a = item.acceptance
  return typeof a.description === 'string' ? a.description : JSON.stringify(a, null, 2)
}

export default function MemberTasks({
  slug, member, slot, enabled, visible, draft, updateDraft, onOpenWorker,
}: {
  slug: string
  member: string
  slot: string
  enabled: boolean
  visible: boolean
  draft: MemberTaskDraft
  updateDraft: (change: (previous: MemberTaskDraft) => MemberTaskDraft) => void
  onOpenWorker: (slot: string) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const queryKey = memberWorkQueryKey(slug, member, slot)
  const query = useQuery({
    queryKey,
    queryFn: () => api.memberWork(slug, member, slot),
    enabled: enabled && visible && !!slot,
    refetchInterval: visible && enabled ? 5000 : false,
    refetchOnWindowFocus: visible && enabled,
  })
  const createKey = [...queryKey, 'create']
  const steerKey = [...queryKey, 'steer']
  const saving = useIsMutating({ mutationKey: createKey }) > 0
  const steering = useIsMutating({ mutationKey: steerKey }) > 0
  const items = query.data?.items ?? []
  const selected = items.find(item => item.item_id === draft.selected)
  const instructionKey = selected?.item_id ?? ''
  const instruction = draft.instructions[instructionKey] ?? ''
  const available = enabled && query.isSuccess && !query.isError && query.data.slot_key === slot

  const create = useMutation({
    mutationKey: createKey,
    mutationFn: ({ title, criteria }: { title: string; criteria: string }) =>
      api.createMemberTask(slug, member, slot, title, criteria),
    onMutate: () => updateDraft(previous => ({ ...previous, createError: '' })),
    onError: error => updateDraft(previous => ({ ...previous, createError: error.message })),
    onSuccess: (result, sent) => {
      updateDraft(previous => ({
        ...previous,
        title: previous.title === sent.title ? '' : previous.title,
        criteria: previous.criteria === sent.criteria ? '' : previous.criteria,
        selected: result.item.item_id,
        createError: '',
      }))
      setCreating(false)
      void qc.invalidateQueries({ queryKey })
    },
  })
  const steer = useMutation({
    mutationKey: steerKey,
    onMutate: () => updateDraft(previous => ({ ...previous, steerError: '', sendNotice: '' })),
    onError: error => updateDraft(previous => ({ ...previous, steerError: error.message })),
    mutationFn: async ({ message }: { message: string; text: string; key: string }) => {
      const receipt = await sendTurn({ message, slot, steer: true })
      if (receipt.status === 'refused') throw new Error(receipt.reason || t('memberTasks.send_refused'))
      if (receipt.status !== 'dispatched' && receipt.status !== 'queued') {
        throw new Error(t('memberTasks.send_uncertain'))
      }
      return receipt
    },
    onSuccess: (receipt, sent) => {
      updateDraft(previous => ({
        ...previous,
        instructions: {
          ...previous.instructions,
          [sent.key]: (previous.instructions[sent.key] ?? '') === sent.text ? '' : previous.instructions[sent.key],
        },
        steerError: '',
        sendNotice: t(receipt.status === 'queued' ? 'memberTasks.queued' : 'memberTasks.sent'),
      }))
      void qc.invalidateQueries({ queryKey })
    },
  })
  const sendInstructions = (start: boolean) => {
    const text = instruction.trim()
    const context = selected
      ? t('memberTasks.task_context', {
        id: selected.item_id, title: selected.title, criteria: criteriaText(selected),
        interpolation: { escapeValue: false },
      })
      : ''
    const message = [
      context,
      start ? t('memberTasks.start_instruction') : text,
      start && text ? text : '',
    ].filter(Boolean).join('\n\n')
    steer.mutate({ message, text: instruction, key: instructionKey })
  }
  const goal = query.data?.conductor?.goal || query.data?.checkpoint.goal
  const counts = new Map(LANES.map(lane => [lane, items.filter(item => memberTaskLane(item) === lane)]))
  const displayForm = creating || !!draft.title || !!draft.criteria

  return (
    <div className="min-w-0 space-y-4 p-3" data-testid="member-tasks">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-semibold text-text-strong">{member}</span>
        <div className="flex items-center gap-2">
          <Btn type="button" onClick={() => void query.refetch()} disabled={!enabled || query.isFetching} aria-label={t('memberTasks.refresh')}>
            <RefreshCw className="lucide-inline" />
          </Btn>
          <Btn type="button" onClick={() => setCreating(true)} disabled={!available}>
            <Plus className="lucide-inline" />{t('memberTasks.new')}
          </Btn>
        </div>
      </div>
      <p className="text-[13px] text-muted">{t('memberTasks.description')}</p>
      {!enabled && <p className="text-sm text-muted">{t('memberTasks.connecting')}</p>}
      {enabled && query.isPending && <ContentSkeleton rows={3} />}
      <ErrorNotice message={query.error?.message} askAgent />
      {goal && <p className="whitespace-pre-wrap break-words text-sm text-text">{goal}</p>}
      {query.data?.checkpoint.next && (
        <p className="whitespace-pre-wrap break-words text-[13px] text-muted">
          {t('memberTasks.next', { next: query.data.checkpoint.next })}
        </p>
      )}
      {displayForm && (
        <form className="space-y-3 rounded-lg border border-border bg-card p-3" onSubmit={event => {
          event.preventDefault()
          if (available && !saving && draft.title.trim() && draft.criteria.trim()) {
            create.mutate({ title: draft.title, criteria: draft.criteria })
          }
        }}>
          <label className="block space-y-1 text-[13px]" htmlFor={`${id}-title`}>
            <span>{t('memberTasks.title')}</span>
            <Input id={`${id}-title`} className="w-full" required maxLength={query.data?.limits.title ?? 200}
              value={draft.title} onChange={event => updateDraft(previous => ({ ...previous, title: event.target.value }))} />
          </label>
          <label className="block space-y-1 text-[13px]" htmlFor={`${id}-criteria`}>
            <span>{t('memberTasks.criteria')}</span>
            <textarea id={`${id}-criteria`} aria-label={t('memberTasks.criteria')} className={TEXTAREA_CLS} rows={3} required
              maxLength={query.data?.limits.criteria ?? 4000} value={draft.criteria}
              onChange={event => updateDraft(previous => ({ ...previous, criteria: event.target.value }))} />
          </label>
          <ErrorNotice message={draft.createError} askAgent />
          <div className="flex flex-wrap gap-2">
            <Btn primary type="submit" disabled={!available || saving || !draft.title.trim() || !draft.criteria.trim()}>
              {t(saving ? 'memberTasks.saving' : 'memberTasks.create')}
            </Btn>
            <Btn type="button" disabled={saving} onClick={() => {
              updateDraft(previous => ({ ...previous, title: '', criteria: '', createError: '' }))
              setCreating(false)
              create.reset()
            }}>{t('components.confirmDialog.cancel')}</Btn>
          </div>
        </form>
      )}
      {available && !items.length && (
        <div className="space-y-2 rounded-lg border border-dashed border-border p-4 text-center">
          <ListTodo className="lucide-inline text-muted" />
          <p className="text-sm text-muted">{t('memberTasks.empty')}</p>
        </div>
      )}
      {query.data && <div className="space-y-3" aria-label={t('memberTasks.board')}>
        {LANES.map(lane => {
          const rows = counts.get(lane) ?? []
          if (lane === 'closed' && !rows.length) return null
          return (
            <section key={lane} className="min-w-0 rounded-lg border border-border bg-bg-elevated p-2" aria-label={t(LANE_LABELS[lane])}>
              <PanelSectionHeader label={t(LANE_LABELS[lane])}
                trailing={<>
                  <span className="text-[11px] tabular-nums text-muted">{fmtNumber(rows.length)}</span>
                  {lane === 'closed' && (
                  <Btn type="button" onClick={() => setShowClosed(!showClosed)} aria-expanded={showClosed} aria-label={t('memberTasks.toggle_closed')}>
                    {showClosed ? <ChevronDown className="lucide-inline" /> : <ChevronRight className="lucide-inline" />}
                  </Btn>
                  )}
                </>} />
              {(lane !== 'closed' || showClosed) && rows.map(item => (
                <div key={item.item_id} className="mt-2 overflow-hidden rounded-md border border-border bg-card">
                  <Clickable className="space-y-1 p-3 text-sm focus-ring hover:bg-bg-hover"
                    aria-expanded={selected?.item_id === item.item_id}
                    onClick={() => {
                      updateDraft(previous => ({
                        ...previous,
                        selected: previous.selected === item.item_id ? null : item.item_id,
                        sendNotice: '',
                      }))
                    }}>
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 break-words font-medium text-text-strong">{item.title}</span>
                      <ChevronDown className="lucide-inline shrink-0 text-muted" />
                    </div>
                    <span className="block text-[11px] text-muted">{item.item_id}</span>
                    {item.summary && <p className="line-clamp-2 break-words text-[13px] text-muted">{item.summary}</p>}
                    {(item.stale || item.orphaned) && <Badge variant="warn">{t(item.orphaned ? 'memberTasks.worker_missing' : 'memberTasks.stale')}</Badge>}
                  </Clickable>
                  {selected?.item_id === item.item_id && (
                    <div className="space-y-3 border-t border-border p-3">
                      <PanelSectionHeader label={t('memberTasks.criteria')} />
                      <p className="whitespace-pre-wrap break-words text-[13px]">{criteriaText(item)}</p>
                      {item.summary && <p className="whitespace-pre-wrap break-words text-[13px]">{item.summary}</p>}
                      {item.decision && <p className="whitespace-pre-wrap break-words text-[13px]">{t('memberTasks.decision', { decision: item.decision })}</p>}
                      {item.verdict && (item.verdict === 'pass' || item.verdict === 'pending'
                        ? <Badge variant={item.verdict === 'pass' ? 'ok' : 'warn'}>{t(VERDICT_LABELS[item.verdict])}</Badge>
                        : <ErrorNotice message={t(VERDICT_LABELS[item.verdict])} askAgent />)}
                      {Object.entries(item.artifacts).map(([name, value]) => (
                        <p key={name} className="break-words text-[13px]"><strong>{name}</strong>{': '}{value}</p>
                      ))}
                      {item.last_report_at && <p className="text-[11px] text-muted">{t('memberTasks.updated', { date: fmtDateTimeNumeric(item.last_report_at) })}</p>}
                      {item.worker_session_key && (
                        <Btn type="button" onClick={() => onOpenWorker(item.worker_session_key!.replace(/^dashboard[:_]/, ''))}>
                          <ArrowUpRight className="lucide-inline" />{t('memberTasks.open_worker')}
                        </Btn>
                      )}
                      {item.events?.length ? (
                        <details>
                          <summary className="cursor-pointer text-[13px] text-muted">{t('memberTasks.history')}</summary>
                          <ol className="mt-2 space-y-2 text-[13px]">
                            {item.events.map(event => <li key={event.id} className="whitespace-pre-wrap break-words">
                              <time className="block text-[11px] text-muted" dateTime={event.ts}>{fmtDateTimeNumeric(event.ts)}</time>
                              {event.text}
                            </li>)}
                          </ol>
                        </details>
                      ) : null}
                    </div>
                  )}
                </div>
              ))}
            </section>
          )
        })}
      </div>}
      <form className="space-y-3 border-t border-border pt-3" onSubmit={event => {
        event.preventDefault()
        if (available && !steering && instruction.trim()) sendInstructions(false)
      }}>
        <label htmlFor={`${id}-instructions`} className="block text-[13px] font-medium">
          {selected ? t('memberTasks.steer_task', { title: selected.title }) : t('memberTasks.steer_member')}
        </label>
        <textarea id={`${id}-instructions`} aria-label={selected ? t('memberTasks.steer_task', { title: selected.title }) : t('memberTasks.steer_member')} className={TEXTAREA_CLS} rows={3} value={instruction}
          onChange={event => {
            const text = event.target.value
            updateDraft(previous => ({ ...previous, instructions: { ...previous.instructions, [instructionKey]: text } }))
          }} />
        <div className="flex flex-wrap gap-2">
          {selected?.state === 'open' && memberTaskLane(selected) === 'todo' && (
            <Btn primary type="button" disabled={!available || steering} onClick={() => sendInstructions(true)}>
              {t('memberTasks.start')}
            </Btn>
          )}
          <Btn type="submit" disabled={!available || steering || !instruction.trim()}>
            <Send className="lucide-inline" />{t(steering ? 'memberTasks.sending' : 'memberTasks.send')}
          </Btn>
        </div>
        <ErrorNotice message={draft.steerError} askAgent />
        <p role="status" className="text-[13px] text-muted">{draft.sendNotice}</p>
      </form>
    </div>
  )
}
