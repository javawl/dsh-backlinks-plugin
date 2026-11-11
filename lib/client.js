window.__ModuleLoader__.load({
	id: "@javawl/dsh-backlinks-bundle",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let zod = require("zod");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		// node_modules/.pnpm/@deepseek-ai+dsh-typert-protocol@0.2.1-rc.2_@deepseek-ai+cordis@4.0.5/node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/remote-info.js
		/** Lazy assembly of generated Remote definitions using caller-supplied Zod; no runtime imports. */
		/**
		* Retain one generated definition per endpoint without constructing parsers or projections.
		* The class instance builds its shared descriptor/method index on first access;
		* input schemas and JSON Schema projections are cached only when requested.
		* @param spec - compiler-produced method facts and Zod factories.
		* @param zod - the generated artifact's Zod runtime for named-input parsers.
		* @returns a lazy, mountable info instance with no registration or transport effects.
		*/
		function createTypertRemoteInfo(spec, zod) {
			return new RemoteInfo(spec, zod);
		}
		var RemoteInfo = class {
			spec;
			zod;
			index;
			constructor(spec, zod) {
				this.spec = spec;
				this.zod = zod;
			}
			get package() {
				return this.spec.package;
			}
			get descriptors() {
				return this.resolve().descriptors;
			}
			get methods() {
				return this.resolve().methods;
			}
			resolve() {
				if (this.index !== void 0) return this.index;
				const zod = this.zod;
				const descriptors = [];
				const methods = Object.create(null);
				for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
					const separator = endpoint.indexOf("/");
					const namespace = endpoint.slice(0, separator);
					const method = endpoint.slice(separator + 1);
					const parameters = definition.parameters.map((parameter) => ({
						...parameter,
						wire: parameter.wire ?? parameter.name
					}));
					const descriptor = {
						...definition,
						id: `${this.spec.package}#${endpoint}`,
						namespace,
						method,
						parameters,
						result: definition.result.description === void 0 ? definition.result : new ResultValue(definition.result)
					};
					if (definition.invocation.kind === "direct") {
						const inputs = [];
						methods[endpoint] = Object.assign(descriptor, {
							input(options) {
								const strict = options?.strict === true;
								return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod);
							},
							invoke(remote, input, signal) {
								const named = input;
								const values = parameters.map((parameter) => named[parameter.wire]);
								if (definition.cancellation !== void 0) values.push(signal);
								const receiver = Reflect.get(remote, namespace);
								return Reflect.get(receiver, method).apply(receiver, values);
							}
						});
					}
					descriptors.push(descriptor);
				}
				return this.index = {
					descriptors,
					methods
				};
			}
		};
		function optional(parameter) {
			return parameter.source === "json" && parameter.acceptsUndefined === true;
		}
		var NamedInput = class {
			parameters;
			strict;
			zod;
			schema;
			projection;
			constructor(parameters, strict, zod) {
				this.parameters = parameters;
				this.strict = strict;
				this.zod = zod;
			}
			codec(parameter) {
				return this.strict ? parameter.strictCodec : parameter.codec;
			}
			create = () => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
				const value = this.codec(parameter).create();
				return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()];
			})));
			get jsonSchema() {
				return this.project().jsonSchema;
			}
			get jsonSchemaError() {
				return this.project().jsonSchemaError;
			}
			project() {
				if (this.projection !== void 0) return this.projection;
				const unavailable = this.parameters.find((parameter) => this.codec(parameter).jsonSchema === void 0);
				if (unavailable !== void 0) return this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${unavailable.wire}` };
				return this.projection = { jsonSchema: {
					type: "object",
					properties: Object.fromEntries(this.parameters.map((parameter) => [parameter.wire, {
						...this.codec(parameter).jsonSchema,
						...parameter.description === void 0 ? {} : { description: parameter.description }
					}])),
					required: this.parameters.filter((parameter) => !optional(parameter)).map((parameter) => parameter.wire),
					additionalProperties: false
				} };
			}
		};
		var ResultValue = class {
			spec;
			projection;
			constructor(spec) {
				this.spec = spec;
			}
			get mode() {
				return this.spec.mode;
			}
			get typeSymbol() {
				return this.spec.typeSymbol;
			}
			get create() {
				return this.spec.create;
			}
			get decode() {
				return this.spec.decode;
			}
			get encode() {
				return this.spec.encode;
			}
			get description() {
				return this.spec.description;
			}
			get jsonSchemaError() {
				return this.spec.jsonSchemaError;
			}
			get jsonSchema() {
				if (this.projection === void 0) {
					const schema = this.spec.jsonSchema;
					this.projection = { value: schema === void 0 ? void 0 : {
						...schema,
						description: this.spec.description
					} };
				}
				return this.projection.value;
			}
		};
		// lib/types/shared/typert-remote.js
		/**
		* Shared Typert Remote client/host wire descriptors for `backlinksConsole`.
		*/
		const PACKAGE_NAME = "@javawl/dsh-backlinks-bundle";
		let batchParamSchema;
		const getBatchParamSchema = () => batchParamSchema ??= zod.z.number();
		let batchSummarySchema;
		const getBatchSummarySchema = () => batchSummarySchema ??= zod.z.object({
			id: zod.z.number().readonly(),
			name: zod.z.string().readonly(),
			websiteId: zod.z.number().readonly(),
			websiteName: zod.z.string().readonly(),
			websiteHost: zod.z.string().readonly(),
			plannedAt: zod.z.string().readonly(),
			counts: zod.z.object({
				pending: zod.z.number().readonly(),
				executed: zod.z.number().readonly(),
				skipped: zod.z.number().readonly(),
				failed: zod.z.number().readonly(),
				total: zod.z.number().readonly()
			}).readonly(),
			executing: zod.z.boolean().readonly()
		}).readonly();
		let batchesResultSchema;
		const getBatchesResultSchema = () => batchesResultSchema ??= zod.z.array(getBatchSummarySchema()).readonly();
		let batchDetailSchema;
		const getBatchDetailSchema = () => batchDetailSchema ??= zod.z.object({
			batch: getBatchSummarySchema(),
			website: zod.z.object({
				id: zod.z.number().readonly(),
				name: zod.z.string().readonly(),
				siteUrl: zod.z.string().readonly(),
				siteHost: zod.z.string().readonly(),
				shortDescription: zod.z.string().readonly().optional(),
				longDescription: zod.z.string().readonly().optional(),
				logoUrl: zod.z.string().readonly().optional(),
				screenshotUrl: zod.z.string().readonly().optional(),
				keyFeatures: zod.z.string().readonly().optional(),
				pricingType: zod.z.string().readonly().optional()
			}).readonly(),
			anchors: zod.z.array(zod.z.object({
				id: zod.z.number().readonly(),
				anchorText: zod.z.string().readonly(),
				targetUrl: zod.z.string().readonly()
			}).readonly()).readonly(),
			items: zod.z.array(zod.z.object({
				id: zod.z.number().readonly(),
				sourceId: zod.z.number().readonly(),
				sourceName: zod.z.string().readonly(),
				sourceUrl: zod.z.string().readonly(),
				sourceHost: zod.z.string().readonly(),
				submitUrl: zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
				sourceNotes: zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
				category: zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
				tags: zod.z.array(zod.z.string()).readonly(),
				paymentType: zod.z.string().readonly(),
				linkType: zod.z.string().readonly(),
				status: zod.z.string().readonly(),
				failureMode: zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
				failureReason: zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
				publishedUrl: zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
				publishStatus: zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
				plannedAt: zod.z.string().readonly()
			}).readonly()).readonly()
		}).readonly();
		const TYPERT_REMOTE = createTypertRemoteInfo({
			package: PACKAGE_NAME,
			methods: {
				"backlinksConsole/batch": {
					service: "backlinksConsole",
					description: "One batch's full detail: website, anchors, and items.",
					invocation: { kind: "direct" },
					parameters: [{
						name: "batchId",
						description: "the batch to read.",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: `${PACKAGE_NAME}#backlinksConsole/batch:batchId`,
							create: getBatchParamSchema,
							jsonSchema: { type: "number" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: `${PACKAGE_NAME}#backlinksConsole/batch:batchId`,
							create: getBatchParamSchema,
							jsonSchema: { type: "number" }
						}
					}],
					result: {
						mode: "strict",
						typeSymbol: `${PACKAGE_NAME}#BacklinkBatchDetail`,
						create: getBatchDetailSchema,
						description: "batch, website, anchors, and items."
					}
				},
				"backlinksConsole/batches": {
					service: "backlinksConsole",
					description: "Every batch in the workspace with per-status counts and the executing flag.",
					invocation: { kind: "direct" },
					parameters: [],
					result: {
						mode: "strict",
						typeSymbol: `${PACKAGE_NAME}#backlinksConsole/batches:result`,
						create: getBatchesResultSchema,
						description: "the provider's batch summaries, newest-planned first."
					}
				}
			}
		}, zod.z);
		// lib/types/client/console/store.js
		/**
		* Console data, batch selection, and submission into a workspace's blank session
		* using the `backlink-operator` preset (falling back to the default preset if needed).
		*/
		function createConsoleStore(ctx) {
			const store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				open: false,
				status: "idle",
				error: null,
				batches: [],
				details: {},
				selectedBatchIds: [],
				publishing: null
			});
			const readBatches = async () => {
				const result = await ctx.remote.backlinksConsole.batches();
				if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
				return [...result.value].sort((a, b) => b.id - a.id);
			};
			const readBatch = async (batchId) => {
				const result = await ctx.remote.backlinksConsole.batch(batchId);
				if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
				return result.value;
			};
			const createBacklinkSession = async (workspaceId) => {
				try {
					return await ctx.sessions.create({
						workspaceId,
						agentPreset: "backlink-operator"
					});
				} catch {
					return await ctx.sessions.create({ workspaceId });
				}
			};
			const publishBatches = async (batchIds) => {
				if (store.getSnapshot().publishing !== null || batchIds.length === 0) return;
				const ids = [...new Set(batchIds)].sort((a, b) => b - a);
				store.update((state) => {
					state.publishing = ids;
					state.error = null;
				});
				try {
					const workspaceId = recentWorkspaceId(ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot());
					if (workspaceId === void 0) throw new Error("publish: select or create a workspace first");
					const sessionId = await createBacklinkSession(workspaceId);
					const command = `/backlink-publish ${ids.join(" ")}` + (ids.length > 1 ? "\n请按以上批次号顺序依次发布，仅处理这些批次。" : "");
					await ctx.sessions.using(sessionId, { source: "backlinksConsole" }, async (reference) => {
						await reference.ready;
						const state = reference.binding.session.getSnapshot();
						if (state.openState !== "open") throw state.openError ?? /* @__PURE__ */ new Error("publish: new session failed to open");
						await reference.binding.ctx.inject(["conversation"], async (scoped) => {
							await scoped.conversation.send(command);
						});
					});
					ctx.uiWorkspace.openSession(sessionId);
					store.update((state) => {
						state.selectedBatchIds = state.selectedBatchIds.filter((id) => !ids.includes(id));
						state.open = false;
					});
				} catch (error) {
					store.update((state) => {
						state.error = error instanceof Error ? error.message : String(error);
					});
				} finally {
					store.update((state) => {
						state.publishing = null;
					});
				}
			};
			return {
				store,
				open() {
					store.update((state) => {
						state.open = true;
					});
					this.refresh();
				},
				close() {
					store.update((state) => {
						state.open = false;
					});
				},
				async refresh() {
					store.update((state) => {
						state.status = "loading";
						state.error = null;
					});
					try {
						const batches = await readBatches();
						store.update((state) => {
							state.batches = batches;
							state.selectedBatchIds = state.selectedBatchIds.filter((id) => batches.some((batch) => batch.id === id));
							state.status = "ready";
						});
					} catch (error) {
						store.update((state) => {
							state.status = "error";
							state.error = error instanceof Error ? error.message : String(error);
						});
					}
				},
				async toggleDetail(batchId) {
					if (store.getSnapshot().details[batchId] !== void 0) {
						store.update((state) => {
							Reflect.deleteProperty(state.details, batchId);
						});
						return;
					}
					try {
						const detail = await readBatch(batchId);
						store.update((state) => {
							state.details[batchId] = detail;
						});
					} catch (error) {
						store.update((state) => {
							state.error = error instanceof Error ? error.message : String(error);
						});
					}
				},
				selectBatches(batchIds, selected) {
					if (store.getSnapshot().publishing !== null) return;
					store.update((state) => {
						const ids = new Set(state.selectedBatchIds);
						for (const id of batchIds) if (selected && state.batches.some((batch) => batch.id === id)) ids.add(id);
						else ids.delete(id);
						state.selectedBatchIds = [...ids].sort((a, b) => b - a);
					});
				},
				async publish(batchId) {
					await publishBatches([batchId]);
				},
				async publishSelected() {
					await publishBatches(store.getSnapshot().selectedBatchIds);
				}
			};
		}
		function recentWorkspaceId(sessions, workspaces) {
			let selected;
			let selectedTime = Number.NEGATIVE_INFINITY;
			for (const workspace of workspaces.items) {
				let latest = Number.NEGATIVE_INFINITY;
				for (const sessionId of workspace.sessionIds) {
					const session = sessions.byId[sessionId];
					if (session !== void 0) latest = Math.max(latest, session.updatedAt);
				}
				if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt);
				if (selected === void 0 || latest > selectedTime) {
					selected = workspace.workspaceId;
					selectedTime = latest;
				}
			}
			return selected;
		}
		// \0dsh-css:src/client/console/SidebarPanel.module.css.mjs
		const css = ".nsVX8q_panel{flex-direction:column;flex:auto;gap:6px;min-height:0;padding:12px 16px;display:flex;overflow:hidden}.nsVX8q_toolbar{flex:none;gap:4px;display:flex}.nsVX8q_search{border-radius:var(--dsw-radius-sm);min-width:0;color:inherit;background:0 0;border:1px solid #7f7f7f59;flex:auto;padding:4px 8px;font-size:12px}.nsVX8q_toolButton{border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap;background:0 0;border:1px solid #7f7f7f59;padding:4px 8px;font-size:12px}.nsVX8q_list{flex-direction:column;flex:auto;gap:4px;min-height:0;display:flex;overflow-y:auto}.nsVX8q_row{border-radius:var(--dsw-radius-sm);border:1px solid #7f7f7f33;flex-direction:column;gap:4px;padding:4px 6px;display:flex}.nsVX8q_rowHead{cursor:pointer;text-align:left;color:inherit;background:0 0;border:none;flex:1;justify-content:space-between;align-items:center;gap:6px;min-width:0;padding:2px 0;display:flex}.nsVX8q_rowHeader,.nsVX8q_selectionBar,.nsVX8q_selectAll{align-items:center;gap:6px;min-width:0;display:flex}.nsVX8q_selectionBar{flex:none;justify-content:space-between}.nsVX8q_selectAll{cursor:pointer;font-size:12px}.nsVX8q_checkbox{accent-color:#3b82f6;cursor:pointer;flex:none;width:14px;height:14px;margin:0}.nsVX8q_row[data-selected=true]{background:#3b82f60f;border-color:#3b82f6}.nsVX8q_rowTitle{white-space:nowrap;text-overflow:ellipsis;min-width:0;font-size:12px;font-weight:500;overflow:hidden}.nsVX8q_rowChips{flex:none;align-items:center;gap:4px;display:inline-flex}.nsVX8q_pending,.nsVX8q_done,.nsVX8q_failed{corner-shape:round;white-space:nowrap;border-radius:9999px;padding:1px 6px;font-size:10px}.nsVX8q_pending{color:#2563eb;background:#3b82f626}.nsVX8q_done{color:#059669;background:#10b98126}.nsVX8q_failed{color:#dc2626;background:#ef444426}.nsVX8q_pulseDot{corner-shape:round;background:#3b82f6;border-radius:9999px;width:7px;height:7px;animation:1.4s ease-in-out infinite nsVX8q_backlinksPanelPulse}@keyframes nsVX8q_backlinksPanelPulse{0%{opacity:1}50%{opacity:.35}to{opacity:1}}.nsVX8q_items{border-top:1px solid #7f7f7f26;flex-direction:column;gap:2px;padding-top:4px;display:flex}.nsVX8q_itemRow{justify-content:space-between;gap:6px;font-size:11px;display:flex}.nsVX8q_itemHost{white-space:nowrap;text-overflow:ellipsis;opacity:.75;min-width:0;overflow:hidden}.nsVX8q_itemStatus{opacity:.6;white-space:nowrap}.nsVX8q_itemStatus[data-status=failed]{color:#dc2626;opacity:1}.nsVX8q_itemStatus[data-status=executed]{color:#059669;opacity:1}.nsVX8q_rowActions{justify-content:flex-end;display:flex}.nsVX8q_publishButton{border-radius:var(--dsw-radius-sm);color:#fff;cursor:pointer;background:#3b82f6;border:none;padding:3px 12px;font-size:11px;font-weight:500}.nsVX8q_publishButton:disabled{opacity:.5;cursor:default}.nsVX8q_note{opacity:.7;margin:0;font-size:12px}.nsVX8q_error{color:#dc2626;word-break:break-all;margin:0;font-size:12px}";
		const tagId = "@javawl/dsh-backlinks-bundle/SidebarPanel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@javawl/dsh-backlinks-bundle";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var SidebarPanel_module_css_default = {
			"backlinksPanelPulse": "nsVX8q_backlinksPanelPulse",
			"checkbox": "nsVX8q_checkbox",
			"done": "nsVX8q_done",
			"error": "nsVX8q_error",
			"failed": "nsVX8q_failed",
			"itemHost": "nsVX8q_itemHost",
			"itemRow": "nsVX8q_itemRow",
			"itemStatus": "nsVX8q_itemStatus",
			"items": "nsVX8q_items",
			"list": "nsVX8q_list",
			"note": "nsVX8q_note",
			"panel": "nsVX8q_panel",
			"pending": "nsVX8q_pending",
			"publishButton": "nsVX8q_publishButton",
			"pulseDot": "nsVX8q_pulseDot",
			"row": "nsVX8q_row",
			"rowActions": "nsVX8q_rowActions",
			"rowChips": "nsVX8q_rowChips",
			"rowHead": "nsVX8q_rowHead",
			"rowHeader": "nsVX8q_rowHeader",
			"rowTitle": "nsVX8q_rowTitle",
			"search": "nsVX8q_search",
			"selectAll": "nsVX8q_selectAll",
			"selectionBar": "nsVX8q_selectionBar",
			"toolButton": "nsVX8q_toolButton",
			"toolbar": "nsVX8q_toolbar"
		};
		// lib/types/client/console/SidebarPanel.js
		/**
		* The publish console as a global panel page: batch rows with status chips,
		* inline item details, search, auto-refresh, and multi-batch selection.
		*/
		function BacklinksConsoleIcon({ size }) {
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLinkOutlineRegular, { size });
		}
		function BatchRow(props) {
			const { store, t, batch } = props;
			const state = (0, react.useSyncExternalStore)((fn) => store.store.subscribe(fn), () => store.store.getSnapshot());
			const detail = state.details[batch.id];
			const publishing = state.publishing?.includes(batch.id) === true;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: SidebarPanel_module_css_default.row,
				"data-selected": state.selectedBatchIds.includes(batch.id),
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: SidebarPanel_module_css_default.rowHeader,
						children: [(0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							className: SidebarPanel_module_css_default.checkbox,
							"aria-label": `${t("selection.batch")} #${String(batch.id)} ${batch.websiteHost}`,
							checked: state.selectedBatchIds.includes(batch.id),
							disabled: state.publishing !== null,
							onChange: (event) => {
								store.selectBatches([batch.id], event.target.checked);
							}
						}), (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: SidebarPanel_module_css_default.rowHead,
							onClick: () => {
								store.toggleDetail(batch.id);
							},
							"aria-expanded": detail !== void 0,
							children: [(0, react_jsx_runtime.jsxs)("span", {
								className: SidebarPanel_module_css_default.rowTitle,
								children: [
									"#",
									String(batch.id),
									" ",
									batch.websiteHost
								]
							}), (0, react_jsx_runtime.jsxs)("span", {
								className: SidebarPanel_module_css_default.rowChips,
								children: [
									batch.counts.pending > 0 ? (0, react_jsx_runtime.jsxs)("span", {
										className: SidebarPanel_module_css_default.pending,
										children: ["待 ", String(batch.counts.pending)]
									}) : null,
									batch.counts.executed > 0 ? (0, react_jsx_runtime.jsxs)("span", {
										className: SidebarPanel_module_css_default.done,
										children: ["成 ", String(batch.counts.executed)]
									}) : null,
									batch.counts.failed > 0 ? (0, react_jsx_runtime.jsxs)("span", {
										className: SidebarPanel_module_css_default.failed,
										children: ["败 ", String(batch.counts.failed)]
									}) : null,
									batch.executing ? (0, react_jsx_runtime.jsx)("span", {
										className: SidebarPanel_module_css_default.pulseDot,
										"aria-label": t("executing")
									}) : null
								]
							})]
						})]
					}),
					detail !== void 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: SidebarPanel_module_css_default.items,
						children: detail.items.map((item) => (0, react_jsx_runtime.jsxs)("div", {
							className: SidebarPanel_module_css_default.itemRow,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: SidebarPanel_module_css_default.itemHost,
								children: item.sourceHost
							}), (0, react_jsx_runtime.jsx)("span", {
								className: SidebarPanel_module_css_default.itemStatus,
								"data-status": item.status,
								children: item.status
							})]
						}, item.id))
					}) : null,
					(0, react_jsx_runtime.jsx)("div", {
						className: SidebarPanel_module_css_default.rowActions,
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: SidebarPanel_module_css_default.publishButton,
							disabled: state.publishing !== null,
							onClick: () => {
								store.publish(batch.id);
							},
							children: publishing ? t("publishing") : t("publish")
						})
					})
				]
			});
		}
		function SidebarConsolePanel(props) {
			const { store, t } = props;
			const state = (0, react.useSyncExternalStore)((fn) => store.store.subscribe(fn), () => store.store.getSnapshot());
			const [query, setQuery] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				store.refresh();
				const timer = setInterval(() => {
					store.refresh();
				}, 3e4);
				return () => {
					clearInterval(timer);
				};
			}, [store]);
			const needle = query.trim().toLowerCase();
			const batches = needle === "" ? state.batches : state.batches.filter((batch) => batch.websiteHost.toLowerCase().includes(needle) || String(batch.id).includes(needle) || batch.websiteName.toLowerCase().includes(needle));
			const selectedVisible = batches.filter((batch) => state.selectedBatchIds.includes(batch.id)).length;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: SidebarPanel_module_css_default.panel,
				role: "region",
				"aria-label": t("title"),
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: SidebarPanel_module_css_default.toolbar,
						children: [(0, react_jsx_runtime.jsx)("input", {
							className: SidebarPanel_module_css_default.search,
							placeholder: t("search.placeholder"),
							value: query,
							onChange: (e) => {
								setQuery(e.target.value);
							}
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: SidebarPanel_module_css_default.toolButton,
							onClick: () => {
								store.refresh();
							},
							children: t("refresh")
						})]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: SidebarPanel_module_css_default.selectionBar,
						children: [(0, react_jsx_runtime.jsxs)("label", {
							className: SidebarPanel_module_css_default.selectAll,
							children: [(0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								className: SidebarPanel_module_css_default.checkbox,
								checked: batches.length > 0 && selectedVisible === batches.length,
								ref: (input) => {
									if (input !== null) input.indeterminate = selectedVisible > 0 && selectedVisible < batches.length;
								},
								disabled: batches.length === 0 || state.publishing !== null,
								onChange: (event) => {
									store.selectBatches(batches.map((batch) => batch.id), event.target.checked);
								}
							}), t("selection.allVisible")]
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: SidebarPanel_module_css_default.publishButton,
							disabled: state.selectedBatchIds.length === 0 || state.publishing !== null,
							onClick: () => {
								store.publishSelected();
							},
							children: state.publishing !== null ? t("publishing") : `${t("publish.selected")} (${String(state.selectedBatchIds.length)})`
						})]
					}),
					state.status === "loading" && state.batches.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
						className: SidebarPanel_module_css_default.note,
						children: t("loading")
					}) : null,
					state.error !== null ? (0, react_jsx_runtime.jsxs)("p", {
						className: SidebarPanel_module_css_default.error,
						role: "alert",
						children: [
							t("error"),
							"：",
							state.error
						]
					}) : null,
					state.status === "ready" && batches.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
						className: SidebarPanel_module_css_default.note,
						children: t("empty")
					}) : null,
					(0, react_jsx_runtime.jsx)("div", {
						className: SidebarPanel_module_css_default.list,
						children: batches.map((batch) => (0, react_jsx_runtime.jsx)(BatchRow, {
							...props,
							batch
						}, batch.id))
					})
				]
			});
		}
		// lib/types/client/console/locales.js
		/** `backlinksConsole` namespace dictionaries: the publish console's copy. */
		const zh$1 = {
			"sidebar.action": "发布批次",
			"title": "外链发布控制台",
			"subtitle": "选择批次一键发布，或展开查看条目明细",
			"refresh": "刷新",
			"close": "关闭",
			"publish": "发布",
			"publish.selected": "批量发布",
			"selection.batch": "选择批次",
			"selection.allVisible": "全选当前列表",
			"detail": "详情",
			"detail.hide": "收起",
			"publishing": "提交中…",
			"executing": "执行中",
			"counts.pending": "待发布",
			"counts.executed": "已执行",
			"counts.skipped": "已跳过",
			"counts.failed": "失败",
			"empty": "没有可发布的批次",
			"error": "操作失败",
			"retry": "重试",
			"loading": "加载中…",
			"search.placeholder": "搜索批次号或网站域名",
			"items.id": "条目",
			"items.status.pending": "待发布",
			"items.status.executed": "已执行",
			"items.status.skipped": "已跳过",
			"items.status.failed": "失败"
		};
		const en$1 = {
			"sidebar.action": "Publish Batches",
			"title": "Backlink Publish Console",
			"subtitle": "Pick a batch to publish in one click, or expand for item details",
			"refresh": "Refresh",
			"close": "Close",
			"publish": "Publish",
			"publish.selected": "Publish selected",
			"selection.batch": "Select batch",
			"selection.allVisible": "Select visible",
			"detail": "Details",
			"detail.hide": "Hide",
			"publishing": "Submitting…",
			"executing": "Executing",
			"counts.pending": "Pending",
			"counts.executed": "Executed",
			"counts.skipped": "Skipped",
			"counts.failed": "Failed",
			"empty": "No publishable batches",
			"error": "Operation failed",
			"retry": "Retry",
			"loading": "Loading…",
			"search.placeholder": "Search batch id or site host",
			"items.id": "Item",
			"items.status.pending": "Pending",
			"items.status.executed": "Executed",
			"items.status.skipped": "Skipped",
			"items.status.failed": "Failed"
		};
		// lib/types/client/settings/locales.js
		/** Locale bundles for the backlinks providers' settings pages. */
		const en = {
			supermanagerTitle: "Supermanager",
			supermanagerDescription: "Set up the backlink batch work source.",
			supermanagerBaseUrl: "Backend endpoint",
			supermanagerBaseUrlHint: "Production domain or a local dev instance; leave blank to keep the composed default.",
			supermanagerToken: "Agent token",
			supermanagerTokenHint: "Stored in the local settings file. Leave blank to keep the current token.",
			supermanagerTokenSet: "A token is configured.",
			supermanagerTokenUnset: "No token is configured; batches are unavailable until one is.",
			cloudMailTitle: "Cloud-mail",
			cloudMailDescription: "Set up the verification-mailbox provider.",
			cloudMailBaseUrl: "API endpoint",
			cloudMailBaseUrlHint: "Leave blank to keep the composed default.",
			cloudMailToken: "API token",
			cloudMailTokenHint: "Stored in the local settings file. Leave blank to keep the current token.",
			cloudMailTokenSet: "A token is configured.",
			cloudMailTokenUnset: "No token is configured; mailboxes are unavailable until one is.",
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			invalidNumber: "Enter a number, or leave blank to use the default."
		};
		const zh = {
			supermanagerTitle: "Supermanager",
			supermanagerDescription: "设置外链批次工作源。",
			supermanagerBaseUrl: "后端地址",
			supermanagerBaseUrlHint: "生产域名或本地开发实例；留空保持组合文件预置值。",
			supermanagerToken: "Agent 令牌",
			supermanagerTokenHint: "保存在本机设置文件里。留空表示保持当前令牌。",
			supermanagerTokenSet: "已配置令牌。",
			supermanagerTokenUnset: "未配置令牌；配置之前批次功能不可用。",
			cloudMailTitle: "Cloud-mail",
			cloudMailDescription: "设置验证邮箱提供方。",
			cloudMailBaseUrl: "接口地址",
			cloudMailBaseUrlHint: "留空保持组合文件预置值。",
			cloudMailToken: "接口令牌",
			cloudMailTokenHint: "保存在本机设置文件里。留空表示保持当前令牌。",
			cloudMailTokenSet: "已配置令牌。",
			cloudMailTokenUnset: "未配置令牌；配置之前邮箱功能不可用。",
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			invalidNumber: "请填数字；留空表示使用默认值。"
		};
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		// lib/types/client/settings/BacklinksCard.js
		function BacklinksProviderCard(props) {
			const { t, copy } = props;
			const state = props.useBacklinksCard((snapshot) => snapshot);
			if (props.view === "summary") return t(copy.description);
			const disabled = !state.writable;
			return (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsValueField, {
					id: `plugin-config-backlinks-base-url-${copy.title}`,
					label: t(copy.baseUrlLabel),
					hint: t(copy.baseUrlHint),
					overriddenLabel: t("overridden"),
					resetLabel: t("reset"),
					invalidLabel: t("invalidNumber"),
					disabled,
					...state.baseUrl,
					onEdit: (text) => {
						props.edit("baseUrl", text);
					},
					onReset: () => {
						props.resetField("baseUrl");
					}
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsSecretField, {
					id: `plugin-config-backlinks-token-${copy.title}`,
					label: t(copy.tokenLabel),
					hint: t(copy.tokenHint),
					disabled,
					text: state.token.text,
					configured: state.tokenConfigured,
					stateLabel: state.tokenConfigured ? t(copy.tokenSet) : t(copy.tokenUnset),
					onEdit: (text) => {
						props.edit("token", text);
					}
				})]
			});
		}
		const SUPERMANAGER_COPY = {
			title: "supermanagerTitle",
			description: "supermanagerDescription",
			baseUrlLabel: "supermanagerBaseUrl",
			baseUrlHint: "supermanagerBaseUrlHint",
			tokenLabel: "supermanagerToken",
			tokenHint: "supermanagerTokenHint",
			tokenSet: "supermanagerTokenSet",
			tokenUnset: "supermanagerTokenUnset"
		};
		const CLOUD_MAIL_COPY = {
			title: "cloudMailTitle",
			description: "cloudMailDescription",
			baseUrlLabel: "cloudMailBaseUrl",
			baseUrlHint: "cloudMailBaseUrlHint",
			tokenLabel: "cloudMailToken",
			tokenHint: "cloudMailTokenHint",
			tokenSet: "cloudMailTokenSet",
			tokenUnset: "cloudMailTokenUnset"
		};
		function SupermanagerCard(props) {
			return (0, react_jsx_runtime.jsx)(BacklinksProviderCard, {
				...props,
				copy: SUPERMANAGER_COPY
			});
		}
		function CloudMailCard(props) {
			return (0, react_jsx_runtime.jsx)(BacklinksProviderCard, {
				...props,
				copy: CLOUD_MAIL_COPY
			});
		}
		// lib/types/client/settings/backlinks-card-controller.js
		/**
		* Staged settings form controller over `backlinks-supermanager` / `backlinks-cloud-mail`.
		*/
		const BACKLINKS_SUPERMANAGER_NS = "backlinks-supermanager";
		const BACKLINKS_CLOUD_MAIL_NS = "backlinks-cloud-mail";
		var BacklinksCardController = class BacklinksCardController {
			describe;
			ns;
			form;
			store;
			unsubscribe;
			configured = false;
			constructor(scope, describe, ns) {
				this.describe = describe;
				this.ns = ns;
				this.form = new _deepseek_ai_dsh_client_ui_primitives.SettingsFormModel(scope, [(0, _deepseek_ai_dsh_client_ui_primitives.settingsTextField)("baseUrl")], [{
					field: "token",
					write: (text) => BacklinksCardController.writeToken(scope, text)
				}]);
				this.store = this.form.bind(() => this.projection());
				this.unsubscribe = describe.subscribe(() => {
					this.readConfigured();
				});
				this.readConfigured();
			}
			dispose() {
				this.unsubscribe();
				this.form.dispose();
			}
			projection() {
				return {
					...this.form.shell(),
					baseUrl: this.form.field("baseUrl"),
					token: this.form.field("token"),
					tokenConfigured: this.configured
				};
			}
			readConfigured() {
				const configured = (this.describe.getSnapshot().view?.namespaces.find((row) => row.ns === this.ns))?.secrets.some((slot) => slot.path[0] === "token" && slot.set) ?? false;
				if (configured === this.configured) return;
				this.configured = configured;
				this.store.set(this.projection());
			}
			inject() {
				return {
					hooks: { backlinksCard: this.store },
					...this.form.actions()
				};
			}
			static async writeToken(scope, value) {
				try {
					await scope.mutate([{
						op: "set",
						path: ["token"],
						value
					}]);
					return true;
				} catch {
					return false;
				}
			}
		};
		// lib/types/client/index.js
		/**
		* Unified Web/Desktop client entry for `@javawl/dsh-backlinks-bundle`:
		* 1. Dynamically mounts `TYPERT_REMOTE` (`backlinksConsole`) onto `ctx.remote.$mount(...)`
		*    without modifying `@deepseek-ai/dsh-api-remotes`.
		* 2. Registers the sidebar Publish Batches panel (`sidebar.panellist` + `main`).
		* 3. Registers the `Supermanager` and `Cloud-mail` settings cards into `plugins.item`.
		*/
		const CONSOLE_NS = "backlinksConsole";
		const SETTINGS_NS = "settings.backlinks";
		const PANEL_ID = "backlinks-console";
		const inject = [
			"remote",
			"slots",
			"locale"
		];
		function mountConsoleSurface(ctx) {
			ctx.effect(() => ctx.locale.register(CONSOLE_NS, {
				zh: zh$1,
				en: en$1
			}), "ui-backlinks-console: dictionaries");
			const t = ctx.locale.bind(CONSOLE_NS);
			const store = createConsoleStore(ctx);
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 25,
				locale: CONSOLE_NS,
				label: () => t("sidebar.action")
			}, BacklinksConsoleIcon));
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: CONSOLE_NS,
				inject: () => ({ store })
			}, (props) => SidebarConsolePanel(props)));
		}
		function mountCard(ctx, ns, id, title, Card) {
			const t = ctx.locale.bind(SETTINGS_NS);
			const card = new BacklinksCardController(ctx.configForms.get(ns), ctx.configForms.describe(), ns);
			ctx.effect(() => () => {
				card.dispose();
			}, `ui-settings-backlinks: ${id} form subscription`);
			ctx.effect(() => ctx.configForms.whileServed([ns], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
				name: "plugins.item",
				id,
				order: 30,
				label: () => t(title),
				locale: SETTINGS_NS,
				inject: () => card.inject()
			}, Card))), `ui-settings-backlinks: ${id} page`);
		}
		function mountSettingsSurface(ctx) {
			ctx.effect(() => ctx.locale.register(SETTINGS_NS, {
				zh,
				en
			}), "ui-settings-backlinks: dictionaries");
			mountCard(ctx, BACKLINKS_SUPERMANAGER_NS, "backlinks-supermanager", "supermanagerTitle", SupermanagerCard);
			mountCard(ctx, BACKLINKS_CLOUD_MAIL_NS, "backlinks-cloud-mail", "cloudMailTitle", CloudMailCard);
		}
		async function apply(ctx) {
			const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			const consoleFork = ctx.inject([
				"remote.backlinksConsole",
				"slots",
				"locale",
				"sessions",
				"workspaces",
				"uiWorkspace"
			], mountConsoleSurface);
			const settingsFork = ctx.inject([
				"slots",
				"locale",
				"configForms"
			], mountSettingsSurface);
			try {
				await Promise.all([consoleFork, settingsFork]);
			} catch (error) {
				await Promise.allSettled([settingsFork.dispose(), consoleFork.dispose()]);
				await disposeRemote();
				throw error;
			}
			return async () => {
				await Promise.allSettled([settingsFork.dispose(), consoleFork.dispose()]);
				await disposeRemote();
			};
		}
		exports.CONSOLE_NS = CONSOLE_NS;
		exports.PANEL_ID = PANEL_ID;
		exports.SETTINGS_NS = SETTINGS_NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map