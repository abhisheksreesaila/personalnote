// The selection and transform layer for the Leafer canvas (F-028): the official editor plugin, configured to look and behave like the
// Fabric one (blue round corner handles, a turn handle, marquee and shift-click selection, a blue marquee) with the keys left to the
// app (main.js owns the keyboard, so no key fires while typing). The plugin lives in the App's top layer, apart from the note, so
// a drag repaints only the objects that move. Leafer is imported here and in scene.js and nowhere else.
import '@leafer-in/editor'
import { EditorEvent, EditorMoveEvent, EditorRotateEvent, EditorScaleEvent } from '@leafer-in/editor'

const BLUE = '#1c70a8' // Fabric's selectionBorderColor and cornerColor
// A fingertip is far bigger than a mouse pointer: on a touch screen the handles are larger (and so is what each one reaches).
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

export const EDITOR_CONFIG = {
  editSize: 'size', // a resize changes width and height; the letters of a text box never stretch
  keyEvent: false, // arrow keys, Delete and the rest are the app's (isTyping and dialogs are checked there)
  stroke: BLUE,
  strokeWidth: 1.5,
  pointFill: BLUE,
  pointSize: COARSE ? 26 : 10,
  pointRadius: COARSE ? 13 : 5, // round handles, like Fabric's cornerStyle 'circle'
  circle: { fill: '#ffffff', stroke: BLUE, strokeWidth: 1.5, width: COARSE ? 24 : 12, height: COARSE ? 24 : 12, cornerRadius: COARSE ? 12 : 6 }, // the turn handle, off the top edge
  circleDirection: 'top', // like Fabric's turn handle
  circleMargin: COARSE ? 30 : 22,
  rotateGap: 0, // turn freely, as Fabric does
  area: { fill: 'rgba(28, 112, 168, 0.08)', stroke: BLUE },
  hover: true,
  hoverStyle: { stroke: BLUE, strokeWidth: 1 },
  selector: true,
  select: 'press',
  multipleSelect: true,
  boxSelect: true,
  moveable: true,
  resizeable: true,
  rotateable: true,
  skewable: false, // Fabric has no skew handles
  flipable: true,
  hideOnSmall: true,
  openInner: 'none', // a double click edits the words (F-029 overlay, scene.js), not the editor plugin's inner editor
}

export function createEditing({ app, onResize, onGestureEnd, onSelect, onGesture = () => {} }) {
  const editor = app.editor

  // While the box is dragged wider the paper and the words follow it; each target decides what that means.
  editor.on(EditorScaleEvent.SCALE, () => { for (const node of editor.list) onResize(node); onGesture('scale') })
  // F-032: every step of a drag, resize or turn tells the scene (connectors follow, pages grow, the dragged object lifts).
  editor.on(EditorMoveEvent.MOVE, () => onGesture('move'))
  editor.on(EditorRotateEvent.ROTATE, () => onGesture('rotate'))
  editor.on(EditorEvent.SELECT, () => onSelect(editor.list))

  // A gesture ends when the pointer comes up; the editor has finished its last move by then, so look once the event is through.
  const end = () => { if (editor.editing) setTimeout(onGestureEnd, 0) }
  window.addEventListener('pointerup', end, true)
  window.addEventListener('pointercancel', end, true)

  return {
    editor,
    nodes: () => [...editor.list],
    select(nodes) { editor.target = nodes.length ? nodes : null },
    clear() { editor.target = null },
    // Re-reads the selection's size and config (after a lock, a rebuilt node, a nudge).
    refresh() {
      if (!editor.editing) return
      const list = [...editor.list]
      editor.target = null
      editor.target = list
    },
    update() { if (editor.editing) editor.updateEditBox() },
    destroy() {
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
    },
  }
}
