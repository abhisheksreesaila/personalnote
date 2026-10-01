// The font choices in the UI are 'Source Serif 4', 'IBM Plex Sans' and 'monospace'. New text in the monospace choice
// is drawn with the loaded Geist Mono and falls back to the system monospace; existing objects keep what they have.
export const DEFAULT_FONT_CHOICE = 'monospace'
export const MONO_STACK = '"Geist Mono", monospace'

export const canvasFontFamily = (choice) => (choice === 'monospace' ? MONO_STACK : choice)
export const fontChoice = (family) => (family === MONO_STACK ? 'monospace' : family)
