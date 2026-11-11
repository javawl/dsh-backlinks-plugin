/**
 * Host-side provider interfaces and error class for `ctx.backlinks`.
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
export class BacklinksError extends HarnessError {
    retryAfterSeconds;
    constructor(message, code, retryAfterSeconds = null, options) {
        super(message, code, options);
        this.retryAfterSeconds = retryAfterSeconds;
    }
}
