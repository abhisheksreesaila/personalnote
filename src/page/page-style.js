// The page note's look (F-041), from the two-layer prototype the captain chose: ivory paper on a warm desk, Literata text, Bricolage
// headings, Figtree controls. Shipped inside the lazy page chunk (not the app's CSS) and installed once, the first time a page opens.
// Screen-only, like the skins (AGENTS.md invariant 9).

const FONTS = 'https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,700;1,7..72,400&family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Figtree:wght@400;500;600&display=swap'

const CSS = `
@media screen {
.page-host {
  --page-desk: #e9e4da; --page-paper: #fffdf8; --page-ink: #1f1b16; --page-muted: #6b6357; --page-line: #e2dbcd;
  --page-markup: #b9b2a6; --page-accent: #2f6fe0; --page-link: #0b7a75; --page-agent: #6a3fc8; --page-red: #d23b26;
  --page-selection: rgba(47, 111, 224, .18);
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
.page-sheets { position: absolute; inset: 0; pointer-events: none; }
.page-sheet-mark {
  position: absolute; left: 0; right: 0; border-top: 1px dashed var(--page-line); padding: 4px 14px 0 0; text-align: right;
  font: 500 11px var(--page-ui); letter-spacing: .06em; text-transform: uppercase; color: #b3aa98;
}
.page-sheet-mark[hidden] { display: none; }
@media (max-width: 900px) {
  .app-shell .page-host { inset: 0; border: 0; border-radius: 0; }
  .page-desk { padding: 0 0 96px; }
  .page-paper { padding: 56px 22px 240px; border-radius: 0; box-shadow: none; }
}
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
