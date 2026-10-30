import { displayIcons, displayText } from './model.js'

// A node's box comes from its measured label: wrapped at word breaks past WRAP characters, as wide as its widest line.
const WRAP = 28
const CLEAN = '"IBM Plex Sans", sans-serif'
const SERIF = '"Source Serif 4", serif'
const widths = new Map()
let context

// Real measurement in the browser (canvas text, same font as the label); a character-count guess where there is no canvas (tests, first paint).
function browserMeasure(text, font) {
  const key = `${font}|${text}`
  if (!widths.has(key)) {
    context ||= globalThis.document?.createElement?.('canvas')?.getContext?.('2d') || false
    if (!context) return text.length * Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]) * (font.includes('Plex') ? 0.53 : 0.49)
    context.font = font
    widths.set(key, context.measureText(text).width)
  }
  return widths.get(key)
}

export const clearMeasureCache = () => widths.clear() // (the web fonts arrived: widths measured in the fallback font are stale)

export function wrapText(text, limit = WRAP) {
  const lines = []
  let line = ''
  for (let word of String(text).split(/\s+/).filter(Boolean)) {
    while (word.length > limit) {
      if (line) lines.push(line)
      lines.push(word.slice(0, limit))
      word = word.slice(limit)
      line = ''
    }
    if (line && line.length + 1 + word.length > limit) { lines.push(line); line = word } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

export function layoutNode(node, measure = browserMeasure) {
  const isRoot = node.parentId === null
  const branch = !isRoot && node.presentation === 'branch'
  const size = node.fontSize || (isRoot ? 28 : 20)
  const font = `${node.italic ? 'italic ' : ''}${isRoot ? 700 : node.font === 'clean' ? 500 : 600} ${size}px ${node.font === 'clean' ? CLEAN : SERIF}`
  const lines = wrapText(branch ? displayText(node).toUpperCase() : displayText(node))
  const lineStep = Math.round(size * 1.2)
  const lineWidths = lines.map((line) => measure(line, font))
  const textWidth = Math.max(...lineWidths)
  const icons = displayIcons(node)
  const iconSize = Math.round(size * 0.9)
  const lead = icons.length * (iconSize + 4) // the icons, then the words
  const width = isRoot ? Math.max(180, lead + textWidth + 50) : Math.max(58, lead + textWidth) + 26
  const height = (isRoot ? 76 : size + 20) + (lines.length - 1) * lineStep
  return { lines, lineStep, icons, iconSize, lead, textWidth, lineWidths, width, height, left: -width / 2 }
}
