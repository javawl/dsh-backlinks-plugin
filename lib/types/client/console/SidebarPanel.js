import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * The publish console as a global panel page: batch rows with status chips,
 * inline item details, search, auto-refresh, and multi-batch selection.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './SidebarPanel.module.css';
export function BacklinksConsoleIcon({ size }) {
    return _jsx(IconLinkOutlineRegular, { size: size });
}
function BatchRow(props) {
    const { store, t, batch } = props;
    const state = useSyncExternalStore((fn) => store.store.subscribe(fn), () => store.store.getSnapshot());
    const detail = state.details[batch.id];
    const publishing = state.publishing?.includes(batch.id) === true;
    return (_jsxs("div", { className: css.row, "data-selected": state.selectedBatchIds.includes(batch.id), children: [_jsxs("div", { className: css.rowHeader, children: [_jsx("input", { type: "checkbox", className: css.checkbox, "aria-label": `${t('selection.batch')} #${String(batch.id)} ${batch.websiteHost}`, checked: state.selectedBatchIds.includes(batch.id), disabled: state.publishing !== null, onChange: (event) => { store.selectBatches([batch.id], event.target.checked); } }), _jsxs("button", { type: "button", className: css.rowHead, onClick: () => { void store.toggleDetail(batch.id); }, "aria-expanded": detail !== undefined, children: [_jsxs("span", { className: css.rowTitle, children: ["#", String(batch.id), " ", batch.websiteHost] }), _jsxs("span", { className: css.rowChips, children: [batch.counts.pending > 0 ? _jsxs("span", { className: css.pending, children: ["\u5F85 ", String(batch.counts.pending)] }) : null, batch.counts.executed > 0 ? _jsxs("span", { className: css.done, children: ["\u6210 ", String(batch.counts.executed)] }) : null, batch.counts.failed > 0 ? _jsxs("span", { className: css.failed, children: ["\u8D25 ", String(batch.counts.failed)] }) : null, batch.executing ? _jsx("span", { className: css.pulseDot, "aria-label": t('executing') }) : null] })] })] }), detail !== undefined
                ? (_jsx("div", { className: css.items, children: detail.items.map(item => (_jsxs("div", { className: css.itemRow, children: [_jsx("span", { className: css.itemHost, children: item.sourceHost }), _jsx("span", { className: css.itemStatus, "data-status": item.status, children: item.status })] }, item.id))) }))
                : null, _jsx("div", { className: css.rowActions, children: _jsx("button", { type: "button", className: css.publishButton, disabled: state.publishing !== null, onClick: () => { void store.publish(batch.id); }, children: publishing ? t('publishing') : t('publish') }) })] }));
}
export function SidebarConsolePanel(props) {
    const { store, t } = props;
    const state = useSyncExternalStore((fn) => store.store.subscribe(fn), () => store.store.getSnapshot());
    const [query, setQuery] = useState('');
    useEffect(() => {
        void store.refresh();
        const timer = setInterval(() => { void store.refresh(); }, 30_000);
        return () => { clearInterval(timer); };
    }, [store]);
    const needle = query.trim().toLowerCase();
    const batches = needle === ''
        ? state.batches
        : state.batches.filter(batch => batch.websiteHost.toLowerCase().includes(needle)
            || String(batch.id).includes(needle)
            || batch.websiteName.toLowerCase().includes(needle));
    const selectedVisible = batches.filter(batch => state.selectedBatchIds.includes(batch.id)).length;
    return (_jsxs("div", { className: css.panel, role: "region", "aria-label": t('title'), children: [_jsxs("div", { className: css.toolbar, children: [_jsx("input", { className: css.search, placeholder: t('search.placeholder'), value: query, onChange: (e) => { setQuery(e.target.value); } }), _jsx("button", { type: "button", className: css.toolButton, onClick: () => { void store.refresh(); }, children: t('refresh') })] }), _jsxs("div", { className: css.selectionBar, children: [_jsxs("label", { className: css.selectAll, children: [_jsx("input", { type: "checkbox", className: css.checkbox, checked: batches.length > 0 && selectedVisible === batches.length, ref: (input) => { if (input !== null)
                                    input.indeterminate = selectedVisible > 0 && selectedVisible < batches.length; }, disabled: batches.length === 0 || state.publishing !== null, onChange: (event) => { store.selectBatches(batches.map(batch => batch.id), event.target.checked); } }), t('selection.allVisible')] }), _jsx("button", { type: "button", className: css.publishButton, disabled: state.selectedBatchIds.length === 0 || state.publishing !== null, onClick: () => { void store.publishSelected(); }, children: state.publishing !== null ? t('publishing') : `${t('publish.selected')} (${String(state.selectedBatchIds.length)})` })] }), state.status === 'loading' && state.batches.length === 0
                ? _jsx("p", { className: css.note, children: t('loading') })
                : null, state.error !== null
                ? _jsxs("p", { className: css.error, role: "alert", children: [t('error'), "\uFF1A", state.error] })
                : null, state.status === 'ready' && batches.length === 0
                ? _jsx("p", { className: css.note, children: t('empty') })
                : null, _jsx("div", { className: css.list, children: batches.map(batch => _jsx(BatchRow, { ...props, batch: batch }, batch.id)) })] }));
}
