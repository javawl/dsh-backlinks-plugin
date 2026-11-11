/**
 * Unified Web/Desktop client entry for `@javawl/dsh-backlinks-bundle`:
 * 1. Dynamically mounts `TYPERT_REMOTE` (`backlinksConsole`) onto `ctx.remote.$mount(...)`
 *    without modifying `@deepseek-ai/dsh-api-remotes`.
 * 2. Registers the sidebar Publish Batches panel (`sidebar.panellist` + `main`).
 * 3. Registers the `Supermanager` and `Cloud-mail` settings cards into `plugins.item`.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { TYPERT_REMOTE } from '../shared/typert-remote.ts'
import { createConsoleStore } from './console/store.ts'
import { BacklinksConsoleIcon, SidebarConsolePanel } from './console/SidebarPanel.tsx'
import { en as consoleEn, zh as consoleZh } from './console/locales.ts'
import { CloudMailCard, SupermanagerCard, type BacklinksProviderCardProps } from './settings/BacklinksCard.tsx'
import {
  BACKLINKS_CLOUD_MAIL_NS,
  BACKLINKS_SUPERMANAGER_NS,
  BacklinksCardController,
} from './settings/backlinks-card-controller.ts'
import { en as settingsEn, zh as settingsZh, type BacklinksSettingsLocaleKey } from './settings/locales.ts'

export const CONSOLE_NS = 'backlinksConsole'
export const SETTINGS_NS = 'settings.backlinks'
export const PANEL_ID = 'backlinks-console' as MainPanelId

export const inject = ['remote', 'slots', 'locale']

function mountConsoleSurface(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(CONSOLE_NS, { zh: consoleZh, en: consoleEn }), 'ui-backlinks-console: dictionaries')
  const t = ctx.locale.bind(CONSOLE_NS)
  const store = createConsoleStore(ctx)

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 25, locale: CONSOLE_NS, label: () => t('sidebar.action') },
      BacklinksConsoleIcon,
    ))

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID, locale: CONSOLE_NS, inject: () => ({ store }) },
      (props: PropsRuntime<'main'> & PropsLocale<'backlinksConsole'> & { store: ReturnType<typeof createConsoleStore> }) =>
        SidebarConsolePanel(props),
    ))
}

function mountCard(
  ctx: ClientContext,
  ns: string,
  id: string,
  title: BacklinksSettingsLocaleKey,
  Card: (props: BacklinksProviderCardProps) => ReturnType<typeof SupermanagerCard>,
): void {
  const t = ctx.locale.bind(SETTINGS_NS)
  const card = new BacklinksCardController(ctx.configForms.get(ns), ctx.configForms.describe(), ns)
  ctx.effect(() => () => { card.dispose() }, `ui-settings-backlinks: ${id} form subscription`)
  ctx.effect(() => ctx.configForms.whileServed([ns], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id, order: 30, label: () => t(title), locale: SETTINGS_NS, inject: () => card.inject(),
  }, Card))), `ui-settings-backlinks: ${id} page`)
}

function mountSettingsSurface(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh: settingsZh, en: settingsEn }), 'ui-settings-backlinks: dictionaries')
  mountCard(ctx, BACKLINKS_SUPERMANAGER_NS, 'backlinks-supermanager', 'supermanagerTitle', SupermanagerCard)
  mountCard(ctx, BACKLINKS_CLOUD_MAIL_NS, 'backlinks-cloud-mail', 'cloudMailTitle', CloudMailCard)
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const consoleFork = ctx.inject(
    ['remote.backlinksConsole', 'slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace'],
    mountConsoleSurface,
  )
  const settingsFork = ctx.inject(
    ['slots', 'locale', 'configForms'],
    mountSettingsSurface,
  )
  try {
    await Promise.all([consoleFork, settingsFork])
  } catch (error) {
    await Promise.allSettled([settingsFork.dispose(), consoleFork.dispose()])
    await disposeRemote()
    throw error
  }
  return async () => {
    await Promise.allSettled([settingsFork.dispose(), consoleFork.dispose()])
    await disposeRemote()
  }
}
