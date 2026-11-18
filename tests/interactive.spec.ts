import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  parseControlReport, readSignIn, renderPageControls, VISIBLE_CONTROLS_SCRIPT,
} from '../src/host/browser-playwright/interactive.ts'

describe('interactive snapshot page collection', () => {
  function collect(html: string) {
    const { window } = new JSDOM(html, { runScripts: 'outside-only' })
    try {
      const roots = [window.document]
      const shadowRoots = [...window.document.querySelectorAll('[data-shadow]')].map(host => {
        const shadow = host.attachShadow({ mode: 'open' })
        shadow.innerHTML = host.getAttribute('data-shadow')!
        return shadow
      })
      // jsdom has no layout or CSS.escape.
      window.CSS = { escape: (value: string) => value.replace(/[:.]/g, '\\$&') }
      for (const root of [...roots, ...shadowRoots]) {
        for (const el of root.querySelectorAll('*')) {
          const width = el.hasAttribute('data-zero') ? 0 : 21
          const left = el.hasAttribute('data-offscreen') ? -45 : 10
          el.getBoundingClientRect = () => new window.DOMRect(left, 20, width, 19)
        }
      }
      return parseControlReport(new window.Function(`return ${VISIBLE_CONTROLS_SCRIPT}`)())
    } finally {
      window.close()
    }
  }

  it('collects DOM evidence and selectors, filtering invisible/noninteractive controls', () => {
    const report = collect(`
      <a href="/oauth/google"><img alt=" Sign   in with Google " src="/g.png"></a>
      <button id="dark:google" class="dark" aria-label="" data-provider=" google " data-noise="discard"><svg></svg></button>
      <a id="gbg" style="background-image:url('/img/google_dark.svg')"></a>
      <iframe data-offscreen src="https://accounts.google.com/gsi/button?client_id=x"></iframe>
      <div data-shadow='<button class="shadow-github bad:class"><svg><title>Sign in with GitHub</title></svg></button>'></div>
      <form action="/signup">
        <input type="password" role="button" value="private">
        <input type="email" name="email">
        <input id="userEmail">
        <input type="submit" value="Continue    with Email">
        <button disabled>disabled</button>
        <fieldset disabled><button>also disabled</button></fieldset>
      </form>
      <a href="mailto:help@example.org">Help</a>
      <button style="display:none">not displayed</button>
      <button style="visibility:hidden">not visible</button>
      <button style="opacity:0.04">transparent</button>
      <button data-zero>no box</button>
      <p>not interactive</p>
      <a id="old-anchor">anchor without href or icon</a>
    `)
    expect(report).toMatchObject({ passwordFields: 1, emailFields: 2, forms: 1, emailLinks: 1, truncated: false })
    expect(report.controls).toMatchObject([
      { tag: 'a', imageAlt: 'Sign in with Google', imageSrc: '/g.png', href: '/oauth/google', x: 21, y: 30, inViewport: true, hasImage: true },
      { tag: 'button', ariaLabel: '', selector: '#dark\\:google', classes: 'dark', data: 'data-provider=google', hasSvg: true },
      { tag: 'a', href: '', selector: '#gbg', background: '/img/google_dark.svg' },
      { tag: 'iframe', src: 'https://accounts.google.com/gsi/button?client_id=x', inViewport: false },
      { tag: 'input', inputType: 'password', value: '', formAction: '/signup' },
      { tag: 'input', inputType: 'submit', value: 'Continue with Email', formAction: '/signup' },
      { tag: 'a', href: 'mailto:help@example.org' },
      { tag: 'button', selector: 'button.shadow-github', hasSvg: true, text: 'Sign in with GitHub' },
    ])
  })

  it('falls back to a unique path or coordinates, and bounds the report and string lengths', () => {
    const same = `data-shadow='<button id="duplicate" class="bad:class">Shadow</button>'`
    const report = collect(`
      <div><button>First</button><button>Second</button></div>
      <div ${same}></div><div ${same}></div>
      <button title="${'x'.repeat(140)}"></button>
    `)
    expect(report.controls.map(control => control.selector)).toEqual([
      'div:nth-of-type(1) > button:nth-of-type(1)', 'button:nth-of-type(2)', 'body > button', '', '',
    ])
    expect(report.controls[2]?.title).toHaveLength(120)
    const capped = collect('<button></button>'.repeat(301) + '<form><input type="email"></form>')
    expect(capped.controls).toHaveLength(300)
    expect(capped).toMatchObject({ truncated: true, forms: 1, emailFields: 1 })
  })
})

describe('interactive snapshot validation, classification and rendering', () => {
  function classify(row: object) {
    return readSignIn(parseControlReport({ controls: [{ tag: 'button', ...row }] }).controls[0]!)
  }

  it('defaults bad types at the browser boundary and drops invalid rows', () => {
    expect(parseControlReport(null)).toEqual(parseControlReport({ controls: {} }))
    const report = parseControlReport({
      controls: [null, false, [], {}, { tag: ' ' }, {
        tag: ' button ', role: {}, inputType: 3, text: false, value: ['caption'],
        ariaLabel: true, title: null, alt: 0, imageAlt: 0, imageSrc: 0, href: 0, src: 0,
        id: 0, classes: 0, data: 0, background: 0, formAction: 0, selector: 0,
        x: Infinity, y: '20', inViewport: 1, hasImage: 'true', hasSvg: true,
      }],
      passwordFields: '1', emailFields: NaN, forms: 2, emailLinks: {}, truncated: true,
    })
    expect(report).toEqual({
      controls: [{
        tag: 'button', role: '', inputType: '', text: '', value: '', ariaLabel: '', title: '',
        alt: '', imageAlt: '', imageSrc: '', href: '', src: '', id: '', classes: '', data: '',
        background: '', formAction: '', selector: '', x: 0, y: 0, inViewport: false, hasImage: false, hasSvg: true,
      }],
      passwordFields: 0, emailFields: 0, forms: 2, emailLinks: 0, truncated: true,
    })
  })

  it.each([
    ['google', 'Google'], ['facebook', 'Facebook'], ['github', 'GitHub'], ['apple', 'Apple'],
    ['microsoft', 'Microsoft'], ['x-twitter', 'Twitter'], ['discord', 'Discord'], ['linkedin', 'LinkedIn'],
    ['amazon', 'Amazon'], ['steam', 'Steam'], ['twitch', 'Twitch'], ['yahoo', 'Yahoo'],
    ['wordpress', 'WordPress.com'], ['reddit', 'Reddit'], ['tiktok', 'TikTok'], ['telegram', 'Telegram'],
  ])('identifies %s sign-in', (provider, brand) => {
    expect(classify({ ariaLabel: `Sign in with ${brand}` })).toEqual({ provider, strength: 'auth' })
  })

  it('uses URL, label and icon evidence without treating generic links as sign-in', () => {
    const google = { provider: 'google', strength: 'auth' }
    expect(classify({ tag: 'iframe', src: 'https://accounts.google.com/gsi/button?client_id=x' })).toEqual(google)
    expect(classify({ tag: 'a', href: '/redirect?url=https%3A%2F%2F%61ccounts%2E%67oogle%2Ecom%2F%6Fauth' })).toEqual(google)
    expect(classify({ href: '/oauth/google?next=%zz', ariaLabel: 'Google' })).toEqual(google)
    expect(classify({ classes: 'google-dark', hasSvg: true })).toEqual({ provider: 'google', strength: 'provider' })
    expect(classify({ tag: 'a', background: '/img/google_dark.svg' })).toEqual({ provider: 'google', strength: 'provider' })
    expect(classify({ tag: 'div', role: 'button', id: 'google' })).toEqual({ provider: 'google', strength: 'provider' })
    const email = { provider: 'email-password', strength: 'auth' }
    expect(classify({ inputType: 'password', id: 'google' })).toEqual(email)
    expect(classify({ value: 'Continue with Email' })).toEqual(email)
    expect(classify({ classes: 'dark', hasSvg: true })).toBeUndefined()
    expect(classify({ classes: 'gmail', text: 'Contact by email' })).toBeUndefined()
    for (const [href, text] of [
      ['https://play.google.com/store/apps', 'Get it on Google Play'],
      ['https://twitter.com/intent/tweet', 'Continue on Twitter'],
      ['https://twitter.com/share?url=https://example.org', 'Continue on Twitter'],
      ['https://www.google.com/', 'Powered by Google'],
      ['/about', 'Google'],
    ]) {
      expect(classify({ tag: 'a', href, text })).toBeUndefined()
    }
  })

  it('renders ordered summaries and complete evidence rows', () => {
    const report = parseControlReport({
      forms: 1, passwordFields: 1, emailFields: 2, emailLinks: 1,
      controls: [
        { tag: 'a', href: '/oauth/google', imageAlt: 'Sign in with Google', imageSrc: '/g.png', selector: 'a.gbtn', x: 91, y: 126, inViewport: true },
        { tag: 'button', classes: 'google-dark', hasSvg: true, selector: 'button.google-dark', x: 198, y: 115, inViewport: true },
        { tag: 'button', data: 'data-provider=github', hasSvg: true, selector: 'body > button', x: 282, y: 125 },
        { tag: 'iframe', title: 'Sign in with Google', src: 'https://accounts.google.com/gsi/button?client_id=x', x: 405, y: 109, inViewport: true },
        { tag: 'span', role: 'link', ariaLabel: 'Get it on Google Play', href: 'https://play.google.com/store/apps', inViewport: true },
        { tag: 'input', value: 'Log in', formAction: '/signup', data: 'data-test-id=submit data-name=sign up', inViewport: true },
        { tag: 'a', background: '/img/google_dark.svg', inViewport: true },
        { tag: 'button', classes: 'dark', inViewport: true },
      ],
    })
    expect(renderPageControls('Sign in to submit', report).split('\n')).toEqual([
      'interactive: 8 visible controls on "Sign in to submit" (1 form, password field: yes ×1, email field: yes ×2, mailto links: ×1)',
      'sign-in candidates: google ×4, github ×1',
      '#1 link "Sign in with Google" signin=google css=a.gbtn xy=91,126 alt="Sign in with Google" href=/oauth/google src=/g.png',
      '#2 button (icon only) signin=google? css=button.google-dark xy=198,115 cls=google-dark',
      '#3 button (icon only) signin=github css="body > button" xy=282,125 (scroll first) data-provider=github',
      '#4 iframe "Sign in with Google" signin=google xy=405,109 title="Sign in with Google" src=https://accounts.google.com/gsi/button?client_id=x',
      '#5 link "Get it on Google Play" xy=0,0 aria="Get it on Google Play" href=https://play.google.com/store/apps',
      '#6 input "Log in" xy=0,0 form=/signup data="data-test-id=submit data-name=sign up"',
      '#7 link (icon only) signin=google? xy=0,0 bg=/img/google_dark.svg',
      '#8 button xy=0,0 cls=dark',
    ])
    expect(renderPageControls('   ', parseControlReport({}))).toBe(
      'interactive: 0 visible controls on (untitled) (0 forms, password field: no, email field: no, mailto links: ×0)\nsign-in candidates: none',
    )
  })
})
