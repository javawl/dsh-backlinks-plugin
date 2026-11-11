/**
 * Vocabulary for the browser automation capability seam (`ctx.browser`).
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

export type BrowserCommand =
  | BrowserNavigateCommand
  | BrowserSnapshotCommand
  | BrowserBringToFrontCommand
  | BrowserClickCommand
  | BrowserFillCommand
  | BrowserSelectCommand
  | BrowserPressCommand
  | BrowserUploadCommand
  | BrowserScreenshotCommand
  | BrowserWaitForCommand
  | BrowserClosePageCommand

export interface BrowserPageAddress {
  readonly page?: string
}

export interface BrowserNavigateCommand extends BrowserPageAddress {
  readonly kind: 'navigate'
  readonly url: string
  readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'
  readonly maxChars?: number
}

export interface BrowserSnapshotCommand extends BrowserPageAddress {
  readonly kind: 'snapshot'
  readonly selector?: string
  readonly format?: 'text' | 'aria'
  readonly maxChars?: number
}

export interface BrowserBringToFrontCommand extends BrowserPageAddress {
  readonly kind: 'bringToFront'
}

export interface BrowserClickCommand extends BrowserPageAddress {
  readonly kind: 'click'
  readonly selector: string
}

export interface BrowserFillCommand extends BrowserPageAddress {
  readonly kind: 'fill'
  readonly selector: string
  readonly value: string
}

export interface BrowserSelectCommand extends BrowserPageAddress {
  readonly kind: 'select'
  readonly selector: string
  readonly value: string
}

export interface BrowserPressCommand extends BrowserPageAddress {
  readonly kind: 'press'
  readonly key: string
}

export interface BrowserUploadCommand extends BrowserPageAddress {
  readonly kind: 'upload'
  readonly selector: string
  readonly files: readonly string[]
}

export interface BrowserScreenshotCommand extends BrowserPageAddress {
  readonly kind: 'screenshot'
}

export interface BrowserWaitForCommand extends BrowserPageAddress {
  readonly kind: 'waitFor'
  readonly selector?: string
  readonly url?: string
  readonly timeoutMs?: number
}

export interface BrowserClosePageCommand extends BrowserPageAddress {
  readonly kind: 'closePage'
}

export type BrowserResult =
  | BrowserPageResult
  | BrowserAckedResult
  | BrowserScreenshotResult

export interface BrowserPageResult {
  readonly kind: 'page'
  readonly page: string
  readonly url: string
  readonly title: string
  readonly text: string
  readonly truncated: boolean
}

export interface BrowserAckedResult {
  readonly kind: 'acked'
}

export interface BrowserScreenshotResult {
  readonly kind: 'screenshot'
  readonly pngBase64: string
}

export interface BrowserSession {
  act(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserResult>
  close(): Promise<void>
}

export interface BrowserAutomationProvider {
  readonly id: string
  available(): boolean
  open(signal?: AbortSignal): Promise<BrowserSession>
}

export type BrowserErrorCode =
  | 'BROWSER_DUPLICATE_PROVIDER'
  | 'BROWSER_PROVIDER_CONFIGURED_MISSING'
  | 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE'
  | 'BROWSER_PROVIDER_UNAVAILABLE'
  | 'BROWSER_PROVIDER_AMBIGUOUS'
  | 'BROWSER_LAUNCH_FAILED'
  | 'BROWSER_ABORTED'
  | 'BROWSER_ACTION_FAILED'

export class BrowserError extends HarnessError {}
