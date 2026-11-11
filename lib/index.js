import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
// lib/types/host/index.js
/**
* Package root Host entry: mounts `BacklinksConsoleRuntime` (`ctx.backlinksConsole`)
* over `ctx.backlinks` while the Web/Desktop half of the same root entry loads `./client`.
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
const inject = ["backlinks"];
let BacklinksConsoleRuntime = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _batches_decorators;
	let _batch_decorators;
	return class BacklinksConsoleRuntime extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_batches_decorators = [Remote];
			_batch_decorators = [Remote];
			__esDecorate(this, null, _batches_decorators, {
				kind: "method",
				name: "batches",
				static: false,
				private: false,
				access: {
					has: (obj) => "batches" in obj,
					get: (obj) => obj.batches
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _batch_decorators, {
				kind: "method",
				name: "batch",
				static: false,
				private: false,
				access: {
					has: (obj) => "batch" in obj,
					get: (obj) => obj.batch
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = ["backlinks"];
		constructor(ctx) {
			super(ctx, "backlinksConsole");
			__runInitializers(this, _instanceExtraInitializers);
		}
		async batches() {
			return await this.ctx.backlinks.listBatches();
		}
		async batch(batchId) {
			return await this.ctx.backlinks.getBatch(batchId);
		}
	};
})();
export { BacklinksConsoleRuntime, BacklinksConsoleRuntime as default, inject };
