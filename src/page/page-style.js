// The page note's look (F-041), from the two-layer prototype the captain chose: ivory paper on a warm desk, Literata text, Bricolage
// headings, Figtree controls. Shipped inside the lazy page chunk (not the app's CSS) and installed once, the first time a page opens.
// Screen-only, like the skins (AGENTS.md invariant 9).

const FONTS = 'https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,700;1,7..72,400&family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Figtree:wght@400;500;600&display=swap'

const CSS = `
@media screen {
.page-host {
  --page-desk: #e9e4da; --page-paper: #fffdf8; --page-ink: #1f1b16; --page-muted: #6b6357; --page-line: #e2dbcd;
  --page-markup: #b9b2a6; --page-accent: #2f6fe0; --page-link: #0b7a75; --page-agent: #6a3fc8; --page-red: #d23b26;
  --page-selection: rgba(47, 111, 224, .18); --page-faint: #a39a88; --page-edge: #d8cfbe; --page-on-agent: #fffdf8;
  --page-link-edge: color-mix(in srgb, var(--page-link) 28%, var(--page-paper)); --page-link-wash: color-mix(in srgb, var(--page-link) 4%, var(--page-paper));
  --page-text: "Literata", Georgia, serif; --page-display: "Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif;
  --page-ui: "Figtree", ui-sans-serif, system-ui, sans-serif; --page-mono: "Geist Mono", ui-monospace, monospace;
  position: absolute; inset: 0; min-width: 0; min-height: 0; color: var(--page-ink); background: var(--page-desk); color-scheme: light;
}
.page-host[hidden] { display: none; }
.app-shell .page-host { inset: 66px 12px 12px 4px; border-radius: var(--sk-radius, 14px); overflow: hidden; border: 1px solid var(--page-line); }
.page-active .workspace { overflow: hidden; padding: 0; }
.page-active .tool-dock, .page-active .ink-options-popover, .page-active .voice-button { display: none !important; }
.page-desk { position: absolute; inset: 0; overflow: auto; padding: 28px 16px 120px; overscroll-behavior: contain; }
.page-stage { position: relative; width: 860px; max-width: 100%; margin: 0 auto; }
.page-paper {
  position: relative; min-height: 1080px; padding: 96px 110px 360px; background: var(--page-paper); border-radius: 3px;
  box-shadow: 0 1px 0 rgba(31, 27, 22, .06), 0 18px 40px -18px rgba(60, 40, 10, .35);
}
.page-editor { position: relative; z-index: 1; }
.page-paper .page-icon {
  position: absolute; z-index: 3; left: 110px; top: 18px; width: 64px; height: 64px; padding: 0; border: 0; border-radius: 18px; cursor: pointer;
  background: color-mix(in srgb, var(--t) 36%, var(--page-paper)); font: 38px/64px "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", sans-serif;
}
.page-paper .page-icon:focus-visible { outline: 2px solid var(--page-accent); outline-offset: 2px; }
.page-paper .page-icon:empty { display: none; }
.page-sheets { position: absolute; inset: 0; pointer-events: none; }
.page-sheet-mark {
  position: absolute; left: 0; right: 0; border-top: 1px dashed var(--page-line); padding: 4px 14px 0 0; text-align: right;
  font: 500 11px var(--page-ui); letter-spacing: .06em; text-transform: uppercase; color: var(--page-faint);
}
.page-sheet-mark[hidden] { display: none; }
.page-ink { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none; overflow: visible; }
.page-draw-cursor, .page-draw-cursor * { cursor: crosshair !important; }
.page-drawing-mode .page-paper, .page-drawing-mode .page-paper * { cursor: crosshair !important; }
.page-drawing-mode .page-desk { box-shadow: inset 0 0 0 3px var(--page-accent); }
.page-toolbar {
  position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 14px; width: max-content;
  max-width: 100%; margin: -16px auto 14px; padding: 6px 8px; border-radius: 12px;
  background: var(--page-paper); box-shadow: var(--oq-shadow-2); font: 500 13px var(--page-ui);
}
.page-tool-group { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.page-tool-group:empty { display: none; }
.page-toolbar button {
  display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 5px 10px; border: 1px solid var(--page-line); border-radius: 8px;
  color: var(--page-ink); background: var(--page-paper); font: inherit; cursor: pointer;
}
.page-toolbar button:hover { border-color: var(--page-edge); }
.page-toolbar button[aria-pressed="true"] { color: var(--page-paper); background: var(--page-ink); border-color: var(--page-ink); }
.page-toolbar button:focus-visible { outline: 2px solid var(--page-accent); outline-offset: 2px; }
.page-swatch { width: 10px; height: 10px; border-radius: 99px; flex: none; }
.page-draw-hint {
  display: none; position: sticky; top: 52px; z-index: 5; width: max-content; max-width: 100%; margin: -8px auto 8px; padding: 6px 14px;
  border-radius: 99px; color: var(--page-paper); background: var(--page-ink); font: 12.5px var(--page-ui);
}
.page-drawing-mode .page-draw-hint { display: block; }
.page-link-hint {
  display: none; position: sticky; top: 52px; z-index: 5; width: max-content; max-width: 100%; margin: -8px auto 8px; padding: 6px 14px;
  border-radius: 99px; color: var(--page-on-agent); background: var(--page-agent); font: 12.5px var(--page-ui);
}
.page-linking .page-link-hint { display: block; }
.page-linking .page-paper, .page-linking .page-paper * { cursor: alias !important; }
.page-text-sizes { display: inline-flex; gap: 4px; }
.page-tray { position: absolute; right: 8px; top: 96px; z-index: 3; width: 94px; display: flex; flex-direction: column; gap: 8px; font: 11px var(--page-ui); }
.page-tray[hidden] { display: none; }
.page-tray > p { margin: 0; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--page-agent); }
.page-loose { position: relative; padding: 6px; border: 1.5px dashed var(--page-agent); border-radius: 8px; background: color-mix(in srgb, var(--page-agent) 8%, var(--page-paper)); color: var(--page-agent); }
.page-loose svg { display: block; width: 100%; height: 40px; }
.page-loose button { position: absolute; top: 2px; right: 4px; border: 0; background: none; color: var(--page-agent); font: 600 14px var(--page-ui); cursor: pointer; }
@media (max-width: 900px) { .page-tray { position: static; width: auto; margin-top: 16px; } }
.page-text-sizes[hidden] { display: none; }
/* drawings (F-043) and folding (F-044) */
.page-drawing {
  position: relative; margin: 6px 0; border: 1.5px dashed transparent; border-radius: 8px;
  transition: height .62s cubic-bezier(.22, 1, .36, 1), margin .62s cubic-bezier(.22, 1, .36, 1), border-color .3s, background-color .4s;
}
.page-drawing:hover { border-color: var(--page-edge); }
.page-drawing-art { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none;
  transition: opacity .45s ease .12s, transform .62s cubic-bezier(.22, 1, .36, 1), filter .45s ease; }
.page-drawing-items { position: absolute; inset: 0; transition: opacity .45s ease .12s, transform .62s cubic-bezier(.22, 1, .36, 1), filter .45s ease; }
.page-text-object { position: absolute; white-space: pre; font-family: var(--page-display); font-weight: 700; line-height: 1.1; cursor: text; }
.page-text-edit {
  position: absolute; z-index: 4; margin: 0; padding: 0; border: 0; outline: 1.5px dashed var(--page-accent); outline-offset: 4px; resize: none;
  overflow: hidden; background: transparent; font-family: var(--page-display); font-weight: 700; line-height: 1.1; white-space: pre;
}
.page-drawing-tag {
  position: absolute; right: 8px; bottom: 6px; display: flex; gap: 6px; align-items: center; opacity: 0; transition: opacity .2s;
  font: 11px var(--page-ui); color: var(--page-faint);
}
.page-drawing:hover .page-drawing-tag, .page-drawing:focus-within .page-drawing-tag { opacity: 1; }
.page-drawing-tag button {
  font: 600 11px var(--page-ui); padding: 3px 8px; border-radius: 99px; border: 1px solid var(--page-line); background: var(--page-paper);
  color: var(--page-ink); cursor: pointer;
}
.page-drawing.linked { border-style: solid; border-color: var(--page-link-edge); background-color: var(--page-link-wash); }
.page-drawing.linked .page-drawing-tag { color: var(--page-link); }
.page-drawing.folded { height: 0 !important; margin: 0; border-width: 0; overflow: hidden; }
.page-drawing.folded .page-drawing-art, .page-drawing.folded .page-drawing-items { opacity: 0; transform: translateY(-18px) scale(.97); filter: blur(3px); }
.page-drawing.folded .page-drawing-tag { opacity: 0; }
.page-link-word {
  color: var(--page-link); background: color-mix(in srgb, var(--page-link) 8%, transparent); border-radius: 4px; padding: 0 2px; cursor: pointer;
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--page-link) 45%, transparent); transition: background .25s;
}
.page-link-word:hover { background: color-mix(in srgb, var(--page-link) 16%, transparent); }
.page-link-word::after {
  content: "\\25B8"; display: inline-block; font-size: .62em; margin-left: 3px; vertical-align: .18em; transition: transform .4s cubic-bezier(.22, 1, .36, 1);
}
.page-link-word.open { background: color-mix(in srgb, var(--page-link) 14%, transparent); }
.page-link-word.open::after { transform: rotate(90deg); }
.page-note-link {
  color: var(--page-link); background: color-mix(in srgb, var(--page-link) 8%, transparent); border-radius: 6px; padding: 1px 6px 1px 4px; cursor: pointer;
  box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--page-link) 45%, transparent);
}
.page-note-link::before { content: "\\2197"; font-size: .8em; margin-right: 4px; }
.page-note-link:hover { background: color-mix(in srgb, var(--page-link) 16%, transparent); }
.page-note-link.gone { color: var(--page-muted); background: none; box-shadow: none; text-decoration: line-through; cursor: default; }
.page-note-link.gone::after { content: " (note removed)"; display: inline-block; font-size: .8em; text-decoration: none; }
@media (prefers-reduced-motion: reduce) { .page-drawing, .page-drawing-art, .page-drawing-items, .page-link-word::after { transition: none; } }
@media (max-width: 900px) {
  .app-shell .page-host { inset: 0; border: 0; border-radius: 0; }
  .page-desk { padding: 0 0 96px; }
  .page-paper { padding: 56px 22px 240px; border-radius: 0; box-shadow: none; }
  .page-paper .page-icon { display: none; }
}
/* focus mode (F-073): the page is only its words, in a column on paper; no toolbar, sheet marks or tray */
.app-shell.focus-mode .page-host { inset: 0; border: 0; border-radius: 0; background: var(--paper); }
.focus-mode .page-desk { padding: 0 16px 120px; }
.focus-mode .page-stage { width: 680px; }
.focus-mode .page-paper { padding: 96px 0 360px; background: transparent; box-shadow: none; }
.focus-mode :is(.page-toolbar, .page-sheets, .page-tray, .page-draw-hint, .page-link-hint, .page-ink, .page-drawing, .page-icon) { display: none; }
}
`

let installed = false
export function installPageStyle(doc = document) {
  if (installed) return
  installed = true
  const fonts = doc.createElement('link')
  fonts.rel = 'stylesheet'
  fonts.href = FONTS
  const style = doc.createElement('style')
  style.dataset.pageStyle = ''
  style.textContent = CSS
  doc.head.append(fonts, style)
}
