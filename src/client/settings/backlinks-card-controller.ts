/**
 * Staged settings form controller over `backlinks-supermanager` / `backlinks-cloud-mail`.
 */

import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel,
  settingsTextField,
  type SettingsFieldState,
  type SettingsFormActions,
  type SettingsFormScope,
  type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

export const BACKLINKS_SUPERMANAGER_NS = 'backlinks-supermanager'
export const BACKLINKS_CLOUD_MAIL_NS = 'backlinks-cloud-mail'

export interface BacklinksSettings {
  readonly baseUrl?: string
  readonly token?: string
}

export interface BacklinksCardState extends SettingsFormShell {
  baseUrl: SettingsFieldState
  token: SettingsFieldState
  tokenConfigured: boolean
}

export interface BacklinksCardFace extends SettingsFormActions {
  hooks: {
    backlinksCard: SnapshotStore<BacklinksCardState>
  }
}

export class BacklinksCardController {
  private readonly form: SettingsFormModel<BacklinksSettings>
  private readonly store: SnapshotStore<BacklinksCardState>
  private readonly unsubscribe: () => void
  private configured = false

  constructor(
    scope: SettingsFormScope<BacklinksSettings>,
    private readonly describe: SettingsDescribeFace,
    private readonly ns: string,
  ) {
    this.form = new SettingsFormModel(
      scope,
      [settingsTextField('baseUrl')],
      [{ field: 'token', write: text => BacklinksCardController.writeToken(scope, text) }],
    )
    this.store = this.form.bind(() => this.projection())
    this.unsubscribe = describe.subscribe(() => { this.readConfigured() })
    this.readConfigured()
  }

  dispose(): void {
    this.unsubscribe()
    this.form.dispose()
  }

  private projection(): BacklinksCardState {
    return {
      ...this.form.shell(),
      baseUrl: this.form.field('baseUrl'),
      token: this.form.field('token'),
      tokenConfigured: this.configured,
    }
  }

  private readConfigured(): void {
    const entry = this.describe.getSnapshot().view?.namespaces.find(row => row.ns === this.ns)
    const configured = entry?.secrets.some(slot => slot.path[0] === 'token' && slot.set) ?? false
    if (configured === this.configured) return
    this.configured = configured
    this.store.set(this.projection())
  }

  inject(): BacklinksCardFace {
    return { hooks: { backlinksCard: this.store }, ...this.form.actions() }
  }

  private static async writeToken(scope: SettingsFormScope<BacklinksSettings>, value: string): Promise<boolean> {
    try {
      await scope.mutate([{ op: 'set', path: ['token'], value }])
      return true
    } catch {
      return false
    }
  }
}
