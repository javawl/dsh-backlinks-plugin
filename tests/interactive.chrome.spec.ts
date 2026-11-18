import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { BrowserSession } from '../src/host/browser/types.ts'
import { PlaywrightBrowserProvider } from '../lib/browser-playwright.js'
import { formatBrowserOutput, parseBrowserArgs } from '../lib/tool-browser.js'

it.runIf(process.env.DSH_TEST_CHROME === '1')('captures and uses sign-in evidence in installed Chrome', async () => {
  const fixture = await readFile(new URL('./fixtures/interactive-login.html', import.meta.url), 'utf8')
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html;charset=utf-8')
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
    response.end(request.url === '/many' ? '<button>Control</button>'.repeat(301) : fixture)
  })
  const userDataDir = await mkdtemp(join(tmpdir(), 'backlinks-chrome-'))
  let session: BrowserSession | undefined
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP address')
    const url = `http://127.0.0.1:${address.port}/`
    session = await new PlaywrightBrowserProvider({
      userDataDir, headless: true, channel: 'chrome', defaultTimeoutMs: 5_000,
      launchArgs: [], ignoreDefaultArgs: [], windowPosition: undefined,
    }).open()

    const opened = await session.act({ kind: 'navigate', url })
    if (opened.kind !== 'page') throw new Error('Expected a page')
    const { page } = opened
    const aria = await session.act({ kind: 'snapshot', format: 'aria', page })
    expect(opened.text).not.toContain('Sign in with Google')
    expect(aria).toMatchObject({ text: expect.stringContaining('link "Sign in with Google"') })
    expect(aria).toMatchObject({ text: expect.not.stringMatching(/google_dark|gsi\/button/) })

    const command = parseBrowserArgs({ action: 'snapshot', format: 'interactive', page })
    if (command.kind !== 'snapshot') throw new Error('Expected a snapshot command')
    const out = await session.act(command)
    if (out.kind !== 'page') throw new Error('Expected a page')
    expect(out).toMatchObject({ page, url, title: 'Sign in to submit', truncated: false })
    const lines = out.text.replace(new URL(url).origin, '').split('\n')
    expect(lines).toEqual([
      'interactive: 8 visible controls on "Sign in to submit" (1 form, password field: yes ×1, email field: yes ×1, mailto links: ×0)',
      'sign-in candidates: google ×4',
      '#1 link "Sign in with Google" signin=google css=a.gbtn xy=40,40 alt="Sign in with Google" href=/oauth/google src=/g.png cls=gbtn',
      '#2 button (icon only) signin=google? css=button.google-dark xy=100,40 cls=google-dark',
      '#3 link (icon only) signin=google? css=#gbg xy=160,40 id=gbg bg=/img/google_dark.svg',
      '#4 iframe signin=google css=iframe xy=220,40 src=https://accounts.google.com/gsi/button?client_id=x',
      '#5 link "Get it on Google Play" css="footer > a:nth-of-type(1)" xy=80,120 href=https://play.google.com/store/apps',
      '#6 link "Share on Twitter" css="footer > a:nth-of-type(2)" xy=260,120 href=https://twitter.com/intent/tweet',
      '#7 button "Log in" css="form > button" xy=300,920 (scroll first) form=/signup',
      '#8 button (icon only) css=#anonymous xy=280,40 id=anonymous cls=dark',
    ])
    const tiny = await session.act({ ...command, maxChars: 18 })
    expect(tiny).toMatchObject({ text: out.text.slice(0, 18), truncated: true })
    expect(formatBrowserOutput(tiny, 18)).toContain('… (truncated)')

    const selector = /css=(\S+)/.exec(lines[3]!)![1]!
    await session.act({ kind: 'click', selector, page })
    expect(await session.act({ kind: 'snapshot', format: 'text', selector, page })).toMatchObject({ text: 'Activated' })

    await session.act({ kind: 'navigate', url: new URL('/many', url).href, page })
    expect(await session.act(command)).toMatchObject({
      text: expect.stringMatching(/^interactive: 300 visible controls/), truncated: true,
    })
  } finally {
    await session?.close()
    server.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
}, 15_000)
