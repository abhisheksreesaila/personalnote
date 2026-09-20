/**
 * Optional built-in mind-map boundary.
 *
 * The notebook shell passes a host plus lifecycle callbacks and receives the
 * existing editor contract (`getDocument`, `setTitle`, `destroy`). Loading the
 * implementation only when a mind-map note opens keeps it out of the canvas
 * capture path without creating a public plugin API.
 */
export async function mountMindMapModule(host, options) {
  const { mountMindMap } = await import('../mindmap/editor.js')
  return mountMindMap(host, options)
}
