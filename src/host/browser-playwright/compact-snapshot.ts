/**
 * Compact DOM snapshot compressors for `browser action="snapshot"` (`aria`, `text`,
 * and fallback plain text). Prunes decorative header/nav/footer/SVG bloat while
 * preserving interactive forms, inputs, buttons, comments, auth gates, and alerts.
 */

const BOILERPLATE_ROLES = new Set([
  'banner',
  'navigation',
  'contentinfo',
  'complementary',
])

const DECORATIVE_ROLES = new Set([
  'presentation',
  'none',
  'separator',
])

const WRAPPER_ROLES = new Set([
  'generic',
  'group',
  'list',
  'listitem',
  'region',
  'article',
  'main',
  'section',
  'paragraph',
])

const FORM_CONTROL_ROLES = new Set([
  'form',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'spinbutton',
  'switch',
  'button',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'iframe',
])

const INPUT_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'spinbutton',
  'switch',
])

const AUTH_OR_ACTION_PATTERN =
  /sign\s*in|log\s*in|sign\s*up|register|submit|add\s*(?:site|tool|listing|url)|comment|reply|post|login|oauth|google|github|登录|注册|提交|评论|入驻|申请|发布|回复|验证/iu

const COMMENT_OR_FORM_HINT_PATTERN =
  /comment|respond|reply|review|submit|form|author|email|website|url|captcha|recaptcha|moderation|awaiting|login|sign\s*in|评论|回复|提交|审核|验证码|登录/iu

interface ParsedAriaLine {
  readonly indent: number
  readonly rawTrimmed: string
  readonly role: string
  readonly isPropertyLine: boolean
  readonly isBoilerplate: boolean
  readonly isDecorative: boolean
  readonly isInteractive: boolean
  readonly isPriority: boolean
  readonly isWrapperOnly: boolean
  readonly formatted: string
}

export interface CompactSnapshotOutput {
  readonly text: string
  readonly truncated: boolean
  readonly compactSummary: string
}

function collapseWs(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function truncateInline(value: string, maxLen: number): string {
  const clean = collapseWs(value)
  if (clean.length <= maxLen) return clean
  return `${clean.slice(0, maxLen - 1)}…`
}

function parseAriaLine(line: string): ParsedAriaLine | undefined {
  if (line.trim().length === 0) return undefined
  const indent = line.length - line.trimStart().length
  const trimmed = line.trim()

  if (!trimmed.startsWith('- ')) {
    const clean = truncateInline(trimmed, 140)
    return {
      indent,
      rawTrimmed: trimmed,
      role: 'meta',
      isPropertyLine: true,
      isBoilerplate: false,
      isDecorative: false,
      isInteractive: false,
      isPriority: false,
      isWrapperOnly: false,
      formatted: `${' '.repeat(indent)}${clean}`,
    }
  }

  const body = trimmed.slice(2)
  if (body.startsWith('/')) {
    const clean = truncateInline(body, 120)
    return {
      indent,
      rawTrimmed: trimmed,
      role: 'url',
      isPropertyLine: true,
      isBoilerplate: false,
      isDecorative: false,
      isInteractive: false,
      isPriority: false,
      isWrapperOnly: false,
      formatted: `${' '.repeat(indent)}- ${clean}`,
    }
  }

  const roleMatch = /^([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?(?:\s*\[[^\]]*\])*\s*:(?:\s*(.*))?$/u.exec(body)
    ?? /^([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?(.*)$/u.exec(body)
  const role = (roleMatch?.[1] ?? 'text').toLowerCase()
  const quotedName = roleMatch?.[2] ?? ''
  const trailingText = (roleMatch?.[3] ?? '').trim()

  const isPropertyLine = role === 'text'
  const isBoilerplate = BOILERPLATE_ROLES.has(role)
  const isDecorative = DECORATIVE_ROLES.has(role)
    || (role === 'img' && quotedName.length === 0 && !AUTH_OR_ACTION_PATTERN.test(body))
  const isFormControl = FORM_CONTROL_ROLES.has(role)
  const isAuthOrAction = AUTH_OR_ACTION_PATTERN.test(body)
  const isInteractive = isFormControl || ((role === 'link' || role === 'menuitem') && isAuthOrAction)
  const isPriority = isFormControl || isAuthOrAction || COMMENT_OR_FORM_HINT_PATTERN.test(body)

  const colonIdx = body.indexOf(':')
  const isWrapperOnly = WRAPPER_ROLES.has(role) && colonIdx >= 0 && body.slice(colonIdx + 1).trim().length === 0

  let compactBody = body
  if (role === 'heading') {
    compactBody = truncateInline(body, 120)
  } else if (role === 'paragraph' || role === 'text' || role === 'generic') {
    if (colonIdx >= 0) {
      const prefix = body.slice(0, colonIdx + 1)
      const val = body.slice(colonIdx + 1).trim()
      compactBody = val.length > 0 ? `${prefix} ${truncateInline(val, 140)}` : prefix
    } else {
      compactBody = truncateInline(body, 140)
    }
  } else {
    compactBody = truncateInline(body, 180)
  }

  return {
    indent,
    rawTrimmed: trimmed,
    role,
    isPropertyLine,
    isBoilerplate,
    isDecorative,
    isInteractive,
    isPriority,
    isWrapperOnly,
    formatted: `${' '.repeat(indent)}- ${compactBody}`,
  }
}

function dropEmptyWrappers(entries: readonly (ParsedAriaLine & { readonly keepPriority: boolean })[]): Array<ParsedAriaLine & { readonly keepPriority: boolean }> {
  const result = [...entries]
  let changed = true
  while (changed) {
    changed = false
    for (let i = result.length - 1; i >= 0; i--) {
      const current = result[i]!
      if (!current.isWrapperOnly) continue
      const next = result[i + 1]
      if (next === undefined || next.indent <= current.indent) {
        result.splice(i, 1)
        changed = true
      }
    }
  }
  return result
}

function collapseSiblingLinks(
  entries: readonly (ParsedAriaLine & { readonly keepPriority: boolean })[],
): { entries: Array<ParsedAriaLine & { readonly keepPriority: boolean }>; collapsedCount: number } {
  const out: Array<ParsedAriaLine & { readonly keepPriority: boolean }> = []
  let collapsedCount = 0
  let i = 0

  while (i < entries.length) {
    const current = entries[i]!
    if (current.role !== 'link' || current.keepPriority) {
      out.push(current)
      i++
      continue
    }

    // Collect contiguous sibling link subtrees at the exact same indent outside priority zones.
    const groupIndents: number[] = []
    let j = i
    while (j < entries.length) {
      const head = entries[j]!
      if (head.indent !== current.indent || head.role !== 'link' || head.keepPriority) break
      groupIndents.push(j)
      j++
      while (j < entries.length && entries[j]!.indent > current.indent) {
        j++
      }
    }

    if (groupIndents.length <= 6) {
      for (let k = i; k < j; k++) out.push(entries[k]!)
    } else {
      const fifthStart = groupIndents[4]!
      for (let k = i; k < fifthStart; k++) out.push(entries[k]!)
      const omitted = groupIndents.length - 4
      collapsedCount += omitted
      out.push({
        indent: current.indent,
        rawTrimmed: `- ... (+${omitted} links)`,
        role: 'meta',
        isPropertyLine: true,
        isBoilerplate: false,
        isDecorative: false,
        isInteractive: false,
        isPriority: false,
        isWrapperOnly: false,
        keepPriority: false,
        formatted: `${' '.repeat(current.indent)}- ... (+${omitted} links)`,
      })
    }
    i = j
  }

  return { entries: out, collapsedCount }
}

function budgetAriaLines(
  entries: readonly (ParsedAriaLine & { readonly keepPriority: boolean })[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const allText = entries.map(e => e.formatted).join('\n')
  if (allText.length <= maxChars) {
    return { text: allText, truncated: false }
  }

  // Reserve budget for priority (forms, inputs, buttons, comments, alerts, auth) lines first.
  const selected = new Array<boolean>(entries.length).fill(false)
  let usedChars = 0

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (!entry.keepPriority) continue
    const cost = entry.formatted.length + (usedChars > 0 ? 1 : 0)
    if (usedChars + cost <= maxChars) {
      selected[i] = true
      usedChars += cost
    }
  }

  // Fill remaining budget in document order (headings and leading content first).
  for (let i = 0; i < entries.length; i++) {
    if (selected[i]) continue
    const entry = entries[i]!
    const cost = entry.formatted.length + (usedChars > 0 ? 1 : 0)
    if (usedChars + cost <= maxChars) {
      selected[i] = true
      usedChars += cost
    }
  }

  const lines: string[] = []
  for (let i = 0; i < entries.length; i++) {
    if (selected[i]) lines.push(entries[i]!.formatted)
  }

  if (lines.length === 0) {
    return { text: allText.slice(0, maxChars), truncated: true }
  }

  return { text: lines.join('\n').slice(0, maxChars), truncated: true }
}

/**
 * Compress a Playwright ARIA snapshot by pruning boilerplate navigation/footer/SVG
 * subtrees, deduplicating prose, collapsing long link lists, and prioritizing
 * forms/inputs/comments under tight character budgets.
 */
export function compactAriaSnapshot(rawAria: string, maxChars: number): CompactSnapshotOutput {
  const rawLines = rawAria.split(/\r?\n/u)
  const counts = { forms: 0, inputs: 0, buttons: 0, links: 0, iframes: 0, alerts: 0 }
  let prunedCount = 0

  const stack: Array<{ indent: number; boilerplate: boolean; priority: boolean }> = []
  const kept: Array<ParsedAriaLine & { readonly keepPriority: boolean }> = []
  let lastKeptFormatted = ''

  for (const rawLine of rawLines) {
    const parsed = parseAriaLine(rawLine)
    if (parsed === undefined) continue

    if (parsed.role === 'form') counts.forms++
    else if (INPUT_ROLES.has(parsed.role)) counts.inputs++
    else if (parsed.role === 'button') counts.buttons++
    else if (parsed.role === 'link') counts.links++
    else if (parsed.role === 'iframe') counts.iframes++
    else if (parsed.role === 'alert' || parsed.role === 'alertdialog' || parsed.role === 'status') counts.alerts++

    while (stack.length > 0 && stack[stack.length - 1]!.indent >= parsed.indent) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    const inBoilerplate = (parent?.boilerplate ?? false) || parsed.isBoilerplate
    const inPrioritySubtree = (parent?.priority ?? false) || parsed.isPriority

    if (inBoilerplate) {
      if (parsed.isInteractive) {
        kept.push({ ...parsed, keepPriority: true })
        lastKeptFormatted = parsed.formatted
        stack.push({ indent: parsed.indent, boilerplate: true, priority: true })
      } else if (parsed.role === 'url' && parent?.priority) {
        kept.push({ ...parsed, keepPriority: true })
        lastKeptFormatted = parsed.formatted
      } else {
        prunedCount++
        stack.push({ indent: parsed.indent, boilerplate: true, priority: false })
      }
      continue
    }

    if (parsed.isDecorative) {
      prunedCount++
      continue
    }

    if (parsed.formatted === lastKeptFormatted && !parsed.isInteractive) {
      prunedCount++
      continue
    }

    kept.push({ ...parsed, keepPriority: inPrioritySubtree })
    lastKeptFormatted = parsed.formatted
    stack.push({ indent: parsed.indent, boilerplate: false, priority: inPrioritySubtree })
  }

  const withoutEmpty = dropEmptyWrappers(kept)
  const { entries: finalEntries, collapsedCount } = collapseSiblingLinks(withoutEmpty)
  const totalPruned = prunedCount + collapsedCount + Math.max(0, kept.length - withoutEmpty.length)

  const compactedUnbounded = finalEntries.map(e => e.formatted).join('\n')
  const reductionPct = rawAria.length > 0
    ? Math.max(0, Math.round((1 - compactedUnbounded.length / rawAria.length) * 100))
    : 0

  const compactSummary = `forms=${counts.forms} inputs=${counts.inputs} buttons=${counts.buttons} links=${counts.links} iframes=${counts.iframes} alerts=${counts.alerts} pruned=${totalPruned} (raw=${rawAria.length}c -> ${compactedUnbounded.length}c, -${reductionPct}%)`
  const budgeted = budgetAriaLines(finalEntries, maxChars)

  return {
    text: budgeted.text,
    truncated: budgeted.truncated,
    compactSummary,
  }
}

/** Evaluated in the browser for compact `snapshot format="text"`. */
export const COMPACT_TEXT_SCRIPT = String.raw`(() => {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const isHidden = (el) => {
    if (!el || el.hidden) return true;
    if (el.localName === 'input' && (el.type || '').toLowerCase() === 'hidden') return true;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    return !!(style && (style.display === 'none' || style.visibility === 'hidden'));
  };
  const isBoilerplate = (el) => {
    const bp = el.closest('header,footer,nav,aside,[role="banner"],[role="navigation"],[role="contentinfo"]');
    if (!bp) return false;
    return !bp.querySelector('form,textarea,input:not([type="hidden"]),[role="dialog"],[role="alertdialog"]');
  };

  const forms = Array.from(document.querySelectorAll('form')).filter(f => !isHidden(f));
  const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]),textarea,select')).filter(i => !isHidden(i));
  const buttons = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"]')).filter(b => !isHidden(b));
  const iframes = Array.from(document.querySelectorAll('iframe')).filter(f => !isHidden(f));

  const formLines = forms.slice(0, 8).map((form, idx) => {
    const action = clean(form.getAttribute('action'));
    const idAttr = form.id ? '#' + form.id : '';
    const ctrls = Array.from(form.querySelectorAll('input:not([type="hidden"]),textarea,select,button'))
      .filter(c => !isHidden(c))
      .slice(0, 12)
      .map(c => {
        const tag = c.localName;
        const name = clean(c.getAttribute('name') || c.id || c.getAttribute('placeholder') || c.getAttribute('aria-label') || clean(c.textContent));
        const type = tag === 'input' ? ':' + (c.type || 'text') : '';
        return name ? tag + type + '(' + name.slice(0, 32) + ')' : tag + type;
      });
    return 'form[' + idx + ']' + idAttr + (action ? ' action=' + action.slice(0, 60) : '') + ': ' + (ctrls.join(', ') || '(no visible fields)');
  });

  const alerts = [];
  for (const el of document.querySelectorAll('[role="alert"],[role="alertdialog"],[role="status"],.comment-awaiting-moderation,.wp-die-message,#error-page')) {
    if (isHidden(el)) continue;
    const text = clean(el.innerText || el.textContent).slice(0, 200);
    if (text && !alerts.includes(text)) alerts.push(text);
    if (alerts.length >= 5) break;
  }

  const rawBodyText = clean(document.body ? (document.body.innerText || document.body.textContent) : '');
  const mainRoot = document.querySelector('main,article,[role="main"],#comments,#respond') || document.body;
  const mainLines = [];
  if (mainRoot) {
    const walker = document.createTreeWalker(mainRoot, NodeFilter.SHOW_ELEMENT);
    const seen = new Set();
    let node = walker.currentNode;
    while (node && mainLines.length < 120) {
      if (node.nodeType === 1) {
        const el = node;
        if (!['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG'].includes(el.tagName) && !isHidden(el) && !isBoilerplate(el)) {
          if (/^(H1|H2|H3|H4|P|LI|LABEL|BUTTON|A|TEXTAREA)$/u.test(el.tagName)) {
            const text = clean(el.innerText || el.textContent);
            if (text && text.length >= 2 && !seen.has(text)) {
              seen.add(text);
              mainLines.push(text.slice(0, 180));
            }
          }
        }
      }
      node = walker.nextNode();
    }
  }

  return {
    forms: forms.length,
    inputs: inputs.length,
    buttons: buttons.length,
    iframes: iframes.length,
    alerts,
    formLines,
    mainLines,
    rawChars: rawBodyText.length,
  };
})()`

export interface CompactTextEvalPayload {
  readonly forms: number
  readonly inputs: number
  readonly buttons: number
  readonly iframes: number
  readonly alerts: readonly string[]
  readonly formLines: readonly string[]
  readonly mainLines: readonly string[]
  readonly rawChars: number
}

/** Format the evaluated `COMPACT_TEXT_SCRIPT` result under `maxChars`. */
export function formatCompactTextEvaluation(raw: unknown, maxChars: number): CompactSnapshotOutput {
  const data = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<CompactTextEvalPayload>
  const forms = typeof data.forms === 'number' ? data.forms : 0
  const inputs = typeof data.inputs === 'number' ? data.inputs : 0
  const buttons = typeof data.buttons === 'number' ? data.buttons : 0
  const iframes = typeof data.iframes === 'number' ? data.iframes : 0
  const alerts = Array.isArray(data.alerts) ? data.alerts.filter((v): v is string => typeof v === 'string') : []
  const formLines = Array.isArray(data.formLines) ? data.formLines.filter((v): v is string => typeof v === 'string') : []
  const mainLines = Array.isArray(data.mainLines) ? data.mainLines.filter((v): v is string => typeof v === 'string') : []
  const rawChars = typeof data.rawChars === 'number' ? data.rawChars : 0

  const sections: string[] = []
  if (alerts.length > 0) {
    sections.push('[alerts]\n' + alerts.map(line => `- ${line}`).join('\n'))
  }
  if (formLines.length > 0) {
    sections.push('[forms]\n' + formLines.map(line => `- ${line}`).join('\n'))
  }
  if (mainLines.length > 0) {
    sections.push('[content]\n' + mainLines.join('\n'))
  }

  const fullCompact = sections.join('\n\n')
  const effectiveRaw = Math.max(rawChars, fullCompact.length)
  const reductionPct = effectiveRaw > 0
    ? Math.max(0, Math.round((1 - fullCompact.length / effectiveRaw) * 100))
    : 0
  const compactSummary = `forms=${forms} inputs=${inputs} buttons=${buttons} iframes=${iframes} alerts=${alerts.length} (raw=${rawChars}c -> ${fullCompact.length}c, -${reductionPct}%)`

  if (fullCompact.length <= maxChars) {
    return { text: fullCompact, truncated: false, compactSummary }
  }
  return {
    text: fullCompact.slice(0, maxChars),
    truncated: true,
    compactSummary,
  }
}

/** Fallback pure-text compressor used when `page.evaluate` is unavailable or selector-scoped. */
export function compactPlainText(rawText: string, maxChars: number): CompactSnapshotOutput {
  const rawLines = rawText.split(/\r?\n/u)
  const cleaned: string[] = []
  let prev = ''
  let pruned = 0

  for (const line of rawLines) {
    const normalized = collapseWs(line)
    if (normalized.length === 0) {
      pruned++
      continue
    }
    if (normalized === prev) {
      pruned++
      continue
    }
    cleaned.push(normalized)
    prev = normalized
  }

  const priority = cleaned.filter(line => COMMENT_OR_FORM_HINT_PATTERN.test(line))
  const regular = cleaned.filter(line => !COMMENT_OR_FORM_HINT_PATTERN.test(line))
  const unbounded = cleaned.join('\n')
  const reductionPct = rawText.length > 0
    ? Math.max(0, Math.round((1 - unbounded.length / rawText.length) * 100))
    : 0
  const compactSummary = `lines=${cleaned.length} priority=${priority.length} pruned=${pruned} (raw=${rawText.length}c -> ${unbounded.length}c, -${reductionPct}%)`

  if (unbounded.length <= maxChars) {
    return { text: unbounded, truncated: false, compactSummary }
  }

  // Keep priority lines first, then fill with leading regular content in order.
  const selected = new Set<string>()
  let used = 0
  for (const line of priority) {
    const cost = line.length + (used > 0 ? 1 : 0)
    if (used + cost <= maxChars) {
      selected.add(line)
      used += cost
    }
  }
  for (const line of regular) {
    const cost = line.length + (used > 0 ? 1 : 0)
    if (used + cost <= maxChars) {
      selected.add(line)
      used += cost
    }
  }
  const ordered = cleaned.filter(line => selected.has(line))
  const finalText = ordered.length > 0 ? ordered.join('\n').slice(0, maxChars) : unbounded.slice(0, maxChars)
  return { text: finalText, truncated: true, compactSummary }
}
