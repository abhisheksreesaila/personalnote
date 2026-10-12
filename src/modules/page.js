/**
 * Page note boundary (F-040).
 *
 * The shell passes a host and an onChange callback and gets back the same editor contract as the mind map (`getDocument`, `setTitle`,
 * `destroy`) plus `setDocument` for an agent's change. CodeMirror loads only when a page note opens, so it stays out of the canvas path.
 */
export async function mountPageModule(host, options) {
  const { mountPage } = await import('../page/page-editor.js')
  return mountPage(host, options)
}
