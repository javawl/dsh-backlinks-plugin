/**
 * The publish console as a global panel page: batch rows with status chips,
 * inline item details, search, auto-refresh, and multi-batch selection.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { BacklinkBatchSummary } from '../../shared/backlinks-types.ts'
import { IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ConsoleKey } from './locales.ts'
import type { ConsoleStore } from './store.ts'
import css from './SidebarPanel.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    backlinksConsole: ConsoleKey
  }
}

export type SidebarConsolePanelProps = PropsLocale<'backlinksConsole'> & {
  store: ConsoleStore
}

export function BacklinksConsoleIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconLinkOutlineRegular size={size} />
}

function BatchRow(props: SidebarConsolePanelProps & { batch: BacklinkBatchSummary }) {
  const { store, t, batch } = props
  const state = useSyncExternalStore(
    (fn: () => void) => store.store.subscribe(fn),
    () => store.store.getSnapshot(),
  )
  const detail = state.details[batch.id]
  const publishing = state.publishing?.includes(batch.id) === true
  return (
    <div className={css.row} data-selected={state.selectedBatchIds.includes(batch.id)}>
      <div className={css.rowHeader}>
        <input
          type="checkbox"
          className={css.checkbox}
          aria-label={`${t('selection.batch')} #${String(batch.id)} ${batch.websiteHost}`}
          checked={state.selectedBatchIds.includes(batch.id)}
          disabled={state.publishing !== null}
          onChange={(event) => { store.selectBatches([batch.id], event.target.checked) }}
        />
        <button
          type="button"
          className={css.rowHead}
          onClick={() => { void store.toggleDetail(batch.id) }}
          aria-expanded={detail !== undefined}
        >
          <span className={css.rowTitle}>
            #{String(batch.id)} {batch.websiteHost}
          </span>
          <span className={css.rowChips}>
            {batch.counts.pending > 0 ? <span className={css.pending}>待 {String(batch.counts.pending)}</span> : null}
            {batch.counts.executed > 0 ? <span className={css.done}>成 {String(batch.counts.executed)}</span> : null}
            {batch.counts.failed > 0 ? <span className={css.failed}>败 {String(batch.counts.failed)}</span> : null}
            {batch.executing ? <span className={css.pulseDot} aria-label={t('executing')} /> : null}
          </span>
        </button>
      </div>
      {detail !== undefined
        ? (
          <div className={css.items}>
            {detail.items.map(item => (
              <div key={item.id} className={css.itemRow}>
                <span className={css.itemHost}>{item.sourceHost}</span>
                <span className={css.itemStatus} data-status={item.status}>{item.status}</span>
              </div>
            ))}
          </div>
        )
        : null}
      <div className={css.rowActions}>
        <button
          type="button"
          className={css.publishButton}
          disabled={state.publishing !== null}
          onClick={() => { void store.publish(batch.id) }}
        >
          {publishing ? t('publishing') : t('publish')}
        </button>
      </div>
    </div>
  )
}

export function SidebarConsolePanel(props: SidebarConsolePanelProps) {
  const { store, t } = props
  const state = useSyncExternalStore(
    (fn: () => void) => store.store.subscribe(fn),
    () => store.store.getSnapshot(),
  )
  const [query, setQuery] = useState('')

  useEffect(() => {
    void store.refresh()
    const timer = setInterval(() => { void store.refresh() }, 30_000)
    return () => { clearInterval(timer) }
  }, [store])

  const needle = query.trim().toLowerCase()
  const batches = needle === ''
    ? state.batches
    : state.batches.filter(batch =>
      batch.websiteHost.toLowerCase().includes(needle)
      || String(batch.id).includes(needle)
      || batch.websiteName.toLowerCase().includes(needle))
  const selectedVisible = batches.filter(batch => state.selectedBatchIds.includes(batch.id)).length

  return (
    <div className={css.panel} role="region" aria-label={t('title')}>
      <div className={css.toolbar}>
        <input
          className={css.search}
          placeholder={t('search.placeholder')}
          value={query}
          onChange={(e) => { setQuery(e.target.value) }}
        />
        <button type="button" className={css.toolButton} onClick={() => { void store.refresh() }}>
          {t('refresh')}
        </button>
      </div>
      <div className={css.selectionBar}>
        <label className={css.selectAll}>
          <input
            type="checkbox"
            className={css.checkbox}
            checked={batches.length > 0 && selectedVisible === batches.length}
            ref={(input) => { if (input !== null) input.indeterminate = selectedVisible > 0 && selectedVisible < batches.length }}
            disabled={batches.length === 0 || state.publishing !== null}
            onChange={(event) => { store.selectBatches(batches.map(batch => batch.id), event.target.checked) }}
          />
          {t('selection.allVisible')}
        </label>
        <button
          type="button"
          className={css.publishButton}
          disabled={state.selectedBatchIds.length === 0 || state.publishing !== null}
          onClick={() => { void store.publishSelected() }}
        >
          {state.publishing !== null ? t('publishing') : `${t('publish.selected')} (${String(state.selectedBatchIds.length)})`}
        </button>
      </div>
      {state.status === 'loading' && state.batches.length === 0
        ? <p className={css.note}>{t('loading')}</p>
        : null}
      {state.error !== null
        ? <p className={css.error} role="alert">{t('error')}：{state.error}</p>
        : null}
      {state.status === 'ready' && batches.length === 0
        ? <p className={css.note}>{t('empty')}</p>
        : null}
      <div className={css.list}>
        {batches.map(batch => <BatchRow key={batch.id} {...props} batch={batch} />)}
      </div>
    </div>
  )
}
