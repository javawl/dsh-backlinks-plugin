import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { SettingsForm, SettingsSecretField, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives';
import { formLabels } from "./locales.js";
export function BacklinksProviderCard(props) {
    const { t, copy } = props;
    const state = props.useBacklinksCard(snapshot => snapshot);
    if (props.view === 'summary')
        return t(copy.description);
    const disabled = !state.writable;
    return (_jsxs(SettingsForm, { labels: formLabels(t), state: state, onSave: props.save, onDiscard: props.discard, children: [_jsx(SettingsValueField, { id: `plugin-config-backlinks-base-url-${copy.title}`, label: t(copy.baseUrlLabel), hint: t(copy.baseUrlHint), overriddenLabel: t('overridden'), resetLabel: t('reset'), invalidLabel: t('invalidNumber'), disabled: disabled, ...state.baseUrl, onEdit: (text) => { props.edit('baseUrl', text); }, onReset: () => { props.resetField('baseUrl'); } }), _jsx(SettingsSecretField, { id: `plugin-config-backlinks-token-${copy.title}`, label: t(copy.tokenLabel), hint: t(copy.tokenHint), disabled: disabled, text: state.token.text, configured: state.tokenConfigured, stateLabel: state.tokenConfigured ? t(copy.tokenSet) : t(copy.tokenUnset), onEdit: (text) => { props.edit('token', text); } })] }));
}
const SUPERMANAGER_COPY = {
    title: 'supermanagerTitle',
    description: 'supermanagerDescription',
    baseUrlLabel: 'supermanagerBaseUrl',
    baseUrlHint: 'supermanagerBaseUrlHint',
    tokenLabel: 'supermanagerToken',
    tokenHint: 'supermanagerTokenHint',
    tokenSet: 'supermanagerTokenSet',
    tokenUnset: 'supermanagerTokenUnset',
};
const CLOUD_MAIL_COPY = {
    title: 'cloudMailTitle',
    description: 'cloudMailDescription',
    baseUrlLabel: 'cloudMailBaseUrl',
    baseUrlHint: 'cloudMailBaseUrlHint',
    tokenLabel: 'cloudMailToken',
    tokenHint: 'cloudMailTokenHint',
    tokenSet: 'cloudMailTokenSet',
    tokenUnset: 'cloudMailTokenUnset',
};
export function SupermanagerCard(props) {
    return _jsx(BacklinksProviderCard, { ...props, copy: SUPERMANAGER_COPY });
}
export function CloudMailCard(props) {
    return _jsx(BacklinksProviderCard, { ...props, copy: CLOUD_MAIL_COPY });
}
