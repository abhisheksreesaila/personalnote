/**
 * Apply mechanical, reversible formatting without interpreting note content.
 * Callers decide whether this operates on a selection or an entire text object.
 */
export function prettifySelection(value, start, end) {
  const text = String(value)
  const selectionStart = Math.max(0, Math.min(text.length, Number(start) || 0))
  const selectionEnd = Math.max(selectionStart, Math.min(text.length, Number(end) || 0))
  const selected = selectionStart === selectionEnd ? text : text.slice(selectionStart, selectionEnd)
  const formatted = prettifyText(selected)
  const nextText = selectionStart === selectionEnd
    ? formatted
    : `${text.slice(0, selectionStart)}${formatted}${text.slice(selectionEnd)}`
  return {
    text: nextText,
    start: selectionStart,
    end: selectionStart + formatted.length,
  }
}

export function prettifyText(value) {
  const lines = String(value).replaceAll('\r\n', '\n').split('\n')
  const formatted = lines.map((line) => {
    const withoutTrailingWhitespace = line.replace(/[\t ]+$/g, '')
    const bullet = withoutTrailingWhitespace.match(/^(\s*)[-*+]\s+(.*)$/)
    if (bullet) return `${bullet[1]}• ${bullet[2]}`
    return withoutTrailingWhitespace.replace(/^(#{1,6})(\S)/, '$1 $2')
  })

  const paragraphs = []
  for (let index = 0; index < formatted.length; index += 1) {
    const line = formatted[index]
    const isBlank = line.trim() === ''
    const previous = paragraphs.at(-1)
    const previousIsBullet = /^\s*•\s/.test(previous || '')
    const nextIsBullet = /^\s*•\s/.test(formatted[index + 1] || '')
    if (isBlank) {
      if (previous && !(previousIsBullet && nextIsBullet)) paragraphs.push('')
    } else {
      paragraphs.push(line)
    }
  }

  while (paragraphs[0] === '') paragraphs.shift()
  while (paragraphs.at(-1) === '') paragraphs.pop()
  return paragraphs.join('\n')
}
