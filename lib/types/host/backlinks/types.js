/**
 * Host-side provider interfaces and error class for `ctx.backlinks`.
 */
import { CodedError } from "../../shared/errors.js";
export class BacklinksError extends CodedError {
    retryAfterSeconds;
    constructor(message, code, retryAfterSeconds = null, options) {
        super(message, code, options);
        this.retryAfterSeconds = retryAfterSeconds;
    }
}
