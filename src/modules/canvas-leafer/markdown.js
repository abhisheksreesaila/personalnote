// Markdown text on the canvas (F-048, ADR 0004): the source read line by line, as a note writer types it (a new line is a new line).
// Pure, no DOM: each line gets its kind (heading, list item, quote, code ...) and its inline runs, where every run is exactly a slice of
// the source (`from`..`to`) with its style. Marks that are not shown (`**`, `#`, the URL of a link) are simply not in any run, so a word
// on screen always maps back to its place in the Markdown (the anchor of a mark on it, F-050).

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/
const TASK = /^([ \t]*)([-*+]) \[([ xX])\](?: |$)/
const BULLET = /^([ \t]*)([-*+])(?: |$)/
const ORDERED = /^([ \t]*)(\d{1,9}[.)])(?: |$)/
const QUOTE = /^ {0,3}> ?/
const PUNCTUATION = /[!-/:-@[-`{-~]/

const depthOf = (indent) => Math.floor(indent.replace(/\t/g, '  ').length / 2)

export function parseMarkdown(source) {
  const lines = []
  let fence = null
  let from = 0
  for (const text of String(source ?? '').split('\n')) {
    const to = from + text.length
    lines.push(readLine(source, text, from, to, fence))
    const opened = FENCE.exec(text)
    if (fence) { if (opened && opened[1][0] === fence[0] && opened[1].length >= fence.length) fence = null } else if (opened) fence = opened[1]
    from = to + 1
  }
  return lines
}

function readLine(source, text, from, to, fence) {
  const line = (kind, extra, contentFrom = from) => ({ kind, from, to, contentFrom, depth: 0, ...extra, runs: contentFrom < to ? inlineRuns(source, contentFrom, to) : [] })
  if (fence) {
    const closing = FENCE.exec(text)
    if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) return { kind: 'fence', from, to, contentFrom: to, depth: 0, runs: [] }
    return { kind: 'code', from, to, contentFrom: from, depth: 0, runs: to > from ? [{ from, to, style: { code: true } }] : [] }
  }
  if (FENCE.test(text)) return { kind: 'fence', from, to, contentFrom: to, depth: 0, runs: [] }
  if (!text.trim()) return { kind: 'blank', from, to, contentFrom: to, depth: 0, runs: [] }
  if (RULE.test(text)) return { kind: 'rule', from, to, contentFrom: to, depth: 0, runs: [] }
  let match = HEADING.exec(text)
  if (match) return line('heading', { level: match[1].length, marker: { from, to: from + match[0].length } }, from + match[0].length)
  match = TASK.exec(text)
  if (match) return line('task', { depth: depthOf(match[1]), checked: match[3] !== ' ', marker: { from: from + match[1].length, to: from + match[0].length } }, from + match[0].length)
  match = BULLET.exec(text)
  if (match) return line('bullet', { depth: depthOf(match[1]), marker: { from: from + match[1].length, to: from + match[0].length } }, from + match[0].length)
  match = ORDERED.exec(text)
  if (match) return line('ordered', { depth: depthOf(match[1]), number: match[2], marker: { from: from + match[1].length, to: from + match[0].length } }, from + match[0].length)
  match = QUOTE.exec(text)
  if (match) return line('quote', { marker: { from, to: from + match[0].length } }, from + match[0].length)
  return line('paragraph', {})
}

// ---------- inline: every character of the line gets a style or is hidden; runs are the stretches of shown characters alike in style

const PAIRS = [
  { mark: '**', style: 'bold' }, { mark: '__', style: 'bold', word: true }, { mark: '~~', style: 'strike' },
  { mark: '*', style: 'italic' }, { mark: '_', style: 'italic', word: true },
]
const isSpace = (char) => char === undefined || /\s/.test(char)
const isWordChar = (char) => char !== undefined && /[\p{L}\p{N}]/u.test(char)

function inlineRuns(source, from, to) {
  const text = source.slice(from, to)
  const n = text.length
  const hidden = new Array(n).fill(false)
  const locked = new Array(n).fill(false) // code, escaped characters, link targets: no emphasis inside
  const styles = Array.from({ length: n }, () => ({}))

  const escaped = (i) => { let count = 0; while (i - 1 - count >= 0 && text[i - 1 - count] === '\\') count += 1; return count % 2 === 1 }
  for (let i = 0; i < n; i += 1) { // code spans first (a backslash inside one is just a backslash): backticks closed by as many
    if (text[i] !== '`' || locked[i] || escaped(i)) continue
    let open = i
    while (open < n && text[open] === '`') open += 1
    const size = open - i
    let close = open
    let found = -1
    while (close < n) {
      if (text[close] === '`') {
        let end = close
        while (end < n && text[end] === '`') end += 1
        if (end - close === size) { found = close; break }
        close = end
      } else close += 1
    }
    if (found === -1) { i = open - 1; continue }
    for (let k = i; k < found + size; k += 1) { locked[k] = true; if (k < open || k >= found) hidden[k] = true; else styles[k].code = true }
    i = found + size - 1
  }
  for (let i = 0; i < n - 1; i += 1) { // escapes, outside code
    if (text[i] === '\\' && PUNCTUATION.test(text[i + 1]) && !locked[i]) { hidden[i] = true; locked[i] = true; locked[i + 1] = true; i += 1 }
  }
  for (let i = 0; i < n; i += 1) { // links: [text](target)
    if (text[i] !== '[' || locked[i]) continue
    const middle = text.indexOf('](', i + 1)
    if (middle === -1) break
    const end = text.indexOf(')', middle + 2)
    if (end === -1) break
    if (text.slice(i + 1, middle).includes('[') || middle === i + 1) continue
    const href = text.slice(middle + 2, end).trim()
    hidden[i] = true
    for (let k = middle; k <= end; k += 1) { hidden[k] = true; locked[k] = true }
    for (let k = i + 1; k < middle; k += 1) styles[k].link = href
    i = end
  }
  for (const pair of PAIRS) { // emphasis: an opener followed by a non-space, closed by the nearest closer after a non-space
    const size = pair.mark.length
    const at = (i) => text.startsWith(pair.mark, i) && !locked.slice(i, i + size).some(Boolean) && !hidden.slice(i, i + size).some(Boolean)
    for (let i = 0; i + size <= n; i += 1) {
      if (!at(i) || isSpace(text[i + size]) || (pair.word && isWordChar(text[i - 1]))) continue
      if (size === 1 && text[i + 1] === pair.mark) { i += 1; continue } // part of a longer run
      let close = -1
      for (let j = i + size + 1; j + size <= n; j += 1) {
        if (at(j) && !isSpace(text[j - 1]) && !(pair.word && isWordChar(text[j + size])) && !(size === 1 && text[j + 1] === pair.mark)) { close = j; break }
      }
      if (close === -1) continue
      for (let k = i; k < i + size; k += 1) hidden[k] = true
      for (let k = close; k < close + size; k += 1) hidden[k] = true
      for (let k = i + size; k < close; k += 1) styles[k][pair.style] = true
      i = close + size - 1
    }
  }

  const runs = []
  const key = (style) => JSON.stringify(style)
  for (let i = 0; i < n; i += 1) {
    if (hidden[i]) continue
    const last = runs.at(-1)
    if (last && last.to === from + i && key(last.style) === key(styles[i])) last.to += 1
    else runs.push({ from: from + i, to: from + i + 1, style: { ...styles[i] } })
  }
  return runs
}
