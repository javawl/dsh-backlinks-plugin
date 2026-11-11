/**
 * Settings cards for `Supermanager` and `Cloud-mail` under Settings -> Plugins.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsSecretField, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels, type BacklinksSettingsLocaleKey } from './locales.ts'
import type { BacklinksCardFace } from './backlinks-card-controller.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.backlinks': BacklinksSettingsLocaleKey
  }
}

export interface BacklinksCardCopy {
  readonly title: BacklinksSettingsLocaleKey
  readonly description: BacklinksSettingsLocaleKey
  readonly baseUrlLabel: BacklinksSettingsLocaleKey
  readonly baseUrlHint: BacklinksSettingsLocaleKey
  readonly tokenLabel: BacklinksSettingsLocaleKey
  readonly tokenHint: BacklinksSettingsLocaleKey
  readonly tokenSet: BacklinksSettingsLocaleKey
  readonly tokenUnset: BacklinksSettingsLocaleKey
}

export type BacklinksProviderCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.backlinks'>
  & InjectFace<BacklinksCardFace>

export function BacklinksProviderCard(props: BacklinksProviderCardProps & { copy: BacklinksCardCopy }) {
  const { t, copy } = props
  const state = props.useBacklinksCard(snapshot => snapshot)
  if (props.view === 'summary') return t(copy.description)
  const disabled = !state.writable
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsValueField
        id={`plugin-config-backlinks-base-url-${copy.title}`}
        label={t(copy.baseUrlLabel)}
        hint={t(copy.baseUrlHint)}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={disabled}
        {...state.baseUrl}
        onEdit={(text) => { props.edit('baseUrl', text) }}
        onReset={() => { props.resetField('baseUrl') }}
      />
      <SettingsSecretField
        id={`plugin-config-backlinks-token-${copy.title}`}
        label={t(copy.tokenLabel)}
        hint={t(copy.tokenHint)}
        disabled={disabled}
        text={state.token.text}
        configured={state.tokenConfigured}
        stateLabel={state.tokenConfigured ? t(copy.tokenSet) : t(copy.tokenUnset)}
        onEdit={(text) => { props.edit('token', text) }}
      />
    </SettingsForm>
  )
}

const SUPERMANAGER_COPY: BacklinksCardCopy = {
  title: 'supermanagerTitle',
  description: 'supermanagerDescription',
  baseUrlLabel: 'supermanagerBaseUrl',
  baseUrlHint: 'supermanagerBaseUrlHint',
  tokenLabel: 'supermanagerToken',
  tokenHint: 'supermanagerTokenHint',
  tokenSet: 'supermanagerTokenSet',
  tokenUnset: 'supermanagerTokenUnset',
}

const CLOUD_MAIL_COPY: BacklinksCardCopy = {
  title: 'cloudMailTitle',
  description: 'cloudMailDescription',
  baseUrlLabel: 'cloudMailBaseUrl',
  baseUrlHint: 'cloudMailBaseUrlHint',
  tokenLabel: 'cloudMailToken',
  tokenHint: 'cloudMailTokenHint',
  tokenSet: 'cloudMailTokenSet',
  tokenUnset: 'cloudMailTokenUnset',
}

export function SupermanagerCard(props: BacklinksProviderCardProps) {
  return <BacklinksProviderCard {...props} copy={SUPERMANAGER_COPY} />
}

export function CloudMailCard(props: BacklinksProviderCardProps) {
  return <BacklinksProviderCard {...props} copy={CLOUD_MAIL_COPY} />
}
