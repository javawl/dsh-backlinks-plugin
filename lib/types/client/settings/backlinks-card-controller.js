/**
 * Staged settings form controller over `backlinks-supermanager` / `backlinks-cloud-mail`.
 */
import { SettingsFormModel, settingsTextField, } from '@deepseek-ai/dsh-client-ui-primitives';
export const BACKLINKS_SUPERMANAGER_NS = 'backlinks-supermanager';
export const BACKLINKS_CLOUD_MAIL_NS = 'backlinks-cloud-mail';
export class BacklinksCardController {
    describe;
    ns;
    form;
    store;
    unsubscribe;
    configured = false;
    constructor(scope, describe, ns) {
        this.describe = describe;
        this.ns = ns;
        this.form = new SettingsFormModel(scope, [settingsTextField('baseUrl')], [{ field: 'token', write: text => BacklinksCardController.writeToken(scope, text) }]);
        this.store = this.form.bind(() => this.projection());
        this.unsubscribe = describe.subscribe(() => { this.readConfigured(); });
        this.readConfigured();
    }
    dispose() {
        this.unsubscribe();
        this.form.dispose();
    }
    projection() {
        return {
            ...this.form.shell(),
            baseUrl: this.form.field('baseUrl'),
            token: this.form.field('token'),
            tokenConfigured: this.configured,
        };
    }
    readConfigured() {
        const entry = this.describe.getSnapshot().view?.namespaces.find(row => row.ns === this.ns);
        const configured = entry?.secrets.some(slot => slot.path[0] === 'token' && slot.set) ?? false;
        if (configured === this.configured)
            return;
        this.configured = configured;
        this.store.set(this.projection());
    }
    inject() {
        return { hooks: { backlinksCard: this.store }, ...this.form.actions() };
    }
    static async writeToken(scope, value) {
        try {
            await scope.mutate([{ op: 'set', path: ['token'], value }]);
            return true;
        }
        catch {
            return false;
        }
    }
}
