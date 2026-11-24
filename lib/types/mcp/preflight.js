/**
 * Zero-LLM concurrent HTTP preflight & standard blocking-tag filter for
 * `backlinks action="batch_preflight"`.
 */
import { BacklinksError } from "../host/backlinks/types.js";
import { DEFAULT_PREFLIGHT_CONCURRENCY, DEFAULT_PREFLIGHT_TIMEOUT_MS, matchBlockingTags, } from "../host/backlinks/standards.js";
import { collectPublishedSourceIds, isPublishedItem } from "../host/backlinks/validation.js";
export const PREFLIGHT_HEAD_BYTES = 32_768;
export const PREFLIGHT_TAIL_BYTES = 65_536;
export const PREFLIGHT_FULL_READ_CAP_BYTES = 131_072;
export const PREFLIGHT_STREAM_SCAN_CAP_BYTES = 524_288;
const RETRY_5XX_DELAY_MS = 200;
const PARKING_HOST_SUFFIXES = [
    'sedoparking.com',
    'dan.com',
    'afternic.com',
    'hugedomains.com',
    'bodis.com',
    'parkingcrew.net',
    'sav.com',
    'above.com',
    'undeveloped.com',
];
const STRONG_DEAD_BODY_PATTERN = new RegExp([
    'vercel deployment paused',
    'this deployment is temporarily paused',
    'this deployment has been disabled',
    'suspendedpage\\.cgi',
    "there isn't a github pages site here",
    'heroku \\| no such app',
    'this account has been suspended',
    'website has been suspended',
    'site has been suspended',
    'netlify site not found',
].join('|'), 'iu');
const SHORT_OR_HEADER_DEAD_PATTERN = new RegExp([
    'account suspended',
    'domain for sale',
    'this domain is for sale',
    'buy this domain',
    'domain has expired',
    'this domain name has expired',
    'domain parking',
    'parked free, courtesy of',
].join('|'), 'iu');
const DNS_ERROR_PATTERN = /ENOTFOUND|EAI_AGAIN|EAI_NONAME|ERR_NAME_NOT_RESOLVED|getaddrinfo|NXDOMAIN/iu;
const TLS_ERROR_PATTERN = new RegExp([
    'ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
    'ERR_TLS_',
    'ERR_SSL_',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'HOSTNAME_MISMATCH',
    'EPROTO',
    'sslv3 alert',
    'tlsv1 alert',
    'wrong version number',
    'self-signed certificate',
    'certificate has expired',
].join('|'), 'iu');
const CONNECTION_ERROR_PATTERN = /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|socket hang up|ECONNABORTED/iu;
const TIMEOUT_ERROR_PATTERN = /TimeoutError|AbortError|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ETIMEDOUT|ERR_TIMED_OUT|timed out/iu;
function collectErrorDiagnostics(error, depth = 0, visited = new Set()) {
    if (error === undefined || error === null || depth > 5 || visited.has(error))
        return '';
    visited.add(error);
    if (typeof error !== 'object') {
        return String(error);
    }
    const parts = [];
    const record = error;
    for (const field of [record.name, record.code, record.errno, record.message]) {
        if (typeof field === 'string' || typeof field === 'number') {
            parts.push(String(field));
        }
    }
    if (record.cause !== undefined) {
        const nested = collectErrorDiagnostics(record.cause, depth + 1, visited);
        if (nested.length > 0)
            parts.push(nested);
    }
    if (Array.isArray(record.errors)) {
        for (const sub of record.errors) {
            const nested = collectErrorDiagnostics(sub, depth + 1, visited);
            if (nested.length > 0)
                parts.push(nested);
        }
    }
    return parts.join(' | ');
}
function classifyFetchError(error, timedOut) {
    const diag = collectErrorDiagnostics(error);
    if (timedOut || TIMEOUT_ERROR_PATTERN.test(diag)) {
        return { kind: 'retryable', reason: 'timeout', detail: diag.slice(0, 140) || 'request timed out' };
    }
    if (DNS_ERROR_PATTERN.test(diag)) {
        return { kind: 'dead', reason: 'dns_error', detail: diag.slice(0, 140) };
    }
    if (TLS_ERROR_PATTERN.test(diag)) {
        return { kind: 'dead', reason: 'tls_error', detail: diag.slice(0, 140) };
    }
    if (CONNECTION_ERROR_PATTERN.test(diag)) {
        return { kind: 'dead', reason: 'connection_error', detail: diag.slice(0, 140) };
    }
    return { kind: 'retryable', reason: 'network_error', detail: diag.slice(0, 140) || 'network error' };
}
function concatByteChunks(chunks, totalBytes) {
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}
/**
 * Read HTML body for preflight sniffing:
 * - Pages <= 128KB are read in full.
 * - Larger pages retain the first 32KB (head/meta/parked markers) + rolling
 *   last 64KB (footer `#commentform`, `wp-comments-post.php`, Typecho forms)
 *   up to a 512KB streaming scan cap.
 */
export async function readBoundedBodyText(response, options) {
    const headBytes = options?.headBytes ?? PREFLIGHT_HEAD_BYTES;
    const tailBytes = options?.tailBytes ?? PREFLIGHT_TAIL_BYTES;
    const fullReadCapBytes = options?.fullReadCapBytes ?? PREFLIGHT_FULL_READ_CAP_BYTES;
    const streamScanCapBytes = options?.streamScanCapBytes ?? PREFLIGHT_STREAM_SCAN_CAP_BYTES;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.length > 0
        && !/(text\/|application\/(xhtml|xml|json)|javascript)/iu.test(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        return '';
    }
    const body = response.body;
    if (body && typeof body.getReader === 'function') {
        const reader = body.getReader();
        let fullChunks = [];
        let headBuf;
        const tailChunks = [];
        let tailTotal = 0;
        let total = 0;
        const pushTail = (slice) => {
            if (slice.byteLength === 0)
                return;
            if (slice.byteLength >= tailBytes) {
                tailChunks.length = 0;
                tailChunks.push(slice.subarray(slice.byteLength - tailBytes));
                tailTotal = tailBytes;
                return;
            }
            tailChunks.push(slice);
            tailTotal += slice.byteLength;
            while (tailTotal > tailBytes && tailChunks.length > 0) {
                const excess = tailTotal - tailBytes;
                const first = tailChunks[0];
                if (first.byteLength <= excess) {
                    tailChunks.shift();
                    tailTotal -= first.byteLength;
                }
                else {
                    tailChunks[0] = first.subarray(excess);
                    tailTotal -= excess;
                }
            }
        };
        try {
            while (total < streamScanCapBytes) {
                const { done, value } = await reader.read();
                if (done || value === undefined)
                    break;
                const remaining = streamScanCapBytes - total;
                const slice = value.byteLength <= remaining ? value : value.subarray(0, remaining);
                total += slice.byteLength;
                if (fullChunks !== undefined) {
                    fullChunks.push(slice);
                    if (total > fullReadCapBytes) {
                        const mergedSoFar = concatByteChunks(fullChunks, total);
                        headBuf = mergedSoFar.slice(0, Math.min(headBytes, mergedSoFar.byteLength));
                        pushTail(mergedSoFar.slice(Math.max(0, mergedSoFar.byteLength - tailBytes)));
                        fullChunks = undefined;
                    }
                }
                else {
                    pushTail(slice);
                }
                if (total >= streamScanCapBytes) {
                    await reader.cancel().catch(() => undefined);
                    break;
                }
            }
        }
        catch {
            // Return whatever bytes were already buffered before stream interruption.
        }
        const decoder = new TextDecoder('utf-8', { fatal: false });
        if (fullChunks !== undefined) {
            return decoder.decode(concatByteChunks(fullChunks, total));
        }
        const headText = decoder.decode(headBuf ?? new Uint8Array(0));
        const tailText = decoder.decode(concatByteChunks(tailChunks, tailTotal));
        return `${headText}\n${tailText}`;
    }
    try {
        const text = await response.text();
        if (text.length <= fullReadCapBytes) {
            return text;
        }
        return `${text.slice(0, headBytes)}\n${text.slice(-tailBytes)}`;
    }
    catch {
        return '';
    }
}
function isKnownParkingHostname(hostname) {
    const lower = hostname.toLowerCase();
    return PARKING_HOST_SUFFIXES.some(suffix => lower === suffix || lower.endsWith(`.${suffix}`));
}
function extractTitleAndH1(html) {
    const parts = [];
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
    if (titleMatch?.[1])
        parts.push(titleMatch[1]);
    const h1Regex = /<h1[^>]*>([\s\S]*?)<\/h1>/giu;
    let match;
    while ((match = h1Regex.exec(html)) !== null) {
        if (match[1])
            parts.push(match[1]);
    }
    return parts.join(' ').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
}
function detectParkedOrSuspended(finalUrl, headers, body) {
    const vercelError = headers.get('x-vercel-error') ?? '';
    if (/DEPLOYMENT_(PAUSED|DISABLED|NOT_FOUND)/iu.test(vercelError)) {
        return `x-vercel-error: ${vercelError}`;
    }
    if (/suspendedpage\.cgi/iu.test(finalUrl)) {
        return 'redirected to suspendedpage.cgi';
    }
    try {
        const host = new URL(finalUrl).hostname;
        if (isKnownParkingHostname(host)) {
            return `parked host ${host}`;
        }
    }
    catch {
        // ignore invalid finalUrl string
    }
    const strongMatch = STRONG_DEAD_BODY_PATTERN.exec(body);
    if (strongMatch) {
        return strongMatch[0];
    }
    const headingText = extractTitleAndH1(body);
    const headingMatch = SHORT_OR_HEADER_DEAD_PATTERN.exec(headingText);
    if (headingMatch) {
        return headingMatch[0];
    }
    if (body.length < 8_000) {
        const shortMatch = SHORT_OR_HEADER_DEAD_PATTERN.exec(body.replace(/<[^>]+>/gu, ' '));
        if (shortMatch) {
            return shortMatch[0];
        }
    }
    return undefined;
}
const COMMENTS_CLOSED_HINT_PATTERN = /comments\s+are\s+closed|commenting\s+(?:is|has\s+been)\s+closed|comments\s+(?:have\s+been\s+)?disabled|评论已关闭|评论功能已关闭|已关闭评论/iu;
const DIRECTORY_URL_PATTERN = /\/(submit|add-site|add-tool|add-listing|submit-site|submit-tool|suggest)(?:[/?#]|$)/iu;
const SUBMIT_LINK_PATTERN = /<a\b[^>]*href\s*=\s*["'][^"']*\/submit(?:[/?#"']|$)/iu;
function hasNonSearchForm(body) {
    const formRegex = /<form\b([^>]*)>/giu;
    let match;
    while ((match = formRegex.exec(body)) !== null) {
        const attrs = match[1] ?? '';
        const isSearchRole = /\brole\s*=\s*["']search["']/iu.test(attrs);
        const isSearchAction = /\baction\s*=\s*["'][^"']*search[^"']*["']/iu.test(attrs);
        const isSearchIdent = /\b(?:id|class)\s*=\s*["'][^"']*search[^"']*["']/iu.test(attrs)
            && !/\bmethod\s*=\s*["']post["']/iu.test(attrs);
        if (!isSearchRole && !isSearchAction && !isSearchIdent) {
            return true;
        }
    }
    return false;
}
/** Extract a lightweight site-type hint from a single HTTP preflight response (0 Chrome cost). */
export function detectSiteHint(finalUrl, headers, body) {
    if (/wp-comments-post\.php/iu.test(body)
        || /\bid\s*=\s*["']commentform["']/iu.test(body)
        || (/<textarea\b[^>]*\bname\s*=\s*["']comment["']/iu.test(body) && /comment_post_ID|wp-content|wordpress/iu.test(body))) {
        return 'wordpress_comment';
    }
    if (/<meta\b[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["'][^"']*typecho/iu.test(body)
        || (/<textarea\b[^>]*\bname\s*=\s*["']text["']/iu.test(body) && /<input\b[^>]*\bname\s*=\s*["']mail["']/iu.test(body))
        || (/\bid\s*=\s*["']comment-form["']/iu.test(body) && /typecho|\bname\s*=\s*["']mail["']/iu.test(body))) {
        return 'typecho_comment';
    }
    if (headers.has('x-wix-request-id')
        || /wixstatic\.com|wix-warmup-data|_wixCIDX|static\.parastorage\.com/iu.test(body)) {
        return 'wix_blog';
    }
    const visibleText = body
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
        .replace(/<[^>]+>/gu, ' ')
        .replace(/\s+/gu, ' ');
    if (COMMENTS_CLOSED_HINT_PATTERN.test(visibleText)) {
        return 'comments_closed_hint';
    }
    if (DIRECTORY_URL_PATTERN.test(finalUrl) || SUBMIT_LINK_PATTERN.test(body) || hasNonSearchForm(body)) {
        return 'directory_or_form';
    }
    return 'other';
}
function normalizeHost(hostname) {
    return hostname.toLowerCase().replace(/^www\./u, '');
}
function detectGoRedirectHint(originalUrl, finalUrl) {
    const isGoPath = /(?:^|\/)go(?:\/|$)/iu.test(originalUrl.pathname);
    if (!isGoPath) {
        return { redirectedFromGo: false, crossHost: false };
    }
    let finalHost = normalizeHost(originalUrl.hostname);
    try {
        finalHost = normalizeHost(new URL(finalUrl).hostname);
    }
    catch {
        // keep original host
    }
    const origHost = normalizeHost(originalUrl.hostname);
    const crossHost = finalHost !== origHost;
    return {
        redirectedFromGo: true,
        crossHost,
        rootSubmitHint: `${originalUrl.origin}/`,
    };
}
const TIMEOUT_CLUSTER_SLUG_STOPWORDS = new Set([
    'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'as', 'is', 'it', 'or', 'be', 'do',
    'we', 'us', 'my', 'no', 'so', 'up', 'out', 'off', 'via', 'vs',
    'and', 'but', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'into', 'onto',
    'over', 'under', 'about', 'after', 'before', 'behind', 'between', 'through', 'your', 'our',
    'their', 'its', 'was', 'were', 'are', 'have', 'has', 'had', 'can', 'will',
    'how', 'why', 'what', 'when', 'where', 'who',
]);
function isSlugNoiseToken(token) {
    if (token.length <= 1)
        return true;
    if (/^\d+$/u.test(token))
        return true;
    return TIMEOUT_CLUSTER_SLUG_STOPWORDS.has(token);
}
/**
 * Group timed-out items sharing a common URL path prefix pattern (e.g. >= 3 items
 * matching `/nano-banana-pro-*` or `/blog/post/*`) or shared mid-slug multi-word
 * n-gram phrase (e.g. `/*nano-banana-pro*` merging `/nano-banana-pro-*` with
 * `/how-nano-banana-pro-*` and `/the-science-behind-nano-banana-pro/`) into
 * deduplicated `timeoutClusters`.
 */
export function detectTimeoutClusters(retryableItems, minClusterSize = 3) {
    const timedOut = retryableItems.filter(item => item.reason === 'timeout');
    if (timedOut.length < minClusterSize)
        return [];
    const groups = new Map();
    const addPattern = (pattern, item, specificity, kind) => {
        const existing = groups.get(pattern);
        if (existing) {
            if (!existing.items.some(i => i.id === item.id)) {
                existing.items.push(item);
            }
        }
        else {
            groups.set(pattern, { items: [item], specificity, kind });
        }
    };
    for (const item of timedOut) {
        let pathname = '';
        try {
            pathname = new URL(item.url).pathname.toLowerCase().replace(/\/+$/u, '');
        }
        catch {
            continue;
        }
        if (!pathname || pathname === '/')
            continue;
        const segments = pathname.split('/').filter(Boolean);
        if (segments.length === 0)
            continue;
        const lastIdx = segments.length - 1;
        const lastSeg = segments[lastIdx].replace(/\.(?:html?|php|aspx?)$/u, '');
        const dirPrefix = segments.length > 1 ? `/${segments.slice(0, lastIdx).join('/')}` : '';
        // 1. Hyphenated slug prefix patterns (e.g. `/nano-banana-pro-guide` -> `/nano-banana-pro-*`, `/nano-banana-*`).
        const hyphenTokens = lastSeg.split('-').filter(Boolean);
        if (hyphenTokens.length >= 3) {
            for (let len = hyphenTokens.length - 1; len >= 2; len--) {
                const prefixTokens = hyphenTokens.slice(0, len);
                const meaningfulCount = prefixTokens.filter(tok => !isSlugNoiseToken(tok)).length;
                if (meaningfulCount === 0)
                    continue;
                const prefix = prefixTokens.join('-');
                const pattern = `${dirPrefix}/${prefix}-*`;
                addPattern(pattern, item, 200 + len * 20 + pattern.length, 'prefix');
            }
        }
        else if (hyphenTokens.length === 2 && !isSlugNoiseToken(hyphenTokens[0])) {
            const pattern = `${dirPrefix}/${hyphenTokens[0]}-*`;
            addPattern(pattern, item, 180 + pattern.length, 'prefix');
        }
        // 2. Mid-slug contiguous multi-word n-gram patterns (2-4 tokens, boundary-filtered for stopwords/numbers)
        //    so `/how-nano-banana-pro-*` and `/the-science-behind-nano-banana-pro/` merge with `/nano-banana-pro-*`.
        for (const rawSegment of segments) {
            const cleanSegment = rawSegment.replace(/\.(?:html?|php|aspx?)$/u, '');
            const tokens = cleanSegment.split('-').filter(Boolean);
            if (tokens.length < 2)
                continue;
            const maxN = Math.min(4, tokens.length);
            for (let n = 2; n <= maxN; n++) {
                for (let start = 0; start <= tokens.length - n; start++) {
                    const slice = tokens.slice(start, start + n);
                    if (isSlugNoiseToken(slice[0]) || isSlugNoiseToken(slice[slice.length - 1]))
                        continue;
                    const meaningfulCount = slice.filter(tok => !isSlugNoiseToken(tok)).length;
                    if (meaningfulCount < 2)
                        continue;
                    const phrase = slice.join('-');
                    if (phrase.length < 5)
                        continue;
                    const pattern = `/*${phrase}*`;
                    addPattern(pattern, item, 150 + n * 20 + phrase.length, 'slug_ngram');
                }
            }
        }
        // 3. Multi-segment directory prefix patterns (e.g. `/tools/foo` -> `/tools/*`).
        if (segments.length >= 2) {
            const pattern = `/${segments.slice(0, -1).join('/')}/*`;
            addPattern(pattern, item, 50 + pattern.length, 'dir');
        }
    }
    const candidates = [...groups.entries()]
        .filter(([, entry]) => entry.items.length >= minClusterSize)
        .sort((a, b) => {
        if (b[1].items.length !== a[1].items.length)
            return b[1].items.length - a[1].items.length;
        return b[1].specificity - a[1].specificity;
    });
    const clusters = [];
    const assignedIds = new Set();
    for (const [pattern, entry] of candidates) {
        const remainingItems = entry.items.filter(item => !assignedIds.has(item.id));
        if (remainingItems.length < minClusterSize)
            continue;
        const ids = remainingItems.map(i => i.id);
        for (const id of ids)
            assignedIds.add(id);
        const hosts = [...new Set(remainingItems.map(i => i.host))];
        const kindLabel = entry.kind === 'slug_ngram' ? '路径关键词' : '路径前缀';
        clusters.push({
            pattern,
            count: ids.length,
            itemIds: ids,
            hosts,
            hint: `${ids.length} 条超时条目共享${kindLabel} ${pattern}，疑似同模板慢站/批量不可达，建议跳过或延后单独重试`,
        });
    }
    return clusters;
}
function detectWafProvider(headers, body) {
    const server = (headers.get('server') ?? '').toLowerCase();
    const via = (headers.get('via') ?? '').toLowerCase();
    if (headers.has('x-amz-cf-id')
        || headers.has('x-amz-cf-pop')
        || server.includes('cloudfront')
        || via.includes('cloudfront')
        || /generated by cloudfront/iu.test(body)) {
        return 'cloudfront';
    }
    if (headers.has('cf-ray')
        || headers.has('cf-mitigated')
        || server.includes('cloudflare')
        || /attention required!.*cloudflare|just a moment\.\.\./isu.test(body)) {
        return 'cloudflare';
    }
    return 'waf';
}
async function singleHttpProbe(url, timeoutMs, fetchImpl, outerSignal) {
    if (outerSignal?.aborted) {
        throw new BacklinksError('request aborted', 'BACKLINKS_ABORTED');
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const onOuterAbort = () => {
        controller.abort();
    };
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
        const response = await fetchImpl(url, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                'user-agent': 'Mozilla/5.0 (compatible; backlinks-preflight/1.0)',
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            signal: controller.signal,
        });
        const body = await readBoundedBodyText(response);
        return { response, body };
    }
    catch (error) {
        if (outerSignal?.aborted) {
            throw new BacklinksError('request aborted', 'BACKLINKS_ABORTED');
        }
        return { errorOutcome: classifyFetchError(error, timedOut) };
    }
    finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', onOuterAbort);
    }
}
async function probeItemUrl(url, timeoutMs, retry5xx, fetchImpl, sleepImpl, signal) {
    let parsed;
    try {
        parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('unsupported protocol');
        }
    }
    catch {
        return { kind: 'dead', reason: 'invalid_url', detail: `invalid URL "${url}"` };
    }
    for (let attempt = 0; attempt <= retry5xx; attempt++) {
        const attemptResult = await singleHttpProbe(parsed.toString(), timeoutMs, fetchImpl, signal);
        if (attemptResult.errorOutcome !== undefined) {
            return attemptResult.errorOutcome;
        }
        const response = attemptResult.response;
        const body = attemptResult.body ?? '';
        const finalUrl = response.url || parsed.toString();
        const goHint = detectGoRedirectHint(parsed, finalUrl);
        // Outbound `/go/` redirect landed on a third-party host: do not misclassify
        // the directory source itself as dead/WAF; surface `rootSubmitHint` instead.
        if (goHint.redirectedFromGo && goHint.crossHost) {
            return {
                kind: 'alive',
                httpStatus: response.status,
                siteHint: 'directory_or_form',
                redirectedFromGo: true,
                ...(goHint.rootSubmitHint === undefined ? {} : { rootSubmitHint: goHint.rootSubmitHint }),
            };
        }
        const parkedReason = detectParkedOrSuspended(finalUrl, response.headers, body);
        if (parkedReason !== undefined) {
            return {
                kind: 'dead',
                reason: 'parked_or_suspended',
                httpStatus: response.status,
                detail: parkedReason,
            };
        }
        if (response.status === 404) {
            return { kind: 'dead', reason: 'http_404', httpStatus: 404 };
        }
        if (response.status === 410) {
            return { kind: 'dead', reason: 'http_410', httpStatus: 410 };
        }
        if (response.status >= 500 && response.status <= 599) {
            if (attempt < retry5xx) {
                await sleepImpl(RETRY_5XX_DELAY_MS, signal);
                continue;
            }
            return {
                kind: 'dead',
                reason: 'http_5xx_persistent',
                httpStatus: response.status,
            };
        }
        if (response.status === 403) {
            return {
                kind: 'waf_403',
                provider: detectWafProvider(response.headers, body),
            };
        }
        if (response.status === 408) {
            return { kind: 'retryable', reason: 'http_408', httpStatus: 408 };
        }
        if (response.status === 429) {
            return { kind: 'retryable', reason: 'http_429', httpStatus: 429 };
        }
        return {
            kind: 'alive',
            httpStatus: response.status,
            siteHint: detectSiteHint(finalUrl, response.headers, body),
            ...(goHint.redirectedFromGo ? { redirectedFromGo: true } : {}),
            ...(goHint.rootSubmitHint === undefined ? {} : { rootSubmitHint: goHint.rootSubmitHint }),
        };
    }
    return { kind: 'retryable', reason: 'network_error', detail: 'probe exhausted' };
}
const PREFLIGHT_SKIP_CHUNK_SIZE = 100;
function isLeaseRequiredError(error) {
    if (!(error instanceof BacklinksError))
        return false;
    return (error.code === 'BACKLINKS_CONFLICT'
        || error.code === 'BACKLINKS_INVALID_REQUEST'
        || /lease/iu.test(error.message));
}
function isUnsupportedEndpointError(error) {
    if (!(error instanceof BacklinksError))
        return false;
    return (error.code === 'BACKLINKS_NOT_FOUND'
        || (error.code === 'BACKLINKS_API_ERROR' && error.message.includes('HTTP 405')));
}
async function applyLegacyAutoSkips(batchSource, batchId, entries, signal) {
    if (entries.length === 0) {
        return { skippedDeadItemIds: [], skippedTaggedItemIds: [], taggedSourceIds: [], errors: [] };
    }
    const skippedDeadItemIds = [];
    const skippedTaggedItemIds = [];
    const deadSourceIds = new Set();
    const taggedSourceIds = [];
    const errors = [];
    const recordSkipSuccess = (entry) => {
        if (entry.kind === 'dead') {
            skippedDeadItemIds.push(entry.itemId);
            deadSourceIds.add(entry.sourceId);
        }
        else {
            skippedTaggedItemIds.push(entry.itemId);
        }
    };
    let startLeaseAt;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        try {
            await batchSource.reportItemResult(entry.itemId, { status: 'skipped', skipReason: entry.skipReason }, signal);
            recordSkipSuccess(entry);
        }
        catch (error) {
            if (signal?.aborted)
                throw error;
            if (isLeaseRequiredError(error)) {
                startLeaseAt = i;
                break;
            }
            errors.push({
                itemId: entry.itemId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (startLeaseAt !== undefined) {
        const remaining = entries.slice(startLeaseAt);
        const remainingIds = remaining.map(entry => entry.itemId);
        let leaseId;
        try {
            const claim = await batchSource.claim(batchId, remainingIds, signal);
            leaseId = claim.leaseId;
            const claimedIds = new Set(claim.items.map(item => item.id));
            for (const entry of remaining) {
                if (claimedIds.size > 0 && !claimedIds.has(entry.itemId)) {
                    errors.push({ itemId: entry.itemId, error: 'item was not included in ephemeral preflight lease' });
                    continue;
                }
                try {
                    await batchSource.reportItemResult(entry.itemId, { status: 'skipped', skipReason: entry.skipReason }, signal);
                    recordSkipSuccess(entry);
                }
                catch (error) {
                    if (signal?.aborted)
                        throw error;
                    errors.push({
                        itemId: entry.itemId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
        catch (error) {
            if (signal?.aborted)
                throw error;
            const message = error instanceof Error ? error.message : String(error);
            for (const entry of remaining) {
                errors.push({ itemId: entry.itemId, error: `ephemeral claim failed: ${message}` });
            }
        }
        finally {
            if (leaseId !== undefined) {
                await batchSource.release(leaseId, signal).catch(() => undefined);
            }
        }
    }
    for (const sourceId of deadSourceIds) {
        try {
            await batchSource.tagSource(sourceId, ['dead_site'], signal);
            taggedSourceIds.push(sourceId);
        }
        catch (error) {
            if (signal?.aborted)
                throw error;
            const relatedItem = entries.find(entry => entry.kind === 'dead' && entry.sourceId === sourceId);
            errors.push({
                itemId: relatedItem?.itemId ?? sourceId,
                error: `tagSource dead_site failed for source ${sourceId}: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }
    return { skippedDeadItemIds, skippedTaggedItemIds, taggedSourceIds, errors };
}
async function applyAutoSkips(batchSource, batchId, entries, signal) {
    if (entries.length === 0) {
        return {
            mode: batchSource.preflightSkip ? 'preflight_skip_api' : 'legacy_fallback',
            skippedDeadItemIds: [],
            skippedTaggedItemIds: [],
            unchangedCount: 0,
            taggedSourceIds: [],
            errors: [],
        };
    }
    if (typeof batchSource.preflightSkip === 'function') {
        const skippedDeadItemIds = [];
        const skippedTaggedItemIds = [];
        const taggedSourceIds = new Set();
        const errors = [];
        let unchangedCount = 0;
        for (let offset = 0; offset < entries.length; offset += PREFLIGHT_SKIP_CHUNK_SIZE) {
            const chunk = entries.slice(offset, offset + PREFLIGHT_SKIP_CHUNK_SIZE);
            const payload = chunk.map(entry => ({
                itemId: entry.itemId,
                skipReason: entry.skipReason,
                ...(entry.kind === 'dead' ? { tags: ['dead_site'] } : {}),
            }));
            try {
                const res = await batchSource.preflightSkip(batchId, payload, signal);
                unchangedCount += res.unchangedCount;
                const entryById = new Map(chunk.map(entry => [entry.itemId, entry]));
                if (res.results.length > 0) {
                    for (const itemRes of res.results) {
                        const matched = entryById.get(itemRes.itemId);
                        if (itemRes.itemStatus === 'skipped' && itemRes.changed) {
                            if (matched?.kind === 'dead')
                                skippedDeadItemIds.push(itemRes.itemId);
                            else
                                skippedTaggedItemIds.push(itemRes.itemId);
                        }
                        if (itemRes.attachedTags.length > 0) {
                            taggedSourceIds.add(itemRes.sourceId);
                        }
                    }
                }
                else {
                    for (const entry of chunk) {
                        if (entry.kind === 'dead') {
                            skippedDeadItemIds.push(entry.itemId);
                            taggedSourceIds.add(entry.sourceId);
                        }
                        else {
                            skippedTaggedItemIds.push(entry.itemId);
                        }
                    }
                }
            }
            catch (error) {
                if (signal?.aborted)
                    throw error;
                if (isUnsupportedEndpointError(error)) {
                    const fallback = await applyLegacyAutoSkips(batchSource, batchId, entries.slice(offset), signal);
                    for (const id of fallback.skippedDeadItemIds)
                        skippedDeadItemIds.push(id);
                    for (const id of fallback.skippedTaggedItemIds)
                        skippedTaggedItemIds.push(id);
                    for (const sid of fallback.taggedSourceIds)
                        taggedSourceIds.add(sid);
                    for (const err of fallback.errors)
                        errors.push(err);
                    return {
                        mode: 'legacy_fallback',
                        skippedDeadItemIds,
                        skippedTaggedItemIds,
                        unchangedCount,
                        taggedSourceIds: [...taggedSourceIds],
                        downgradeNotice: 'Supermanager returned 404/405 for /preflight-skip; downgraded to legacy item_result/ephemeral lease flow.',
                        errors,
                    };
                }
                const message = error instanceof Error ? error.message : String(error);
                for (const entry of chunk) {
                    errors.push({ itemId: entry.itemId, error: message });
                }
                if (error instanceof BacklinksError && error.code === 'BACKLINKS_CONFLICT') {
                    for (const entry of entries.slice(offset + PREFLIGHT_SKIP_CHUNK_SIZE)) {
                        errors.push({ itemId: entry.itemId, error: message });
                    }
                    break;
                }
            }
        }
        return {
            mode: 'preflight_skip_api',
            skippedDeadItemIds,
            skippedTaggedItemIds,
            unchangedCount,
            taggedSourceIds: [...taggedSourceIds],
            errors,
        };
    }
    const legacy = await applyLegacyAutoSkips(batchSource, batchId, entries, signal);
    return {
        mode: 'legacy_fallback',
        skippedDeadItemIds: legacy.skippedDeadItemIds,
        skippedTaggedItemIds: legacy.skippedTaggedItemIds,
        unchangedCount: 0,
        taggedSourceIds: legacy.taggedSourceIds,
        errors: legacy.errors,
    };
}
async function applyAutoFailWaf(batchSource, batchId, entries, signal) {
    if (entries.length === 0) {
        return { failedItemIds: [], taggedSourceIds: [], errors: [] };
    }
    const failedItemIds = [];
    const taggedSourceIds = [];
    const errors = [];
    let startLeaseAt;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        try {
            await batchSource.reportItemResult(entry.itemId, { status: 'failed', failureMode: 'manual_required', failureReason: entry.failureReason }, signal);
            failedItemIds.push(entry.itemId);
        }
        catch (error) {
            if (signal?.aborted)
                throw error;
            if (isLeaseRequiredError(error)) {
                startLeaseAt = i;
                break;
            }
            errors.push({
                itemId: entry.itemId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (startLeaseAt !== undefined) {
        const remaining = entries.slice(startLeaseAt);
        const remainingIds = remaining.map(entry => entry.itemId);
        let leaseId;
        try {
            const claim = await batchSource.claim(batchId, remainingIds, signal);
            leaseId = claim.leaseId;
            const claimedIds = new Set(claim.items.map(item => item.id));
            for (const entry of remaining) {
                if (claimedIds.size > 0 && !claimedIds.has(entry.itemId)) {
                    errors.push({ itemId: entry.itemId, error: 'item was not included in ephemeral preflight lease' });
                    continue;
                }
                try {
                    await batchSource.reportItemResult(entry.itemId, { status: 'failed', failureMode: 'manual_required', failureReason: entry.failureReason }, signal);
                    failedItemIds.push(entry.itemId);
                }
                catch (error) {
                    if (signal?.aborted)
                        throw error;
                    errors.push({
                        itemId: entry.itemId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
        catch (error) {
            if (signal?.aborted)
                throw error;
            const message = error instanceof Error ? error.message : String(error);
            for (const entry of remaining) {
                errors.push({ itemId: entry.itemId, error: `ephemeral claim failed: ${message}` });
            }
        }
        finally {
            if (leaseId !== undefined) {
                await batchSource.release(leaseId, signal).catch(() => undefined);
            }
        }
    }
    const tagSourceIds = new Set();
    for (const entry of entries) {
        if (entry.needsTag)
            tagSourceIds.add(entry.sourceId);
    }
    for (const sourceId of tagSourceIds) {
        try {
            await batchSource.tagSource(sourceId, ['waf_403'], signal);
            taggedSourceIds.push(sourceId);
        }
        catch (error) {
            if (signal?.aborted)
                throw error;
            const relatedItem = entries.find(entry => entry.needsTag && entry.sourceId === sourceId);
            errors.push({
                itemId: relatedItem?.itemId ?? sourceId,
                error: `tagSource waf_403 failed for source ${sourceId}: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }
    return { failedItemIds, taggedSourceIds, errors };
}
function formatDeadSkipReason(dead) {
    const details = [dead.reason, ...(dead.httpStatus === undefined ? [] : [`HTTP ${dead.httpStatus}`])];
    if (dead.detail !== undefined && dead.detail.length > 0 && dead.reason === 'parked_or_suspended') {
        details.push(dead.detail.slice(0, 60));
    }
    return `预检不可用(${details.join(', ')})`;
}
export async function runBatchPreflight(batchSource, detail, options, signal) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
    const concurrency = options.concurrency ?? DEFAULT_PREFLIGHT_CONCURRENCY;
    const autoSkip = options.autoSkip === true;
    const autoSkipTagged = options.autoSkipTagged === true;
    const autoFailWaf = options.autoFailWaf === true;
    const retry5xx = options.retry5xx ?? 1;
    const publishedSourceIds = collectPublishedSourceIds(detail.items);
    const publishedSourceSet = new Set(publishedSourceIds);
    const pendingItems = detail.items.filter(item => item.status === 'pending');
    const requestedSet = options.itemIds === undefined ? undefined : new Set(options.itemIds);
    const candidates = requestedSet === undefined
        ? pendingItems
        : pendingItems.filter(item => requestedSet.has(item.id));
    const alreadyPublishedItemIds = [];
    const taggedBlocked = [];
    const heldForManual = [];
    const probeQueue = [];
    for (const item of candidates) {
        if (isPublishedItem(item) || publishedSourceSet.has(item.sourceId)) {
            alreadyPublishedItemIds.push(item.id);
            continue;
        }
        const combinedTags = [
            ...item.tags,
            ...(item.sourceTags ?? []),
            ...(item.blockingTags ?? []),
        ];
        const tagMatch = matchBlockingTags(combinedTags, options.skipTags);
        if (tagMatch.matchedSkipTags.length > 0) {
            taggedBlocked.push({
                id: item.id,
                sourceId: item.sourceId,
                host: item.sourceHost,
                matchedTags: tagMatch.matchedSkipTags,
            });
            continue;
        }
        const heldSoftTags = options.skipSoftTagged === true
            ? tagMatch.soft
            : options.skipSoftTagged === false
                ? []
                : tagMatch.soft.filter(tag => tag === 'waf_403');
        if (heldSoftTags.length > 0) {
            heldForManual.push({
                id: item.id,
                sourceId: item.sourceId,
                host: item.sourceHost,
                matchedTags: heldSoftTags,
                reason: heldSoftTags.includes('waf_403') ? 'already_tagged_waf_403' : 'already_tagged_soft_block',
            });
            continue;
        }
        const targetUrl = item.submitUrl !== null && item.submitUrl.trim().length > 0
            ? item.submitUrl.trim()
            : item.sourceUrl.trim();
        probeQueue.push({ item, url: targetUrl, softTags: tagMatch.soft });
    }
    const probeOutcomes = new Array(probeQueue.length);
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, probeQueue.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
            if (signal?.aborted) {
                throw new BacklinksError('request aborted', 'BACKLINKS_ABORTED');
            }
            const index = nextIndex++;
            if (index >= probeQueue.length)
                break;
            const target = probeQueue[index];
            probeOutcomes[index] = await probeItemUrl(target.url, timeoutMs, retry5xx, options.fetchImpl, options.sleepImpl, signal);
        }
    }));
    const runnableItemIds = [];
    const runnableItems = [];
    const cautionItems = [];
    const deadItems = [];
    const wafBlocked = [];
    const retryableItems = [];
    for (let i = 0; i < probeQueue.length; i++) {
        const { item, url, softTags } = probeQueue[i];
        const outcome = probeOutcomes[i];
        switch (outcome.kind) {
            case 'alive':
                runnableItemIds.push(item.id);
                runnableItems.push({
                    itemId: item.id,
                    domain: item.sourceHost,
                    siteHint: outcome.siteHint,
                    ...(outcome.redirectedFromGo ? { redirectedFromGo: true } : {}),
                    ...(outcome.rootSubmitHint === undefined ? {} : { rootSubmitHint: outcome.rootSubmitHint }),
                });
                if (softTags.length > 0) {
                    cautionItems.push({
                        id: item.id,
                        sourceId: item.sourceId,
                        host: item.sourceHost,
                        tags: softTags,
                    });
                }
                break;
            case 'dead':
                deadItems.push({
                    id: item.id,
                    sourceId: item.sourceId,
                    host: item.sourceHost,
                    url,
                    reason: outcome.reason,
                    ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
                    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
                });
                break;
            case 'waf_403':
                wafBlocked.push({
                    id: item.id,
                    sourceId: item.sourceId,
                    host: item.sourceHost,
                    url,
                    httpStatus: 403,
                    provider: outcome.provider,
                });
                break;
            case 'retryable':
                retryableItems.push({
                    id: item.id,
                    sourceId: item.sourceId,
                    host: item.sourceHost,
                    url,
                    reason: outcome.reason,
                    ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
                    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
                });
                break;
        }
    }
    const autoSkipEntries = [];
    if (autoSkip) {
        for (const dead of deadItems) {
            autoSkipEntries.push({
                itemId: dead.id,
                sourceId: dead.sourceId,
                skipReason: formatDeadSkipReason(dead),
                kind: 'dead',
            });
        }
    }
    if (autoSkipTagged) {
        for (const tagged of taggedBlocked) {
            autoSkipEntries.push({
                itemId: tagged.id,
                sourceId: tagged.sourceId,
                skipReason: `预检命中已有硬阻断标签: ${tagged.matchedTags.join(', ')}`,
                kind: 'tagged',
            });
        }
    }
    const skipEffect = await applyAutoSkips(batchSource, detail.batch.id, autoSkipEntries, signal);
    const totalAutoSkipped = skipEffect.skippedDeadItemIds.length + skipEffect.skippedTaggedItemIds.length;
    const combinedSkippedIds = [...skipEffect.skippedDeadItemIds, ...skipEffect.skippedTaggedItemIds];
    const wafFailEntries = [];
    if (autoFailWaf) {
        for (const waf of wafBlocked) {
            wafFailEntries.push({
                itemId: waf.id,
                sourceId: waf.sourceId,
                failureReason: `预检命中 WAF 403 拦截(${waf.provider})，需人工处理`,
                needsTag: true,
            });
        }
        for (const held of heldForManual) {
            if (held.matchedTags.includes('waf_403')) {
                wafFailEntries.push({
                    itemId: held.id,
                    sourceId: held.sourceId,
                    failureReason: '预检命中已有 waf_403 标签，避免重复入队，需人工处理',
                    needsTag: false,
                });
            }
        }
    }
    const wafFailEffect = await applyAutoFailWaf(batchSource, detail.batch.id, wafFailEntries, signal);
    const hardItemIds = taggedBlocked.map(entry => entry.id);
    const softItemIds = heldForManual.map(entry => entry.id);
    const timeoutClusters = detectTimeoutClusters(retryableItems);
    const summary = `preflight batch ${detail.batch.id}: ${runnableItemIds.length} runnable, ${deadItems.length} dead, ${taggedBlocked.length} tagged-blocked, ${wafBlocked.length} waf_403, ${retryableItems.length} retryable`
        + (heldForManual.length > 0 ? `, ${heldForManual.length} held-manual` : '')
        + (timeoutClusters.length > 0 ? `, ${timeoutClusters.length} timeout-cluster(s)` : '')
        + ` (auto-skipped ${totalAutoSkipped}`
        + (wafFailEffect.failedItemIds.length > 0 ? `, auto-failed-waf ${wafFailEffect.failedItemIds.length}` : '')
        + ')';
    return {
        summary,
        skippedDeadItemIds: skipEffect.skippedDeadItemIds,
        skippedTaggedItemIds: skipEffect.skippedTaggedItemIds,
        failedWafItemIds: wafFailEffect.failedItemIds,
        data: {
            batchId: detail.batch.id,
            batchName: detail.batch.name,
            counts: {
                totalItems: detail.items.length,
                pendingItems: pendingItems.length,
                considered: candidates.length,
                alreadyPublished: alreadyPublishedItemIds.length,
                taggedBlocked: taggedBlocked.length,
                heldForManual: heldForManual.length,
                probed: probeQueue.length,
                runnable: runnableItemIds.length,
                dead: deadItems.length,
                wafBlocked: wafBlocked.length,
                retryable: retryableItems.length,
                autoSkipped: totalAutoSkipped,
                autoFailedWaf: wafFailEffect.failedItemIds.length,
            },
            publishedSourceIds,
            runnableItemIds,
            runnableItems,
            ...(cautionItems.length > 0 ? { cautionItems } : {}),
            ...(taggedBlocked.length > 0 ? { taggedBlocked } : {}),
            ...(heldForManual.length > 0 ? { heldForManual } : {}),
            ...(hardItemIds.length > 0 || softItemIds.length > 0
                ? { skippedByTag: { hardItemIds, softItemIds } }
                : {}),
            ...(deadItems.length > 0 ? { deadItems } : {}),
            ...(wafBlocked.length > 0 ? { wafBlocked } : {}),
            ...(retryableItems.length > 0 ? { retryableItems } : {}),
            ...(timeoutClusters.length > 0 ? { timeoutClusters } : {}),
            ...(alreadyPublishedItemIds.length > 0 ? { alreadyPublishedItemIds } : {}),
            ...(autoSkip || autoSkipTagged
                ? {
                    autoSkipResult: {
                        mode: skipEffect.mode,
                        skippedItemIds: combinedSkippedIds,
                        ...(skipEffect.unchangedCount > 0 ? { unchangedCount: skipEffect.unchangedCount } : {}),
                        ...(skipEffect.taggedSourceIds.length > 0 ? { taggedSourceIds: skipEffect.taggedSourceIds } : {}),
                        ...(skipEffect.downgradeNotice === undefined ? {} : { downgradeNotice: skipEffect.downgradeNotice }),
                        ...(skipEffect.errors.length > 0 ? { errors: skipEffect.errors } : {}),
                    },
                }
                : {}),
            ...(autoFailWaf
                ? {
                    autoFailWafResult: {
                        failedItemIds: wafFailEffect.failedItemIds,
                        ...(wafFailEffect.taggedSourceIds.length > 0 ? { taggedSourceIds: wafFailEffect.taggedSourceIds } : {}),
                        ...(wafFailEffect.errors.length > 0 ? { errors: wafFailEffect.errors } : {}),
                    },
                }
                : {}),
        },
    };
}
