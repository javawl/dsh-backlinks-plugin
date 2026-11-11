/**
 * Console data, batch selection, and submission into a workspace's blank session
 * using the `backlink-operator` preset (falling back to the default preset if needed).
 */

import type { BacklinkBatchDetail, BacklinkBatchSummary } from '../../shared/backlinks-types.ts'
import type {} from '../../shared/typert-remote.ts'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    backlinksConsole: unknown
  }
}

export interface ConsoleViewState {
  open: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  batches: readonly BacklinkBatchSummary[]
  details: Record<number, BacklinkBatchDetail>
  selectedBatchIds: readonly number[]
  publishing: readonly number[] | null
}

export interface ConsoleStore {
  readonly store: SnapshotStore<ConsoleViewState>
  open(): void
  close(): void
  refresh(): Promise<void>
  toggleDetail(batchId: number): Promise<void>
  selectBatches(batchIds: readonly number[], selected: boolean): void
  publish(batchId: number): Promise<void>
  publishSelected(): Promise<void>
}

export function createConsoleStore(ctx: ClientContext): ConsoleStore {
  const store = createSnapshotStore<ConsoleViewState>({
    open: false,
    status: 'idle',
    error: null,
    batches: [],
    details: {},
    selectedBatchIds: [],
    publishing: null,
  })

  const readBatches = async (): Promise<readonly BacklinkBatchSummary[]> => {
    const result = await ctx.remote.backlinksConsole.batches()
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return [...result.value].sort((a, b) => b.id - a.id)
  }

  const readBatch = async (batchId: number): Promise<BacklinkBatchDetail> => {
    const result = await ctx.remote.backlinksConsole.batch(batchId)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }

  const createBacklinkSession = async (
    workspaceId: WorkspaceSnapshot['items'][number]['workspaceId'],
  ) => {
    try {
      return await ctx.sessions.create({ workspaceId, agentPreset: 'backlink-operator' })
    } catch {
      return await ctx.sessions.create({ workspaceId })
    }
  }

  const publishBatches = async (batchIds: readonly number[]): Promise<void> => {
    if (store.getSnapshot().publishing !== null || batchIds.length === 0) return
    const ids = [...new Set(batchIds)].sort((a, b) => b - a)
    store.update((state) => { state.publishing = ids; state.error = null })
    try {
      const workspaceId = recentWorkspaceId(ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot())
      if (workspaceId === undefined) throw new Error('publish: select or create a workspace first')
      const sessionId = await createBacklinkSession(workspaceId)
      const command = `/backlink-publish ${ids.join(' ')}`
        + (ids.length > 1 ? '\n请按以上批次号顺序依次发布，仅处理这些批次。' : '')
      await ctx.sessions.using(sessionId, { source: 'backlinksConsole' }, async (reference) => {
        await reference.ready
        const state = reference.binding.session.getSnapshot()
        if (state.openState !== 'open') {
          throw state.openError ?? new Error('publish: new session failed to open')
        }
        await reference.binding.ctx.inject(['conversation'], async (scoped) => {
          await scoped.conversation.send(command)
        })
      })
      ctx.uiWorkspace.openSession(sessionId)
      store.update((state) => {
        state.selectedBatchIds = state.selectedBatchIds.filter(id => !ids.includes(id))
        state.open = false
      })
    } catch (error) {
      store.update((state) => {
        state.error = error instanceof Error ? error.message : String(error)
      })
    } finally {
      store.update((state) => { state.publishing = null })
    }
  }

  return {
    store,
    open(): void {
      store.update((state) => { state.open = true })
      void this.refresh()
    },
    close(): void {
      store.update((state) => { state.open = false })
    },
    async refresh(): Promise<void> {
      store.update((state) => { state.status = 'loading'; state.error = null })
      try {
        const batches = await readBatches()
        store.update((state) => {
          state.batches = batches
          state.selectedBatchIds = state.selectedBatchIds.filter(id => batches.some(batch => batch.id === id))
          state.status = 'ready'
        })
      } catch (error) {
        store.update((state) => {
          state.status = 'error'
          state.error = error instanceof Error ? error.message : String(error)
        })
      }
    },
    async toggleDetail(batchId: number): Promise<void> {
      if (store.getSnapshot().details[batchId] !== undefined) {
        store.update((state) => { Reflect.deleteProperty(state.details, batchId) })
        return
      }
      try {
        const detail = await readBatch(batchId)
        store.update((state) => { state.details[batchId] = detail })
      } catch (error) {
        store.update((state) => {
          state.error = error instanceof Error ? error.message : String(error)
        })
      }
    },
    selectBatches(batchIds, selected): void {
      if (store.getSnapshot().publishing !== null) return
      store.update((state) => {
        const ids = new Set(state.selectedBatchIds)
        for (const id of batchIds) {
          if (selected && state.batches.some(batch => batch.id === id)) ids.add(id)
          else ids.delete(id)
        }
        state.selectedBatchIds = [...ids].sort((a, b) => b - a)
      })
    },
    async publish(batchId): Promise<void> {
      await publishBatches([batchId])
    },
    async publishSelected(): Promise<void> {
      await publishBatches(store.getSnapshot().selectedBatchIds)
    },
  }
}

function recentWorkspaceId(
  sessions: SessionListState,
  workspaces: WorkspaceSnapshot,
): WorkspaceSnapshot['items'][number]['workspaceId'] | undefined {
  let selected: WorkspaceSnapshot['items'][number]['workspaceId'] | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces.items) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions.byId[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}
