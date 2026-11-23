/**
 * Environment configuration, cross-platform home-path expansion, and secret
 * redaction helpers for the `backlinks-publisher` Stdio MCP Server.
 */
import { homedir } from 'node:os';
import path from 'node:path';
export const DEFAULT_CLOUDMAIL_BASE_URL = 'https://mail.screwdom.org/api';
export const DEFAULT_MAX_OUTPUT_CHARS = 16_000;
export const DEFAULT_NAVIGATE_MAX_CHARS = 3_000;
export const DEFAULT_BROWSER_TIMEOUT_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const PLACEHOLDER_PATTERNS = [
    /^<[^>]+>$/u,
    /^REPLACE_WITH_/iu,
    /YOUR_[A-Z0-9_]+/u,
];
export function isPlaceholderValue(value) {
    if (typeof value !== 'string')
        return true;
    const trimmed = value.trim();
    if (trimmed.length === 0)
        return true;
    return PLACEHOLDER_PATTERNS.some(pattern => pattern.test(trimmed));
}
export function expandHomePath(raw, homeDir = homedir(), pathImpl = path) {
    const trimmed = raw.trim();
    if (trimmed === '~')
        return homeDir;
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        const rest = trimmed.slice(2).split(/[\\/]+/u).filter(Boolean);
        return rest.length === 0 ? homeDir : pathImpl.join(homeDir, ...rest);
    }
    return trimmed;
}
function readTrimmed(env, key, fallback = '') {
    const raw = env[key];
    return typeof raw === 'string' ? raw.trim() : fallback;
}
function readPositiveIntEnv(env, key, fallback) {
    const raw = readTrimmed(env, key);
    if (raw.length === 0)
        return fallback;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${key} must be a positive integer, got "${raw}"`);
    }
    return parsed;
}
function readBooleanEnv(env, key, fallback) {
    const raw = readTrimmed(env, key).toLowerCase();
    if (raw.length === 0)
        return fallback;
    if (raw === 'true' || raw === '1' || raw === 'yes')
        return true;
    if (raw === 'false' || raw === '0' || raw === 'no')
        return false;
    throw new Error(`${key} must be a boolean (true/false/1/0), got "${raw}"`);
}
export function resolveMcpConfig(env = process.env, options = {}) {
    const homeDir = options.homeDir ?? homedir();
    const pathImpl = options.pathImpl ?? path;
    const rawProfile = readTrimmed(env, 'DSH_BACKLINK_BROWSER_PROFILE');
    const browserProfileDir = rawProfile.length > 0 && !isPlaceholderValue(rawProfile)
        ? expandHomePath(rawProfile, homeDir, pathImpl)
        : pathImpl.join(homeDir, '.dsh', 'backlink-browser-profile');
    const rawWindowPos = readTrimmed(env, 'BACKLINKS_BROWSER_WINDOW_POSITION');
    const normalizedWindowPos = rawWindowPos.toLowerCase();
    const browserWindowPosition = rawWindowPos.length === 0
        || normalizedWindowPos === 'visible'
        || normalizedWindowPos === 'none'
        || isPlaceholderValue(rawWindowPos)
        ? undefined
        : rawWindowPos;
    const rawExecutablePath = readTrimmed(env, 'BACKLINKS_BROWSER_EXECUTABLE_PATH');
    const browserExecutablePath = rawExecutablePath.length > 0 && !isPlaceholderValue(rawExecutablePath)
        ? expandHomePath(rawExecutablePath, homeDir, pathImpl)
        : undefined;
    const cloudMailBaseUrl = readTrimmed(env, 'CLOUDMAIL_BASE_URL');
    const browserChannel = readTrimmed(env, 'BACKLINKS_BROWSER_CHANNEL');
    return {
        supermanagerBaseUrl: readTrimmed(env, 'SUPERMANAGER_BASE_URL'),
        supermanagerToken: readTrimmed(env, 'SUPERMANAGER_TOKEN'),
        supermanagerTimeoutMs: readPositiveIntEnv(env, 'SUPERMANAGER_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
        cloudMailBaseUrl: cloudMailBaseUrl.length > 0 ? cloudMailBaseUrl : DEFAULT_CLOUDMAIL_BASE_URL,
        cloudMailToken: readTrimmed(env, 'CLOUDMAIL_TOKEN'),
        cloudMailTimeoutMs: readPositiveIntEnv(env, 'CLOUDMAIL_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
        browserProfileDir,
        maxOutputChars: readPositiveIntEnv(env, 'BACKLINKS_MAX_OUTPUT_CHARS', DEFAULT_MAX_OUTPUT_CHARS),
        navigateMaxChars: readPositiveIntEnv(env, 'BACKLINKS_NAVIGATE_MAX_CHARS', DEFAULT_NAVIGATE_MAX_CHARS),
        browserHeadless: readBooleanEnv(env, 'BACKLINKS_BROWSER_HEADLESS', false),
        browserChannel: browserChannel.length > 0 ? browserChannel : 'chrome',
        browserTimeoutMs: readPositiveIntEnv(env, 'BACKLINKS_BROWSER_TIMEOUT_MS', DEFAULT_BROWSER_TIMEOUT_MS),
        browserWindowPosition,
        browserExecutablePath,
    };
}
export function redactSecrets(text, config) {
    let out = text;
    for (const token of [config.supermanagerToken, config.cloudMailToken]) {
        if (token.length > 0 && !isPlaceholderValue(token)) {
            out = out.split(token).join('[REDACTED]');
        }
    }
    return out;
}
