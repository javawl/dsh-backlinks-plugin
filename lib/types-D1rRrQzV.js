import { t as CodedError } from "./errors-DOUm_tGk.js";
// lib/types/host/backlinks/types.js
/**
* Host-side provider interfaces and error class for `ctx.backlinks`.
*/
var BacklinksError = class extends CodedError {
	retryAfterSeconds;
	constructor(message, code, retryAfterSeconds = null, options) {
		super(message, code, options);
		this.retryAfterSeconds = retryAfterSeconds;
	}
};
export { BacklinksError as t };
