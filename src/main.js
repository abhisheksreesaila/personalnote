import './style.css'
import './workspace-theme.css'
import './skins.css'
import './chrome.css'
import { mountSkinSwitcher, startSkins } from './skins.js'
import { MAC_CHROME_CLASS, readHostChrome, setMacFullscreen } from './modules/desktop/hostChrome.js'
import { createIcons, icons } from './icons.js'
import { api, downloadWorkspaceFile } from './core/api.js'
import { createDocumentEncoder, decodeNoteDocument, encodeDocument } from './core/note-codec.js'
import { nudgeDistance } from './core/document/operations.js'
import { createVoiceClient, describeVoice, prepareLocalVoice } from './modules/voice/voice-setup.js'
import { mountMindMapModule } from './modules/mindmap.js'
import { DictationSession } from './modules/voice/transcript-session.js'
import { createMobileHoldController } from './modules/voice/mobile-hold-controller.js'
import { pageBoundedTextLayout, voiceInsertPoint } from './modules/voice/text-layout.js'
import { contentBounds } from './modules/canvas-leafer/bounds.js'
import { mountAgentSync } from './modules/sync/index.js'
import { pickFlagBlock } from './modules/sync/changes.js'
import { dockIcon } from './modules/editor/dock-icons.js'
import { imageFiles, objectPalette, stickyDefaults } from './modules/editor/objects.js'
import { readPreferences, writePreferences } from './preferences.js'
import { createLeaferCanvas } from './modules/canvas-leafer/index.js'
import { createLeaferEdits } from './modules/canvas-leafer/edits.js'
import { mergeDocuments } from './core/document/merge.js'
import { createInk } from './modules/canvas-leafer/ink.js'
import { pictureFiles, prepareImage, uploadPicture } from './modules/canvas-leafer/media.js'
import { renderNotePicture, renderSheet } from './modules/canvas-leafer/export.js'
import { createConnectTool } from './modules/canvas-leafer/connect-tool.js'
import { EDGE_OVERFLOW, shiftedDocument } from './modules/canvas-leafer/pages.js'
import { createSpeedMeter, detectEngine, detectHost, isSpeedMeterShortcut } from './speedMeter.js'
import { createPressToTalk } from './modules/voice/press-to-talk.js'
import { CATEGORIES, categoryLabel, inboxNotes, isQuickNoteShortcut, modifierLabel, outline as notebookOutline, quickNoteKeycap } from './modules/library/outline.js'
import { bindPageLifecycle, canKeepAlive, confirmedRevision, createSaveTiming, joinSaveBody, settleSaves } from './modules/editor/save-flush.js'
import { canPanFromKeyboard as keyboardCanPan, keyboardPan } from './modules/editor/keyboard-pan.js'
import { createTemporaryHand, toolShortcut } from './modules/editor/tool-switch.js'
import { DEFAULT_FONT_CHOICE, canvasFontFamily, fontChoice } from './modules/editor/fonts.js'
import { chooseOpeningView, fitView, openingView, pageLabel, scrollThumbs, stepZoom, viewForPage, visiblePages, zoomPercent } from './modules/editor/navigation.js'
import {
  clampView,
  pageExtents,
  parseBoxShadow,
  shiftExtents,
  viewMargins,
  wheelPanDelta,
  zoomAtPoint,
} from './modules/editor/viewport.js'

const PAGE_WIDTH = 860
const PAGE_HEIGHT = 1080
const CANVAS_ZOOM_MIN = 0.25
const CANVAS_ZOOM_MAX = 4
// desktop.py opens the Chromium app window with engine=chromium (see createSaveTiming).
const saveTiming = createSaveTiming({ fast: new URLSearchParams(location.search).get('engine') === 'chromium' })
const INK_COLORS = [
  ['Charcoal', '#20201e'],
  ['Graphite', '#5f6368'],
  ['Red', '#d14b3f'],
  ['Coral', '#e56b5d'],
  ['Orange', '#df8437'],
  ['Gold', '#d0a12e'],
  ['Green', '#3a7d5a'],
  ['Mint', '#4f9c78'],
  ['Blue', '#1c70a8'],
  ['Cyan', '#2d91a8'],
  ['Violet', '#76669a'],
  ['Magenta', '#b45f8c'],
]
const QUICK_INK_COLORS = [
  ['Charcoal', '#20201e'],
  ['Red', '#d14b3f'],
  ['Orange', '#df8437'],
  ['Green', '#3a7d5a'],
  ['Blue', '#1c70a8'],
]
const STROKE_WIDTHS = {
  pen: [1, 3, 6, 10],
  highlight: [10, 20, 32, 48],
}
const dictationSession = new DictationSession()
const DEFAULT_MINDMAP_DOCUMENT = {
  version: 1,
  title: 'Untitled mind map',
  rootId: 'root',
  defaultPresentation: 'box',
  nodes: [{
    id: 'root', parentId: null, text: 'Central idea', x: 0, y: 0,
    color: '#ef684b', fontSize: 28, bold: true, font: 'hand',
    presentation: 'box', curve: 78,
  }],
}

document.querySelector('#app').innerHTML = `
  <div class="app-shell">
    <div class="note-create-menu" id="note-create-menu" role="menu" aria-label="Create note as" hidden>
      <button role="menuitem" data-create-note-type="canvas"><i data-lucide="file-text"></i><span>Canvas note</span></button>
      <button role="menuitem" data-create-note-type="mindmap"><i data-lucide="git-fork"></i><span>Mind map</span></button>
    </div>
    <div class="sidebar-scrim" id="sidebar-scrim" aria-hidden="true"></div>
    <aside class="sidebar" id="sidebar" aria-label="Notebooks">
      <div class="brand-row">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-name">Personal Note</span>
        <button class="icon-button sidebar-close" id="close-sidebar" title="Close notebooks" aria-label="Close notebooks"><i data-lucide="x"></i></button>
      </div>
      <button class="quick-note hold-create-button" id="rail-new-note" title="New canvas note - hold for more types" aria-label="Quick note. Press and hold for more note types" aria-haspopup="menu" aria-expanded="false">
        <i data-lucide="plus"></i><span>Quick note</span><kbd id="quick-note-kbd">Ctrl N</kbd>
      </button>
      <nav class="notebook-navigator" id="notebook-navigator" aria-label="Inbox and notebooks">
        <div class="notebook-list" id="notebook-list"></div>
      </nav>
      <div class="sidebar-footer">
        <span class="skin-label">Skin</span>
        <span class="skin-switcher" id="skin-switcher"></span>
      </div>
    </aside>

    <main class="main-view">
      <header class="topbar">
        <button class="icon-button glass-button sidebar-toggle" id="toggle-sidebar" title="Notebooks" aria-label="Open notebooks" aria-expanded="false" aria-controls="sidebar"><i data-lucide="panel-left"></i></button>
        <div class="topbar-title">
          <div class="crumb" id="breadcrumb" aria-label="Notebook"><span id="crumb-category">Projects</span><span class="crumb-sep" aria-hidden="true">/</span><b id="crumb-notebook">Notebook</b></div>
          <input class="note-title" id="note-title" value="Untitled note" aria-label="Note title" />
          <div class="save-state" id="save-state"><span></span>Saved on this device</div>
        </div>
        <div class="topbar-actions">
          <button class="search-button" id="search-button" title="Search notes (Ctrl+K)" aria-label="Search notes"><i data-lucide="search"></i><span>Search everything</span><kbd id="search-kbd">Ctrl K</kbd></button>
          <div class="share-wrap">
            <button class="icon-button glass-button share-button" id="share-button" title="Share or export" aria-label="Share or export" aria-haspopup="menu" aria-expanded="false"><i data-lucide="share"></i></button>
            <div class="share-menu" id="share-menu" role="menu" aria-label="Share or export" hidden>
              <button role="menuitem" id="share-print"><i data-lucide="printer"></i><span>Print preview</span><kbd id="print-kbd">Ctrl P</kbd></button>
              <button role="menuitem" id="share-png"><i data-lucide="image-down"></i><span>Note as picture (PNG)</span></button>
              <button role="menuitem" id="share-backup"><i data-lucide="archive"></i><span>Download backup</span></button>
              <button role="menuitem" id="share-markdown"><i data-lucide="file-down"></i><span>Markdown + assets</span></button>
              <button role="menuitem" id="share-vault"><i data-lucide="folder-down"></i><span>Obsidian vault</span></button>
            </div>
          </div>
          <button class="icon-button glass-button" id="clear-note" title="Clear all" aria-label="Clear all"><i data-lucide="eraser"></i></button>
          <button class="icon-button glass-button properties-trigger" id="top-properties" title="Settings and properties" aria-label="Open settings and properties" aria-controls="properties-panel" aria-expanded="false"><i data-lucide="sliders-horizontal"></i></button>
        </div>
      </header>

      <section class="workspace" id="workspace">
        <div class="selection-bar" id="selection-bar" role="toolbar" aria-label="Selected objects" hidden>
          <button type="button" data-selection-action="backward" title="Send backward (Ctrl+[)">Back</button>
          <button type="button" data-selection-action="forward" title="Bring forward (Ctrl+])">Forward</button>
          <button type="button" data-selection-action="lock" title="Lock or unlock (Ctrl+Shift+L)">Lock</button>
          <button type="button" data-selection-action="delete" title="Delete (Delete key)">Delete</button>
        </div>
        <div class="tool-dock" role="toolbar" aria-label="Canvas tools">
          <div class="dock-canvas" id="dock-canvas">
            <div class="tool-group dock-tools">
              <button class="tool-button" data-tool="select" title="Select (V)" aria-label="Select">${dockIcon('select')}</button>
              <button class="tool-button" data-tool="hand" title="Hand (H) - drag to move the canvas; or hold Space" aria-label="Hand"><i data-lucide="hand"></i></button>
              <button class="tool-button active" data-tool="text" data-tool-options title="Text (T) - hold for color" aria-label="Text">${dockIcon('text')}</button>
              <button class="tool-button" data-tool="pen" data-tool-options title="Pen (D or P) - hold for color and width" aria-label="Pen">${dockIcon('pen')}</button>
              <button class="tool-button" data-tool="highlight" data-tool-options title="Highlighter (M) - hold for color and width" aria-label="Highlighter">${dockIcon('marker')}</button>
              <button class="tool-button" data-tool="shape" data-tool-options title="Shape (R) - click the page to place, hold for color" aria-label="Shape">${dockIcon('shape')}</button>
              <button class="tool-button" data-tool="sticky" data-tool-options title="Sticky note (N) - click the page to place, hold for color" aria-label="Sticky note">${dockIcon('sticky')}</button>
              <button class="tool-button" data-tool="connect" title="Connect (C) - drag from one object to another" aria-label="Connect">${dockIcon('connect')}</button>
              <button class="tool-button" id="add-image" title="Image (I) - choose a file, or drop one on the page" aria-label="Add image">${dockIcon('image')}</button>
              <button class="tool-button" data-tool="eraser" title="Stroke eraser (E)" aria-label="Stroke eraser">${dockIcon('eraser')}</button>
            </div>
            <input type="file" id="image-file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />
            <div class="dock-divider"></div>
            <div class="ink-swatches" role="group" aria-label="Ink color">
              ${QUICK_INK_COLORS.map(([name, color]) => `<button class="ink-swatch ${color === '#20201e' ? 'active' : ''}" data-color="${color}" style="--swatch:${color}" title="${name}" aria-label="${name}"></button>`).join('')}
              <button class="tool-button ink-options-trigger" id="ink-options-trigger" title="More colors and widths" aria-label="Open ink options" aria-haspopup="dialog" aria-expanded="false"><span class="ink-options-dot" id="ink-options-dot"></span></button>
            </div>
            <div class="dock-divider"></div>
            <div class="tool-group dock-history">
              <button class="tool-button prettify-button" id="prettify" data-keeps-text-editing title="Prettify selected text or this note" aria-label="Prettify selected text or this note"><i data-lucide="align-left"></i></button>
              <button class="tool-button" id="undo" title="Undo" aria-label="Undo">${dockIcon("undo")}</button>
              <button class="tool-button" id="redo" title="Redo" aria-label="Redo">${dockIcon("redo")}</button>
            </div>
            <button class="voice-button" id="voice-button" data-keeps-text-editing title="Hold to talk, or tap to keep listening" aria-label="Start voice dictation" aria-pressed="false"><span class="voice-button-icon voice-mic-icon">${dockIcon("mic", 2)}</span></button>
          </div>
          <div class="mindmap-dock-actions mindmap-rail-actions" id="mindmap-rail-actions" aria-label="Mind map tools" hidden>
            <button class="tool-button" data-map-action="image" title="Add image" aria-label="Add image"><i data-lucide="image-plus"></i></button>
            <button class="tool-button" data-map-action="import" title="Import JSON" aria-label="Import JSON"><i data-lucide="folder-open"></i></button>
            <button class="tool-button" data-map-action="export-json" title="Export JSON" aria-label="Export JSON"><i data-lucide="braces"></i></button>
            <button class="tool-button" data-map-action="export-png" title="Export PNG" aria-label="Export PNG"><i data-lucide="image-down"></i></button>
            <span class="dock-divider"></span>
            <button class="tool-button" data-map-action="undo" title="Undo" aria-label="Undo"><i data-lucide="undo-2"></i></button>
            <button class="tool-button" data-map-action="redo" title="Redo" aria-label="Redo"><i data-lucide="redo-2"></i></button>
            <span class="dock-divider"></span>
            <button class="tool-button" data-map-action="clean" title="Clean up layout" aria-label="Clean up layout"><i data-lucide="wand-sparkles"></i></button>
            <button class="tool-button" data-map-action="fit" title="Fit map" aria-label="Fit map"><i data-lucide="scan"></i></button>
          </div>
        </div>
        <div class="mobile-capture-controls" aria-label="Canvas capture controls">
          <button class="mobile-tool-button" id="mobile-select" title="Select, move and resize" aria-label="Select, move and resize" aria-pressed="false"><i data-lucide="mouse-pointer-2"></i></button>
          <button class="mobile-tool-button" id="mobile-sticky" title="Sticky note" aria-label="Sticky note" aria-pressed="false"><i data-lucide="sticky-note"></i></button>
          <button class="mobile-connect-button" id="mobile-connect" title="Connect two objects" aria-label="Connect two objects" aria-pressed="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="5.5" r="2"/><path d="M7.5 16.5c4-1 3-8 9-9"/></svg></button>
          <button class="mobile-draw-button" id="mobile-draw" aria-label="Enable drawing"><i data-lucide="pencil"></i><span>Draw</span></button>
          <button class="mobile-speak-button" id="mobile-speak" data-keeps-text-editing title="Hold to speak" aria-label="Hold to speak" aria-pressed="false"><i data-lucide="mic"></i><span>Hold to speak</span></button>
        </div>
        <section class="ink-options-popover" id="ink-options-popover" role="dialog" aria-label="Ink options" hidden>
          <div class="ink-options-heading">
            <span id="ink-color-label">Text color</span>
            <button id="close-ink-options" aria-label="Close ink options"><i data-lucide="x"></i></button>
          </div>
          <div class="ink-palette" id="ink-palette" aria-label="Common colors">
            ${INK_COLORS.map(([name, color]) => `<button class="palette-swatch ${color === '#20201e' ? 'active' : ''}" data-color="${color}" style="--swatch:${color}" title="${name}" aria-label="${name}"></button>`).join('')}
          </div>
          <div class="ink-palette" id="object-palette" aria-label="Note and shape colors" hidden></div>
          <div class="stroke-options" id="stroke-options" hidden>
            <span id="stroke-options-label">Pen width</span>
            <div class="stroke-widths" id="stroke-widths"></div>
          </div>
        </section>

        <div class="voice-caption" id="voice-caption" role="status" hidden><span class="voice-pulse"></span><span id="voice-status">Listening</span></div>
        <div class="eraser-cursor" id="eraser-cursor" hidden></div>

        <div class="paper" id="paper">
          <div class="input-surface" id="note-input"></div>
        </div>
        <div class="mindmap-host" id="mindmap-host" hidden></div>
        <div class="scroll-indicator scroll-indicator-y" id="scroll-y" aria-hidden="true"><span></span></div>
        <div class="scroll-indicator scroll-indicator-x" id="scroll-x" aria-hidden="true"><span></span></div>
        <div class="page-minimap" id="page-minimap" role="group" aria-label="Pages">
          <div class="mini-grid" id="mini-grid"></div>
          <span class="page-count" id="page-count">1 page · 1 × 1</span>
        </div>
        <div class="zoom-control" id="zoom-control" role="group" aria-label="Zoom">
          <button class="icon-button" id="zoom-out" title="Zoom out" aria-label="Zoom out"><i data-lucide="minus"></i></button>
          <button class="zoom-value" id="zoom-value" title="Reset to 100%" aria-label="Zoom level, press to reset to 100%">100%</button>
          <button class="icon-button" id="zoom-in" title="Zoom in" aria-label="Zoom in"><i data-lucide="plus"></i></button>
          <span class="zoom-divider"></span>
          <button class="icon-button" id="zoom-fit" title="Zoom to fit all pages" aria-label="Zoom to fit all pages"><i data-lucide="maximize-2"></i></button>
        </div>
      </section>
    </main>

    <aside class="properties-panel" id="properties-panel" aria-label="Settings and properties" aria-hidden="true" inert>
      <div class="properties-heading">
        <div><span>Inspector</span><h2>Note properties</h2></div>
        <button class="icon-button" id="close-properties" title="Close settings and properties" aria-label="Close settings and properties"><i data-lucide="x"></i></button>
      </div>
      <section class="property-section">
        <label class="property-label">Notebook</label>
        <div class="notebook-picker-wrap">
          <button class="notebook-picker" id="notebook-picker" aria-haspopup="menu" aria-expanded="false"></button>
          <div class="notebook-picker-menu" id="notebook-picker-menu" role="menu" hidden></div>
        </div>
      </section>
      <section class="property-section" id="canvas-typography-properties">
        <div class="property-section-title"><span>Typography</span><small id="text-selection-status">New text</small></div>
        <div class="font-family-control" id="font-family-control" aria-label="Font family">
          <button data-font-family="Source Serif 4" title="Serif" aria-label="Serif">Ag</button>
          <button data-font-family="IBM Plex Sans" title="Sans serif" aria-label="Sans serif">Ag</button>
          <button data-font-family="monospace" title="Monospace" aria-label="Monospace">Ag</button>
        </div>
        <label class="font-size-row" for="font-size-control">
          <span>Size</span><output id="font-size-value">24</output>
          <input id="font-size-control" type="range" min="12" max="72" step="1" value="24" />
        </label>
      </section>
      <div class="mindmap-properties" id="mindmap-properties" hidden></div>
      <section class="property-section property-note-info">
        <div><span id="note-surface-label">Canvas</span><strong id="note-surface-detail">Expands automatically</strong></div>
        <div><span>Storage</span><strong>On this device</strong></div>
      </section>
      <div class="properties-section-heading"><span>Workspace settings</span></div>
      <section class="settings-section">
        <p class="settings-section-label">Writing</p>
        <div class="setting-field-heading"><span>Default text</span><small>New objects</small></div>
        <div class="font-family-control settings-font-control" aria-label="Default font family">
          <button data-default-font-family="Source Serif 4" title="Serif" aria-label="Serif">Ag</button>
          <button data-default-font-family="IBM Plex Sans" title="Sans serif" aria-label="Sans serif">Ag</button>
          <button data-default-font-family="monospace" title="Monospace" aria-label="Monospace">Ag</button>
        </div>
        <label class="font-size-row settings-font-size-row" for="settings-font-size">
          <span>Size</span><output id="settings-font-size-value">24</output>
          <input id="settings-font-size" type="range" min="12" max="72" step="1" value="24" />
        </label>
      </section>
      <section class="settings-section">
        <p class="settings-section-label">Performance</p>
        <label class="setting-row" for="settings-speed-meter"><span><i data-lucide="gauge"></i>Show speed meter</span><input type="checkbox" id="settings-speed-meter" aria-keyshortcuts="Control+Shift+F" title="Ctrl/Cmd+Shift+F" /></label>
        <p class="portability-help speedtest-offer">The speed test measures this computer on a generated note of 5,000+ objects. It opens in a window of its own and leaves your notes alone.</p>
        <div class="portability-actions speedtest-offer"><button type="button" id="settings-speed-test"><i data-lucide="gauge"></i><span>Run speed test…</span></button></div>
      </section>
      <section class="settings-section">
        <p class="settings-section-label">Built-in modules</p>
        <div class="setting-row"><span><i data-lucide="git-fork"></i>Mind maps</span><small id="settings-mindmap">On demand</small></div>
        <div class="setting-row"><span><i data-lucide="mic"></i>Voice capture</span><small id="settings-voice">Transcript only</small></div>
        <div class="setting-row"><span><i data-lucide="audio-lines"></i>Audio retention</span><small>None</small></div>
      </section>
      <section class="settings-section" id="settings-voice-section" aria-labelledby="settings-voice-label">
        <p class="settings-section-label" id="settings-voice-label">Voice</p>
        <div class="setting-row"><span><i data-lucide="mic"></i>Dictation</span><small id="voice-setup-headline">Checking…</small></div>
        <progress id="voice-setup-progress" max="100" value="0" aria-label="Voice download progress" hidden></progress>
        <p class="portability-help" id="voice-setup-detail" role="status" aria-live="polite"></p>
        <div class="portability-actions">
          <button id="voice-download" hidden><i data-lucide="download"></i><span></span></button>
          <button id="voice-cancel" hidden><i data-lucide="x"></i><span></span></button>
          <button id="voice-remove" hidden><i data-lucide="trash-2"></i><span></span></button>
        </div>
      </section>
      <section class="settings-section">
        <p class="settings-section-label">Workspace data</p>
        <div class="setting-row"><span><i data-lucide="hard-drive"></i>Storage</span><small id="settings-storage">SQLite · This device</small></div>
        <div class="portability-actions">
          <button id="download-backup"><i data-lucide="archive"></i><span>Download backup</span></button>
          <button id="export-markdown"><i data-lucide="file-down"></i><span>Markdown + assets</span></button>
          <button id="import-backup"><i data-lucide="folder-input"></i><span>Import backup</span></button>
          <input id="import-backup-file" type="file" accept="application/json,.json" hidden />
        </div>
        <p class="portability-help">Backup JSON preserves editable canvas and mind-map data. Import merges copies without replacing existing notes.</p>
        <p class="portability-status" id="portability-status" role="status" aria-live="polite"></p>
      </section>
      <div class="properties-footer">
        <button class="delete-note-action" id="delete-note"><i data-lucide="trash-2"></i><span>Delete note</span></button>
      </div>
    </aside>

  </div>

  <div class="search-backdrop" id="search-backdrop" hidden>
    <section class="spotlight" role="dialog" aria-modal="true" aria-label="Search notes">
      <div class="spotlight-input-row">
        <i data-lucide="search"></i>
        <input id="search-input" type="search" placeholder="Search every note" autocomplete="off" aria-label="Search every note" />
        <button class="search-close" id="search-close" aria-label="Close search">Esc</button>
      </div>
      <div class="search-results" id="search-results"></div>
      <footer class="search-footer"><span><i data-lucide="corner-down-left"></i> Open</span><span><i data-lucide="arrow-up-down"></i> Navigate</span></footer>
    </section>
  </div>

  <section class="print-preview" id="print-preview" aria-label="Print preview" aria-hidden="true" hidden>
    <header class="print-preview-bar">
      <button class="print-back" id="close-print" aria-label="Close print preview"><i data-lucide="arrow-left"></i><span>Back to note</span></button>
      <div class="print-preview-title">
        <strong id="print-note-title">Print preview</strong>
        <span id="print-sheet-count">1 sheet</span>
      </div>
      <div class="print-actions">
        <label class="paper-select">Paper
          <select id="print-paper" aria-label="Print paper size">
            <option value="letter">Letter</option>
            <option value="a4">A4</option>
          </select>
        </label>
        <button class="print-button" id="print-note"><i data-lucide="printer"></i><span>Print</span></button>
      </div>
    </header>
    <div class="print-preview-body">
      <aside class="print-summary">
        <div class="print-summary-mark"><i data-lucide="layout-grid"></i></div>
        <strong>Canvas to paper</strong>
        <p>Each outlined canvas page becomes one printed sheet. Content crossing a boundary appears on both sheets at that exact cut.</p>
        <dl>
          <div><dt>Layout</dt><dd id="print-layout">1 x 1</dd></div>
          <div><dt>Sheets</dt><dd id="print-summary-count">1</dd></div>
          <div><dt>Scale</dt><dd>Fit to paper</dd></div>
        </dl>
      </aside>
      <main class="print-sheet-list" id="print-sheet-list" aria-live="polite"></main>
    </div>
  </section>

  <dialog class="notebook-dialog" id="notebook-dialog">
    <form method="dialog" id="notebook-form">
      <div class="dialog-heading-row">
        <div>
          <p class="dialog-eyebrow">Notebook</p>
          <h2 id="notebook-dialog-title">New notebook</h2>
        </div>
        <button class="icon-button" value="cancel" aria-label="Close"><i data-lucide="x"></i></button>
      </div>
      <label class="field-label" for="notebook-name">Name</label>
      <input class="notebook-name-input" id="notebook-name" maxlength="80" required />
      <fieldset class="color-fieldset">
        <legend>Section</legend>
        <div class="category-options" id="notebook-categories">
          ${CATEGORIES.map((category) => `
            <label class="category-option">
              <input type="radio" name="notebook-category" value="${category}" ${category === 'projects' ? 'checked' : ''} />
              <span>${categoryLabel(category)}</span>
            </label>
          `).join('')}
        </div>
      </fieldset>
      <fieldset class="color-fieldset">
        <legend>Color</legend>
        <div class="notebook-colors" id="notebook-colors">
          ${['#B86B4B', '#D09A45', '#6F8C63', '#4D839C', '#7A6F9B', '#A55D6F'].map((color) => `
            <label class="notebook-color" style="--notebook-color:${color}">
              <input type="radio" name="notebook-color" value="${color}" ${color === '#B86B4B' ? 'checked' : ''} />
              <span></span>
            </label>
          `).join('')}
        </div>
      </fieldset>
      <p class="dialog-note" id="notebook-dialog-note">Give related notes a quiet place of their own.</p>
      <div class="dialog-actions">
        <button class="delete-notebook" id="delete-notebook" type="button" hidden>Delete notebook</button>
        <button class="dialog-cancel" value="cancel">Cancel</button>
        <button class="dialog-primary" id="save-notebook" value="default">Create</button>
      </div>
    </form>
  </dialog>

  <div class="toast" id="toast" role="status" aria-live="polite" hidden><span></span><button id="toast-action" type="button">Undo</button></div>

`

createIcons({ icons })
const skinSwitcher = mountSkinSwitcher(document.querySelector('#skin-switcher'))
// The macOS window (desktop.py opens it with ?host=desktop&chrome=mac) extends under its title bar.
if (readHostChrome(location.search).chrome === 'mac') document.documentElement.classList.add(MAC_CHROME_CLASS)

const elements = {
  shell: document.querySelector('.app-shell'),
  selectionBar: document.querySelector('#selection-bar'),
  workspace: document.querySelector('#workspace'),
  paper: document.querySelector('#paper'),
  mindmapHost: document.querySelector('#mindmap-host'),
  title: document.querySelector('#note-title'),
  list: document.querySelector('#notebook-navigator'),
  notebookList: document.querySelector('#notebook-list'),
  saveState: document.querySelector('#save-state'),
  pageCount: document.querySelector('#page-count'),
  pageMinimap: document.querySelector('#page-minimap'),
  miniGrid: document.querySelector('#mini-grid'),
  zoomControl: document.querySelector('#zoom-control'),
  zoomValue: document.querySelector('#zoom-value'),
  scrollX: document.querySelector('#scroll-x'),
  scrollY: document.querySelector('#scroll-y'),
  dockCanvas: document.querySelector('#dock-canvas'),
  breadcrumbCategory: document.querySelector('#crumb-category'),
  breadcrumbNotebook: document.querySelector('#crumb-notebook'),
  shareButton: document.querySelector('#share-button'),
  shareMenu: document.querySelector('#share-menu'),
  sidebarScrim: document.querySelector('#sidebar-scrim'),
  sidebar: document.querySelector('#sidebar'),
  notebookPicker: document.querySelector('#notebook-picker'),
  notebookPickerMenu: document.querySelector('#notebook-picker-menu'),
  searchBackdrop: document.querySelector('#search-backdrop'),
  searchButton: document.querySelector('#search-button'),
  searchInput: document.querySelector('#search-input'),
  searchResults: document.querySelector('#search-results'),
  notebookDialog: document.querySelector('#notebook-dialog'),
  toast: document.querySelector('#toast'),
  toastAction: document.querySelector('#toast-action'),
  mobileSpeak: document.querySelector('#mobile-speak'),
  mobileConnect: document.querySelector('#mobile-connect'),
  notebookForm: document.querySelector('#notebook-form'),
  notebookName: document.querySelector('#notebook-name'),
  sidebarToggle: document.querySelector('#toggle-sidebar'),
  properties: document.querySelector('#properties-panel'),
  canvasTypographyProperties: document.querySelector('#canvas-typography-properties'),
  noteSurfaceLabel: document.querySelector('#note-surface-label'),
  noteSurfaceDetail: document.querySelector('#note-surface-detail'),
  printButton: document.querySelector('#share-print'),
  fontSize: document.querySelector('#font-size-control'),
  fontSizeValue: document.querySelector('#font-size-value'),
  settingsFontSize: document.querySelector('#settings-font-size'),
  settingsSpeedMeter: document.querySelector('#settings-speed-meter'),
  settingsFontSizeValue: document.querySelector('#settings-font-size-value'),
  voiceButton: document.querySelector('#voice-button'),
  voiceCaption: document.querySelector('#voice-caption'),
  voiceStatus: document.querySelector('#voice-status'),
  eraserCursor: document.querySelector('#eraser-cursor'),
  inkOptionsTrigger: document.querySelector('#ink-options-trigger'),
  inkOptionsDot: document.querySelector('#ink-options-dot'),
  inkPalette: document.querySelector('#ink-palette'),
  objectPalette: document.querySelector('#object-palette'),
  imageFile: document.querySelector('#image-file'),
  inkOptionsPopover: document.querySelector('#ink-options-popover'),
  inkColorLabel: document.querySelector('#ink-color-label'),
  strokeOptions: document.querySelector('#stroke-options'),
  strokeOptionsLabel: document.querySelector('#stroke-options-label'),
  strokeWidths: document.querySelector('#stroke-widths'),
  portabilityStatus: document.querySelector('#portability-status'),
  importBackupFile: document.querySelector('#import-backup-file'),
  printPreview: document.querySelector('#print-preview'),
  printSheetList: document.querySelector('#print-sheet-list'),
  printPaper: document.querySelector('#print-paper'),
  noteCreateMenu: document.querySelector('#note-create-menu'),
  mindmapProperties: document.querySelector('#mindmap-properties'),
  mindmapRailActions: document.querySelector('#mindmap-rail-actions'),
}

const state = {
  notes: [],
  notebooks: [],
  activeNoteId: null,
  activeNoteType: 'canvas',
  selectedNotebookId: null,
  inboxOpen: false,
  archiveOpen: false,
  pages: { columns: 1, rows: 1 },
  tool: 'text',
  color: '#20201e',
  objectColor: 0,
  penWidth: 3,
  highlightWidth: 20,
  fontFamily: DEFAULT_FONT_CHOICE,
  fontSize: 24,
  speedMeter: false,
  displayScale: 1,
  canvasZoom: 1,
  recognition: null,
  listening: false,
  voiceError: null,
  voiceMode: null,
  localTranscription: null,
  microphoneCapture: null,
  localFinishTimer: null,
  voiceAttempt: 0,
  creatingNote: false,
  loading: false,
}

let mindmapEditor = null

function setActiveNoteType(noteType) {
  state.activeNoteType = noteType === 'mindmap' ? 'mindmap' : 'canvas'
  const isMindMap = state.activeNoteType === 'mindmap'
  elements.shell.classList.toggle('mindmap-active', isMindMap)
  elements.paper.hidden = isMindMap
  elements.mindmapHost.hidden = !isMindMap
  elements.pageMinimap.hidden = isMindMap
  elements.zoomControl.hidden = isMindMap
  elements.dockCanvas.hidden = isMindMap
  if (isMindMap) hideScrollIndicators()
  elements.canvasTypographyProperties.hidden = isMindMap
  elements.mindmapProperties.hidden = !isMindMap
  elements.mindmapRailActions.hidden = !isMindMap
  elements.properties.querySelector('.properties-heading span').textContent = isMindMap ? 'Mind map' : 'Inspector'
  elements.properties.querySelector('.properties-heading h2').textContent = isMindMap ? 'Node properties' : 'Note properties'
  elements.noteSurfaceLabel.textContent = isMindMap ? 'Mind map' : 'Canvas'
  elements.noteSurfaceDetail.textContent = isMindMap ? 'Infinite SVG workspace' : 'Expands automatically'
  elements.printButton.disabled = isMindMap
  elements.printButton.title = isMindMap ? 'Print preview is available for canvas notes' : 'Print preview'
  if (!isMindMap) {
    mindmapEditor?.destroy()
    mindmapEditor = null
  }
}

async function mountActiveMindMap(documentValue) {
  mindmapEditor?.destroy()
  mindmapEditor = await mountMindMapModule(elements.mindmapHost, {
    documentValue,
    inspectorRoot: elements.mindmapProperties,
    controlsRoot: elements.mindmapRailActions,
    createIcons: () => createIcons({ icons }),
    onChange: () => queueSave(),
  })
}

function loadPreferences() {
  const preferences = readPreferences()
  if (preferences.fontFamily) state.fontFamily = preferences.fontFamily
  if (preferences.fontSize) state.fontSize = preferences.fontSize
  if (preferences.speedMeter) state.speedMeter = true
}

function savePreferences() {
  writePreferences(undefined, { fontFamily: state.fontFamily, fontSize: state.fontSize, speedMeter: state.speedMeter })
}

loadPreferences()

// ADR 0001: Leafer is the canvas. It draws the open note from the document model (JSON Canvas is the stored form, ADR 0002); a transparent
// input surface over it hosts the pan, zoom and touch gestures and the placing clicks of the text and sticky tools. A note that was not
// edited is never rewritten: a save (a new title, say) sends the note's own content back untouched, and only for the note that content
// was loaded from. An edited note is saved from the document model.
let leaferCanvas = null
let leaferHost = null
let leaferInk = null // the pen, highlighter and eraser (F-031)
let leaferConnect = null // the connect tool (F-032)
// Saving an edited note writes only what changed: the encoder keeps the JSON of every object it has written (core/note-codec.js).
const leaferEncoder = createDocumentEncoder()
// The first save of a note that was just opened would write the JSON of every object (150 ms on 5,000, a stall right after the first edit):
// it is done ahead, in idle slices of a few milliseconds, and every later save writes only what changed. The scene's layout is done ahead
// the same way (the first click would pay 80 ms for it).
let encoderWarmToken = 0
function warmLeaferEncoder() {
  const mine = ++encoderWarmToken
  let layoutWarmed = false
  const later = (run) => (typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(run, { timeout: 1500 }) : setTimeout(run, 40))
  const slice = () => {
    if (mine !== encoderWarmToken || !leaferEdits.doc) return
    if (!layoutWarmed) { layoutWarmed = true; leaferCanvas?.warmLayout(); return later(slice) }
    let done = true
    try { done = leaferEncoder.warm(leaferEdits.doc, 5) } catch (error) { console.warn('encoder warm-up stopped', error); return }
    if (!done) later(slice)
  }
  later(slice)
}
let leaferBase = null // the document as last loaded or last saved: what an agent's merge is measured against
let leaferSource = { noteId: null, content: { nodes: [], edges: [] }, pageState: { columns: 1, rows: 1 } } // the open note exactly as loaded

// The window the pages are shown in, always exactly as large as the workspace.
const viewSize = { width: Math.max(1, elements.workspace.clientWidth || PAGE_WIDTH), height: Math.max(1, elements.workspace.clientHeight || PAGE_HEIGHT) }
// The transparent layer over the Leafer picture: it takes the pointer when the select tool is not the one picking (the hand pans, the text
// and sticky tools place), and it is where touch pan and pinch begin.
const inputSurface = document.querySelector('#note-input')

const CANVAS_FONT_SPECS = [
  '400 24px "Source Serif 4"',
  '600 24px "Source Serif 4"',
  '400 24px "IBM Plex Sans"',
  '600 24px "IBM Plex Sans"',
  '500 34px "Caveat"',
  '400 24px "Geist Mono"',
]
let canvasFontLoadPromise


function loadCanvasFonts() {
  canvasFontLoadPromise ||= Promise.allSettled(
    CANVAS_FONT_SPECS.map((spec) => document.fonts.load(spec)),
  )
  return canvasFontLoadPromise
}

function refreshCanvasTextMetrics() {
  leaferCanvas?.refreshText()
}

async function prepareCanvasFonts() {
  await Promise.race([
    loadCanvasFonts(),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ])
  refreshCanvasTextMetrics()
}

let inkOptionsCloseTimer

function currentObjectPalette() {
  const styles = getComputedStyle(document.documentElement)
  return objectPalette((name) => styles.getPropertyValue(name))
}

function closeInkOptions() {
  clearTimeout(inkOptionsCloseTimer)
  elements.inkOptionsPopover.hidden = true
  elements.inkOptionsTrigger.setAttribute('aria-expanded', 'false')
  document.querySelectorAll('[data-tool-options]').forEach((button) => button.setAttribute('aria-expanded', 'false'))
}

function scheduleInkOptionsClose(delay = 750) {
  clearTimeout(inkOptionsCloseTimer)
  inkOptionsCloseTimer = setTimeout(closeInkOptions, delay)
}

function updateInkOptions() {
  elements.inkOptionsDot.style.setProperty('--active-ink', state.color)
  const placing = state.tool === 'sticky' || state.tool === 'shape'
  elements.inkPalette.hidden = placing
  elements.objectPalette.hidden = !placing
  if (placing) {
    elements.inkColorLabel.textContent = state.tool === 'sticky' ? 'Note color' : 'Shape color'
    elements.objectPalette.innerHTML = currentObjectPalette().map(({ fill }, index) => `
      <button class="palette-swatch object-swatch ${index === state.objectColor ? 'active' : ''}" data-object-color="${index}" style="--swatch:${fill}" aria-label="Color ${index + 1}"></button>
    `).join('')
  } else {
    elements.inkColorLabel.textContent = state.tool === 'text' ? 'Text color' : 'Ink color'
  }
  document.querySelectorAll('.palette-swatch:not(.object-swatch), .ink-swatch').forEach((swatch) => {
    swatch.classList.toggle('active', swatch.dataset.color === state.color)
  })

  const drawingTool = state.tool === 'pen' || state.tool === 'highlight' ? state.tool : null
  elements.strokeOptions.hidden = !drawingTool
  if (!drawingTool) return
  const widthKey = drawingTool === 'pen' ? 'penWidth' : 'highlightWidth'
  elements.strokeOptionsLabel.textContent = drawingTool === 'pen' ? 'Pen width' : 'Highlighter width'
  elements.strokeWidths.innerHTML = STROKE_WIDTHS[drawingTool].map((width) => `
    <button class="stroke-width-button ${state[widthKey] === width ? 'active' : ''}" data-stroke-width="${width}" aria-label="${width} pixel ${drawingTool} width" title="${width} px">
      <span style="--stroke-preview:${Math.min(width, 12)}px"></span>
    </button>
  `).join('')
}

function positionInkOptions(anchor) {
  const anchorRect = anchor.getBoundingClientRect()
  const popoverWidth = elements.inkOptionsPopover.offsetWidth
  const railWidth = Number.parseFloat(getComputedStyle(elements.shell).getPropertyValue('--rail-width')) || 0
  const minimum = railWidth + 8 + popoverWidth / 2
  const maximum = window.innerWidth - 8 - popoverWidth / 2
  const center = anchorRect.left + anchorRect.width / 2
  elements.inkOptionsPopover.style.left = `${Math.max(minimum, Math.min(maximum, center))}px`
}

function openInkOptions(anchor = elements.inkOptionsTrigger) {
  clearTimeout(inkOptionsCloseTimer)
  updateInkOptions()
  elements.inkOptionsPopover.hidden = false
  elements.inkOptionsTrigger.setAttribute('aria-expanded', String(anchor === elements.inkOptionsTrigger))
  document.querySelectorAll('[data-tool-options]').forEach((button) => {
    button.setAttribute('aria-expanded', String(button === anchor))
  })
  positionInkOptions(anchor)
}

function toggleInkOptions() {
  if (!elements.inkOptionsPopover.hidden) return closeInkOptions()
  openInkOptions(elements.inkOptionsTrigger)
}

const suppressedToolClicks = new WeakSet()

function setupToolOptionGestures() {
  document.querySelectorAll('[data-tool-options]').forEach((button) => {
    let holdTimer
    let startPoint
    let held = false

    const cancelHold = () => {
      clearTimeout(holdTimer)
      button.classList.remove('is-holding')
    }

    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      held = false
      startPoint = { x: event.clientX, y: event.clientY }
      button.classList.add('is-holding')
      try { button.setPointerCapture?.(event.pointerId) } catch {}
      holdTimer = setTimeout(() => {
        held = true
        suppressedToolClicks.add(button)
        setTool(button.dataset.tool)
        openInkOptions(button)
        navigator.vibrate?.(8)
        button.classList.remove('is-holding')
      }, 420)
    })

    button.addEventListener('pointermove', (event) => {
      if (!startPoint || Math.hypot(event.clientX - startPoint.x, event.clientY - startPoint.y) <= 10) return
      startPoint = null
      cancelHold()
    })

    button.addEventListener('pointerup', (event) => {
      startPoint = null
      cancelHold()
      try { button.releasePointerCapture?.(event.pointerId) } catch {}
      if (held) event.preventDefault()
    })
    button.addEventListener('pointercancel', () => {
      startPoint = null
      cancelHold()
    })
    button.addEventListener('contextmenu', (event) => event.preventDefault())
  })
}

function escapeHtml(value) {
  const element = document.createElement('div')
  element.textContent = value
  return element.innerHTML
}

function noteRowHtml(note, { dotFor = null } = {}) {
  const dot = dotFor
    ? `<span class="notebook-dot" style="--notebook-color:${dotFor.color}" title="${escapeHtml(dotFor.name)}"></span>`
    : `<i data-lucide="${note.noteType === 'mindmap' ? 'git-fork' : 'file-text'}"></i>`
  return `
    <button class="note-list-item ${note.id === state.activeNoteId ? 'active' : ''}" data-note-id="${note.id}" draggable="true">
      ${dot}
      <span>${escapeHtml(note.title || 'Untitled note')}</span>
    </button>
  `
}

function notebookRowHtml(notebook, selectedNotebook) {
  const isSelected = notebook.id === selectedNotebook?.id
  const notes = isSelected ? state.notes.filter((note) => note.notebookId === notebook.id) : []
  return `
    <div class="nav-row ${isSelected ? 'active' : ''}">
      <button class="notebook-tab ${isSelected ? 'active' : ''}" data-notebook-select="${notebook.id}" data-notebook-drop="${notebook.id}" aria-expanded="${isSelected}">
        <span class="notebook-dot" style="--notebook-color:${notebook.color}"></span>
        <span class="notebook-name">${escapeHtml(notebook.name)}</span>
        <span class="notebook-count">${notebook.count}</span>
      </button>
      <button class="nav-edit" data-edit-notebook="${notebook.id}" title="Edit ${escapeHtml(notebook.name)}" aria-label="Edit notebook ${escapeHtml(notebook.name)}"><i data-lucide="more-horizontal"></i></button>
    </div>
    ${isSelected ? `
      <div class="nav-notes" role="group" aria-label="Notes in ${escapeHtml(notebook.name)}">
        ${notes.length ? notes.map((note) => noteRowHtml(note)).join('') : '<div class="empty-notebook"><span>No notes yet</span></div>'}
      </div>` : ''}
  `
}

function renderNoteList() {
  const activeNote = state.notes.find((note) => note.id === state.activeNoteId)
  const selectedNotebook = state.notebooks.find((notebook) => notebook.id === state.selectedNotebookId)
    || state.notebooks.find((notebook) => notebook.id === activeNote?.notebookId)
    || state.notebooks[0]
  if (selectedNotebook) state.selectedNotebookId = selectedNotebook.id

  const sections = notebookOutline(state.notebooks, state.notes)
  const selectedSection = sections.find((section) => section.notebooks.some((item) => item.id === selectedNotebook?.id))
  const archiveOpen = state.archiveOpen || selectedSection?.id === 'archive'
  const notebookById = new Map(state.notebooks.map((notebook) => [notebook.id, notebook]))
  const recent = state.inboxOpen ? inboxNotes(state.notes) : []

  const inboxHtml = `
    <button class="nav-item inbox-tab ${state.inboxOpen ? 'active' : ''}" data-inbox-toggle aria-expanded="${state.inboxOpen}">
      <i data-lucide="inbox"></i><span class="notebook-name">Inbox</span><span class="notebook-count" title="Most recent notes">${inboxNotes(state.notes).length}</span>
    </button>
    ${state.inboxOpen ? `
      <div class="nav-notes" role="group" aria-label="Recent notes">
        ${recent.length ? recent.map((note) => noteRowHtml(note, { dotFor: notebookById.get(note.notebookId) || { color: '#B86B4B', name: 'Notebook' } })).join('') : '<div class="empty-notebook"><span>No notes yet</span></div>'}
      </div>` : ''}
  `

  const sectionHtml = sections.map((section) => {
    if (section.id === 'archive') {
      return `
        <div class="nav-section nav-archive">
          <button class="nav-item archive-tab" data-archive-toggle aria-expanded="${archiveOpen}">
            <i data-lucide="archive"></i><span class="notebook-name">Archive</span><span class="notebook-count">${section.notebooks.length}</span>
            <i class="nav-chevron ${archiveOpen ? 'open' : ''}" data-lucide="chevron-right"></i>
          </button>
          ${archiveOpen ? section.notebooks.map((notebook) => notebookRowHtml(notebook, selectedNotebook)).join('') : ''}
        </div>`
    }
    return `
      <div class="nav-section" data-category="${section.id}">
        <div class="nav-heading">
          <span>${section.label}</span>
          <button class="nav-add" data-new-notebook="${section.id}" title="New notebook in ${section.label}" aria-label="New notebook in ${section.label}"><i data-lucide="plus"></i></button>
        </div>
        ${section.notebooks.map((notebook) => notebookRowHtml(notebook, selectedNotebook)).join('')}
      </div>`
  }).join('')

  // Keep the outline's scroll position across re-renders.
  const scrollTop = elements.list.scrollTop
  elements.notebookList.innerHTML = inboxHtml + sectionHtml
  elements.list.scrollTop = scrollTop

  const notebookForCrumb = state.notebooks.find((item) => item.id === activeNote?.notebookId) || selectedNotebook
  elements.breadcrumbCategory.textContent = categoryLabel(notebookForCrumb?.category)
  elements.breadcrumbNotebook.textContent = notebookForCrumb?.name || 'Notebook'
  renderNotebookPicker()
  createIcons({ icons })
}

function renderNotebookPicker() {
  const activeNote = state.notes.find((note) => note.id === state.activeNoteId)
  const notebook = state.notebooks.find((item) => item.id === activeNote?.notebookId)
  if (!notebook) {
    elements.notebookPicker.innerHTML = ''
    return
  }
  elements.notebookPicker.innerHTML = `
    <span class="picker-dot" style="--notebook-color:${notebook.color}"></span>
    <span>${escapeHtml(notebook.name)}</span><i data-lucide="chevron-down"></i>
  `
  elements.notebookPickerMenu.innerHTML = state.notebooks.map((item) => `
    <button role="menuitem" data-move-to-notebook="${item.id}" class="${item.id === notebook.id ? 'active' : ''}">
      <span class="picker-dot" style="--notebook-color:${item.color}"></span>
      <span>${escapeHtml(item.name)}</span>${item.id === notebook.id ? '<i data-lucide="check"></i>' : ''}
    </button>
  `).join('')
}

const SAVED_LABEL = `Saved on this ${/mac|iphone|ipad/i.test(navigator.platform) ? 'Mac' : 'device'}`

function setSaveState(status, isError = false) {
  if (status === 'Saving' && !isError && elements.saveState.dataset.state === 'Saving') return // already showing it: leave the spinner running
  elements.saveState.dataset.state = status
  elements.saveState.classList.toggle('error', isError)
  elements.saveState.innerHTML = status === 'Saving'
    ? '<span class="saving-spinner"></span>Saving'
    : `<span></span>${status === 'Saved' ? SAVED_LABEL : status}`
}

let viewportOffsetX = 0
const layoutListeners = [] // told when the view or the note's content moved (the agent flag follows it)
const layoutChanged = () => layoutListeners.forEach((listener) => listener())
let viewportOffsetY = 0
let pageExtentsNow = pageExtents(1, 1, PAGE_WIDTH, PAGE_HEIGHT)
let pageColors = { paper: '#fbfaf5', label: '#6e6e78', radius: 6, edge: '#2c2c34', accent: '#2f6fe0', accentInk: '#ffffff', shadows: [] }

function getDisplayScale() {
  if (window.innerWidth > 800) return 1
  return Math.min(1, (elements.workspace.clientWidth - 24) / PAGE_WIDTH)
}

function getCanvasScale() {
  return state.displayScale * state.canvasZoom
}

function getInputFontSize() {
  return window.innerWidth <= 800 ? Math.max(32, state.fontSize) : state.fontSize
}

function resolveShadowLayer(layer) {
  const probe = document.createElement('canvas')
  probe.width = probe.height = 1
  const probeContext = probe.getContext('2d', { willReadFrequently: true })
  probeContext.fillStyle = layer.color
  probeContext.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = probeContext.getImageData(0, 0, 1, 1).data
  return { ...layer, rgb: `rgb(${r}, ${g}, ${b})`, peak: a / 255 }
}

function refreshPageColors() {
  const styles = getComputedStyle(document.documentElement)
  const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback
  const highContrast = window.matchMedia('(prefers-contrast: more)').matches
  pageColors = {
    paper: read('--paper', '#fbfaf5'),
    label: read('--ui-muted', '#6e6e78'),
    radius: Number.parseFloat(read('--sk-page-radius', '6')) || 0,
    accent: read('--accent', '#4D839C'),
    accentInk: read('--sk-accent-ink', '#ffffff'),
    edge: highContrast ? read('--line', '#2c2c34') : read('--sk-edge', read('--line', '#2c2c34')),
    shadows: parseBoxShadow(read('--sk-shadow', 'none')).map(resolveShadowLayer),
  }
  leaferCanvas?.setColors(pageColors)
}

// The view is always exactly as large as the workspace. Page growth only changes the page count.
function syncCanvasSize() {
  const width = Math.max(1, elements.workspace.clientWidth)
  const height = Math.max(1, elements.workspace.clientHeight)
  if (viewSize.width === width && viewSize.height === height) return false
  viewSize.width = width
  viewSize.height = height
  leaferCanvas?.resize(width, height)
  return true
}

function pageExtentsTarget() {
  return pageExtents(state.pages.columns, state.pages.rows, PAGE_WIDTH, PAGE_HEIGHT)
}

function clampedViewOffset(offsetX, offsetY, keep = false, scale = getCanvasScale()) {
  const target = pageExtentsTarget()
  return clampView({ x: offsetX, y: offsetY }, {
    viewW: viewSize.width,
    viewH: viewSize.height,
    contentW: target.right,
    contentH: target.bottom,
    scale,
    margins: viewMargins(window.innerWidth),
    keep,
    previous: { x: viewportOffsetX, y: viewportOffsetY },
  })
}

function setCanvasViewportOffset(offsetX = viewportOffsetX, offsetY = viewportOffsetY, keep = false) {
  let next = clampedViewOffset(offsetX, offsetY, keep)
  // A view that no longer overlaps any page (after an undo or a fold-back) goes at once, not animated, to the nearest page edge.
  if (!keep) {
    const scale0 = getCanvasScale()
    const target = pageExtentsTarget()
    const apart = next.x + target.right * scale0 <= 0 || next.x >= viewSize.width || next.y + target.bottom * scale0 <= 0 || next.y >= viewSize.height
    if (apart) next = clampView({ x: next.x, y: next.y }, { viewW: viewSize.width, viewH: viewSize.height, contentW: target.right, contentH: target.bottom, scale: scale0, margins: viewMargins(window.innerWidth) })
  }
  const previousX = viewportOffsetX
  const moved = next.y !== viewportOffsetY
  viewportOffsetX = next.x
  viewportOffsetY = next.y
  const scale = getCanvasScale()
  leaferCanvas?.setView({ x: next.x, y: next.y, scale })
  scheduleHandleClearance()
  layoutChanged()
  updateNavigationUi(moved || next.x !== previousX)
}

// ---- Page minimap, zoom control and scroll indicator. They only read the view; the canvas owns it.
let miniGridKey = ''
let scrollFadeTimer

function updateMiniGrid() {
  const { columns, rows } = state.pages
  const visible = visiblePages({
    view: { x: viewportOffsetX, y: viewportOffsetY, scale: getCanvasScale() },
    viewW: viewSize.width, viewH: viewSize.height, columns, rows, pageW: PAGE_WIDTH, pageH: PAGE_HEIGHT,
  })
  const key = `${columns}x${rows}:${[...visible].join(',')}`
  if (key === miniGridKey) return
  miniGridKey = key
  elements.miniGrid.style.setProperty('--mini-columns', Math.min(columns, 8))
  elements.miniGrid.innerHTML = Array.from({ length: columns * rows }, (_, index) => `
    <button class="mini-page ${visible.has(index) ? 'on' : ''}" data-page-index="${index}" aria-label="Go to page ${index + 1}" title="Page ${index + 1}"></button>
  `).join('')
}

function hideScrollIndicators() {
  elements.scrollX.classList.remove('visible')
  elements.scrollY.classList.remove('visible')
}

function updateScrollIndicators(reveal) {
  if (state.activeNoteType !== 'canvas') return
  const target = pageExtentsTarget()
  const thumbs = scrollThumbs({
    view: { x: viewportOffsetX, y: viewportOffsetY, scale: getCanvasScale() },
    viewW: viewSize.width, viewH: viewSize.height,
    contentW: target.right, contentH: target.bottom, margins: viewMargins(window.innerWidth),
  })
  for (const [axis, element, thumb] of [['x', elements.scrollX, thumbs.x], ['y', elements.scrollY, thumbs.y]]) {
    const bar = element.firstElementChild
    element.hidden = !thumb
    if (!thumb) continue
    bar.style[axis === 'y' ? 'height' : 'width'] = `${thumb.length * 100}%`
    bar.style.transform = axis === 'y'
      ? `translateY(${(thumb.start / thumb.length) * 100}%)`
      : `translateX(${(thumb.start / thumb.length) * 100}%)`
    if (reveal) element.classList.add('visible')
  }
  if (reveal) {
    clearTimeout(scrollFadeTimer)
    scrollFadeTimer = setTimeout(hideScrollIndicators, 900)
  }
}

function updateNavigationUi(reveal = false) {
  elements.zoomValue.textContent = `${zoomPercent(getCanvasScale())}%`
  updateMiniGrid()
  updateScrollIndicators(reveal)
}

// Jumps the view to a target { x, y, scale } (scale is the real canvas scale, not the relative zoom). No glide: the
// view lands on the next paint, like a zoom.
function setViewTo(view) {
  state.canvasZoom = view.scale / state.displayScale
  const scale = getCanvasScale()
  viewportOffsetX = view.x
  viewportOffsetY = view.y
  leaferCanvas?.setView({ x: view.x, y: view.y, scale })
  scheduleHandleClearance()
  layoutChanged()
  updateNavigationUi(true)
}

function zoomTarget(nextZoom, point = { x: viewSize.width / 2, y: viewSize.height / 2 }) {
  const zoom = Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, nextZoom))
  const scale = state.displayScale * zoom
  const view = zoomAtPoint({ x: viewportOffsetX, y: viewportOffsetY, scale: getCanvasScale() }, scale, point)
  const clamped = clampedViewOffset(view.x, view.y, false, scale)
  return { x: clamped.x, y: clamped.y, scale }
}

function zoomStep(direction) {
  const next = stepZoom(state.canvasZoom, direction, { min: CANVAS_ZOOM_MIN, max: CANVAS_ZOOM_MAX })
  setViewTo(zoomTarget(next))
}

function fitAllPages() {
  const target = pageExtentsTarget()
  const margins = viewMargins(window.innerWidth)
  const fit = fitView({
    viewW: viewSize.width, viewH: viewSize.height, contentW: target.right, contentH: target.bottom,
    margins, min: state.displayScale * CANVAS_ZOOM_MIN, max: state.displayScale * 1,
  })
  const clamped = clampedViewOffset(fit.x, fit.y, false, fit.scale)
  setViewTo({ x: clamped.x, y: clamped.y, scale: fit.scale })
}

function resetZoom() {
  setViewTo(zoomTarget(1))
}

function goToPage(index) {
  const column = index % state.pages.columns
  const row = Math.floor(index / state.pages.columns)
  const scale = getCanvasScale()
  const view = viewForPage({ column, row, scale, viewW: viewSize.width, viewH: viewSize.height, pageW: PAGE_WIDTH, pageH: PAGE_HEIGHT })
  const clamped = clampedViewOffset(view.x, view.y, false, scale)
  setViewTo({ x: clamped.x, y: clamped.y, scale })
}

const OPEN_ZOOM_MIN = 0.4
const OPEN_OBJECT_LIMIT = 150

// A note opens with its whole page grid on the desk (zoomed out). A dense note would pan at a crawl with hundreds of
// objects on screen, so it opens on its first page, or at full size if even that is crowded. Phones keep the
// full-width first page.
function openCanvasView() {
  if (window.innerWidth <= 800) return resetCanvasView()
  const target = pageExtentsTarget()
  const margins = viewMargins(window.innerWidth)
  const viewW = viewSize.width
  const viewH = viewSize.height
  const min = state.displayScale * OPEN_ZOOM_MIN
  const max = state.displayScale
  const whole = openingView({
    viewW, viewH, contentW: target.right, contentH: target.bottom,
    margins: { ...margins, left: 72, right: 72, bottom: margins.bottom + 10 }, min, max,
  })
  const firstPage = fitView({ viewW, viewH, contentW: PAGE_WIDTH, contentH: PAGE_HEIGHT, margins, min, max })
  const actual = { scale: max, x: (viewW - PAGE_WIDTH * max) / 2, y: margins.top }
  const boxes = leaferCanvas.boxes()
  const view = chooseOpeningView([whole, firstPage, actual], viewW, viewH, boxes, OPEN_OBJECT_LIMIT, { width: target.right, height: target.bottom })
  state.canvasZoom = view.scale / state.displayScale
  setCanvasViewportOffset(view.x, view.y)
}

function resetCanvasView() {
  const scale = getCanvasScale()
  const target = pageExtentsTarget()
  // Centre the pages when they fit; otherwise start at the first page rather than mid-grid.
  const freeWidth = viewSize.width - target.right * scale
  viewportOffsetX = freeWidth >= 48 ? freeWidth / 2 : 24
  viewportOffsetY = viewMargins(window.innerWidth).top
  setCanvasViewportOffset(viewportOffsetX, viewportOffsetY)
}

function zoomCanvasAt(nextZoom, point) {
  const zoom = Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, nextZoom))
  if (zoom === state.canvasZoom) return
  const previous = { x: viewportOffsetX, y: viewportOffsetY, scale: getCanvasScale() }
  state.canvasZoom = zoom
  const next = zoomAtPoint(previous, getCanvasScale(), point)
  setCanvasViewportOffset(next.x, next.y)
}

// Retargets the drawn page tiles at once. `shift` is the world distance every object
// moved when pages were prepended, so the view is compensated and nothing jumps.
// `settle`: pages folded away, so the view is put back inside the content now (the page growth `keep` would leave it for the next pan to
// snap), F-009.
function resizePaper(shiftX = 0, shiftY = 0, settle = false) {
  state.displayScale = getDisplayScale()
  syncCanvasSize()
  const target = pageExtentsTarget()
  const from = shiftExtents(pageExtentsNow, shiftX, shiftY)
  const changed = !settle && (from.left !== target.left || from.top !== target.top
    || from.right !== target.right || from.bottom !== target.bottom)
  pageExtentsNow = target
  const scale = getCanvasScale()
  if (shiftX || shiftY) {
    viewportOffsetX -= shiftX * scale
    viewportOffsetY -= shiftY * scale
  }
  setCanvasViewportOffset(viewportOffsetX, viewportOffsetY, !settle && Boolean(shiftX || shiftY || changed))
  leaferCanvas?.setPages(state.pages)
  elements.pageCount.textContent = pageLabel(state.pages.columns, state.pages.rows)
  updateMiniGrid()
  updateScrollIndicators(false)
}

const temporaryHand = createTemporaryHand()
let applyingTemporaryHand = false

const toolCursor = () => (state.tool === 'hand' ? 'grab' : state.tool === 'text' ? 'text' : state.tool === 'eraser' ? 'none' : state.tool === 'connect' || state.tool === 'sticky' || state.tool === 'shape' ? 'crosshair' : 'default')
const TOOLS = new Set(['select', 'hand', 'text', 'sticky', 'shape', 'pen', 'highlight', 'eraser', 'connect'])
function setTool(tool) {
  if (!TOOLS.has(tool)) tool = 'select'
  if (!applyingTemporaryHand) temporaryHand.cancel()
  state.tool = tool
  document.querySelectorAll('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool))
  if (tool === 'text' || tool === 'sticky' || tool === 'shape') leaferCanvas?.clearSelection() // placing words: no handles on the canvas meanwhile
  if (tool === 'pen' || tool === 'highlight' || tool === 'eraser' || tool === 'connect') leaferCanvas?.clearSelection()
  leaferInk?.setTool(tool)
  leaferConnect?.setTool(tool)
  elements.shell.classList.toggle('leafer-picking', tool === 'select') // Leafer takes the pointer to select and move; the hand gives it to the pan
  inputSurface.style.cursor = toolCursor()
  for (const [id, name] of [['mobile-select', 'select'], ['mobile-sticky', 'sticky'], ['mobile-draw', 'pen']]) {
    const button = document.getElementById(id)
    button?.classList.toggle('active', tool === name)
    button?.setAttribute('aria-pressed', String(tool === name))
  }
  elements.mobileConnect.classList.toggle('active', tool === 'connect')
  elements.mobileConnect.setAttribute('aria-pressed', String(tool === 'connect'))
  updateInkOptions()
  if (tool !== 'eraser') elements.eraserCursor.hidden = true
}

// A shape: a rounded rectangle in the chosen object colour, selected, one undo step.
function placeShape(point) {
  setTool('select')
  leaferCanvas.createShape(point, { fill: currentObjectPalette()[state.objectColor].fill })
}

// A sticky note. (A mouse press opens the overlay on the next tick: the press must finish first, or it takes the focus back. A tap's click is the end already.)
function placeSticky(point, { now = false } = {}) {
  const at = { x: point.x, y: point.y }
  setTool('select')
  if (now) leaferCanvas.createSticky(at)
  else setTimeout(() => leaferCanvas.createSticky(at), 0)
}

function viewCenterPoint() {
  const scale = getCanvasScale()
  return { x: (viewSize.width / 2 - viewportOffsetX) / scale, y: (viewSize.height / 2 - viewportOffsetY) / scale }
}

// Each picture is shrunk off the main thread, stored once in the media library, and placed as a reference to it.
async function placeLeaferPictures(files, point) {
  const pictures = pictureFiles(files)
  const noteId = state.activeNoteId
  const made = []
  for (const file of pictures) {
    try {
      const { blob, width, height } = await prepareImage(file)
      const mediaId = await uploadPicture(blob)
      made.push({ mediaId, url: URL.createObjectURL(blob), width, height })
    } catch (error) {
      console.error(error)
      setSaveState(error?.message || 'Could not add that picture', true)
    }
  }
  const dropMade = () => { for (const picture of made) URL.revokeObjectURL(picture.url); return 0 }
  if (!made.length) return 0
  // A drag, a stroke, an erase pass or typing in progress when the upload finishes is never interrupted: the pictures wait for it to end.
  while (gestureBusy()) {
    if (noteId !== state.activeNoteId || leaferSwitching) return dropMade()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (noteId !== state.activeNoteId || leaferSwitching) return dropMade() // the note was left while the pictures were being prepared
  setTool('select')
  return leaferCanvas.addImages(made, point).length
}

// True while the pointer is held down on the page, a pen or eraser stroke is under way, or words are being typed on the canvas.
let pointerHeld = false
for (const type of ['pointerdown']) window.addEventListener(type, () => { pointerHeld = true }, true)
for (const type of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(type, () => { pointerHeld = false }, true)
const gestureBusy = () => pointerHeld || Boolean(leaferInk?.active) || Boolean(leaferCanvas?.isEditingText())

async function placeImageFiles(files, point = viewCenterPoint()) {
  const pictures = imageFiles(files)
  if (!pictures.length || state.activeNoteType !== 'canvas') return 0
  return placeLeaferPictures(pictures, point)
}

let saveTimer
let saveInFlight = false
let speedTestPaused = false // the speed test edits a note of its own and saves nothing while it runs
let saveSettled = Promise.resolve() // resolves when the save in flight has been answered (or has failed)
const MERGE_WAIT_MS = 4000 // how long a merge waits for a save that moved the page frame
const MERGE_RETRY_MS = 3000
let saveFrame = null // the page frame the save in flight was written in
let saveDone = () => {}
let saveQueued = false
// Agent sync: edits not yet saved.
let unsavedEdits = false
let agentSync = null

async function saveActiveNote({ unloading = false } = {}) {
  if (!state.activeNoteId || state.loading || speedTestPaused) return
  if (saveInFlight && !unloading) {
    saveQueued = true
    return
  }
  // The page is going away with a save still in flight: send the latest edits now with the last confirmed
  // revision. Never guess ahead: if the in-flight save lands first this one conflicts and overwrites nothing.
  const parallelUnload = saveInFlight && unloading
  if (parallelUnload) saveQueued = false
  else { saveInFlight = true; saveSettled = new Promise((resolve) => { saveDone = resolve }) }
  unsavedEdits = false
  setSaveState('Saving')
  const noteId = state.activeNoteId
  const note = state.notes.find((item) => item.id === noteId)
  try {
    if (state.activeNoteType === 'canvas' && leaferSource.noteId !== noteId) throw Object.assign(new Error('the content on hand belongs to another note'), { refused: true })
    const title = elements.title.value.trim() || 'Untitled note'
    if (state.activeNoteType === 'mindmap') mindmapEditor?.setTitle(title)
    // A note that was not edited goes back as the server sent it (JSON Canvas), untouched; an edited one is written from the document model.
    const editedLeafer = state.activeNoteType === 'canvas' && leaferSource.editedDoc
    const savedShift = leaferSource.shift
    saveFrame = editedLeafer && savedShift ? savedShift : null
    const savedContent = state.activeNoteType === 'mindmap' ? mindmapEditor?.getDocument() : leaferSource.content
    const fields = {
      title,
      pageState: state.activeNoteType === 'canvas' ? leaferSource.pageState : state.pages,
      notebookId: note?.notebookId,
      revision: note?.revision,
    }
    // An edited Leafer note's text is joined in as it was kept, not walked again (and never searched for: a title can say anything).
    const body = editedLeafer
      ? joinSaveBody(leaferSource.contentJson, fields)
      : JSON.stringify({ ...fields, content: savedContent })
    saveTiming.saved(body)
    // While the page is going away a keepalive request is the only one guaranteed to be sent (it takes the text itself). Otherwise the
    // body goes as a Blob: handing a note of megabytes to fetch as a string copies it on the main thread and stalls a drag for ~100 ms.
    const mergesBefore = mergeCount
    const result = await api(`/notes/${noteId}`, { method: 'PUT', body: unloading ? body : new Blob([body]), keepalive: unloading && canKeepAlive(body) })
    if (note) Object.assign(note, { title, revision: confirmedRevision(note.revision, result.revision), resourceId: result.resourceId })
    // What the server now holds is the base for the next merge, unless the note was left or a merge moved the base on while this save was out.
    // The server holds what was just saved, in the frame it was saved in, whether or not a merge came meanwhile; the base moves on only when none did.
    if (editedLeafer && noteId === state.activeNoteId && leaferSource.noteId === noteId && savedShift) leaferServerShift = savedShift
    if (editedLeafer && noteId === state.activeNoteId && leaferSource.noteId === noteId && mergeCount === mergesBefore) { leaferBase = editedLeafer; if (savedShift) leaferBaseShift = savedShift }
    renderNoteList()
    setSaveState('Saved')
  } catch (error) {
    console.error(error)
    // A refused save is dropped, not retried: it would be refused again and block switching notes.
    unsavedEdits = !error.refused
    if (/revision/i.test(error.message)) {
      // An agent wrote first: this is not a failure. Merge its changes into the edits and save again on its revision.
      setSaveState('Saving')
      const mark = mergeCount
      agentSync?.syncActiveNote().catch(console.error).finally(() => { if (mergeCount === mark) setSaveState('Could not save', true) })
    } else setSaveState('Could not save', true)
  } finally {
    if (!parallelUnload) { saveInFlight = false; saveFrame = null; saveDone() }
    if (saveQueued && !parallelUnload) {
      const unloadingNext = saveQueued === 'unloading'
      saveQueued = false
      saveActiveNote({ unloading: unloadingNext })
    }
  }
}

function queueSave() {
  if (state.loading || speedTestPaused) return
  unsavedEdits = true
  // Any edit after Clear all ends its Undo, so Ctrl/Cmd+Z goes back to ordinary undo.
  if (pendingClearUndo) hideToast()
  setSaveState('Saving')
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveActiveNote, saveTiming.saveDelay())
}

// Sends anything still waiting on the two debounces (history 180ms, save 650ms; 100ms and 150ms in the Chromium window) right now.
function flushPendingEdits(reason) {
  // Hiding the window may come back (Undo must still work); only a real close sends the held delete.
  if (reason !== 'hidden') void commitPendingDelete({ keepalive: true })
  if (state.loading || !state.activeNoteId) return
  leaferCanvas?.finishTextEdit() // words still being typed in the overlay become an edit (and a save) now
  if (mindmapChanged()) queueSave()
  if (!unsavedEdits) return
  clearTimeout(saveTimer)
  saveActiveNote({ unloading: true })
}
bindPageLifecycle({ windowTarget: window, documentTarget: document, flush: flushPendingEdits })

// Lets the desktop window wait for edits to land before it closes: resolves true once nothing is unsaved.
// Window-state hooks desktop.py calls; defined here, not in the lazy desktop chunk, so an early call is never lost.
const windowHooks = {
  setFullscreen: (on) => setMacFullscreen(document.documentElement, on),
  setMacChrome: (on) => document.documentElement.classList.toggle(MAC_CHROME_CLASS, Boolean(on)),
}
window.personalNote = {
  ...windowHooks,
  flush: () => settleSaves({
    flushPending: () => {
      void commitPendingDelete({ keepalive: true })
      if (state.loading || !state.activeNoteId) return
      leaferCanvas?.finishTextEdit()
      if (mindmapChanged()) queueSave()
      clearTimeout(saveTimer)
    },
    isSaving: () => saveInFlight || deleteInFlight,
    hasUnsaved: () => unsavedEdits,
    save: () => saveActiveNote(),
  }),
}

// A mind map announces its edits through onChange. What it was when it was loaded is kept, so that leaving it unchanged sends nothing and a
// change that was not announced still goes out. A canvas note needs none of this: the Leafer scene queues a save for every edit it records.
let mindmapSnapshot = null
function mindmapChanged() {
  if (state.activeNoteType !== 'mindmap') return false
  const next = JSON.stringify({ content: mindmapEditor?.getDocument() })
  if (next === mindmapSnapshot) return false
  mindmapSnapshot = next
  return true
}

// Lands the outgoing note's pending edits and save, with its own confirmed revision, before another note loads.
// Waits at most SWITCH_SAVE_LIMIT; returns false when the save did not land, and the edits stay marked unsaved.
const SWITCH_SAVE_LIMIT = 3000
async function settleOutgoingNote() {
  if (state.loading || !state.activeNoteId) return true
  leaferCanvas?.finishTextEdit()
  const settled = settleSaves({
    flushPending: () => {
      if (mindmapChanged()) queueSave()
      clearTimeout(saveTimer)
    },
    isSaving: () => saveInFlight,
    hasUnsaved: () => unsavedEdits,
    save: () => saveActiveNote(),
  })
  let timer
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(false), SWITCH_SAVE_LIMIT) })
  const landed = await Promise.race([settled, limit])
  clearTimeout(timer)
  if (!landed) {
    unsavedEdits = true
    setSaveState('Could not save', true)
    queueSave()
  }
  return landed
}

// Undo and redo (F-030): the history lives in modules/canvas-leafer/edits.js; this puts each new document on screen and saves it.
// The stored form is made when a save asks for it (a held arrow key makes many edits for one save).
// How far the page frame has moved since the note was last loaded (pages added or folded on the top or left shift every object), and what it
// was when the server's copy was written: an agent's write is in the server's frame, so a merge moves it into ours first.
let leaferFrameShift = { x: 0, y: 0 }
let leaferServerShift = { x: 0, y: 0 }
let leaferBaseShift = { x: 0, y: 0 } // the frame leaferBase is written in (a merge's base is what the server held, which was in the server's frame)
function leaferSourceOf(noteId, doc) {
  return { noteId, editedDoc: doc, shift: { ...leaferFrameShift }, get contentJson() { const json = leaferEncoder.encode(doc); Object.defineProperty(this, 'contentJson', { value: json }); return json }, pageState: { ...doc.page } }
}
const leaferEdits = createLeaferEdits({
  sizeOf: (object) => leaferCanvas?.sizeOf(object) ?? {},
  onChange(doc, { kind, changed, page, pageShift, viewShift, selection }) {
    if (leaferSource.noteId !== state.activeNoteId) return
    if (pageShift) leaferFrameShift = { x: leaferFrameShift.x + pageShift.x, y: leaferFrameShift.y + pageShift.y }
    // Pages added or folded on the top or left moved every object; the view moves by the same amount, so what is on screen stays where it is.
    if ((page || viewShift) && (viewShift?.x || viewShift?.y || !samePageGrid(doc.page, state.pages))) {
      const folded = doc.page.columns < state.pages.columns || doc.page.rows < state.pages.rows || kind === 'undo' || kind === 'redo' // F-009: after a fold-back or an undo the view settles inside the content now, not at the next pan
      state.pages = { ...doc.page }
      resizePaper(viewShift?.x ?? 0, viewShift?.y ?? 0, folded)
    }
    // An edit made on the canvas is already on screen (the scene recorded it); any other change (an undo, a redo, an edit recorded
    // from elsewhere) draws the document again, with the objects the step names selected.
    if (!leaferCanvas.isCommitting()) {
      // An undo or a redo draws again only the objects the step names; a step that moved the page frame, and any other change, draws the note again.
      if ((kind === 'undo' || kind === 'redo') && !pageShift) leaferCanvas.applyChanged(doc, changed)
      else leaferCanvas.load(doc)
      leaferCanvas.select(selection)
    }
    leaferSource = leaferSourceOf(leaferSource.noteId, doc)
    queueSave()
    layoutChanged()
  },
})
// Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, Ctrl+Y, the dock buttons and the desktop menu all arrive here. (A mind map has undo of its own.)
function stepHistory(direction) {
  if (state.activeNoteType === 'mindmap' || state.loading) return
  if (direction < 0) leaferEdits.undo()
  else leaferEdits.redo()
}

// Note JSON -> document model -> Leafer nodes, and the view and page grid to match.
let leaferShowSequence = 0
let leaferShowFixed = false
// Returns false when a later selection or refresh superseded this one while the note was being converted: nothing is drawn then.
async function showLeaferNote(note, { openView = true } = {}) {
  // The stored JSON Canvas is read straight into the document model; the note's own content is kept to save back until it is edited.
  const showing = ++leaferShowSequence
  const decoded = await decodeNoteDocument(note)
  if (showing !== leaferShowSequence || note.id !== state.activeNoteId) return false
  leaferInk?.documentChanged() // the document is replaced: an erase pass planned on the old one is dropped
  leaferSource = { noteId: note.id, content: note.content || { objects: [] }, pageState: decoded.doc.page }
  state.pages = { ...decoded.doc.page } // a copy: the document the history holds is never edited through the paper state
  resizePaper()
  leaferFrameShift = { x: 0, y: 0 } // the document as the server holds it is the frame the page rules count from
  leaferServerShift = { x: 0, y: 0 }
  leaferBaseShift = { x: 0, y: 0 }
  const shown = leaferCanvas.showDocument(decoded.doc, { resolveMedia: decoded.resolveMedia })
  if (openView) leaferEdits.open(note.id, shown) // a newly opened note starts a new undo history; an agent's newer content does not (undo never reverts it)
  else leaferEdits.remote(note.id, shown)
  leaferCanvas.adopt(leaferEdits.doc) // the scene edits the document the history holds
  leaferBase = leaferEdits.doc
  warmLeaferEncoder()
  // An arrow the note was stored with out of line (an agent moved what it joins) was brought in line on screen; what is stored is not, yet.
  leaferShowFixed = shown !== decoded.doc
  if (leaferShowFixed && !openView) leaferSource = leaferSourceOf(note.id, leaferEdits.doc) // (a note just opened keeps its stored content until it is edited)
  if (openView) openCanvasView()
  leaferCanvas.setColors(pageColors)
  leaferCanvas.whenSettled().then(() => { document.documentElement.dataset.leaferSettled = String(state.activeNoteId) })
  return true
}

// While the text editor is open the page may not zoom (iOS zooms in on a field with small text when it takes the focus); the rest of the
// time the viewport allows the person's own pinch-zoom.
function setPageZoomLocked(locked) {
  const meta = document.querySelector('meta[name="viewport"]')
  if (!meta) return
  const base = 'width=device-width, initial-scale=1.0'
  meta.setAttribute('content', locked ? `${base}, maximum-scale=1.0` : base)
}

function mountLeaferCanvas() {
  const host = document.createElement('div')
  leaferHost = host
  host.id = 'leafer-host'
  elements.paper.prepend(host)
  leaferCanvas = createLeaferCanvas({ host, width: viewSize.width, height: viewSize.height, onOperation: (op, options) => leaferEdits.record(op, options),
    onBegin: (label) => leaferEdits.begin(label),
    onEnd: () => leaferEdits.end(),
    // A drag, a resize or a turn brought an object near an edge: the page grid grows in every direction.
    onPages: ({ columns, rows, shiftX, shiftY }) => { state.pages = { ...state.pages, columns, rows }; resizePaper(shiftX, shiftY) },
    onTextEvent: (type) => {
      if (type === 'escape') setTool('select')
      if (type === 'start' || type === 'end') setPageZoomLocked(type === 'start')
    },
    // What a new text and a new sticky look like, in the model's words.
    defaults: {
      text: () => ({ fontFamily: canvasFontFamily(state.fontFamily), fontSize: getInputFontSize(), color: state.color }),
      sticky: () => {
        const { fill, ink } = currentObjectPalette()[state.objectColor]
        const { fontFamily, fontSize, fontWeight, lineHeight } = stickyDefaults({ fill, ink })
        return { fill, ink, style: { fontFamily, fontSize, fontWeight, lineHeight } }
      },
    },
  })
}
mountLeaferCanvas()

// The pen, highlighter and eraser (F-031). The stroke is a model object recorded as one undo step; a page grows when the pen
// goes past the right or bottom edge.
leaferInk = createInk({
  host: elements.paper,
  scene: leaferCanvas,
  getDoc: () => leaferEdits.doc,
  getBrush: () => ({ color: state.color, width: state.tool === 'highlight' ? state.highlightWidth : state.penWidth }),
  getPages: () => state.pages,
  growPages(point) {
    let { columns, rows } = state.pages
    if (point.x > columns * PAGE_WIDTH + EDGE_OVERFLOW) columns += 1
    if (point.y > rows * PAGE_HEIGHT + EDGE_OVERFLOW) rows += 1
    if (columns === state.pages.columns && rows === state.pages.rows) return false
    state.pages = { ...state.pages, columns, rows } // a new object: the document the history holds shares the old one
    resizePaper()
    return true
  },
  setPages(pages) { state.pages = { ...pages }; resizePaper() },
  cursor: elements.eraserCursor,
})

// The connect tool (F-032): press on an object, drag to another, and an arrow joins them (one undo step).
leaferConnect = createConnectTool({ host: elements.paper, scene: leaferCanvas, getColor: () => state.color })

// The bar over the canvas that does with the mouse what the keys do (Back, Forward, Lock, Delete); it shows while something is selected.
leaferCanvas.onSelection(() => { updateSelectionBar(); syncTypographyControls(); scheduleHandleClearance() })
// A floating control (zoom, pages, dock) that sits right over one of the selection's handles stands aside (faint, no pointer) so the handle can be grabbed.
let clearanceFrame = 0
function scheduleHandleClearance() {
  if (clearanceFrame) return
  clearanceFrame = requestAnimationFrame(() => {
    clearanceFrame = 0
    const controls = [...document.querySelectorAll('.zoom-control, .page-minimap')]
    const ids = leaferCanvas?.selection() ?? []
    const host = leaferHost?.getBoundingClientRect()
    let handles = []
    if (ids.length && host) {
      let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity
      for (const id of ids) {
        const box = leaferCanvas.screenBox(id)
        if (!box) continue
        left = Math.min(left, box.x); top = Math.min(top, box.y); right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height)
      }
      if (left !== Infinity) {
        const midX = (left + right) / 2; const midY = (top + bottom) / 2
        handles = [[left, top], [midX, top], [right, top], [left, midY], [right, midY], [left, bottom], [midX, bottom], [right, bottom], [midX, top - 22]].map(([x, y]) => ({ x: host.left + x, y: host.top + y }))
      }
    }
    for (const control of controls) {
      const rect = control.getBoundingClientRect()
      const under = rect.width > 0 && handles.some((p) => p.x > rect.left - 10 && p.x < rect.right + 10 && p.y > rect.top - 10 && p.y < rect.bottom + 10)
      control.classList.toggle('is-clear-of-handles', under)
    }
  })
}
window.addEventListener('pointerup', () => setTimeout(scheduleHandleClearance, 30), true)
function updateSelectionBar() {
  const selection = leaferCanvas.selection()
  elements.selectionBar.hidden = !selection.length
  const locked = selection.some((id) => leaferCanvas.isLocked(id))
  const lockButton = elements.selectionBar.querySelector('[data-selection-action="lock"]')
  lockButton.textContent = locked ? 'Unlock' : 'Lock'
  elements.selectionBar.classList.toggle('is-locked', locked)
}
elements.selectionBar.addEventListener('pointerdown', (event) => event.stopPropagation())
elements.selectionBar.addEventListener('click', (event) => {
  const action = event.target.closest('[data-selection-action]')?.dataset.selectionAction
  if (action === 'forward' || action === 'backward') leaferCanvas.reorderSelection(action)
  else if (action === 'lock') toggleLeaferLock()
  else if (action === 'delete') leaferCanvas.deleteSelection()
  updateSelectionBar()
})

let selectSequence = 0
// From the moment a switch to another note starts until it has landed, the old note takes no more input on the Leafer canvas: an edit
// made then would land on a note that is being left (and be dropped).
let leaferSwitching = 0
// Dictation ends when a switch to another note starts: the words already final stay in the note being left (and go out with its save);
// an interim result still being heard is dropped, and nothing more arrives for the new note.
async function stopDictationForSwitch() {
  if (!state.listening) return
  if (dictationSession.active && dictationSession.partial) updateVoiceTextBox(dictationSession.preview(''), { create: false }) // the interim words go first (before anything is awaited)
  if (state.voiceMode === 'browser') {
    state.recognition?.abort?.()
    removeEmptyVoiceTextBox()
    dictationSession.cancel()
    setVoiceListening(false)
    state.voiceMode = null
  } else await stopLocalDictation({ cancel: true })
  leaferCanvas?.finishTextEdit()
}

async function selectNote(id) {
  if (id === state.activeNoteId) return
  leaferSwitching += 1
  await stopDictationForSwitch()
  leaferCanvas.clearSelection()
  leaferInk.cancel()
  leaferConnect.cancel()
  elements.shell.classList.add('leafer-switching')
  try { await selectNoteNow(id) } finally {
    if (!--leaferSwitching) elements.shell.classList.remove('leafer-switching')
  }
}
async function selectNoteNow(id) {
  hideToast()
  const sequence = ++selectSequence
  // Stay on the current note rather than drop its edits when they cannot be saved in time.
  if (!(await settleOutgoingNote())) return
  if (sequence !== selectSequence || id === state.activeNoteId) return
  clearTimeout(saveTimer)
  unsavedEdits = false
  state.activeNoteId = id
  renderNoteList()
  state.loading = true
  mindmapEditor?.destroy()
  mindmapEditor = null
  try {
    const note = await api(`/notes/${id}`)
    // A newer pick superseded this one while it loaded: its content must not land under another note's id.
    if (sequence !== selectSequence) return
    const summary = state.notes.find((item) => item.id === id)
    if (summary) Object.assign(summary, {
      notebookId: note.notebookId,
      noteType: note.noteType,
      resourceId: note.resourceId,
      revision: note.revision,
    })
    state.selectedNotebookId = note.notebookId
    elements.title.value = note.title
    setActiveNoteType(note.noteType)
    if (state.activeNoteType === 'mindmap') {
      await mountActiveMindMap(note.content || structuredClone(DEFAULT_MINDMAP_DOCUMENT))
      mindmapSnapshot = JSON.stringify({ content: mindmapEditor?.getDocument() }) // what the map was when it was loaded: leaving it unchanged sends nothing
    } else {
      if (!(await showLeaferNote(note)) || sequence !== selectSequence) return
      setTool('text') // a note opens ready for typing
    }
    setSaveState('Saved')
    renderNoteList()
    requestAnimationFrame(openCanvasView)
  } catch (error) {
    console.error(error)
    setSaveState('Could not load', true)
  } finally {
    if (sequence === selectSequence) state.loading = false
  }
}

async function refreshWorkspaceLists() {
  const [notebooks, notes] = await Promise.all([api('/notebooks'), api('/notes')])
  state.notebooks = notebooks
  const previous = new Map(state.notes.map((note) => [note.id, note]))
  state.notes = notes.filter((note) => note.id !== pendingDelete?.note.id).map((note) => {
    const known = previous.get(note.id)
    if (!known) return note
    // The open note keeps its own revision and title until sync or save settles them.
    if (note.id === state.activeNoteId) return Object.assign(known, note, { revision: known.revision, title: known.title })
    return Object.assign(known, note)
  })
  renderNoteList()
}

async function applyRemoteNote(note) {
  if (note.id !== state.activeNoteId || state.activeNoteType !== 'canvas') return
  elements.title.value = note.title
  if (!(await showLeaferNote(note, { openView: false }))) return
  if (leaferShowFixed) queueSave() // the stored arrows follow what the agent moved
  const summary = state.notes.find((item) => item.id === note.id)
  if (summary) Object.assign(summary, { title: note.title, revision: note.revision, resourceId: note.resourceId, updatedAt: note.updatedAt })
  setSaveState('Saved')
  renderNoteList()
  layoutChanged() // the agent's flag sits over text that may have moved
}

let mergeCount = 0
// Unsaved local edits win. A three-way merge against the note as last loaded or saved (core/document/merge.js). What the agent changed, rewrote,
// deleted or appended arrives; what the user changed (words being typed included) stays; the editor stays open on its text. The
// note is then saved on the agent's revision.
async function mergeLeaferNote(note) {
  const decoded = await decodeNoteDocument(note)
  // A save in flight that moved the page frame has not told us yet which frame the server's copy is in (the server applies it before it
  // answers), so a merge waits for the answer; what was fetched meanwhile is the user's own save, or older, and there is nothing in it to merge.
  // A save that left the frame as it was (the usual one) changes nothing about how the server's copy is read: the merge goes ahead.
  if (saveInFlight && saveFrame && (saveFrame.x !== leaferServerShift.x || saveFrame.y !== leaferServerShift.y)) {
    // Not for ever: a save that gets no answer must not hold the changes feed. The merge is dropped and tried again a little later.
    const gaveUp = Symbol('gave up')
    let timer
    const outcome = await Promise.race([(async () => { while (saveInFlight) await saveSettled })(), new Promise((resolve) => { timer = setTimeout(() => resolve(gaveUp), MERGE_WAIT_MS) })])
    clearTimeout(timer)
    if (outcome === gaveUp) { setTimeout(() => agentSync?.syncActiveNote().catch(console.error), MERGE_RETRY_MS); return 0 }
    if (note.id !== state.activeNoteId) return 0
    const known = state.notes.find((item) => item.id === note.id)
    if (known && note.revision <= known.revision) return 0
  }
  if (note.id !== state.activeNoteId) return 0
  mergeCount += 1
  leaferInk.documentChanged() // an erase pass was planned on the document as it was; it is dropped rather than committed against the merged one (a pen stroke only adds, so it carries on)
  const typing = leaferCanvas.flushText() // words typed so far are in the document now; that text counts as the user's whatever the agent did to it
  const local = leaferEdits.doc
  // The agent wrote in the server's page frame and our base is in its own; both are moved into ours before they are compared.
  const frame = { x: leaferFrameShift.x - leaferServerShift.x, y: leaferFrameShift.y - leaferServerShift.y }
  const baseFrame = { x: leaferFrameShift.x - leaferBaseShift.x, y: leaferFrameShift.y - leaferBaseShift.y }
  const moved = Boolean(frame.x || frame.y)
  const { doc: joined, added } = mergeDocuments({ base: shiftedDocument(leaferBase ?? local, baseFrame.x, baseFrame.y), local, remote: shiftedDocument(decoded.doc, frame.x, frame.y), touched: typing ? [typing] : [] })
  // The grid the agent grew (it wrote in the server's frame, so its pages are counted from there) and the grid we have are both kept.
  const grid = moved ? { columns: Math.max(joined.page.columns, decoded.doc.page.columns + frame.x / PAGE_WIDTH), rows: Math.max(joined.page.rows, decoded.doc.page.rows + frame.y / PAGE_HEIGHT) } : null
  const merged = grid && (grid.columns !== joined.page.columns || grid.rows !== joined.page.rows) ? { ...joined, page: { ...joined.page, ...grid } } : joined
  const summary = state.notes.find((item) => item.id === note.id)
  if (summary) summary.revision = note.revision
  leaferBase = decoded.doc // what the server holds now; the next save moves it on
  leaferBaseShift = { ...leaferServerShift }
  if (merged !== local) {
    leaferEdits.remote(note.id, merged) // a merge, not an edit: undo stays safe
    const next = leaferEdits.doc
    if (next.page && !samePageGrid(next.page, state.pages)) { state.pages = { ...next.page }; resizePaper() }
    leaferCanvas.applyMerged(next, { resolveMedia: decoded.resolveMedia })
    // An agent that moved an object leaves its arrows where they were: they follow what is on screen now (derived, not an edit).
    const followed = leaferCanvas.followConnectors(next)
    if (followed !== next) {
      leaferEdits.remote(note.id, followed)
      leaferCanvas.applyMerged(leaferEdits.doc)
    }
    leaferSource = leaferSourceOf(note.id, leaferEdits.doc)
  }
  queueSave()
  layoutChanged()
  return added.length
}
const samePageGrid = (a, b) => a.columns === b.columns && a.rows === b.rows
async function mergeRemoteNote(note) {
  if (note.id !== state.activeNoteId || state.activeNoteType !== 'canvas') return 0
  return mergeLeaferNote(note)
}

async function createNote(notebookId, noteType = 'canvas') {
  if (state.creatingNote) return
  state.creatingNote = true
  const activeNote = state.notes.find((note) => note.id === state.activeNoteId)
  const destinationId = Number(notebookId) || state.selectedNotebookId || activeNote?.notebookId || state.notebooks[0]?.id
  try {
    const note = await api('/notes', {
      method: 'POST',
      body: JSON.stringify({
        title: noteType === 'mindmap' ? 'Untitled mind map' : 'Untitled note',
        notebookId: destinationId,
        noteType,
      }),
    })
    state.notes.unshift(note)
    state.selectedNotebookId = note.notebookId
    state.activeNoteId = null
    await selectNote(note.id)
    setSidebarOpen(false)
  } finally {
    state.creatingNote = false
  }
}

async function moveNote(noteId, notebookId) {
  const note = state.notes.find((item) => item.id === noteId)
  if (!note || note.notebookId === notebookId) return
  const result = await api(`/notes/${noteId}/notebook`, {
    method: 'PATCH',
    body: JSON.stringify({ notebookId, revision: note.revision }),
  })
  Object.assign(note, { notebookId, revision: result.revision, resourceId: result.resourceId })
  if (noteId === state.activeNoteId) state.selectedNotebookId = notebookId
  renderNoteList()
}

function openNotebookDialog(notebook = null, category = 'projects') {
  elements.notebookForm.dataset.notebookId = notebook?.id || ''
  const categoryInput = document.querySelector(`[name="notebook-category"][value="${notebook?.category || category}"]`)
  if (categoryInput) categoryInput.checked = true
  elements.notebookName.value = notebook?.name || ''
  document.querySelector('#notebook-dialog-title').textContent = notebook ? 'Edit notebook' : 'New notebook'
  document.querySelector('#save-notebook').textContent = notebook ? 'Save changes' : 'Create'
  document.querySelector('#delete-notebook').hidden = !notebook
  document.querySelector('#notebook-dialog-note').textContent = notebook
    ? 'Deleting it moves its notes into another notebook.'
    : 'Give related notes a quiet place of their own.'
  const color = notebook?.color || '#B86B4B'
  const colorInput = document.querySelector(`[name="notebook-color"][value="${color}"]`)
  if (colorInput) colorInput.checked = true
  elements.notebookDialog.showModal()
  requestAnimationFrame(() => elements.notebookName.focus())
}

async function saveNotebook() {
  const id = Number(elements.notebookForm.dataset.notebookId)
  const name = elements.notebookName.value.trim()
  if (!name) return elements.notebookName.focus()
  const color = document.querySelector('[name="notebook-color"]:checked').value
  const category = document.querySelector('[name="notebook-category"]:checked').value
  if (id) {
    const notebook = state.notebooks.find((item) => item.id === id)
    const updated = await api(`/notebooks/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name, color, category, revision: notebook?.revision }),
    })
    Object.assign(notebook, updated)
  } else {
    const notebook = await api('/notebooks', { method: 'POST', body: JSON.stringify({ name, color, category }) })
    state.notebooks.unshift(notebook)
    state.selectedNotebookId = notebook.id
  }
  elements.notebookDialog.close()
  renderNoteList()
}

async function deleteNotebook() {
  const id = Number(elements.notebookForm.dataset.notebookId)
  if (!id) return
  const result = await api(`/notebooks/${id}`, { method: 'DELETE' })
  const movedRevisions = new Map(result.movedNotes.map((note) => [note.id, note.revision]))
  state.notes.forEach((note) => {
    if (note.notebookId === id) {
      note.notebookId = result.destinationNotebookId
      note.revision = movedRevisions.get(note.id) ?? note.revision
    }
  })
  state.notebooks = await api('/notebooks')
  state.selectedNotebookId = result.destinationNotebookId
  elements.notebookDialog.close()
  renderNoteList()
}

function recentSearchResults() {
  return state.notes.slice(0, 8).map((note) => {
    const notebook = state.notebooks.find((item) => item.id === note.notebookId)
    return {
      ...note,
      notebookName: notebook?.name || 'Notebook',
      notebookColor: notebook?.color || '#B86B4B',
      excerpt: '',
    }
  })
}

function setPropertiesOpen(open) {
  elements.properties.classList.toggle('open', open)
  elements.properties.setAttribute('aria-hidden', String(!open))
  elements.properties.inert = !open
  const trigger = document.querySelector('#top-properties')
  trigger.classList.toggle('active', open)
  trigger.setAttribute('aria-expanded', String(open))
  trigger.setAttribute('aria-label', open ? 'Close settings and properties' : 'Open settings and properties')
}

function syncDefaultTypographySettings() {
  document.querySelectorAll('[data-default-font-family]').forEach((button) => {
    button.classList.toggle('active', button.dataset.defaultFontFamily === state.fontFamily)
  })
  elements.settingsFontSize.value = state.fontSize
  elements.settingsFontSizeValue.value = state.fontSize
}

function updateCapabilitySettings(capabilities) {
  const storage = capabilities.storage || {}
  const modules = capabilities.modules || {}
  document.querySelector('#settings-storage').textContent = storage.engine === 'sqlite'
    ? 'SQLite · This device'
    : 'Unavailable'
  document.querySelector('#settings-mindmap').textContent = modules.mindmap?.available
    ? 'On demand'
    : 'Unavailable'
  document.querySelector('#settings-voice').textContent = modules.voice?.available
    ? 'Transcript only'
    : 'Unavailable'
}

async function loadCapabilitySettings() {
  try {
    updateCapabilitySettings(await api('/settings/capabilities'))
  } catch {
    document.querySelector('#settings-storage').textContent = 'Unavailable'
    document.querySelector('#settings-mindmap').textContent = 'Unavailable'
    document.querySelector('#settings-voice').textContent = 'Unavailable'
  }
}

const voiceClient = createVoiceClient(api)
let voicePoll = null

function renderVoiceSetup(status) {
  const view = describeVoice(status)
  document.querySelector('#voice-setup-headline').textContent = view.headline
  document.querySelector('#voice-setup-detail').textContent = view.detail
  const progress = document.querySelector('#voice-setup-progress')
  progress.hidden = view.percent === null
  if (view.percent !== null) progress.value = view.percent
  for (const [id, label] of [['#voice-download', view.download], ['#voice-cancel', view.cancel], ['#voice-remove', view.remove]]) {
    const button = document.querySelector(id)
    button.hidden = !label
    button.querySelector('span').textContent = label || ''
  }
}

async function refreshVoiceSetup() {
  clearTimeout(voicePoll)
  let status
  try {
    status = await voiceClient.status()
  } catch {
    renderVoiceSetup({ state: 'error', error: 'The local server did not answer.' })
    return null
  }
  renderVoiceSetup(status)
  // Keep the progress bar moving while the server downloads.
  if (status.state === 'downloading') voicePoll = setTimeout(refreshVoiceSetup, 1000)
  return status
}

async function voiceSetupAction(action) {
  try {
    renderVoiceSetup(await action(voiceClient))
  } catch (error) {
    renderVoiceSetup({ state: 'error', error: error.message })
    return
  }
  void refreshVoiceSetup()
}

function openVoiceSettings() {
  setPropertiesOpen(true)
  void refreshVoiceSetup()
  const section = document.querySelector('#settings-voice-section')
  section.scrollIntoView?.({ block: 'center' })
  section.querySelector('button:not([hidden])')?.focus({ preventScroll: true })
}

function setPortabilityStatus(message, error = false) {
  elements.portabilityStatus.textContent = message
  elements.portabilityStatus.classList.toggle('error', error)
}

async function downloadWorkspaceExport(path, fileName) {
  setPortabilityStatus('Preparing export…')
  try {
    await saveActiveNote()
    await downloadWorkspaceFile(path, fileName)
    setPortabilityStatus('Export downloaded')
  } catch (error) {
    console.error(error)
    setPortabilityStatus('Export failed. Your workspace was not changed.', true)
  }
}

async function importWorkspaceFile(file) {
  if (!file) return
  if (file.size > 100 * 1024 * 1024) {
    setPortabilityStatus('Backup is larger than the 100 MB import limit.', true)
    return
  }
  setPortabilityStatus('Checking backup…')
  try {
    const backup = JSON.parse(await file.text())
    const result = await api('/import/workspace', {
      method: 'POST',
      body: JSON.stringify(backup),
    })
    setPortabilityStatus(`Imported ${result.notesImported} notes into ${result.notebooksImported} notebooks.`)
    ;[state.notebooks, state.notes] = await Promise.all([api('/notebooks'), api('/notes')])
    renderNoteList()
  } catch (error) {
    console.error(error)
    setPortabilityStatus(`Import failed: ${error.message}`, true)
  } finally {
    elements.importBackupFile.value = ''
  }
}

function syncTypographyControls() {
  const picked = leaferCanvas?.selectedText()[0]
  const text = picked ? { fontFamily: picked.style.fontFamily, fontSize: picked.style.fontSize } : null
  const fontFamily = fontChoice(text?.fontFamily || state.fontFamily)
  const fontSize = Math.round(text?.fontSize || state.fontSize)
  document.querySelector('#text-selection-status').textContent = text ? 'Selected text' : 'New text'
  document.querySelectorAll('[data-font-family]').forEach((button) => {
    button.classList.toggle('active', button.dataset.fontFamily === fontFamily)
  })
  elements.fontSize.value = fontSize
  elements.fontSizeValue.value = fontSize
}

function prettifyActiveNote() {
  if (state.activeNoteType !== 'canvas') return
  leaferCanvas.prettify() // the document model: the same tidy per text, one undo step
}

function applyTypography(property, value) {
  // The selected text and stickies change; the choice is also what the next new text gets.
  state[property] = value
  leaferCanvas.setTextStyle({ style: { [property]: property === 'fontFamily' ? canvasFontFamily(value) : value } })
  syncTypographyControls()
}

// Print sheets are drawn from the document model on a leafer of their own (white paper, no page furniture), as blob URLs.
let printSheetUrls = []
async function renderPrintSheet(column, row) {
  const url = URL.createObjectURL(await renderSheet(leaferCanvas, { column, row }))
  printSheetUrls.push(url)
  return url
}

let printRenderSequence = 0
async function renderPrintPreview(sequence) {
  const total = state.pages.columns * state.pages.rows
  elements.printSheetList.innerHTML = Array.from({ length: total }, (_, index) => `
    <article class="print-sheet-card is-loading">
      <div class="print-sheet-number">${index + 1}</div>
      <div class="print-sheet-loading"><span class="saving-spinner"></span>Rendering page</div>
    </article>
  `).join('')

  let index = 0
  for (let row = 0; row < state.pages.rows; row += 1) {
    for (let column = 0; column < state.pages.columns; column += 1) {
      const card = elements.printSheetList.children[index]
      const dataUrl = await renderPrintSheet(column, row)
      if (sequence !== printRenderSequence || elements.printPreview.hidden) return
      card.classList.remove('is-loading')
      card.innerHTML = `
        <div class="print-sheet-number">${index + 1}</div>
        <img src="${dataUrl}" alt="Printed page ${index + 1}, row ${row + 1}, column ${column + 1}" />
        <footer><span>Page ${index + 1}</span><span>Canvas ${column + 1}, ${row + 1}</span></footer>
      `
      index += 1
    }
  }
}

// The whole note as one PNG (white paper, no page furniture).
async function downloadNotePicture() {
  if (state.activeNoteType !== 'canvas') return
  leaferCanvas.finishTextEdit()
  try {
    const blob = await renderNotePicture(leaferCanvas, state.pages)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${(elements.title.value.trim() || 'note').replace(/[\\/:*?"<>|]+/g, '-')}.png`
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (error) {
    console.error(error)
    showToast('Could not make the picture')
  }
}

async function openPrintPreview() {
  if (state.activeNoteType !== 'canvas') return
  leaferCanvas?.finishTextEdit() // words still being typed are on the sheets
  const sequence = ++printRenderSequence
  setSidebarOpen(false)
  setPropertiesOpen(false)
  elements.printPreview.hidden = false
  elements.printPreview.setAttribute('aria-hidden', 'false')
  elements.shell.inert = true
  document.body.classList.add('print-preview-open')
  const total = state.pages.columns * state.pages.rows
  document.querySelector('#print-note-title').textContent = elements.title.value.trim() || 'Untitled note'
  document.querySelector('#print-sheet-count').textContent = `${total} ${total === 1 ? 'sheet' : 'sheets'}`
  document.querySelector('#print-summary-count').textContent = total
  document.querySelector('#print-layout').textContent = `${state.pages.columns} x ${state.pages.rows}`
  createIcons({ icons })
  requestAnimationFrame(() => document.querySelector('#close-print').focus())
  try {
    await renderPrintPreview(sequence)
  } catch (error) {
    if (sequence !== printRenderSequence) return
    console.error(error)
    elements.printSheetList.innerHTML = '<div class="print-error"><strong>Preview could not be rendered</strong><span>Your note has not been changed.</span></div>'
  }
}

function closePrintPreview() {
  printRenderSequence += 1
  elements.printPreview.setAttribute('aria-hidden', 'true')
  elements.printPreview.hidden = true
  elements.printSheetList.innerHTML = ''
  for (const url of printSheetUrls) URL.revokeObjectURL(url)
  printSheetUrls = []
  elements.shell.inert = false
  document.body.classList.remove('print-preview-open')
  elements.shareButton.focus()
}

function printNote() {
  const paper = elements.printPaper.value
  let pageStyle = document.querySelector('#print-page-style')
  if (!pageStyle) {
    pageStyle = document.createElement('style')
    pageStyle.id = 'print-page-style'
    document.head.append(pageStyle)
  }
  pageStyle.textContent = `@page { size: ${paper === 'a4' ? 'A4' : 'letter'} portrait; margin: 0; }`
  window.print()
}

function setVoiceListening(listening, message = 'Listening') {
  state.listening = listening
  elements.voiceButton.classList.toggle('active', listening)
  elements.voiceButton.setAttribute('aria-pressed', String(listening))
  elements.voiceButton.setAttribute('aria-label', listening ? 'Stop voice dictation' : 'Start voice dictation')
  elements.mobileSpeak.classList.toggle('active', listening)
  elements.mobileSpeak.setAttribute('aria-pressed', String(listening))
  elements.mobileSpeak.setAttribute('aria-label', listening ? 'Release to finish speaking' : 'Hold to speak')
  leaferCanvas?.setListening(listening)
  elements.voiceCaption.hidden = !listening
  elements.voiceStatus.textContent = message
}


// The words go into the text being edited through the overlay (the selected text, the open one, or a new text box).
// The "target" is only what the dictation session reads: the words in the editor now.
// Where a new dictation box goes when nothing is being edited: under the note's content.
const currentVoiceInsertPoint = () => voiceInsertPoint(contentBounds(leaferEdits.doc.objects, (object) => leaferCanvas.sizeOf(object) ?? {}), { columns: state.pages.columns, pageWidth: PAGE_WIDTH })
let leaferVoiceShown = '' // the words last put in the editor
function createVoiceTextBox() {
  const layout = pageBoundedTextLayout(currentVoiceInsertPoint(), { pageWidth: PAGE_WIDTH })
  const { fresh } = leaferCanvas.beginDictation({ x: layout.x, y: layout.y }, { width: layout.width })
  leaferVoiceShown = leaferCanvas.dictationText() ?? ''
  return { __voiceDictationBox: fresh, get text() { return leaferCanvas.dictationText() ?? '' } }
}

function removeEmptyVoiceTextBox() {
  const target = dictationSession.target
  if (dictationSession.active && dictationSession.partial) updateVoiceTextBox(dictationSession.preview(''), { create: false })
  if (target?.__voiceDictationBox && !target.text.trim() && leaferCanvas.isEditingText()) leaferCanvas.finishTextEdit() // a new box nothing was said into is never made
}

function updateVoiceTextBox(text, { record = false, create = true } = {}) {
  if (!dictationSession.target || !leaferCanvas.isEditingText()) { // the editor was closed meanwhile: what comes next goes in a new text box
    if (!create) return
    const shown = leaferVoiceShown
    dictationSession.target = createVoiceTextBox()
    dictationSession.committed = ''
    text = text.startsWith(shown) ? text.slice(shown.length).trim() : text
  }
  leaferCanvas.setDictation(text)
  leaferVoiceShown = text
  if (record) leaferCanvas.flushText() // final words are in the document (and a save) now, inside the same typing session
}

function previewVoiceTranscript(transcript, options) {
  updateVoiceTextBox(dictationSession.preview(transcript, options))
}

function insertVoiceTranscript(transcript) {
  if (!transcript) return
  updateVoiceTextBox(dictationSession.commit(transcript), { record: true })
}

function showVoiceNotice(message, duration = 2600) {
  elements.voiceCaption.hidden = false
  elements.voiceStatus.textContent = message
  clearTimeout(showVoiceNotice.timer)
  showVoiceNotice.timer = setTimeout(() => {
    if (!state.listening) elements.voiceCaption.hidden = true
  }, duration)
}

function completeLocalDictation(message = '') {
  clearTimeout(state.localFinishTimer)
  state.localTranscription?.disconnect()
  state.localTranscription = null
  state.microphoneCapture = null
  state.voiceMode = null
  removeEmptyVoiceTextBox()
  dictationSession.finish()
  setVoiceListening(false)
  if (message) showVoiceNotice(message)
}

async function stopLocalDictation({ cancel = false } = {}) {
  state.voiceAttempt += 1
  await state.microphoneCapture?.stop()
  state.microphoneCapture = null
  if (cancel) {
    state.localTranscription?.cancel()
    state.localTranscription = null
    state.voiceMode = null
    removeEmptyVoiceTextBox()
    dictationSession.cancel()
    setVoiceListening(false)
    return
  }

  state.localTranscription?.finish()
  elements.voiceStatus.textContent = 'Finishing transcript'
  state.localFinishTimer = setTimeout(() => completeLocalDictation(), 4000)
}

async function startLocalDictation(attempt, endpoint) {
  const { LocalTranscriptionProvider, MicrophonePcmCapture } = await import('./modules/voice/capture.js')
  // The server picks the engine's port (8080 when free), so the page uses the endpoint it reports.
  const provider = new LocalTranscriptionProvider(endpoint ? { endpoint, connectionTimeout: 3000 } : {})
  state.localTranscription = provider
  await provider.connect({
    language: (navigator.language || 'en').split('-')[0],
    onPartial: (text) => {
      elements.voiceStatus.textContent = text || 'Listening locally'
      previewVoiceTranscript(text, { append: true })
    },
    onFinal: (text) => {
      if (!dictationSession.active) return
      elements.voiceStatus.textContent = text || 'Listening locally'
      insertVoiceTranscript(text)
      if (!state.microphoneCapture) completeLocalDictation()
    },
    onError: async () => {
      await state.microphoneCapture?.stop()
      completeLocalDictation('Local transcription became unavailable; no audio was saved')
    },
  })
  if (attempt !== state.voiceAttempt) {
    provider.cancel()
    return false
  }

  const capture = new MicrophonePcmCapture()
  state.microphoneCapture = capture
  await capture.start((audio) => provider.sendAudio(audio))
  if (attempt !== state.voiceAttempt) {
    await capture.stop()
    provider.cancel()
    return false
  }
  state.voiceMode = 'local'
  setVoiceListening(true, 'Listening locally')
  return true
}

let toggleVoiceDictation = async () => {}

function setupVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
  let recognition = null
  if (SpeechRecognition) {
    recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language || 'en-US'
    state.recognition = recognition

    recognition.onstart = () => {
      state.voiceMode = 'browser'
      setVoiceListening(true, 'Local service unavailable · using browser voice; Personal Note retains transcript only')
    }
    recognition.onresult = (event) => {
      const update = dictationSession.accept(event.results, event.resultIndex)
      elements.voiceStatus.textContent = update.partial || update.stable.at(-1) || 'Listening'
      update.stable.forEach(insertVoiceTranscript)
      previewVoiceTranscript(update.partial)
    }
    recognition.onerror = (event) => {
      state.voiceError = event.error === 'not-allowed' ? 'Microphone permission is required' : 'Voice input stopped'
      if (event.error === 'not-allowed') dictationSession.cancel()
    }
    recognition.onend = () => {
      state.voiceMode = null
      removeEmptyVoiceTextBox()
      dictationSession.finish()
      setVoiceListening(false)
      if (state.voiceError) {
        showVoiceNotice(state.voiceError)
        state.voiceError = null
      }
    }
  }

  toggleVoiceDictation = async () => {
    if (state.listening) {
      if (state.voiceMode === 'browser') recognition.stop()
      else await stopLocalDictation({ cancel: state.voiceMode !== 'local' })
      return
    }

    dictationSession.start(createVoiceTextBox())
    const attempt = state.voiceAttempt + 1
    state.voiceAttempt = attempt
    state.voiceMode = 'connecting'
    setVoiceListening(true, 'Connecting local voice')
    const plan = await prepareLocalVoice(voiceClient, {
      onStarting: () => { elements.voiceStatus.textContent = 'Starting voice' },
    })
    if (attempt !== state.voiceAttempt) return
    const inAppWindow = hostFlag === 'desktop' || Boolean(window.pywebview)
    if (plan.blocked && (inAppWindow || !recognition)) {
      // Not ready: say why and take the user to where it is fixed, never fail silently.
      state.voiceMode = null
      removeEmptyVoiceTextBox()
      dictationSession.cancel()
      setVoiceListening(false)
      showVoiceNotice(plan.blocked, 6000)
      openVoiceSettings()
      return
    }
    try {
      if (!plan.blocked && await startLocalDictation(attempt, plan.endpoint)) return
    } catch (error) {
      state.localTranscription?.cancel()
      state.localTranscription = null
      await state.microphoneCapture?.stop()
      state.microphoneCapture = null
      if (attempt !== state.voiceAttempt) return
      if (error?.name === 'NotAllowedError') {
        state.voiceMode = null
        removeEmptyVoiceTextBox()
        dictationSession.cancel()
        setVoiceListening(false)
        showVoiceNotice('Microphone permission is required')
        return
      }
    }

    if (!recognition) {
      state.voiceMode = null
      removeEmptyVoiceTextBox()
      dictationSession.cancel()
      setVoiceListening(false)
      showVoiceNotice('Voice is unavailable. Start the loopback transcription service; no audio was retained.')
      return
    }
    try {
      recognition.start()
    } catch {
      state.voiceMode = null
      removeEmptyVoiceTextBox()
      dictationSession.cancel()
      setVoiceListening(false)
      showVoiceNotice('Voice input could not start')
    }
  }

  // Hold to talk (release stops), or tap once to keep listening and tap again to stop.
  const pressToTalk = createPressToTalk({ toggle: () => toggleVoiceDictation(), isListening: () => state.listening })
  elements.voiceButton.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    elements.voiceButton.setPointerCapture?.(event.pointerId)
    void pressToTalk.press()
  })
  elements.voiceButton.addEventListener('pointerup', (event) => {
    elements.voiceButton.releasePointerCapture?.(event.pointerId)
    void pressToTalk.release()
  })
  elements.voiceButton.addEventListener('pointercancel', () => void pressToTalk.release())
  elements.voiceButton.addEventListener('contextmenu', (event) => event.preventDefault())
  // Keyboard activation arrives as a click with no pointer; pointer clicks are handled above.
  elements.voiceButton.addEventListener('click', (event) => {
    if (event.detail === 0) toggleVoiceDictation()
  })
}

function renderSearchResults(allResults, query = '') {
  const results = allResults.filter((result) => result.id !== pendingDelete?.note.id)
  if (!results.length) {
    elements.searchResults.innerHTML = `
      <div class="search-empty"><i data-lucide="search-x"></i><strong>No notes found</strong><span>Try a title, phrase, or idea.</span></div>
    `
  } else {
    elements.searchResults.innerHTML = `
      <p class="search-results-label">${query ? `${results.length} ${results.length === 1 ? 'result' : 'results'}` : 'Recently edited'}</p>
      ${results.map((result) => `
        <button class="search-result" data-search-note-id="${result.id}">
          <span class="search-result-icon" style="--notebook-color:${result.notebookColor}"><i data-lucide="${result.noteType === 'mindmap' ? 'git-fork' : 'file-text'}"></i></span>
          <span class="search-result-copy">
            <strong>${escapeHtml(result.title || 'Untitled note')}</strong>
            ${result.excerpt ? `<small>${escapeHtml(result.excerpt)}</small>` : ''}
          </span>
          <span class="search-result-notebook"><i data-lucide="notebook-tabs"></i>${escapeHtml(result.notebookName)}</span>
        </button>
      `).join('')}
    `
  }
  createIcons({ icons })
}

function openSearch() {
  elements.searchBackdrop.hidden = false
  renderSearchResults(recentSearchResults())
  elements.searchInput.focus()
  elements.searchInput.select()
  requestAnimationFrame(() => {
    elements.searchBackdrop.classList.add('open')
  })
}

function closeSearch() {
  elements.searchBackdrop.classList.remove('open')
  setTimeout(() => { elements.searchBackdrop.hidden = true }, 160)
}

let searchTimer
let searchSequence = 0
function queueSearch() {
  clearTimeout(searchTimer)
  const query = elements.searchInput.value.trim()
  if (!query) return renderSearchResults(recentSearchResults())
  const sequence = ++searchSequence
  elements.searchResults.innerHTML = '<div class="search-loading"><span class="saving-spinner"></span>Searching your notes</div>'
  searchTimer = setTimeout(async () => {
    try {
      const results = await api(`/search?q=${encodeURIComponent(query)}`)
      if (sequence === searchSequence) renderSearchResults(results, query)
    } catch (error) {
      console.error(error)
      elements.searchResults.innerHTML = '<div class="search-empty"><strong>Search is unavailable</strong><span>Your notes are still safe on this device.</span></div>'
    }
  }, 120)
}

async function deleteActiveNote() {
  if (!state.activeNoteId) return
  await commitPendingDelete()
  // Land the note's latest edits first, so Undo brings back exactly what was on screen.
  flushPendingEdits()
  const id = state.activeNoteId
  const index = state.notes.findIndex((note) => note.id === id)
  const note = state.notes[index]
  if (!note) return
  state.notes = state.notes.filter((item) => item.id !== id)
  state.activeNoteId = null
  if (!state.notes.length) await createNote()
  else await selectNote(state.notes[0].id)
  pendingDelete = { note, index }
  showToast('Note deleted', 'Undo', undoDelete)
}

// Clear all runs at once and offers Undo in a toast (and Ctrl/Cmd+Z), so no confirmation dialog is needed.
let pendingClearUndo = null
let toastTimer

function showToast(message, actionLabel, onAction) {
  elements.toast.firstElementChild.textContent = message
  elements.toastAction.textContent = actionLabel || ''
  elements.toastAction.hidden = !actionLabel
  elements.toast.onAction = onAction
  elements.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(hideToast, 8000)
}

// Hiding the toast ends whatever it was offering to undo; a held delete is sent for real.
function hideToast() {
  clearTimeout(toastTimer)
  elements.toast.hidden = true
  pendingClearUndo = null
  void commitPendingDelete()
}

// Delete note leaves the view at once; the real DELETE waits for the toast to expire, another note to open,
// or the app to close (flushed with the other pending edits). Undo cancels it.
let pendingDelete = null
let deleteInFlight = false

async function commitPendingDelete({ keepalive = false } = {}) {
  const held = pendingDelete
  if (!held) return
  pendingDelete = null
  // The toast offered Undo for this delete; never leave it up once the delete is sent.
  if (!pendingClearUndo) {
    clearTimeout(toastTimer)
    elements.toast.hidden = true
  }
  deleteInFlight = true
  try {
    await api(`/notes/${held.note.id}`, { method: 'DELETE', keepalive })
  } catch (error) {
    console.error(error)
    state.notes = await api('/notes').catch(() => state.notes)
    renderNoteList()
  } finally {
    deleteInFlight = false
  }
}

async function undoDelete() {
  const held = pendingDelete
  pendingDelete = null
  hideToast()
  if (!held) return
  if (!state.notes.some((note) => note.id === held.note.id)) state.notes.splice(Math.min(held.index, state.notes.length), 0, held.note)
  renderNoteList()
  await selectNote(held.note.id)
}

async function undoClear() {
  const pending = pendingClearUndo
  hideToast()
  if (!pending || pending.noteId !== state.activeNoteId) return
  if (pending.mindmap) {
    await mountActiveMindMap(pending.mindmap)
    queueSave()
  } else if (pending.canvas) stepHistory(-1) // the clear is the last step: no other edit has been made since (an edit ends the Undo)
}

async function clearActiveNote() {
  if (!state.activeNoteId) return
  await commitPendingDelete()
  if (state.activeNoteType === 'mindmap') {
    const previous = mindmapEditor?.getDocument()
    await mountActiveMindMap(structuredClone(DEFAULT_MINDMAP_DOCUMENT))
    queueSave()
    pendingClearUndo = { noteId: state.activeNoteId, mindmap: previous }
    showToast('Note cleared', 'Undo', undoClear)
    return
  }
  if (!leaferCanvas.clearAll()) return
  setTool('text')
  pendingClearUndo = { noteId: state.activeNoteId, canvas: true }
  showToast('Note cleared', 'Undo', undoClear)
}

// A touch that starts in the gutter around the pages scrolls the view with one
// finger, as the old padded workspace did; touches on the page keep drawing.
function isOutsidePages(event) {
  const rect = inputSurface.getBoundingClientRect()
  const scale = getCanvasScale()
  const worldX = (event.clientX - rect.left - viewportOffsetX) / scale
  const worldY = (event.clientY - rect.top - viewportOffsetY) / scale
  const target = pageExtentsTarget()
  return worldX < 0 || worldY < 0 || worldX > target.right || worldY > target.bottom
}

// Touch pinch and pan and the middle-button pan work from every layer that takes the pointer: the input surface (the hand, Space, text,
// sticky), Leafer's own (the select tool) and the ink surface.
function onCanvasInput(type, handler, options) {
  inputSurface.addEventListener(type, handler, options)
  leaferHost.addEventListener(type, handler, options)
  leaferInk?.surface.addEventListener(type, handler, options)
}
const canvasTouchPointers = new Map()
let canvasPinchGesture = null
let canvasPanGesture = null

function beginCanvasPinch() {
  const [first, second] = [...canvasTouchPointers.values()]
  if (!first || !second) return
  const rect = inputSurface.getBoundingClientRect()
  const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
  const scale = getCanvasScale()
  canvasPinchGesture = {
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    center,
    zoom: state.canvasZoom,
    worldX: (center.x - rect.left - viewportOffsetX) / scale,
    worldY: (center.y - rect.top - viewportOffsetY) / scale,
  }
  canvasPanGesture = null
  leaferInk?.cancel() // a second finger is a pinch: the stroke the first one began is dropped
  leaferConnect?.cancel()
}

function updateCanvasPinch() {
  if (!canvasPinchGesture || canvasTouchPointers.size < 2) return false
  const [first, second] = [...canvasTouchPointers.values()]
  const rect = inputSurface.getBoundingClientRect()
  const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
  const ratio = Math.hypot(second.x - first.x, second.y - first.y) / canvasPinchGesture.distance
  state.canvasZoom = Math.min(2.5, Math.max(0.75, canvasPinchGesture.zoom * ratio))
  const scale = getCanvasScale()
  const offsetX = center.x - rect.left - canvasPinchGesture.worldX * scale
  const offsetY = center.y - rect.top - canvasPinchGesture.worldY * scale
  setCanvasViewportOffset(offsetX, offsetY)
  return true
}

// Whether a pen has touched this window (F-035). An Apple Pencil (pointerType 'pen') draws; once one has
// touched, a finger is for panning and pinching, never for drawing, so a resting palm leaves no marks.
let penLastAt = -Infinity // when a pen last touched the screen (a hovering pen does not count)
const penInUse = () => performance.now() - penLastAt < 10000 // after ten seconds without a pen a finger may draw again
for (const type of ['pointerdown', 'pointermove']) window.addEventListener(type, (event) => { if (event.pointerType === 'pen' && event.buttons > 0) penLastAt = performance.now() }, true)

// Does a finger put down here pan the view, or is it for the tool? Off the pages, with the Hand, or (palm rejection) with a drawing tool
// while a pen is in use: it pans. With the Select, Text or Sticky tool, a finger on paper (not on an object or the handles of
// the selection) pans too, as on every phone canvas; there is no marquee by finger.
function fingerPans(event) {
  if (state.tool === 'hand' || isOutsidePages(event)) return true
  if (penInUse() && (state.tool === 'pen' || state.tool === 'highlight' || state.tool === 'eraser')) return true
  if (state.tool === 'select' || state.tool === 'text' || state.tool === 'sticky') return leaferCanvas.touchHit(event.clientX, event.clientY) === 'empty'
  return false
}

onCanvasInput('pointerdown', (event) => {
  if (event.pointerType !== 'touch') return
  canvasTouchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (canvasTouchPointers.size === 2) {
    beginCanvasPinch()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.stopImmediatePropagation()
    return
  }
  if (!fingerPans(event)) return
  canvasPanGesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: viewportOffsetX,
    offsetY: viewportOffsetY,
  }
  event.currentTarget.setPointerCapture(event.pointerId)
  event.preventDefault()
  event.stopImmediatePropagation()
}, { capture: true })

onCanvasInput('pointermove', (event) => {
  if (!canvasTouchPointers.has(event.pointerId)) return
  canvasTouchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (canvasPinchGesture) updateCanvasPinch()
  else if (canvasPanGesture?.pointerId === event.pointerId) {
    setCanvasViewportOffset(
      canvasPanGesture.offsetX + event.clientX - canvasPanGesture.startX,
      canvasPanGesture.offsetY + event.clientY - canvasPanGesture.startY,
    )
  } else return
  event.preventDefault()
  event.stopImmediatePropagation()
}, { capture: true })

onCanvasInput('pointerup', (event) => {
  if (!canvasTouchPointers.has(event.pointerId)) return
  // Only a lift that ends a pan or a pinch of ours is swallowed; any other finger's lift belongs to the tool (the editor must see it end).
  const owned = canvasPanGesture?.pointerId === event.pointerId || Boolean(canvasPinchGesture)
  canvasTouchPointers.delete(event.pointerId)
  if (canvasPanGesture?.pointerId === event.pointerId) canvasPanGesture = null
  if (canvasPinchGesture && !canvasTouchPointers.size) canvasPinchGesture = null
  if (!owned) return
  event.preventDefault()
  event.stopImmediatePropagation()
}, { capture: true })

onCanvasInput('pointercancel', (event) => {
  canvasTouchPointers.delete(event.pointerId)
  if (canvasPanGesture?.pointerId === event.pointerId) canvasPanGesture = null
  if (canvasPinchGesture && !canvasTouchPointers.size) canvasPinchGesture = null
}, { capture: true })

elements.workspace.addEventListener('wheel', (event) => {
  if (state.activeNoteType !== 'canvas' || event.target.closest?.('.tool-dock, .page-minimap, .zoom-control, .properties-panel, .sidebar')) return
  event.preventDefault()
  if (event.ctrlKey || event.metaKey) {
    const rect = elements.workspace.getBoundingClientRect()
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    zoomCanvasAt(state.canvasZoom * Math.exp(-event.deltaY * 0.01), point)
    return
  }
  const { dx, dy } = wheelPanDelta(event)
  setCanvasViewportOffset(viewportOffsetX - dx, viewportOffsetY - dy)
}, { passive: false })

// The hand (a held Space or the sticky hand) pans with the mouse or a pen; a finger's pan is the touch gesture above.
let mousePan = null
inputSurface.addEventListener('pointerdown', (event) => {
  if (state.tool !== 'hand' || event.pointerType === 'touch') return
  mousePan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX: viewportOffsetX, offsetY: viewportOffsetY }
  try { inputSurface.setPointerCapture(event.pointerId) } catch {}
  inputSurface.style.cursor = 'grabbing'
})
inputSurface.addEventListener('pointermove', (event) => {
  if (mousePan?.pointerId !== event.pointerId) return
  setCanvasViewportOffset(mousePan.offsetX + event.clientX - mousePan.x, mousePan.offsetY + event.clientY - mousePan.y)
})
function endMousePan(event) {
  if (mousePan?.pointerId !== event.pointerId) return
  mousePan = null
  inputSurface.style.cursor = toolCursor()
}
inputSurface.addEventListener('pointerup', endMousePan)
inputSurface.addEventListener('pointercancel', endMousePan)


// Middle-mouse drag pans from any tool, and keeps the press away from drawing, selecting and placing.
let middlePan = null
onCanvasInput('pointerdown', (event) => {
  if (event.button !== 1 || event.pointerType === 'touch' || state.activeNoteType !== 'canvas') return
  middlePan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX: viewportOffsetX, offsetY: viewportOffsetY }
  event.currentTarget.setPointerCapture(event.pointerId)
  event.currentTarget.style.cursor = 'grabbing'
  event.preventDefault()
  event.stopImmediatePropagation()
}, { capture: true })
onCanvasInput('pointermove', (event) => {
  if (middlePan?.pointerId !== event.pointerId) return
  setCanvasViewportOffset(middlePan.offsetX + event.clientX - middlePan.x, middlePan.offsetY + event.clientY - middlePan.y)
  event.preventDefault()
  event.stopImmediatePropagation()
}, { capture: true })
function endMiddlePan(event) {
  if (middlePan?.pointerId !== event.pointerId) return
  middlePan = null
  event.currentTarget.style.cursor = event.currentTarget === inputSurface ? toolCursor() : ''
  event.stopImmediatePropagation()
}
onCanvasInput('pointerup', endMiddlePan, { capture: true })
onCanvasInput('pointercancel', endMiddlePan, { capture: true })
onCanvasInput('mousedown', (event) => { if (event.button === 1) event.preventDefault() })

// A press with the mouse places a sticky or starts a text where the page is pressed. A finger or a pen places on the click that ends the
// tap (below): a phone only raises its keyboard for focus given at the end of a gesture, and the compatibility mouse events a tap sends
// are not relied on.
inputSurface.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.pointerType !== 'mouse') return
  if (state.tool === 'sticky') placeSticky(leaferCanvas.pageAt(event.clientX, event.clientY))
  else if (state.tool === 'shape') placeShape(leaferCanvas.pageAt(event.clientX, event.clientY))
  else if (state.tool === 'text') {
    const at = leaferCanvas.pageAt(event.clientX, event.clientY)
    setTimeout(() => { if (!leaferCanvas.editText(at, { select: false })) leaferCanvas.createText(at, { select: false }) }, 0)
  }
})

let tapStart = null
window.addEventListener('pointerdown', (event) => {
  tapStart = event.pointerType !== 'mouse' && event.isPrimary && event.target === inputSurface ? { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() } : null
}, true)
window.addEventListener('pointerup', (event) => {
  const start = tapStart
  tapStart = null
  if (!start || start.id !== event.pointerId || state.activeNoteType !== 'canvas' || canvasPinchGesture) return
  if (performance.now() - start.time > 600 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) return
  const at = leaferCanvas.pageAt(event.clientX, event.clientY)
  if (state.tool === 'sticky') placeSticky(at, { now: true })
  else if (state.tool === 'shape') placeShape(at)
  else if (state.tool === 'text' && !leaferCanvas.editText(at, { select: false })) leaferCanvas.createText(at, { select: false })
}, true)


document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => {
  if (suppressedToolClicks.has(button)) {
    suppressedToolClicks.delete(button)
    return
  }
  const wasActive = state.tool === button.dataset.tool
  setTool(button.dataset.tool)
  if (button.hasAttribute('data-tool-options') && wasActive) openInkOptions(button)
  else closeInkOptions()
}))
document.querySelectorAll('[data-color]').forEach((button) => button.addEventListener('click', () => {
  state.color = button.dataset.color
  leaferCanvas.setTextStyle({ style: { color: state.color } })
  setTool(state.tool)
  updateInkOptions()
  if (state.tool === 'text') closeInkOptions()
  else scheduleInkOptionsClose()
}))
elements.objectPalette.addEventListener('click', (event) => {
  const swatch = event.target.closest('[data-object-color]')
  if (!swatch) return
  state.objectColor = Number(swatch.dataset.objectColor)
  const color = currentObjectPalette()[state.objectColor]
  leaferCanvas.setTextStyle({ paper: { fill: color.fill, ink: color.ink } })
  leaferCanvas.setShapeFill(color.fill)
  updateInkOptions()
  scheduleInkOptionsClose()
})
document.querySelector('#add-image').addEventListener('click', () => elements.imageFile.click())
elements.imageFile.addEventListener('change', async () => {
  const files = [...elements.imageFile.files]
  elements.imageFile.value = ''
  await placeImageFiles(files)
})
const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files')
elements.workspace.addEventListener('dragover', (event) => {
  if (state.activeNoteType !== 'canvas' || !hasFiles(event)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
  elements.workspace.classList.add('is-drop-target')
})
elements.workspace.addEventListener('dragleave', (event) => {
  if (!elements.workspace.contains(event.relatedTarget)) elements.workspace.classList.remove('is-drop-target')
})
elements.workspace.addEventListener('drop', (event) => {
  elements.workspace.classList.remove('is-drop-target')
  if (state.activeNoteType !== 'canvas' || !hasFiles(event)) return
  event.preventDefault()
  placeImageFiles(event.dataTransfer.files, leaferCanvas.pageAt(event.clientX, event.clientY))
})
// A picture on the clipboard (a screenshot, a copied image) is pasted where the view is centred; words keep pasting into whatever is typed in.
document.addEventListener('paste', (event) => {
  if (state.activeNoteType !== 'canvas' || event.target.closest?.('input, textarea, select, [contenteditable]')) return
  const files = pictureFiles(event.clipboardData?.files)
  if (!files.length) return
  event.preventDefault()
  void placeImageFiles(files)
})
elements.inkOptionsTrigger.addEventListener('click', toggleInkOptions)
document.querySelector('#close-ink-options').addEventListener('click', closeInkOptions)
elements.strokeWidths.addEventListener('click', (event) => {
  const button = event.target.closest('[data-stroke-width]')
  if (!button || !['pen', 'highlight'].includes(state.tool)) return
  const width = Number(button.dataset.strokeWidth)
  if (state.tool === 'pen') state.penWidth = width
  else state.highlightWidth = width
  setTool(state.tool)
  closeInkOptions()
})

document.querySelector('#clear-note').addEventListener('click', clearActiveNote)
elements.toastAction.addEventListener('click', () => elements.toast.onAction?.())
document.querySelector('#delete-note').addEventListener('click', deleteActiveNote)
document.querySelector('#prettify').addEventListener('click', prettifyActiveNote)
document.querySelector('#undo').addEventListener('click', () => stepHistory(-1))
document.querySelector('#redo').addEventListener('click', () => stepHistory(1))
const mobileLayout = window.matchMedia('(max-width: 800px)')

function setSidebarOpen(open) {
  const isOpen = mobileLayout.matches && open
  const wasOpen = elements.sidebar.classList.contains('open')
  // Move focus before the drawer becomes inert so it never gets stranded inside it.
  if (!isOpen && wasOpen && elements.sidebar.contains(document.activeElement)) elements.sidebarToggle.focus()
  elements.shell.classList.toggle('sidebar-open', isOpen)
  elements.sidebar.classList.toggle('open', isOpen)
  elements.sidebar.inert = mobileLayout.matches && !isOpen
  elements.sidebarToggle.setAttribute('aria-expanded', String(isOpen))
  elements.sidebarToggle.setAttribute('aria-label', isOpen ? 'Close notebooks' : 'Open notebooks')
  if (isOpen && !wasOpen) requestAnimationFrame(() => document.querySelector('#rail-new-note').focus())
}

elements.sidebarToggle.addEventListener('click', () => setSidebarOpen(!elements.sidebar.classList.contains('open')))
document.querySelector('#close-sidebar').addEventListener('click', () => setSidebarOpen(false))
elements.sidebarScrim.addEventListener('click', () => setSidebarOpen(false))
mobileLayout.addEventListener('change', () => setSidebarOpen(false))
setSidebarOpen(false)

const desktopNewNoteButtons = [document.querySelector('#rail-new-note')]
const suppressedNewNoteClicks = new WeakSet()

function setNoteCreateMenuOpen(open, anchor) {
  elements.noteCreateMenu.hidden = !open
  desktopNewNoteButtons.forEach((button) => button.setAttribute('aria-expanded', String(open && button === anchor)))
  if (!open || !anchor) return
  const rect = anchor.getBoundingClientRect()
  const menuWidth = 168
  elements.noteCreateMenu.style.left = `${Math.max(10, Math.min(window.innerWidth - menuWidth - 10, rect.left))}px`
  elements.noteCreateMenu.style.top = `${Math.min(window.innerHeight - 108, rect.bottom + 6)}px`
  requestAnimationFrame(() => elements.noteCreateMenu.querySelector('button')?.focus())
}

desktopNewNoteButtons.forEach((button) => {
  let holdTimer
  let startPoint

  const cancelHold = () => {
    clearTimeout(holdTimer)
    startPoint = null
    button.classList.remove('is-holding')
  }

  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    cancelHold()
    startPoint = { x: event.clientX, y: event.clientY }
    button.classList.add('is-holding')
    holdTimer = setTimeout(() => {
      suppressedNewNoteClicks.add(button)
      button.classList.remove('is-holding')
      setNoteCreateMenuOpen(true, button)
      navigator.vibrate?.(8)
    }, 420)
  })
  button.addEventListener('pointermove', (event) => {
    if (startPoint && Math.hypot(event.clientX - startPoint.x, event.clientY - startPoint.y) > 10) cancelHold()
  })
  button.addEventListener('pointerup', cancelHold)
  button.addEventListener('pointercancel', cancelHold)
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    cancelHold()
    setNoteCreateMenuOpen(true, button)
  })
  button.addEventListener('click', (event) => {
    if (suppressedNewNoteClicks.delete(button)) return event.preventDefault()
    setNoteCreateMenuOpen(false)
    createNote()
  })
})

elements.noteCreateMenu.addEventListener('click', (event) => {
  const option = event.target.closest('[data-create-note-type]')
  if (!option) return
  setNoteCreateMenuOpen(false)
  createNote(undefined, option.dataset.createNoteType)
})
document.addEventListener('pointerdown', (event) => {
  const trigger = event.target.closest('button')
  if (!elements.noteCreateMenu.hidden && !elements.noteCreateMenu.contains(event.target) && !desktopNewNoteButtons.includes(trigger)) {
    setNoteCreateMenuOpen(false)
  }
})

const mobileHoldController = createMobileHoldController({
  start: async () => {
    if (!state.listening) await toggleVoiceDictation()
  },
  finish: async () => {
    if (state.listening) await toggleVoiceDictation()
  },
  cancel: async () => {
    if (state.listening) await toggleVoiceDictation()
  },
})

elements.mobileSpeak.addEventListener('pointerdown', async (event) => {
  if (event.button !== 0) return
  event.preventDefault()
  elements.mobileSpeak.setPointerCapture?.(event.pointerId)
  await mobileHoldController.press(event)
})
elements.mobileSpeak.addEventListener('pointerup', async (event) => {
  event.preventDefault()
  elements.mobileSpeak.releasePointerCapture?.(event.pointerId)
  await mobileHoldController.release()
})
elements.mobileSpeak.addEventListener('pointercancel', async () => mobileHoldController.cancel())
elements.mobileSpeak.addEventListener('contextmenu', (event) => event.preventDefault())
// A finger choosing a drawing tool says a finger is going to draw: pen use is forgotten at once.
for (const selector of ['#mobile-draw', '[data-tool="pen"]', '[data-tool="highlight"]', '[data-tool="eraser"]']) document.querySelectorAll(selector).forEach((button) => button.addEventListener('pointerdown', (event) => { if (event.pointerType === 'touch') penLastAt = -Infinity }))
document.querySelector('#mobile-draw').addEventListener('click', () => setTool(state.tool === 'pen' ? 'text' : 'pen'))
// Phones have no dock: Select (to move and resize by finger; the default Text tool edits what a finger taps) and Sticky sit beside Draw.
document.querySelector('#mobile-select').addEventListener('click', () => setTool(state.tool === 'select' ? 'text' : 'select'))
document.querySelector('#mobile-sticky').addEventListener('click', () => setTool(state.tool === 'sticky' ? 'text' : 'sticky'))
// Phones have no dock, so the Connect tool sits beside Draw: tap to arm it, tap again to go back to typing.
elements.mobileConnect.addEventListener('click', () => setTool(state.tool === 'connect' ? 'text' : 'connect'))
const searchButton = elements.searchButton
searchButton.addEventListener('click', openSearch)
function setShareMenuOpen(open) {
  elements.shareMenu.hidden = !open
  elements.shareButton.setAttribute('aria-expanded', String(open))
  if (open) requestAnimationFrame(() => elements.shareMenu.querySelector('button:not(:disabled)')?.focus())
}
elements.shareButton.addEventListener('click', () => setShareMenuOpen(elements.shareMenu.hidden))
elements.shareMenu.addEventListener('click', (event) => {
  const item = event.target.closest('button')
  if (!item || item.disabled) return
  setShareMenuOpen(false)
  if (item.id === 'share-print') openPrintPreview()
  else if (item.id === 'share-png') void downloadNotePicture()
  else if (item.id === 'share-backup') void downloadWorkspaceExport('/export/workspace', 'personal-note-backup.json')
  else if (item.id === 'share-markdown') void downloadWorkspaceExport('/export/markdown', 'personal-note-markdown.zip')
  else if (item.id === 'share-vault') void downloadWorkspaceExport('/export/vault', 'personal-note-obsidian-vault.zip')
})
elements.shareMenu.addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  const items = [...elements.shareMenu.querySelectorAll('button:not(:disabled)')]
  const index = items.indexOf(document.activeElement)
  items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
})
document.querySelector('#top-properties').addEventListener('click', () => setPropertiesOpen(!elements.properties.classList.contains('open')))
document.querySelector('#close-properties').addEventListener('click', () => setPropertiesOpen(false))
document.querySelector('#top-properties').addEventListener('click', () => {
  if (elements.properties.classList.contains('open')) void refreshVoiceSetup()
})
document.querySelector('#voice-download').addEventListener('click', () => void voiceSetupAction((client) => client.install()))
document.querySelector('#voice-cancel').addEventListener('click', () => void voiceSetupAction((client) => client.cancel()))
document.querySelector('#voice-remove').addEventListener('click', () => void voiceSetupAction((client) => client.remove()))
document.querySelector('#download-backup').addEventListener('click', () => {
  void downloadWorkspaceExport('/export/workspace', 'personal-note-backup.json')
})
document.querySelector('#export-markdown').addEventListener('click', () => {
  void downloadWorkspaceExport('/export/markdown', 'personal-note-markdown.zip')
})
document.querySelector('#import-backup').addEventListener('click', () => elements.importBackupFile.click())
elements.importBackupFile.addEventListener('change', () => {
  void importWorkspaceFile(elements.importBackupFile.files?.[0])
})
document.querySelector('#close-print').addEventListener('click', closePrintPreview)
document.querySelector('#print-note').addEventListener('click', printNote)
document.querySelectorAll('[data-font-family]').forEach((button) => {
  button.addEventListener('click', () => applyTypography('fontFamily', button.dataset.fontFamily))
})
elements.fontSize.addEventListener('input', () => applyTypography('fontSize', Number(elements.fontSize.value)))
document.querySelectorAll('[data-default-font-family]').forEach((button) => {
  button.addEventListener('click', () => {
    state.fontFamily = button.dataset.defaultFontFamily
    savePreferences()
    syncDefaultTypographySettings()
    syncTypographyControls()
  })
})
// Speed meter: a corner pill, created on first use. The frame loop only runs while it is visible.
let speedMeterPill = null
const speedMeter = createSpeedMeter({
  onUpdate({ fps, slowestMs }) {
    if (speedMeterPill) speedMeterPill.querySelector('[data-speed-frames]').textContent = `${Math.round(fps)} fps · slowest ${Math.round(slowestMs)} ms`
  },
})

const hostFlag = new URLSearchParams(location.search).get('host')

function renderSpeedMeterWhere() {
  if (!speedMeterPill) return
  const standalone = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches
  const engine = detectEngine({ userAgentData: navigator.userAgentData, userAgent: navigator.userAgent })
  const host = detectHost({ pywebview: window.pywebview, hostFlag, standalone, menubarVisible: window.menubar?.visible })
  speedMeterPill.querySelector('[data-speed-where]').textContent = `${engine} · ${host}`
}
window.addEventListener('pywebviewready', renderSpeedMeterWhere)

function setSpeedMeter(visible) {
  state.speedMeter = visible
  elements.settingsSpeedMeter.checked = visible
  if (visible) {
    if (!speedMeterPill) {
      speedMeterPill = document.createElement('div')
      speedMeterPill.className = 'speed-meter'
      speedMeterPill.setAttribute('role', 'status')
      speedMeterPill.innerHTML = '<span data-speed-frames>measuring…</span><small data-speed-where></small>'
      document.body.append(speedMeterPill)
    }
    renderSpeedMeterWhere()
    speedMeterPill.hidden = false
    speedMeter.start()
  } else {
    speedMeter.stop()
    if (speedMeterPill) speedMeterPill.hidden = true
  }
}

elements.settingsSpeedMeter.addEventListener('change', () => {
  setSpeedMeter(elements.settingsSpeedMeter.checked)
  savePreferences()
})
if (state.speedMeter) setSpeedMeter(true)

// The speed test (F-034): Settings, the View menu of the desktop app, or the page opened with ?speedtest=1. The code is loaded when it runs.
// The test never runs in the person's own notebook: from the app it starts a separate instance (temporary notebook, own profile, own port);
// the page that runs it is that instance, which says so itself (/speedtest/status).
let speedTestRunning = false
let speedTestInstance = false
let speedTestCanLaunch = false
const speedTestStatus = api('/speedtest/status').then((status) => {
  speedTestInstance = Boolean(status?.instance)
  speedTestCanLaunch = Boolean(status?.canLaunch)
  // Only the desktop app starts the test (it has a window to open it in); elsewhere the button is not offered.
  if (!speedTestCanLaunch && !speedTestInstance) document.querySelectorAll('.speedtest-offer').forEach((node) => { node.hidden = true })
}).catch(() => {})
async function startSpeedTest() {
  if (speedTestRunning) return
  await speedTestStatus
  setPropertiesOpen(false)
  if (!speedTestInstance) {
    try {
      await api('/speedtest/launch', { method: 'POST', headers: { 'x-personal-note': '1' } })
      showToast('The speed test opens in a window of its own and leaves your notes alone. Its results show there.')
    } catch (error) {
      console.error('The speed test could not be started', error)
      showToast(error?.message || 'The speed test could not be started.') // (the server says why: already running, or what stopped it)
    }
    return
  }
  if (!leaferCanvas || state.loading) return
  speedTestRunning = true
  const previous = state.activeNoteId
  try {
    const { runSpeedTest } = await import('./modules/speedtest/index.js')
    const standalone = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches
    await runSpeedTest({
      api,
      notebookId: state.selectedNotebookId || state.notebooks[0]?.id,
      engine: detectEngine({ userAgentData: navigator.userAgentData, userAgent: navigator.userAgent }),
      hostName: detectHost({ pywebview: window.pywebview, hostFlag, standalone, menubarVisible: window.menubar?.visible }),
      pageCount: () => `${state.pages.columns}x${state.pages.rows}`,
      pause: (on) => { speedTestPaused = on },
      activeNoteId: () => state.activeNoteId,
      openNote: async (id) => {
        const { content: _content, pageState: _pageState, ...summary } = await api(`/notes/${id}`)
        state.notes.unshift(summary)
        renderNoteList()
        await selectNote(id)
        setTool('select') // the speed test selects and drags
        await leaferCanvas.whenSettled()
      },
      restore: async () => {
        const back = state.notes.find((note) => note.id === previous) ?? state.notes.find((note) => note.title !== 'Speed test (safe to delete)')
        if (back) await selectNote(back.id)
      },
      forgetNote: (id) => { state.notes = state.notes.filter((note) => note.id !== id); renderNoteList() },
      host: {
        workspace: elements.workspace,
        canvasHost: leaferHost,
        scene: leaferCanvas,
        edits: leaferEdits,
        get inkSurface() { return leaferInk.surface },
        setTool: (name) => setTool(name),
        setView: async ({ zoom }) => {
          if (zoom === 'fit') fitAllPages()
          else { state.canvasZoom = zoom; setCanvasViewportOffset(viewSize.width / 2 - 430 * getCanvasScale(), 104) }
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        },
      },
    })
  } catch (error) {
    console.error('Speed test failed to start', error)
  } finally { speedTestRunning = false }
}
document.querySelector('#settings-speed-test')?.addEventListener('click', () => void startSpeedTest())

elements.settingsFontSize.addEventListener('input', () => {
  state.fontSize = Number(elements.settingsFontSize.value)
  savePreferences()
  syncDefaultTypographySettings()
  syncTypographyControls()
})
elements.notebookPicker.addEventListener('click', () => {
  const willOpen = elements.notebookPickerMenu.hidden
  elements.notebookPickerMenu.hidden = !willOpen
  elements.notebookPicker.setAttribute('aria-expanded', String(willOpen))
  if (willOpen) createIcons({ icons })
})
elements.notebookPickerMenu.addEventListener('click', async (event) => {
  const item = event.target.closest('[data-move-to-notebook]')
  if (!item) return
  elements.notebookPickerMenu.hidden = true
  elements.notebookPicker.setAttribute('aria-expanded', 'false')
  await moveNote(state.activeNoteId, Number(item.dataset.moveToNotebook))
})
document.addEventListener('click', (event) => {
  if (!elements.shareMenu.hidden && !event.target.closest('.share-wrap')) setShareMenuOpen(false)
  if (!event.target.closest('.notebook-picker-wrap')) {
    elements.notebookPickerMenu.hidden = true
    elements.notebookPicker.setAttribute('aria-expanded', 'false')
  }
  if (!event.target.closest('.ink-options-popover, #ink-options-trigger, [data-tool-options]')) closeInkOptions()
})
document.addEventListener('pointerdown', (event) => {
  const target = event.target
  if (
    elements.sidebar.classList.contains('open')
    && !target.closest('.sidebar, #toggle-sidebar')
  ) setSidebarOpen(false)

  if (
    elements.properties.classList.contains('open')
    && !target.closest('.properties-panel, #top-properties')
  ) setPropertiesOpen(false)
})
elements.title.addEventListener('input', () => {
  if (state.activeNoteType === 'mindmap') mindmapEditor?.setTitle(elements.title.value.trim())
  queueSave()
})
elements.list.addEventListener('click', (event) => {
  const item = event.target.closest('[data-note-id]')
  if (item) {
    selectNote(Number(item.dataset.noteId))
    setSidebarOpen(false)
    return
  }
  const add = event.target.closest('[data-new-notebook]')
  if (add) return openNotebookDialog(null, add.dataset.newNotebook)
  const edit = event.target.closest('[data-edit-notebook]')
  if (edit) return openNotebookDialog(state.notebooks.find((notebook) => notebook.id === Number(edit.dataset.editNotebook)))
  if (event.target.closest('[data-inbox-toggle]')) {
    state.inboxOpen = !state.inboxOpen
    return renderNoteList()
  }
  if (event.target.closest('[data-archive-toggle]')) {
    state.archiveOpen = !state.archiveOpen
    return renderNoteList()
  }
  const notebook = event.target.closest('[data-notebook-select]')
  if (notebook) {
    state.selectedNotebookId = Number(notebook.dataset.notebookSelect)
    renderNoteList()
  }
})
elements.list.addEventListener('dragstart', (event) => {
  const note = event.target.closest('[data-note-id]')
  if (!note) return
  event.dataTransfer.setData('text/plain', note.dataset.noteId)
  event.dataTransfer.effectAllowed = 'move'
})
elements.list.addEventListener('dragover', (event) => {
  const notebook = event.target.closest('[data-notebook-drop]')
  if (!notebook) return
  event.preventDefault()
  notebook.classList.add('drag-over')
})
elements.list.addEventListener('dragleave', (event) => event.target.closest('[data-notebook-drop]')?.classList.remove('drag-over'))
elements.list.addEventListener('drop', (event) => {
  const notebook = event.target.closest('[data-notebook-drop]')
  if (!notebook) return
  event.preventDefault()
  notebook.classList.remove('drag-over')
  moveNote(Number(event.dataTransfer.getData('text/plain')), Number(notebook.dataset.notebookDrop))
})

elements.notebookForm.addEventListener('submit', (event) => {
  if (event.submitter?.value === 'cancel') return
  event.preventDefault()
  saveNotebook().catch(console.error)
})
document.querySelector('#delete-notebook').addEventListener('click', () => deleteNotebook().catch(console.error))
document.querySelector('#search-close').addEventListener('click', closeSearch)
elements.searchBackdrop.addEventListener('click', (event) => {
  if (event.target === elements.searchBackdrop) closeSearch()
})
elements.searchInput.addEventListener('input', queueSearch)
elements.searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    elements.searchResults.querySelector('.search-result')?.focus()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    elements.searchResults.querySelector('.search-result')?.click()
  }
})
elements.searchResults.addEventListener('click', (event) => {
  const result = event.target.closest('[data-search-note-id]')
  if (!result) return
  selectNote(Number(result.dataset.searchNoteId))
  closeSearch()
})
elements.searchResults.addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  const results = [...elements.searchResults.querySelectorAll('.search-result')]
  const index = results.indexOf(document.activeElement)
  if (event.key === 'ArrowUp' && index <= 0) elements.searchInput.focus()
  else results[Math.max(0, Math.min(results.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
})

// Native scrolling is gone (the canvas is window-sized), so the keyboard pans it. Only when focus is
// on the page itself, never while typing or on a control that uses these keys (buttons, radios, menus).
function canPanFromKeyboard(activeElement) {
  return keyboardCanPan({
    activeElement,
    body: document.body,
    canvasElement: inputSurface,
    editingText: Boolean(leaferCanvas?.isEditingText()),
    dialogOpen: Boolean(document.querySelector('dialog[open]')) || !elements.searchBackdrop.hidden,
  })
}

// Space is only a hand between drags: while any pointer is down the tool must not change under a stroke,
// connector drag, object drag or eraser pass, so the switch waits for the release.
// A pointerup can be lost (a native context menu eats it), so the set is re-synced from `buttons` and
// cleared on contextmenu, blur and when the page is hidden; a stuck entry must never disable Space.
const activePointers = new Set()
let lastPointerButtons = 0
let spaceHeld = false
function releaseAllPointers() {
  if (!activePointers.size) return
  activePointers.clear()
  setTimeout(settleSpaceAfterPointer, 0)
}
function settleSpaceAfterPointer() {
  if (activePointers.size) return
  if (spaceHeld) beginTemporaryHand()
  else endTemporaryHand()
}
document.addEventListener('pointerdown', (event) => {
  lastPointerButtons = event.buttons
  activePointers.add(event.pointerId)
}, { capture: true })
window.addEventListener('pointermove', (event) => {
  lastPointerButtons = event.buttons
  if (event.buttons === 0) releaseAllPointers()
}, { capture: true })
document.addEventListener('keydown', () => { if (lastPointerButtons === 0) releaseAllPointers() }, { capture: true })
document.addEventListener('contextmenu', releaseAllPointers, { capture: true })
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAllPointers() })
const pointerReleased = (event) => {
  lastPointerButtons = event.buttons
  activePointers.delete(event.pointerId)
  setTimeout(settleSpaceAfterPointer, 0)
}
window.addEventListener('pointerup', pointerReleased, { capture: true })
window.addEventListener('pointercancel', pointerReleased, { capture: true })

function beginTemporaryHand() {
  if (activePointers.size) return
  const hand = temporaryHand.begin(state.tool)
  if (!hand) return
  applyingTemporaryHand = true
  try { setTool(hand) } finally { applyingTemporaryHand = false }
}

function endTemporaryHand() {
  if (activePointers.size) return
  const back = temporaryHand.end()
  if (!back) return
  applyingTemporaryHand = true
  try { setTool(back) } finally { applyingTemporaryHand = false }
}

// A mouse click leaves focus on the dock, zoom and page buttons, and Space would then press that button
// instead of holding the hand. Let go of focus after a mouse click; keyboard use is unaffected.
document.addEventListener('click', (event) => {
  const button = event.target.closest?.('.tool-dock button, .zoom-control button, .page-minimap button')
  if (button && event.detail > 0) button.blur()
})
document.addEventListener('keyup', (event) => { if (event.key === ' ') { spaceHeld = false; endTemporaryHand() } })
window.addEventListener('blur', () => { spaceHeld = false; activePointers.clear(); endTemporaryHand() })

function panWithKeyboard(event) {
  const delta = keyboardPan(event, { viewH: viewSize.height })
  if (!delta) return false
  setCanvasViewportOffset(viewportOffsetX + delta.dx, viewportOffsetY + delta.dy)
  updateNavigationUi(true)
  return true
}

// Keys for the selection on the Leafer canvas (F-028). Returns true when the key was used. Only called when nothing is being typed.
const NUDGE_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
function handleLeaferKey(event) {
  if (state.activeNoteType !== 'canvas' || state.tool === 'hand' || leaferSwitching) return false
  const mod = event.ctrlKey || event.metaKey
  if (mod && !event.shiftKey && !event.altKey && event.code === 'KeyA') {
    leaferCanvas.selectAll()
    return true
  }
  const selection = leaferCanvas.selection()
  if (!selection.length) return false
  if (!mod && !event.altKey && NUDGE_KEYS[event.key]) {
    const step = nudgeDistance(event)
    leaferCanvas.nudge(NUDGE_KEYS[event.key][0] * step, NUDGE_KEYS[event.key][1] * step)
    return true
  }
  if (!mod && !event.altKey && (event.key === 'Delete' || event.key === 'Backspace')) {
    leaferCanvas.deleteSelection()
    return true
  }
  if (!mod && event.key === 'Escape') {
    leaferCanvas.clearSelection()
    return true
  }
  if (mod && !event.altKey && (event.code === 'BracketRight' || event.code === 'BracketLeft')) {
    const forward = event.code === 'BracketRight'
    leaferCanvas.reorderSelection(event.shiftKey ? (forward ? 'front' : 'back') : (forward ? 'forward' : 'backward'))
    return true
  }
  if (mod && event.shiftKey && !event.altKey && event.code === 'KeyL') {
    toggleLeaferLock()
    return true
  }
  return false
}

// Lock the selection, or unlock it when anything in it is locked.
function toggleLeaferLock() {
  const selection = leaferCanvas.selection()
  if (selection.length) leaferCanvas.lockSelection(!selection.some((id) => leaferCanvas.isLocked(id)))
}

document.addEventListener('keydown', (event) => {
  const activeElement = document.activeElement
  const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement?.tagName)
    || activeElement?.isContentEditable
  if (!elements.printPreview.hidden) {
    if (event.key === 'Escape') closePrintPreview()
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
      event.preventDefault()
      printNote()
    }
    return
  }
  const shortcutBlocked = isTyping || Boolean(document.querySelector('dialog[open]')) || !elements.searchBackdrop.hidden
  if (isQuickNoteShortcut(event, { blocked: shortcutBlocked })) {
    event.preventDefault()
    setNoteCreateMenuOpen(false)
    createNote()
  } else if (isSpeedMeterShortcut(event, { blocked: shortcutBlocked })) {
    event.preventDefault()
    setSpeedMeter(!state.speedMeter)
    savePreferences()
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    if (state.activeNoteType === 'canvas') openPrintPreview()
  } else if (event.key === 'Escape' && !elements.shareMenu.hidden) {
    setShareMenuOpen(false)
    elements.shareButton.focus()
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    if (elements.searchBackdrop.hidden) openSearch()
    else closeSearch()
  } else if (event.key === 'Escape' && !elements.searchBackdrop.hidden) {
    closeSearch()
  } else if (event.key === 'Escape' && elements.properties.classList.contains('open')) {
    setPropertiesOpen(false)
  } else if (event.key === 'Escape' && !elements.inkOptionsPopover.hidden) {
    closeInkOptions()
  } else if (event.key === 'Escape' && elements.sidebar.classList.contains('open')) {
    setSidebarOpen(false)
  } else if (pendingClearUndo && !isTyping && (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    undoClear()
  } else if (state.activeNoteType === 'mindmap') {
    return
  } else if (!isTyping && canPanFromKeyboard(activeElement) && handleLeaferKey(event)) {
    event.preventDefault()
  } else if (event.key === 'Escape' && leaferConnect?.active) {
    leaferConnect.cancel()
  } else if (event.key === 'Escape' && !isTyping && state.tool !== 'select') {
    setTool('select')
  } else if (isTyping && (event.ctrlKey || event.metaKey)) {
    return
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    stepHistory(event.shiftKey ? 1 : -1)
  } else if (event.ctrlKey && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    stepHistory(1)
  } else if (!isTyping && event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey && canPanFromKeyboard(activeElement)) {
    event.preventDefault()
    spaceHeld = true
    if (!event.repeat) beginTemporaryHand()
  } else if (!isTyping && canPanFromKeyboard(activeElement) && panWithKeyboard(event)) {
    event.preventDefault()
  } else if (!isTyping && !event.ctrlKey && !event.metaKey) {
    const shortcuts = { t: 'text', p: 'pen', d: 'pen', e: 'eraser', c: 'connect', r: 'shape', n: 'sticky' }
    const quick = toolShortcut(event) || shortcuts[event.key.toLowerCase()]
    if (quick) setTool(quick)
    else if (event.key.toLowerCase() === 'i' && state.activeNoteType === 'canvas' && elements.printPreview.hidden) elements.imageFile.click()
  }
})

// Desktop window only (desktop.py): the native menu bar calls window.personalNote.command(name), and the macOS
// window gets its title-bar chrome. The code is a separate chunk, loaded only inside the desktop app.
if (hostFlag === 'desktop') {
  const clickWhenPresent = (selector) => document.querySelector(selector)?.click()
  const canvasNote = () => state.activeNoteType === 'canvas'
  void import('./modules/desktop/host.js').then(({ installDesktopHost }) => installDesktopHost({
    root: document.documentElement,
    search: location.search,
    api: window.personalNote,
    zoomWindow: () => window.pywebview?.api?.zoom_window?.(),
    handlers: {
      newNote: () => { setNoteCreateMenuOpen(false); void createNote() },
      exportBackup: () => downloadWorkspaceExport('/export/workspace', 'personal-note-backup.json'),
      exportMarkdown: () => downloadWorkspaceExport('/export/markdown', 'personal-note-markdown.zip'),
      print: () => { if (canvasNote()) void openPrintPreview() },
      settings: () => setPropertiesOpen(true),
      history: (name) => {
        if (state.activeNoteType === 'mindmap') clickWhenPresent(`[data-map-action="${name}"]`)
        else stepHistory(name === 'undo' ? -1 : 1)
      },
      zoom: (direction) => {
        if (direction === 'fit') (canvasNote() ? fitAllPages() : clickWhenPresent('[data-map-action="fit"]'))
        else if (canvasNote()) zoomStep(direction)
      },
      skin: (id) => { startSkins().select(id); skinSwitcher.sync() },
      speedMeter: () => { setSpeedMeter(!state.speedMeter); savePreferences() },
      speedTest: () => void startSpeedTest(),
    },
  }))
}

document.querySelector('#zoom-in').addEventListener('click', () => zoomStep(1))
document.querySelector('#zoom-out').addEventListener('click', () => zoomStep(-1))
document.querySelector('#zoom-fit').addEventListener('click', fitAllPages)
elements.zoomValue.addEventListener('click', resetZoom)
elements.miniGrid.addEventListener('click', (event) => {
  const tile = event.target.closest('[data-page-index]')
  if (tile) goToPage(Number(tile.dataset.pageIndex))
})

async function initialize() {
  await prepareCanvasFonts()
  refreshPageColors()
  resizePaper()
  resetCanvasView()
  syncDefaultTypographySettings()
  syncTypographyControls()
  loadCapabilitySettings()
  try {
    ;[state.notebooks, state.notes] = await Promise.all([api('/notebooks'), api('/notes')])
    state.selectedNotebookId = state.notes[0]?.notebookId || state.notebooks[0]?.id || null
    if (!state.notes.length) await createNote()
    else await selectNote(state.notes[0].id)
    agentSync = mountAgentSync({
      api,
      saveStateElement: elements.saveState,
      chipAnchor: elements.searchButton,
      getActive: () => {
        const note = state.notes.find((item) => item.id === state.activeNoteId)
        return note ? { id: note.id, resourceId: note.resourceId, revision: note.revision, noteType: state.activeNoteType } : null
      },
      // Also true while words are being typed in the editor.
      hasUnsavedEdits: () => unsavedEdits || saveInFlight || Boolean(leaferCanvas?.isEditingText()),
      // Where the flag over the block an agent is writing sits: that text's top-left corner on screen, or null when it is off screen.
      locateFlagBlock: (action) => {
        const block = pickFlagBlock(action, leaferEdits.doc?.objects ?? [])
        if (!block) return null
        const box = leaferHost.getBoundingClientRect()
        const { x, y, scale } = leaferCanvas.view()
        const point = { x: box.left + x + block.geometry.x * scale, y: box.top + y + block.geometry.y * scale }
        const area = elements.workspace.getBoundingClientRect()
        const inside = point.x >= area.left && point.x <= area.right && point.y >= area.top && point.y <= area.bottom
        return inside ? point : null
      },
      onLayout: (callback) => {
        layoutListeners.push(callback)
        elements.workspace.addEventListener('scroll', callback, { passive: true })
        window.addEventListener('resize', callback)
      },
      reload: applyRemoteNote,
      merge: mergeRemoteNote,
      refreshLists: refreshWorkspaceLists,
    })
  } catch (error) {
    console.error(error)
    setSaveState('Database offline', true)
  }
}

{
  const modifier = modifierLabel(navigator.platform)
  const glue = modifier === '⌘' ? '' : ' '
  document.querySelector('#quick-note-kbd').textContent = quickNoteKeycap(navigator.platform)
  document.querySelector('#search-kbd').textContent = `${modifier}${glue}K`
  document.querySelector('#print-kbd').textContent = `${modifier}${glue}P`
  elements.searchButton.title = `Search notes (${modifier}${glue}K)`
}

document.fonts.ready.then(refreshCanvasTextMetrics)
document.fonts.addEventListener('loadingdone', refreshCanvasTextMetrics)
function handleWorkspaceResize() {
  if (state.activeNoteType !== 'canvas') return
  const previous = { x: viewportOffsetX, y: viewportOffsetY, scale: getCanvasScale() }
  state.displayScale = getDisplayScale()
  syncCanvasSize()
  refreshPageColors()
  const center = { x: viewSize.width / 2, y: viewSize.height / 2 }
  const next = zoomAtPoint(previous, getCanvasScale(), center)
  setCanvasViewportOffset(next.x, next.y)
}
// Page colors and shadow come from skin tokens, so repaint when the skin changes.
const repaintPageColors = () => refreshPageColors()
new MutationObserver(repaintPageColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin'] })
window.matchMedia('(prefers-contrast: more)').addEventListener('change', repaintPageColors)
window.addEventListener('resize', handleWorkspaceResize)

// F-035: the on-screen keyboard takes the lower part of the window (visualViewport shrinks, or the window does). The text being typed stays
// in the part still showing: the view moves up just far enough, never pushing the first line under the top bar.
let keyboardTimer = 0
function keepEditorAboveKeyboard() {
  clearTimeout(keyboardTimer)
  keyboardTimer = setTimeout(() => {
    const area = leaferCanvas.isEditingText() ? document.querySelector('.leafer-text-editor') : null
    if (!area) return
    const vv = window.visualViewport
    const rect = area.getBoundingClientRect()
    const delta = Math.min(rect.bottom - ((vv ? vv.offsetTop + vv.height : window.innerHeight) - 16), rect.top - ((vv ? vv.offsetTop : 0) + 70))
    if (delta > 0) setCanvasViewportOffset(viewportOffsetX, viewportOffsetY - delta, true)
  }, 120)
}
window.visualViewport?.addEventListener('resize', keepEditorAboveKeyboard)
window.visualViewport?.addEventListener('scroll', keepEditorAboveKeyboard)
window.addEventListener('resize', keepEditorAboveKeyboard)
document.addEventListener('input', (event) => { if (event.target?.classList?.contains('leafer-text-editor')) keepEditorAboveKeyboard() }, true)
document.addEventListener('focusin', (event) => { if (event.target?.classList?.contains('leafer-text-editor')) keepEditorAboveKeyboard() })
if (typeof ResizeObserver === 'function') new ResizeObserver(handleWorkspaceResize).observe(elements.workspace)
setupVoiceInput()
setupToolOptionGestures()
// Dev-only handle used by the scripts/ checks; stripped from production builds.
if (import.meta.env.DEV) window.__personalNote = { voiceBoxPoint: () => pageBoundedTextLayout(currentVoiceInsertPoint(), { pageWidth: PAGE_WIDTH }), selectNote, leaferBase: () => leaferBase, inputSurface, viewSize, state, leaferEdits, leaferSource: () => leaferSource, encodeDocument, createNote, setLeaferSourceNoteId: (id) => { leaferSource.noteId = id }, leaferCanvas: () => leaferCanvas, setTool, getCanvasScale, setCanvasViewportOffset, pageExtents: () => pageExtentsNow, pageExtentsTarget, refreshWorkspaceLists }
initialize().then(async () => { await speedTestStatus; if (speedTestInstance && new URLSearchParams(location.search).get('speedtest') === '1') setTimeout(() => void startSpeedTest(), 800) }) // `npm run speedtest` opens the page this way
