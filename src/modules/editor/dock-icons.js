// The dock's own 24px stroke icons, drawn to the design handoff so every tool reads the same.
const PATHS = {
  select: '<path d="M5 3l6 16 2.2-6.8L20 10 5 3z"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 6l3 3"/>',
  marker: '<path d="M9 14l-4 6h6l1.5-2.5"/><path d="M9 14l7-10 4 3-7 10-4-3z"/>',
  shape: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
  sticky: '<path d="M5 4h14v10l-5 6H5z"/><path d="M14 20v-6h5"/>',
  connect: '<circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="5.5" r="2"/><path d="M7.5 16.5c4-1 3-8 9-9"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8.5 8"/>',
  eraser: '<path d="M8 20h12"/><path d="M4.5 15.5l9-9a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L12 18H7l-2.5-2.5z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"/>',
  undo: '<path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h9a5 5 0 010 10h-2"/>',
  redo: '<path d="M15 7l4.5 4.5L15 16"/><path d="M19 11.5h-9a5 5 0 000 10h2"/>',
}

export function dockIcon(name, strokeWidth = 1.7) {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`
}
