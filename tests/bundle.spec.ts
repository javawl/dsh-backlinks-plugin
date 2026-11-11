import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BacklinksRuntime, { BacklinksError } from '../src/host/backlinks/index.ts'
import { SupermanagerBatchSource } from '../src/host/supermanager/index.ts'
import { CloudMailMailbox } from '../src/host/cloud-mail/index.ts'
import { parseItemResult, renderBacklinksValue } from '../src/host/tool-backlinks/index.ts'
import BrowserRuntime from '../src/host/browser/index.ts'
import { formatBrowserOutput, parseBrowserArgs } from '../src/host/tool-browser/index.ts'
import { resolveBundledSkillsDir } from '../src/host/skill-backlinks/index.ts'
import BacklinksConsoleRuntime from '../src/host/index.ts'
import { TYPERT } from '../src/host/typert-host.ts'
import { PACKAGE_NAME, TYPERT_REMOTE } from '../src/shared/typert-remote.ts'

describe('@javawl/dsh-backlinks-bundle standalone unit checks', () => {
  it('resolves bundled skills and all 6 category playbooks independent of cwd', () => {
    const dir = resolveBundledSkillsDir()
    expect(existsSync(join(dir, 'backlink-publish', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, 'google-session', 'SKILL.md'))).toBe(true)
    for (const kind of ['article', 'blog', 'directory', 'forum', 'gaming', 'tools']) {
      expect(existsSync(join(dir, 'backlink-publish', 'references', 'playbooks', `playbook-${kind}.md`))).toBe(true)
    }
  })

  it('registers batch-source and mailbox providers on BacklinksRuntime and routes through BacklinksConsoleRuntime', async () => {
    const ctx = new Context()
    await ctx.plugin(BacklinksRuntime)
    ctx.effect(() => ctx.backlinks.registerBatchSourceProvider({
      id: 'mock-source',
      available: () => true,
      listBatches: async () => [{
        id: 176,
        name: 'Batch 176',
        websiteId: 1,
        websiteName: 'Demo',
        websiteHost: 'demo.example.com',
        plannedAt: '2026-11-11T00:00:00Z',
        counts: { pending: 3, executed: 1, skipped: 0, failed: 0, total: 4 },
        executing: false,
      }],
      getBatch: async (batchId) => ({
        batch: {
          id: batchId,
          name: `Batch ${String(batchId)}`,
          websiteId: 1,
          websiteName: 'Demo',
          websiteHost: 'demo.example.com',
          plannedAt: '2026-11-11T00:00:00Z',
          counts: { pending: 1, executed: 0, skipped: 0, failed: 0, total: 1 },
          executing: false,
        },
        website: { id: 1, name: 'Demo', siteUrl: 'https://demo.example.com', siteHost: 'demo.example.com' },
        anchors: [{ id: 1, anchorText: 'Demo Tool', targetUrl: 'https://demo.example.com' }],
        items: [],
      }),
      claim: async () => ({ leaseId: 9, leaseExpiresAt: '2026-11-11T02:00:00Z', items: [] }),
      heartbeat: async (leaseId) => ({ leaseId, leaseExpiresAt: '2026-11-11T02:30:00Z' }),
      release: async () => {},
      reportItemResult: async () => ({ itemStatus: 'executed', publishRecordId: 42 }),
      addBadge: async () => ({ backlinkId: 7, callbackTriggered: true }),
      tagSource: async (sourceId, names) => ({
        sourceId,
        attached: names.map((name, idx) => ({ id: idx + 1, name, created: true })),
      }),
    }))

    await ctx.plugin(BacklinksConsoleRuntime)
    const batches = await ctx.backlinksConsole.batches()
    expect(batches).toHaveLength(1)
    expect(batches[0]?.id).toBe(176)

    const detail = await ctx.backlinksConsole.batch(176)
    expect(detail.website.siteHost).toBe('demo.example.com')

    await ctx.fiber.dispose()
  })

  it('validates tool-backlinks item_result closed union and renders tool output', () => {
    const live = parseItemResult({
      status: 'live',
      publicUrl: 'https://blog.example.org/post-1',
      anchorText: 'Demo',
      targetUrl: 'https://demo.example.com',
      evidence: '使用后台资料包',
    })
    expect(live).toEqual({
      status: 'live',
      publicUrl: 'https://blog.example.org/post-1',
      anchorText: 'Demo',
      targetUrl: 'https://demo.example.com',
      evidence: '使用后台资料包',
    })
    expect(() => parseItemResult({ status: 'failed', failureMode: 'unknown', failureReason: 'x' })).toThrow()
    expect(renderBacklinksValue({ summary: '1 batch(es)', data: { ok: true } })).toBe('1 batch(es)\n{"ok":true}')
  })

  it('validates tool-browser actions including closeBrowser, bringToFront, role/xy selectors, and session close', async () => {
    expect(parseBrowserArgs({ action: 'closeBrowser' })).toEqual({ kind: 'closeBrowser' })
    expect(parseBrowserArgs({ action: 'bringToFront', page: 'g1' })).toEqual({ kind: 'bringToFront', page: 'g1' })
    expect(parseBrowserArgs({ action: 'click', page: 'g1', selector: 'role:button|Submit' })).toEqual({
      kind: 'click',
      page: 'g1',
      selector: 'role:button|Submit',
    })
    expect(() => parseBrowserArgs({ action: 'click', selector: 'xy:bad' })).toThrow()

    const ctx = new Context()
    await ctx.plugin(BrowserRuntime)
    let closed = false
    ctx.effect(() => ctx.browser.registerProvider({
      id: 'mock-browser',
      available: () => true,
      open: async () => ({
        act: async () => ({ kind: 'page', page: 'p1', url: 'https://example.com', title: 'Example', text: 'Hello', truncated: false }),
        close: async () => { closed = true },
      }),
    }))
    const pageOut = await ctx.browser.act({ kind: 'navigate', url: 'https://example.com' })
    expect(formatBrowserOutput(pageOut, 100)).toContain('[page p1] Example')
    await ctx.browser.closeSession()
    expect(closed).toBe(true)
    await ctx.fiber.dispose()
  })

  it('loads built ESM lib/index.js directly under Node with lowered @Remote decorators', async () => {
    const mod = await import('../lib/index.js')
    const ctx = new Context()
    await ctx.plugin(BacklinksRuntime)
    ctx.effect(() => ctx.backlinks.registerBatchSourceProvider({
      id: 'built-mock',
      available: () => true,
      listBatches: async () => [],
      getBatch: async () => { throw new Error('unused') },
      claim: async () => { throw new Error('unused') },
      heartbeat: async () => { throw new Error('unused') },
      release: async () => {},
      reportItemResult: async () => ({ itemStatus: 'skipped', publishRecordId: null }),
      addBadge: async () => ({ backlinkId: 1, callbackTriggered: false }),
      tagSource: async (sourceId) => ({ sourceId, attached: [] }),
    }))
    await ctx.plugin(mod.default)
    expect(await ctx.backlinksConsole.batches()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('exposes consistent Typert descriptors and provider availability checks', () => {
    const manifest = TYPERT as { package: string; face: string; invocations: unknown[] }
    expect(manifest.package).toBe(PACKAGE_NAME)
    expect(manifest.face).toBe('host')
    expect(manifest.invocations).toHaveLength(2)
    expect(Object.keys(TYPERT_REMOTE.methods).sort()).toEqual(['backlinksConsole/batch', 'backlinksConsole/batches'])

    const sm = new SupermanagerBatchSource(() => ({ baseUrl: '', token: '', requestTimeoutMs: 5000 }))
    const cm = new CloudMailMailbox(() => ({ baseUrl: 'https://mail.screwdom.org/api', token: 'tok', requestTimeoutMs: 5000 }))
    expect(sm.available()).toBe(false)
    expect(cm.available()).toBe(true)
    expect(new BacklinksError('conflict', 'BACKLINKS_CONFLICT', 15).retryAfterSeconds).toBe(15)

    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { name: string }
    expect(pkg.name).toBe(PACKAGE_NAME)
  })
})
