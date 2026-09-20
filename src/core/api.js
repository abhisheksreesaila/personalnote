export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })
  if (!response.ok) {
    let message = 'Request failed'
    try {
      message = (await response.json()).error || message
    } catch {}
    throw new Error(message)
  }
  return response.status === 204 ? null : response.json()
}

export async function downloadWorkspaceFile(path, fallbackName) {
  const response = await fetch(`/api${path}`)
  if (!response.ok) throw new Error('Export failed')
  const blob = await response.blob()
  const disposition = response.headers.get('content-disposition') || ''
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  const fileName = encodedName ? decodeURIComponent(encodedName) : plainName || fallbackName
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
