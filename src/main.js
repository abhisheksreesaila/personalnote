import './style.css'
import './workspace-theme.css'
import './skins.css'
import './chrome.css'
import './secure.css'
import { mountSkinSwitcher, SKINS, startSkins } from './skins.js'
import { buildGroups, FILTERS, flatten, highlight, latestRequest, moveSelection, queryTokens } from './modules/omnibar/omnibar.js'
import { MAC_CHROME_CLASS, readHostChrome, setMacFullscreen } from './modules/desktop/hostChrome.js'
import { createIcons, icons } from './icons.js'
import { createSecureSession } from './modules/secure/session.js'
import { createHeldEdit, noteRowIcon, searchResultView } from './modules/secure/secure.js'
import { api, downloadWorkspaceFile } from './core/api.js'
import { createDocumentEncoder, decodeNoteDocument, encodeDocument } from './core/note-codec.js'
import { nudgeDistance } from './core/document/operations.js'
import { createVoiceClient, describeVoice, prepareLocalVoice } from './modules/voice/voice-setup.js'
import { createMeaningClient, describeMeaning, indexIsCatchingUp } from './modules/search/meaning-setup.js'
import { mountMindMapModule } from './modules/mindmap.js'
import { mountPageModule } from './modules/page.js'
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
import { RENDER_MODES } from './modules/canvas-leafer/perf.js'
import { createLeaferEdits } from './modules/canvas-leafer/edits.js'
import { mergeDocuments } from './core/document/merge.js'
import { createInk } from './modules/canvas-leafer/ink.js'
import { pictureFiles, prepareImage, uploadPicture } from './modules/canvas-leafer/media.js'
import { renderNotePicture, renderSheet } from './modules/canvas-leafer/export.js'
import { createConnectTool } from './modules/canvas-leafer/connect-tool.js'
import { EDGE_OVERFLOW, shiftedDocument } from './modules/canvas-leafer/pages.js'
import { createSpeedMeter, detectEngine, detectHost, isSpeedMeterShortcut } from './speedMeter.js'
import { createPressToTalk } from './modules/voice/press-to-talk.js'
import { CATEGORIES, categoryLabel, inboxNotes, isQuickNoteShortcut, isSectionOpen, modifierLabel, outline as notebookOutline, quickNoteKeycap, NOTEBOOK_FOLD_KEY, readFolded, writeFolded } from './modules/library/outline.js'
import { mountShelves } from './modules/library/shelves.js'
import { iconButtonHtml, openIconPicker } from './modules/library/notebook-icon-picker.js'
import { NOTEBOOK_COLORS } from './modules/library/notebook-icon.js'
import { bindPageLifecycle, canKeepAlive, confirmedRevision, createSaveTiming, joinSaveBody, settleSaves } from './modules/editor/save-flush.js'
import { canPanFromKeyboard as keyboardCanPan, keyboardPan } from './modules/editor/keyboard-pan.js'
import { createTemporaryHand, toolShortcut } from './modules/editor/tool-switch.js'
import { createDoubleTap, tapKeyFor } from './modules/editor/double-tap.js'
import { createMiddleClick } from './modules/editor/middle-click.js'
import { DEFAULT_FONT_CHOICE, canvasFontFamily, fontChoice } from './modules/editor/fonts.js'
import { loadPanelOpen, savePanelOpen } from './modules/library/panel-pref.js'
import { writingBox } from './modules/canvas-leafer/text-ops.js'
import { countWords, createFocusMode, focusShortcut, focusView } from './modules/editor/focus-mode.js'
import { chooseOpeningView, fitView, isDrawingTool, openingView, pageLabel, pageView, scrollThumbs, stepZoom, writingView, zoomPercent } from './modules/editor/navigation.js'
import {
  clampView,
  pageExtents,
  parseBoxShadow,
  shiftExtents,
  viewMargins,
  wheelPanDelta,
  giveWayToIsland,
  moveWithCentre,
  zoomAtPoint,
} from './modules/editor/viewport.js'

const PAGE_WIDTH = 860
const PAGE_HEIGHT = 1080
const PAGE_ISLAND_CLEARANCE = { right: PAGE_WIDTH, clear: 80 } // the tool island (56px) and its 16px inset, plus a gap: the page's right edge stays left of this strip
let panelGaveWay = 0 // how far the page gave way to the tool island when the notes panel narrowed the area (F-083); closing the panel returns it
let gaveWayAt = null // the view that left it there: if the person has panned or zoomed since, nothing is owed
const panelOwed = () => (gaveWayAt && Math.abs(viewportOffsetX - gaveWayAt.x) < 0.5 && Math.abs(getCanvasScale() - gaveWayAt.scale) < 1e-6 ? panelGaveWay : 0)
const CANVAS_ZOOM_MIN = 0.25
const CANVAS_ZOOM_MAX = 4
// desktop.py opens the Chromium app window with engine=chromium (see createSaveTiming).
const heldEdit = createHeldEdit() // typed words a secure note's save could not take because it had locked
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
      <button class="quick-note hold-create-button" id="rail-new-note" title="New note - hold for more types" aria-label="Quick note. Press and hold for more note types" aria-haspopup="menu" aria-expanded="false">
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
          <input class="note-title" id="note-title" value="Untitled note" aria-label="Note title" />
          <div class="save-state" id="save-state"><span></span>Saved on this device</div>
          <div class="share-wrap">
            <button class="pill-more share-button" id="share-button" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="false"><i data-lucide="more-horizontal"></i></button>
            <div class="share-menu" id="share-menu" role="menu" aria-label="More actions" hidden>
              <button role="menuitem" id="share-print"><i data-lucide="printer"></i><span>Print preview</span><kbd id="print-kbd">Ctrl P</kbd></button>
              <button role="menuitem" id="share-png"><i data-lucide="image-down"></i><span>Note as picture (PNG)</span></button>
              <button role="menuitem" id="share-backup"><i data-lucide="archive"></i><span>Download backup</span></button>
              <button role="menuitem" id="share-markdown"><i data-lucide="file-down"></i><span>Markdown + assets</span></button>
              <button role="menuitem" id="share-vault"><i data-lucide="folder-down"></i><span>Obsidian vault</span></button>
              <button role="menuitem" id="fold-all" title="Fold all linked objects into their words" hidden><i data-lucide="fold-vertical"></i><span>Fold all</span></button>
              <button role="menuitem" id="clear-note" title="Clear all"><i data-lucide="eraser"></i><span>Clear all</span></button>
              <button role="menuitem" id="top-properties" title="Settings and properties" aria-controls="properties-panel" aria-expanded="false"><i data-lucide="sliders-horizontal"></i><span>Settings and properties</span></button>
            </div>
          </div>
        </div>
        <div class="topbar-actions">
          <button class="focus-pill" id="focus-button" data-keeps-text-editing title="Focus mode (Ctrl+.)" aria-label="Focus mode"><i data-lucide="focus"></i><span>Focus</span><kbd id="focus-top-kbd">Ctrl .</kbd></button>
          <button class="search-button" id="search-button" title="Search or jump to (Ctrl+K)" aria-label="Search or jump to" aria-haspopup="dialog"><i data-lucide="search"></i><span>Search</span><kbd id="search-kbd">Ctrl K</kbd></button>
        </div>
      </header>
      <div class="focus-strip" id="focus-strip"><b id="focus-title"></b><span id="focus-count"></span><button type="button" id="focus-leave" data-keeps-text-editing><i data-lucide="x"></i>Leave focus <kbd>Esc</kbd></button></div>
      <div class="focus-hint" id="focus-hint" aria-hidden="true">Esc or <span id="focus-kbd">Ctrl .</span> to leave</div>

      <section class="workspace" id="workspace">
        <div class="selection-bar" id="selection-bar" role="toolbar" aria-label="Selected objects" hidden>
          <button type="button" data-selection-action="backward" title="Send backward (Ctrl+[)">Back</button>
          <button type="button" data-selection-action="forward" title="Bring forward (Ctrl+])">Forward</button>
          <button type="button" data-selection-action="lock" title="Lock or unlock (Ctrl+Shift+L)">Lock</button>
          <button type="button" data-selection-action="link" title="Link to words: then click a word of a text; the word opens and folds it">Link to words</button>
          <button type="button" data-selection-action="delete" title="Delete (Delete key)">Delete</button>
        </div>
        <div class="tool-dock" role="toolbar" aria-label="Canvas tools" aria-orientation="vertical">
          <div class="dock-canvas" id="dock-canvas">
            <div class="tool-group dock-tools">
              <button class="tool-button" data-tool="select" title="Select (V)" aria-label="Select">${dockIcon('select')}</button>
              <button class="tool-button active" data-tool="text" data-tool-options title="Text (T) - hold for color" aria-label="Text">${dockIcon('text')}</button>
              <button class="tool-button" data-tool="pen" data-tool-options title="Pen (D or P) - hold for color and width" aria-label="Pen">${dockIcon('pen')}</button>
              <button class="tool-button" data-tool="eraser" title="Stroke eraser (E)" aria-label="Stroke eraser">${dockIcon('eraser')}</button>
              <button class="tool-button" data-tool="shape" data-tool-options title="Shape (R) - click the page to place, hold for color" aria-label="Shape">${dockIcon('shape')}</button>
              <button class="tool-button" data-tool="sticky" data-tool-options title="Sticky note (N) - click the page to place, hold for color" aria-label="Sticky note">${dockIcon('sticky')}</button>
            </div>
            <div class="dock-divider"></div>
            <button class="tool-button ink-options-trigger" id="ink-options-trigger" title="Colors and widths" aria-label="Open ink options" aria-haspopup="dialog" aria-expanded="false"><span class="ink-options-dot" id="ink-options-dot"></span></button>
            <div class="dock-more-wrap">
              <button class="tool-button dock-more" id="dock-more" data-keeps-text-editing title="More tools" aria-label="More tools" aria-haspopup="true" aria-expanded="false"><i data-lucide="plus" class="more-plus"></i><span class="more-tool" id="dock-more-tool"></span></button>
              <div class="dock-flyout" id="dock-flyout" role="group" aria-label="More tools" hidden>
                <button class="tool-button" data-tool="hand" title="Hand (H) - drag to move the canvas; or hold Space" aria-label="Hand"><i data-lucide="hand"></i></button>
                <button class="tool-button" data-tool="highlight" data-tool-options title="Highlighter (M) - hold for color and width" aria-label="Highlighter">${dockIcon('marker')}</button>
                <button class="tool-button" data-tool="connect" title="Connect (C) - drag from one object to another" aria-label="Connect">${dockIcon('connect')}</button>
                <button class="tool-button" id="add-image" title="Image (I) - choose a file, or drop one on the page" aria-label="Add image">${dockIcon('image')}</button>
                <button class="tool-button prettify-button" id="prettify" data-keeps-text-editing title="Prettify selected text or this note" aria-label="Prettify selected text or this note"><i data-lucide="align-left"></i></button>
              </div>
            </div>
            <input type="file" id="image-file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />
            <div class="dock-divider"></div>
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
        <div class="page-host" id="page-host" hidden></div>
        <div class="scroll-indicator scroll-indicator-y" id="scroll-y" aria-hidden="true"><span></span></div>
        <div class="scroll-indicator scroll-indicator-x" id="scroll-x" aria-hidden="true"><span></span></div>
        <div class="history-island" id="history-island" role="group" aria-label="History">
          <button class="icon-button" id="undo" title="Undo" aria-label="Undo">${dockIcon("undo")}</button>
          <button class="icon-button" id="redo" title="Redo" aria-label="Redo">${dockIcon("redo")}</button>
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
        <details class="settings-advanced">
          <summary>Advanced</summary>
          <label class="setting-row" for="settings-render-mode"><span>Render mode</span><select id="settings-render-mode"><option value="default">Hybrid (page bitmaps while navigating)</option><option value="classic">Draw every step (before)</option><option value="bitmaps">Page bitmaps always</option><option value="gestureTransform">Slide picture (preview 3)</option><option value="dpr1">Lower resolution (1x)</option></select></label>
          <p class="portability-help">For trying how the canvas feels on this computer. Changes only how the screen is drawn, never a note. "Page bitmaps always" can make drawing and typing slower.</p>
        </details>
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
        <progress class="setup-progress" id="voice-setup-progress" max="100" value="0" aria-label="Voice download progress" hidden></progress>
        <p class="portability-help" id="voice-setup-detail" role="status" aria-live="polite"></p>
        <div class="portability-actions">
          <button id="voice-download" hidden><i data-lucide="download"></i><span></span></button>
          <button id="voice-cancel" hidden><i data-lucide="x"></i><span></span></button>
          <button id="voice-remove" hidden><i data-lucide="trash-2"></i><span></span></button>
        </div>
      </section>
      <section class="settings-section" id="settings-meaning-section" aria-labelledby="settings-meaning-label">
        <p class="settings-section-label" id="settings-meaning-label">Search by meaning</p>
        <div class="setting-row"><span><i data-lucide="search"></i>Find by meaning</span><small id="meaning-setup-headline">Checking…</small></div>
        <progress class="setup-progress" id="meaning-setup-progress" max="100" value="0" aria-label="Search by meaning download progress" hidden></progress>
        <p class="portability-help" id="meaning-setup-detail" role="status" aria-live="polite"></p>
        <div class="portability-actions">
          <button id="meaning-download" hidden><i data-lucide="download"></i><span></span></button>
          <button id="meaning-cancel" hidden><i data-lucide="x"></i><span></span></button>
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
        <button class="secure-note-action" id="secure-note" type="button"><i data-lucide="lock"></i><span>Make secure</span></button>
        <button class="delete-note-action" id="delete-note"><i data-lucide="trash-2"></i><span>Delete note</span></button>
      </div>
    </aside>

  </div>

  <div class="search-backdrop" id="search-backdrop" hidden>
    <section class="spotlight" role="dialog" aria-modal="true" aria-label="Search or jump to">
      <div class="spotlight-input-row">
        <i data-lucide="search"></i>
        <input id="search-input" type="text" role="combobox" aria-expanded="true" aria-controls="search-results" aria-autocomplete="list" placeholder="Search notes, words, notebooks, actions" autocomplete="off" spellcheck="false" aria-label="Search notes, words, notebooks and actions" />
        <button class="search-close" id="search-close" aria-label="Close search"><span class="k-esc">Esc</span><span class="k-cancel">Cancel</span></button>
      </div>
      <div class="omni-chips" id="omni-chips" role="group" aria-label="Show"></div>
      <div class="search-results" id="search-results" role="listbox" aria-label="Results"></div>
      <footer class="search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Move</span><span><kbd>↵</kbd> Open</span><span><kbd>Esc</kbd> Close</span></footer>
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
        <button class="icon-button notebook-dialog-close" type="button" aria-label="Close"><i data-lucide="x"></i></button>
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
          ${NOTEBOOK_COLORS.map((color) => `
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
        <button class="dialog-cancel notebook-dialog-close" type="button">Cancel</button>
        <button class="dialog-primary" id="save-notebook" value="default">Create</button>
      </div>
    </form>
  </dialog>

  <div class="toast" id="toast" role="status" aria-live="polite" hidden><span></span><button id="toast-action" type="button">Undo</button></div>
  <div class="toast" id="tool-pill" style="pointer-events:none;top:64px;bottom:auto;padding:6px 14px" role="status" aria-live="polite" hidden></div>

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
  pageHost: document.querySelector('#page-host'),
  title: document.querySelector('#note-title'),
  list: document.querySelector('#notebook-navigator'),
  notebookList: document.querySelector('#notebook-list'),
  saveState: document.querySelector('#save-state'),
  historyIsland: document.querySelector('#history-island'),
  zoomFit: document.querySelector('#zoom-fit'),
  dockMore: document.querySelector('#dock-more'),
  dockMoreTool: document.querySelector('#dock-more-tool'),
  dockFlyout: document.querySelector('#dock-flyout'),
  zoomControl: document.querySelector('#zoom-control'),
  zoomValue: document.querySelector('#zoom-value'),
  scrollX: document.querySelector('#scroll-x'),
  scrollY: document.querySelector('#scroll-y'),
  dockCanvas: document.querySelector('#dock-canvas'),
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
  toolPill: document.querySelector('#tool-pill'),
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
  settingsRenderMode: document.querySelector('#settings-render-mode'),
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
  sectionOpen: readFolded(safeStorage()),
  notebookOpen: readFolded(safeStorage(), NOTEBOOK_FOLD_KEY), // notebook id -> whether its notes show; several can be open
  pages: { columns: 1, rows: 1 },
  tool: 'text',
  color: '#20201e',
  objectColor: 0,
  penWidth: 3,
  highlightWidth: 20,
  fontFamily: DEFAULT_FONT_CHOICE,
  fontSize: 24,
  speedMeter: false,
  renderMode: 'default',
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
  noteLocked: false, // the open note is a locked secure note: the page shows its cover and nothing here may be saved
}

let mindmapEditor = null
let pageEditor = null

function setActiveNoteType(noteType) {
  state.activeNoteType = noteType === 'mindmap' || noteType === 'page' ? noteType : 'canvas'
  const isMindMap = state.activeNoteType === 'mindmap'
  const isPage = state.activeNoteType === 'page'
  const notCanvas = isMindMap || isPage
  elements.shell.classList.toggle('mindmap-active', isMindMap)
  elements.shell.classList.toggle('page-active', isPage)
  elements.paper.hidden = notCanvas
  elements.mindmapHost.hidden = !isMindMap
  elements.pageHost.hidden = !isPage
  elements.historyIsland.hidden = notCanvas
  elements.zoomControl.hidden = notCanvas
  elements.dockCanvas.hidden = notCanvas
  setFlyoutOpen(false)
  if (notCanvas) hideScrollIndicators()
  elements.canvasTypographyProperties.hidden = notCanvas
  elements.mindmapProperties.hidden = !isMindMap
  elements.mindmapRailActions.hidden = !isMindMap
  elements.properties.querySelector('.properties-heading span').textContent = isMindMap ? 'Mind map' : 'Inspector'
  elements.properties.querySelector('.properties-heading h2').textContent = isMindMap ? 'Node properties' : 'Note properties'
  elements.noteSurfaceLabel.textContent = isMindMap ? 'Mind map' : isPage ? 'Page' : 'Canvas'
  elements.noteSurfaceDetail.textContent = isMindMap ? 'Infinite SVG workspace' : isPage ? 'Markdown you can draw on' : 'Expands automatically'
  elements.printButton.disabled = notCanvas
  elements.printButton.title = notCanvas ? 'Print preview is available for canvas notes' : 'Print preview'
  if (!isMindMap) {
    mindmapEditor?.destroy()
    mindmapEditor = null
  }
  if (!isPage) {
    pageMountTicket += 1
    pageEditor?.destroy()
    pageEditor = null
  }
}

// The editor chunk loads asynchronously: a mount that finishes after another note was picked is thrown away, never left running.
let pageMountTicket = 0
async function mountActivePage(documentValue) {
  pageEditor?.destroy()
  pageEditor = null
  const ticket = ++pageMountTicket
  const editor = await mountPageModule(elements.pageHost, { documentValue, onChange: () => queueSave() })
  if (ticket !== pageMountTicket || state.activeNoteType !== 'page') { editor.destroy(); return }
  pageEditor = editor
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
  if (preferences.renderMode) state.renderMode = preferences.renderMode
}

function savePreferences() {
  writePreferences(undefined, { fontFamily: state.fontFamily, fontSize: state.fontSize, speedMeter: state.speedMeter, renderMode: state.renderMode })
}

// The canvas's render strategy (perf.js): a benchmark's own `window.__pnPerf` switches stay, the named mode goes on top. The speed test's comparison and
// Settings > Performance > Advanced > Render mode both come through here.
const externalPerf = { ...(globalThis.__pnPerf ?? {}) }
function setPerfSwitches(name) { globalThis.__pnPerf = { ...externalPerf, ...(RENDER_MODES[name] ?? {}) } }

loadPreferences()
setPerfSwitches(state.renderMode)

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
  '600 24px "Geist Mono"', // Markdown bold and headings (F-048)
  'italic 400 24px "Source Serif 4"',
  '600 24px "IBM Plex Mono"',
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

function setFlyoutOpen(open) {
  elements.dockFlyout.hidden = !open
  elements.dockMore.setAttribute('aria-expanded', String(open))
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
  const placing = state.tool === 'sticky' || state.tool === 'shape'
  elements.inkOptionsDot.style.setProperty('--active-ink', placing ? currentObjectPalette()[state.objectColor].fill : state.color) // the dot shows the colour the active tool will use
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
  document.querySelectorAll('.palette-swatch:not(.object-swatch)').forEach((swatch) => {
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

// Beside the tool island, level with the control that opened it (the dot when that control sat in the flyout, which has just closed).
function positionInkOptions(anchor) {
  const popover = elements.inkOptionsPopover
  const source = elements.dockFlyout.contains(anchor) ? elements.inkOptionsTrigger : anchor
  const rect = source.getBoundingClientRect()
  const island = elements.inkOptionsTrigger.closest('.tool-dock').getBoundingClientRect()
  popover.style.right = `${window.innerWidth - island.left + 12}px`
  popover.style.top = `${Math.max(8, Math.min(window.innerHeight - 8 - popover.offsetHeight, rect.top + rect.height / 2 - popover.offsetHeight / 2))}px`
}

function openInkOptions(anchor = elements.inkOptionsTrigger) {
  clearTimeout(inkOptionsCloseTimer)
  updateInkOptions()
  setFlyoutOpen(false)
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

// The Archive's icon is a box whose lid opens while something is dragged over it (plain CSS, see .sec-box).
const ARCHIVE_BOX = '<svg class="sec-box" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/><g class="lid"><rect x="2.5" y="4" width="19" height="5" rx="1.2"/></g></svg>'
const SECTION_ICONS = { projects: 'target', areas: 'compass', resources: 'book-open' }
let lastInboxCount = 0
let shelves = null

function safeStorage() {
  try { return window.localStorage } catch { return null }
}

function noteRowHtml(note) {
  const secureRow = noteRowIcon(note) // a secure note shows the lock in the secure colour
  const dot = `<i data-lucide="${secureRow.icon}"></i>`
  return `
    <button class="note-list-item ${note.id === state.activeNoteId ? 'active' : ''} ${secureRow.className}" data-note-id="${note.id}" draggable="true">
      ${dot}
      <span>${escapeHtml(note.title || 'Untitled note')}</span>
    </button>
  `
}

let lastSelectedNotebookId = null // a notebook that becomes the selected one (a note opened in it, a new one) opens

function setNotebookOpen(id, open) {
  state.notebookOpen[id] = open
  writeFolded(safeStorage(), state.notebookOpen, NOTEBOOK_FOLD_KEY)
}

// The notes of a closed notebook are only drawn once it has been opened (a notebook can hold hundreds); closing just folds them.
function notebookRowHtml(notebook, selectedNotebook) {
  const isSelected = notebook.id === selectedNotebook?.id
  const isOpen = state.notebookOpen[notebook.id] === true
  const notes = isOpen ? state.notes.filter((note) => note.notebookId === notebook.id) : []
  return `
    <div class="nbk${isOpen ? ' open' : ''}" data-nbk="${notebook.id}">
    <div class="nav-row ${isSelected ? 'active' : ''}">
      <button class="notebook-tab ${isSelected ? 'active' : ''}" draggable="true" data-notebook-select="${notebook.id}" data-notebook-drop="${notebook.id}" data-notebook-drag="${notebook.id}" data-category="${notebook.category}" aria-expanded="${isOpen}">
        <span class="nbi-gap"></span>
        <span class="notebook-name">${escapeHtml(notebook.name)}</span>
        <span class="notebook-count">${notebook.count}</span><i class="sec-chev" data-lucide="chevron-right"></i>
      </button>
      ${iconButtonHtml(notebook)}
      <button class="nav-edit nav-new-note" data-new-note-in="${notebook.id}" title="New note in ${escapeHtml(notebook.name)}" aria-label="New note in ${escapeHtml(notebook.name)}"><i data-lucide="plus"></i></button>
      <button class="nav-edit" data-edit-notebook="${notebook.id}" title="Edit ${escapeHtml(notebook.name)}" aria-label="Edit notebook ${escapeHtml(notebook.name)}"><i data-lucide="more-horizontal"></i></button>
    </div>
    <div class="fold"${isOpen ? '' : ' inert'}><div class="inner">
      ${isOpen ? `<div class="nav-notes" role="group" aria-label="Notes in ${escapeHtml(notebook.name)}">
        ${notes.length ? notes.map((note) => noteRowHtml(note)).join('') : '<div class="empty-notebook"><span>No notes yet</span></div>'}
      </div>` : ''}
    </div></div>
    </div>
  `
}

// Click on a notebook row: an open notebook folds, a folded one opens, and nothing else changes (the selection and breadcrumb stay). Only classes change, unless the notes were never drawn.
function toggleNotebook(id) {
  const open = state.notebookOpen[id] !== true
  setNotebookOpen(id, open)
  const wrap = elements.list.querySelector(`[data-nbk="${id}"]`)
  if (!wrap || (open && !wrap.querySelector('.nav-notes'))) return renderNoteList()
  wrap.classList.toggle('open', open)
  wrap.querySelector('[data-notebook-select]').setAttribute('aria-expanded', String(open))
  wrap.querySelector('.fold').toggleAttribute('inert', !open)
}

function renderNoteList() {
  // An unfiled note has no notebook (it sits in the Inbox), so no notebook is open for it.
  const selectedNotebook = state.notebooks.find((notebook) => notebook.id === state.selectedNotebookId)
  if (!selectedNotebook) state.selectedNotebookId = null
  if (selectedNotebook && selectedNotebook.id !== lastSelectedNotebookId) setNotebookOpen(selectedNotebook.id, true)
  lastSelectedNotebookId = selectedNotebook?.id ?? null

  const sections = notebookOutline(state.notebooks, state.notes)
  const unfiled = inboxNotes(state.notes)
  const openClass = (id) => (isSectionOpen(state.sectionOpen, id) ? ' open' : '')
  const chevron = '<i class="sec-chev" data-lucide="chevron-right"></i>'

  // Inbox first: the notes not filed yet, with a count that empties as they are filed.
  const inboxHtml = `
    <div class="sec inbox-sec${openClass('inbox')}" data-sec="inbox" data-inbox-drop>
      <div class="sec-top"><button class="sec-head inbox-head" data-fold="inbox" aria-expanded="${isSectionOpen(state.sectionOpen, 'inbox')}">
        <span class="sec-ic"><i data-lucide="inbox"></i></span><span class="lbl">Inbox</span>
        <span class="badge ${unfiled.length ? '' : 'zero'}" id="inbox-badge" title="Notes not filed yet">${unfiled.length}</span>${chevron}
      </button></div>
      <div class="fold"><div class="inner">
        <div class="nav-notes" role="group" aria-label="Inbox">
          ${unfiled.length ? unfiled.map((note) => noteRowHtml(note)).join('') : '<div class="empty-notebook"><span>All filed. New notes land here.</span></div>'}
        </div>
      </div></div>
    </div>`

  // Projects, Areas, Resources and Archive: shelves a notebook can be dragged onto.
  const sectionHtml = sections.map((section) => {
    const icon = section.id === 'archive' ? ARCHIVE_BOX : `<i data-lucide="${SECTION_ICONS[section.id]}"></i>`
    return `
      <div class="sec${openClass(section.id)}" data-sec="${section.id}" data-sec-drop="${section.id}">
        <div class="sec-top">
          <button class="sec-head" data-fold="${section.id}" aria-expanded="${isSectionOpen(state.sectionOpen, section.id)}">
            <span class="sec-ic">${icon}</span><span class="lbl">${section.label}</span>
            ${section.id === 'archive' ? `<span class="notebook-count" title="Notebooks in the Archive">${section.notebooks.length}</span>` : ''}${chevron}
          </button>
          ${section.id === 'archive' ? '' : `<button class="sec-add" type="button" data-new-notebook="${section.id}" title="New notebook in ${section.label} (Shift-click: choose a colour)" aria-label="New notebook in ${section.label}"><i data-lucide="plus"></i></button>`}
        </div>
        <div class="fold"><div class="inner">
          ${section.notebooks.map((notebook) => notebookRowHtml(notebook, selectedNotebook)).join('')}
          ${section.notebooks.length ? '' : '<div class="empty-notebook empty-section"><span>Drop a notebook here</span></div>'}
        </div></div>
      </div>`
  }).join('')

  // Keep the outline's scroll position across re-renders.
  const scrollTop = elements.list.scrollTop
  shelves?.beforeRender()
  elements.notebookList.innerHTML = inboxHtml + sectionHtml
  elements.list.scrollTop = scrollTop
  if (lastInboxCount > unfiled.length) shelves?.bumpInbox() // a note just left the Inbox
  lastInboxCount = unfiled.length

  renderNotebookPicker()
  createIcons({ icons })
  shelves?.afterRender()
}

function renderNotebookPicker() {
  const activeNote = state.notes.find((note) => note.id === state.activeNoteId)
  if (!activeNote) {
    elements.notebookPicker.innerHTML = ''
    return
  }
  const notebook = state.notebooks.find((item) => item.id === activeNote.notebookId) // none: the note is in the Inbox
  elements.notebookPicker.innerHTML = `
    ${notebook ? `<span class="picker-dot" style="--notebook-color:${notebook.color}"></span>` : '<i data-lucide="inbox"></i>'}
    <span>${escapeHtml(notebook ? notebook.name : 'Inbox')}</span><i data-lucide="chevron-down"></i>
  `
  elements.notebookPickerMenu.innerHTML = `
    <button role="menuitem" data-move-to-notebook="inbox" class="${notebook ? '' : 'active'}">
      <i data-lucide="inbox"></i><span>Inbox</span>${notebook ? '' : '<i data-lucide="check"></i>'}
    </button>
  ` + state.notebooks.map((item) => `
    <button role="menuitem" data-move-to-notebook="${item.id}" class="${item.id === notebook?.id ? 'active' : ''}">
      <span class="picker-dot" style="--notebook-color:${item.color}"></span>
      <span>${escapeHtml(item.name)}</span>${item.id === notebook?.id ? '<i data-lucide="check"></i>' : ''}
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

// F-059: a glide of the view in progress (glideViewTo, below) gives way to any other move of the view.
let viewGlide = 0
const stopGlide = () => cancelAnimationFrame(viewGlide) // the person moved the view (or a note opened): their move wins
function setCanvasViewportOffset(offsetX = viewportOffsetX, offsetY = viewportOffsetY, keep = false) {
  stopGlide()
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
let scrollFadeTimer

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
  updateWritingQuiet()
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
  stopGlide()
  const next = stepZoom(state.canvasZoom, direction, { min: CANVAS_ZOOM_MIN, max: CANVAS_ZOOM_MAX })
  setViewTo(zoomTarget(next))
}

function fitAllPages() {
  stopGlide()
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

const OPEN_ZOOM_MIN = 0.4
const OPEN_OBJECT_LIMIT = 150

// A note opens with its whole page grid on the desk (zoomed out). A dense note would pan at a crawl with hundreds of
// objects on screen, so it opens on its first page, or at full size if even that is crowded. Phones keep the
// full-width first page.
// F-059 editor first: a note with Markdown writing (or nothing in it yet) opens like a document, at 100% at its writing; a note of
// drawings opens as before. Returns { text } (the topmost Markdown text, or null for an empty note) or null.
function writingTarget() {
  if (window.innerWidth <= 800) return null
  const objects = (leaferEdits.doc?.objects ?? []).filter(Boolean)
  const texts = objects.filter((object) => object.type === 'text' && object.format === 'markdown' && object.geometry).sort((a, b) => a.geometry.y - b.geometry.y || a.geometry.x - b.geometry.x)
  if (texts.length) return { text: texts[0] }
  return objects.length ? null : { text: null }
}

function writingViewFor(text) {
  const g = text?.geometry
  const column = g ? Math.max(0, Math.floor((g.x + 1) / PAGE_WIDTH)) : 0
  const row = g ? Math.max(0, Math.floor((g.y + 1) / PAGE_HEIGHT)) : 0
  return writingView({ viewW: viewSize.width, viewH: viewSize.height, margins: viewMargins(window.innerWidth), scale: 1,
    page: { left: column * PAGE_WIDTH, top: row * PAGE_HEIGHT, width: PAGE_WIDTH }, text: g ? { top: g.y, height: g.height ?? 0 } : null })
}

// The caret goes into the writing as the note opens: at the end of its topmost text, or in a new text at the top of the first page.
// `sequence`: the note pick this belongs to (a later pick, or the person having clicked into something else meanwhile, wins).
async function startWriting(sequence) {
  const writing = writingTarget()
  if (!writing) return
  const focusedBefore = document.activeElement
  await Promise.race([leaferCanvas.whenEditorReady?.(), new Promise((resolve) => setTimeout(resolve, 1500))])
  if (sequence !== selectSequence || state.loading || leaferSwitching || state.tool !== 'text' || leaferCanvas.isEditingText()) return
  const focused = document.activeElement
  if (focused !== focusedBefore && focused && focused !== document.body && (['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName) || focused.isContentEditable)) return // clicked into a field meanwhile
  if (writing.text) leaferCanvas.editText(writing.text.id, { select: false })
  else leaferCanvas.createText({ x: 80, y: 80 }, { select: false })
}

// The view moves smoothly to `target` ({ x, y, scale }) over a moment (at once when motion is reduced).
function glideViewTo(target, ms = 320) {
  cancelAnimationFrame(viewGlide)
  const from = { x: viewportOffsetX, y: viewportOffsetY, scale: getCanvasScale() }
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return setViewTo(target)
  const began = performance.now()
  const step = (now) => {
    const t = Math.min(1, (now - began) / ms)
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    setViewTo({ x: from.x + (target.x - from.x) * eased, y: from.y + (target.y - from.y) * eased, scale: from.scale + (target.scale - from.scale) * eased })
    if (t < 1) viewGlide = requestAnimationFrame(step)
  }
  viewGlide = requestAnimationFrame(step)
}

const OPENS_PAGE = new Set(['shape', 'sticky', 'connect'])
// The canvas shows the view this window last set (nothing else moved it): only then does the view move on its own.
// (Code that sets the canvas view itself, as the real-app checks do to aim their strokes, is left alone.)
const viewIsOurs = () => { const view = leaferCanvas.view(); return Math.abs(view.x - viewportOffsetX) < 1 && Math.abs(view.y - viewportOffsetY) < 1 && Math.abs(view.scale - getCanvasScale()) < 1e-3 }

// Drawing opens the page up: the whole page the view is on (when the view is closer than that), once per tool pick, so drawing zoomed in
// afterwards stays where the person put the view.
let pageOpened = false
function openPageForDrawing() {
  if (pageOpened || window.innerWidth <= 800 || state.activeNoteType !== 'canvas' || !viewIsOurs()) return
  pageOpened = true
  const target = pageView({ viewW: viewSize.width, viewH: viewSize.height, margins: viewMargins(window.innerWidth), center: viewCenterPoint(),
    pageW: PAGE_WIDTH, pageH: PAGE_HEIGHT, columns: state.pages.columns, rows: state.pages.rows, min: state.displayScale * CANVAS_ZOOM_MIN, max: state.displayScale })
  if (getCanvasScale() > target.scale + 0.01) glideViewTo(target)
}

// Writing again (Esc from a drawing tool, or a text opened while the page is zoomed out) comes back to 100%, about `point` (view pixels).
function backToWriting(point = { x: viewSize.width / 2, y: viewSize.height / 2 }) {
  if (window.innerWidth <= 800 || state.activeNoteType !== 'canvas' || getCanvasScale() > 0.99 || !viewIsOurs()) return
  glideViewTo(zoomTarget(1 / state.displayScale, point))
}

// While writing at 100% the page map and zoom stay quiet (they come back on hover, when zoomed, or with a drawing tool).
function updateWritingQuiet() {
  const quiet = window.innerWidth > 800 && state.activeNoteType === 'canvas' && Math.abs(getCanvasScale() - 1) < 0.01 && !isDrawingTool(state.tool)
  elements.shell.classList.toggle('writing-quiet', quiet)
}

function openCanvasView() {
  panelGaveWay = 0
  if (window.innerWidth <= 800) return resetCanvasView()
  const writing = writingTarget()
  if (writing) {
    const view = writingViewFor(writing.text)
    state.canvasZoom = view.scale / state.displayScale
    panelGaveWay = giveWayToIsland(view.x, view.scale, viewSize.width, PAGE_ISLAND_CLEARANCE) // (the notes panel narrows the area: the page keeps clear of the tool island)
    setCanvasViewportOffset(view.x - panelGaveWay, view.y)
    gaveWayAt = { x: viewportOffsetX, scale: getCanvasScale() }
    return
  }
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
  const fitLabel = `Zoom to fit all pages (${pageLabel(state.pages.columns, state.pages.rows)})`
  elements.zoomFit.title = fitLabel
  elements.zoomFit.setAttribute('aria-label', fitLabel)
  updateScrollIndicators(false)
}

const temporaryHand = createTemporaryHand()
let applyingTemporaryHand = false

const toolCursor = () => (state.tool === 'hand' ? 'grab' : state.tool === 'text' ? 'text' : state.tool === 'eraser' ? 'none' : state.tool === 'connect' || state.tool === 'sticky' || state.tool === 'shape' ? 'crosshair' : 'default')
const PEN_TOOLS = new Set(['pen', 'highlight', 'eraser'])
let lastPenTool = null
const TOOLS = new Set(['select', 'hand', 'text', 'sticky', 'shape', 'pen', 'highlight', 'eraser', 'connect'])
let togglingTool = false // F-070: the double-tap's own tool change
let writingSpot = null // F-070 { noteId, id, start, end }: where the caret was when drawing took over; any other tool change forgets it
let focusActive = false // F-073: while focus mode is on, writing is the only tool
let focusRestore = null // F-073 { view, scroll, timer }: the window is changing size on the way out; the view is put back once it has settled
function setTool(tool) {
  if (!TOOLS.has(tool)) tool = 'select'
  if (focusActive) tool = 'text'
  if (!togglingTool && !applyingTemporaryHand) writingSpot = null // (the space-bar hand and its release are temporary: the way back stays)
  if (!applyingTemporaryHand) temporaryHand.cancel()
  if (tool !== state.tool) pageOpened = false
  state.tool = tool
  if (PEN_TOOLS.has(tool)) lastPenTool = tool
  if (OPENS_PAGE.has(tool)) openPageForDrawing() // F-059: whiteboard tools open the page up (the pen and highlighter do at their first drawing)
  document.querySelectorAll('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool))
  if (tool === 'text' || tool === 'sticky' || tool === 'shape') leaferCanvas?.clearSelection() // placing words: no handles on the canvas meanwhile
  if (tool === 'pen' || tool === 'highlight' || tool === 'eraser' || tool === 'connect') leaferCanvas?.clearSelection()
  leaferInk?.setTool(tool)
  leaferCanvas?.setDrawing(tool === 'pen' || tool === 'highlight' || tool === 'eraser')
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
  const flyoutTool = elements.dockFlyout.querySelector(`[data-tool="${tool}"]`) // the + wears the icon of a tool picked from its flyout
  elements.dockMore.classList.toggle('active', Boolean(flyoutTool))
  elements.dockMore.classList.toggle('has-tool', Boolean(flyoutTool))
  elements.dockMoreTool.innerHTML = flyoutTool?.innerHTML ?? ''
  updateInkOptions()
  if (tool !== 'eraser') elements.eraserCursor.hidden = true
  updateWritingQuiet()
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
  // A text merely open, as a note is when it opens ready for writing (F-059), is not typing: the pictures the person dropped go in and the
  // text closes. Typing counts while a key was pressed in the last moment, so a pause mid-sentence longer than that lets the pictures in.
  const busy = () => pointerHeld || Boolean(leaferInk?.active) || (Boolean(leaferCanvas?.isEditingText()) && performance.now() - lastKeyAt < 1500)
  while (busy()) {
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
let lastKeyAt = -Infinity // when a key was last pressed (typing in progress)
window.addEventListener('keydown', () => { lastKeyAt = performance.now() }, true)

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
  if (!state.activeNoteId || state.loading || speedTestPaused || state.noteLocked) return
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
  let sentBody = ''
  try {
    if (state.activeNoteType === 'canvas' && leaferSource.noteId !== noteId) throw Object.assign(new Error('the content on hand belongs to another note'), { refused: true })
    const title = elements.title.value.trim() || 'Untitled note'
    if (state.activeNoteType === 'mindmap') mindmapEditor?.setTitle(title)
    // A note that was not edited goes back as the server sent it (JSON Canvas), untouched; an edited one is written from the document model.
    const editedLeafer = state.activeNoteType === 'canvas' && leaferSource.editedDoc
    const savedShift = leaferSource.shift
    saveFrame = editedLeafer && savedShift ? savedShift : null
    const savedContent = state.activeNoteType === 'mindmap' ? mindmapEditor?.getDocument()
      : state.activeNoteType === 'page' ? pageEditor?.getDocument()
      : leaferSource.content
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
    sentBody = body
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
    // A page's base for merging an agent's change is what the server now holds, unless a merge moved it on meanwhile.
    if (state.activeNoteType === 'page' && noteId === state.activeNoteId && mergeCount === mergesBefore) pageEditor?.markSaved(savedContent?.markdown)
    renderNoteList()
    setSaveState('Saved')
  } catch (error) {
    console.error(error)
    if (error.status === 423) { // the server locked the secure notes (quiet time, sleep): show the cover, don't call it a failure
      unsavedEdits = false
      if (sentBody) heldEdit.hold(noteId, sentBody) // the words stay (in memory only) and go out after the next unlock
      setSaveState('Locked')
      void secure.serverLocked()
      return
    }
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
  if (state.loading || speedTestPaused || state.noteLocked) return
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
// Secure notes (F-058): the cover, the sheets and the pill live in modules/secure; this hands them what they need from the note lifecycle.
const secure = createSecureSession({
  api,
  workspace: elements.workspace,
  topbarActions: document.querySelector('.topbar-actions'),
  shell: elements.shell,
  titleInput: elements.title,
  renderIcons: () => createIcons({ icons }),
  // The Mac app's bridge (desktop.py DesktopApi); the browser and the Linux window have none.
  captureBridge: () => { const bridge = window.pywebview?.api; return typeof bridge?.set_capture_hidden === 'function' ? (hidden) => bridge.set_capture_hidden(hidden) : undefined },
  host: {
    flush: () => settleOutgoingNote(),
    reload: () => selectNote(state.activeNoteId, { reload: true }),
    note: (id) => state.notes.find((item) => item.id === id),
    patchNote: (id, patch) => { const note = state.notes.find((item) => item.id === id); if (note) Object.assign(note, patch) },
    renderList: () => renderNoteList(),
    syncMenu: () => syncSecureMenu(),
    toast: (message) => showToast(message),
  },
})
function syncSecureMenu() {
  const note = state.notes.find((item) => item.id === state.activeNoteId)
  const button = document.querySelector('#secure-note')
  if (!button) return
  button.disabled = !note
  button.querySelector('span').textContent = note?.secure ? 'Make ordinary' : 'Make secure'
  button.querySelector('svg, i')?.setAttribute('data-lucide', note?.secure ? 'lock-open' : 'lock')
  createIcons({ icons })
}
function toggleSecureActiveNote() {
  const note = state.notes.find((item) => item.id === state.activeNoteId)
  if (!note) return
  setPropertiesOpen(false)
  void (note.secure ? secure.makeOrdinary(note.id) : secure.makeSecure(note.id)).catch((error) => { console.error(error); showToast(error.message || 'Something went wrong') })
}
document.querySelector('#secure-note').addEventListener('click', toggleSecureActiveNote)
window.personalNote = {
  ...windowHooks,
  // The Mac slept or its screen locked (desktop.py): cover the secure note at once.
  lockSecure: () => secure.lockNow(),
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
// The same for a page note: CodeMirror announces each edit, and the snapshot catches one that was not announced.
function mindmapChanged() {
  if (state.activeNoteType !== 'mindmap' && state.activeNoteType !== 'page') return false
  const next = JSON.stringify({ content: state.activeNoteType === 'page' ? pageEditor?.getDocument() : mindmapEditor?.getDocument() })
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
  if (state.activeNoteType === 'page') { pageEditor?.history(direction); return }
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
      if (type === 'link') updateSelectionBar()
      if (type === 'start' || type === 'end') setPageZoomLocked(type === 'start')
      if (type === 'start' && document.querySelector('.md-editor')) { // F-059: writing opened while the page is zoomed out comes back to 100%, about the words (a sticky being placed stays as it is)
        const words = document.querySelector('.leafer-text-editor')?.getBoundingClientRect()
        const host = leaferHost.getBoundingClientRect()
        backToWriting(words ? { x: words.left - host.left, y: words.top - host.top } : undefined)
      }
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
  onDrawn: (object) => { if (object.tool === 'pen' || object.tool === 'highlight') openPageForDrawing() }, // F-059: drawing on the page opens it up (marks on words stay at 100%)
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
    const controls = [...document.querySelectorAll('.zoom-control, .history-island')]
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
  const linkButton = elements.selectionBar.querySelector('[data-selection-action="link"]')
  linkButton.textContent = leaferCanvas.isLinking() ? 'Click a word…' : leaferCanvas.selectionLinked() ? 'Unlink' : 'Link to words'
  updateFoldAll()
}
// F-051: the top bar's Fold all / Open all, shown when the note has linked objects.
function updateFoldAll() {
  const button = document.querySelector('#fold-all')
  const has = state.activeNoteType === 'canvas' && Boolean(leaferCanvas?.hasLinks())
  button.hidden = !has
  if (!has) return
  const folded = leaferCanvas.allFolded()
  button.title = folded ? 'Open everything folded into words' : 'Fold all linked objects into their words'
  button.setAttribute('aria-label', button.title)
  button.innerHTML = `<i data-lucide="${folded ? 'unfold-vertical' : 'fold-vertical'}"></i><span>${folded ? 'Open all' : 'Fold all'}</span>`
  createIcons({ icons, root: button })
}
document.querySelector('#fold-all').addEventListener('click', () => { leaferCanvas.foldAll(!leaferCanvas.allFolded()); setTimeout(updateFoldAll, 700) })
elements.selectionBar.addEventListener('pointerdown', (event) => event.stopPropagation())
elements.selectionBar.addEventListener('click', (event) => {
  const action = event.target.closest('[data-selection-action]')?.dataset.selectionAction
  if (action === 'forward' || action === 'backward') leaferCanvas.reorderSelection(action)
  else if (action === 'lock') toggleLeaferLock()
  else if (action === 'delete') leaferCanvas.deleteSelection()
  else if (action === 'link') {
    if (leaferCanvas.isLinking()) leaferCanvas.stopLinking()
    else if (leaferCanvas.selectionLinked()) leaferCanvas.unlinkSelection()
    else leaferCanvas.startLinking()
  }
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

async function selectNote(id, { reload = false } = {}) {
  if (id === state.activeNoteId && !reload) return
  if (focusActive) { focus.leave(); clearTimeout(focusRestore?.timer); focusRestore = null } // (the other note opens in its own view)
  leaferSwitching += 1
  await stopDictationForSwitch()
  leaferCanvas.clearSelection()
  leaferInk.cancel()
  leaferConnect.cancel()
  elements.shell.classList.add('leafer-switching')
  try { await selectNoteNow(id, { reload }) } finally {
    if (!--leaferSwitching) elements.shell.classList.remove('leafer-switching')
  }
}
async function selectNoteNow(id, { reload = false } = {}) {
  hideToast()
  const sequence = ++selectSequence
  // Stay on the current note rather than drop its edits when they cannot be saved in time.
  if (!(await settleOutgoingNote())) return
  if (sequence !== selectSequence || (id === state.activeNoteId && !reload)) return
  clearTimeout(saveTimer)
  unsavedEdits = false
  if (!reload) await secure.leave() // another note opens: secure notes lock, the window may be shared again (a reload keeps the keys)
  if (sequence !== selectSequence) return
  state.activeNoteId = id
  renderNoteList()
  state.loading = true
  mindmapEditor?.destroy()
  mindmapEditor = null
  pageMountTicket += 1
  pageEditor?.destroy()
  pageEditor = null
  try {
    let note = await api(`/notes/${id}`)
    // A newer pick superseded this one while it loaded: its content must not land under another note's id.
    if (sequence !== selectSequence) return
    // An unlocked secure note is drawn only with the window hidden from sharing (the Mac); if that cannot be done it stays locked.
    if (note.secure && !note.locked && !(await secure.guardOpen())) note = { ...note, content: null, pageState: null, locked: true }
    // Words typed just before the keys timed out were held: they go out now, on the new revision, and the note is read again with them.
    if (note.secure && !note.locked && heldEdit.has(id)) {
      try {
        await api(`/notes/${id}`, { method: 'PUT', body: heldEdit.take(id, note.revision) })
        heldEdit.done(id)
        note = await api(`/notes/${id}`)
      } catch (error) { console.error(error) }
    }
    if (sequence !== selectSequence) return
    const summary = state.notes.find((item) => item.id === id)
    if (summary) Object.assign(summary, {
      notebookId: note.notebookId,
      noteType: note.noteType,
      resourceId: note.resourceId,
      revision: note.revision,
      secure: Boolean(note.secure),
    })
    state.selectedNotebookId = note.notebookId
    revealNotebook(note.notebookId)
    elements.title.value = note.title
    state.noteLocked = Boolean(note.locked)
    elements.title.readOnly = state.noteLocked
    if (state.noteLocked) { // a locked secure note: an empty page and the cover, never its words
      setActiveNoteType('canvas')
      if (!(await showLeaferNote({ id: note.id, noteType: 'canvas', content: null, pageState: null })) || sequence !== selectSequence) return
      secure.showCover(note)
      setSaveState('Locked')
      syncSecureMenu()
      renderNoteList()
      return
    }
    setActiveNoteType(note.noteType)
    if (state.activeNoteType === 'mindmap') {
      await mountActiveMindMap(note.content || structuredClone(DEFAULT_MINDMAP_DOCUMENT))
      mindmapSnapshot = JSON.stringify({ content: mindmapEditor?.getDocument() }) // what the map was when it was loaded: leaving it unchanged sends nothing
    } else if (state.activeNoteType === 'page') {
      await mountActivePage(note.content)
      if (sequence !== selectSequence) return
      mindmapSnapshot = JSON.stringify({ content: pageEditor?.getDocument() })
      pageEditor?.focus() // a page opens ready for typing
    } else {
      if (!(await showLeaferNote(note)) || sequence !== selectSequence) return
      setTool('text') // a note opens ready for typing
    }
    setSaveState('Saved')
    if (note.secure) await secure.noteOpened(note)
    else secure.clear()
    syncSecureMenu()
    renderNoteList()
    requestAnimationFrame(() => { openCanvasView(); if (state.activeNoteType === 'canvas') startWriting(sequence) })
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
  pruneOpenNotebooks()
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
  if (note.id === state.activeNoteId && state.activeNoteType === 'page' && pageEditor) {
    // An agent changed the open page and nothing here is unsaved: show its version (ink placed by the server).
    elements.title.value = note.title
    pageEditor.setDocument(note.content)
    mindmapSnapshot = JSON.stringify({ content: pageEditor.getDocument() })
    const summary = state.notes.find((item) => item.id === note.id)
    if (summary) Object.assign(summary, { title: note.title, revision: note.revision, resourceId: note.resourceId, updatedAt: note.updatedAt })
    setSaveState('Saved')
    renderNoteList()
    return
  }
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
  if (note.id === state.activeNoteId && state.activeNoteType === 'page' && pageEditor) {
    // An agent changed the page while you were typing: its change is merged into your text, your edits stay, and the result is saved
    // on the agent's revision. A save still out is waited for first: until it answers, the base it moves the merge onto isn't known,
    // and what was fetched may be that very save coming back.
    if (saveInFlight) {
      const gaveUp = Symbol('gave up')
      let timer
      const outcome = await Promise.race([(async () => { while (saveInFlight) await saveSettled })(), new Promise((resolve) => { timer = setTimeout(() => resolve(gaveUp), MERGE_WAIT_MS) })])
      clearTimeout(timer)
      if (outcome === gaveUp) { setTimeout(() => agentSync?.syncActiveNote().catch(console.error), MERGE_RETRY_MS); return 0 }
      if (note.id !== state.activeNoteId || !pageEditor) return 0
      const known = state.notes.find((item) => item.id === note.id)
      if (known && note.revision <= known.revision) return 0
    }
    const changed = pageEditor.mergeRemote(note.content)
    const summary = state.notes.find((item) => item.id === note.id)
    if (summary) Object.assign(summary, { revision: note.revision, resourceId: note.resourceId, updatedAt: note.updatedAt })
    mergeCount += 1
    queueSave()
    return changed
  }
  if (note.id !== state.activeNoteId || state.activeNoteType !== 'canvas') return 0
  return mergeLeaferNote(note)
}

async function createNote(notebookId, noteType = 'canvas', title) {
  if (state.creatingNote) return
  state.creatingNote = true
  const destinationId = Number(notebookId) || null // no notebook named: the note lands in the Inbox
  try {
    const note = await api('/notes', {
      method: 'POST',
      body: JSON.stringify({
        title: title || (noteType === 'mindmap' ? 'Untitled mind map' : 'Untitled note'),
        notebookId: destinationId,
        noteType,
      }),
    })
    state.notes.unshift(note)
    state.selectedNotebookId = note.notebookId
    state.activeNoteId = null
    await selectNote(note.id)
    if (mobileLayout.matches) setSidebarOpen(false)
  } finally {
    state.creatingNote = false
  }
}

// A move shows at once and is put back, with the toast, if the server does not keep it. Resolves to whether it was kept.
async function moveNote(noteId, notebookId) { // notebookId null: back to the Inbox
  const note = state.notes.find((item) => item.id === noteId)
  if (!note || (note.notebookId ?? null) === notebookId) return true
  const before = { notebookId: note.notebookId, selected: state.selectedNotebookId }
  note.notebookId = notebookId
  if (noteId === state.activeNoteId) state.selectedNotebookId = notebookId
  renderNoteList()
  try {
    const result = await api(`/notes/${noteId}/notebook`, {
      method: 'PATCH',
      body: JSON.stringify({ notebookId, revision: note.revision }),
    })
    Object.assign(note, { revision: result.revision, resourceId: result.resourceId })
    return true
  } catch (error) {
    console.error(error)
    note.notebookId = before.notebookId
    state.selectedNotebookId = before.selected
    renderNoteList()
    showToast("Couldn't move it. Try again.")
    // A refusal is often a stale revision: take the server's, so the retry can go through.
    try { Object.assign(note, { revision: (await api(`/notes/${noteId}`)).revision }) } catch {}
    return false
  }
}

async function moveNotebook(notebookId, category) {
  const notebook = state.notebooks.find((item) => item.id === notebookId)
  if (!notebook || notebook.category === category) return true
  const before = { category: notebook.category }
  notebook.category = category
  setSectionOpen(category, true) // show it where it landed
  renderNoteList()
  try {
    const updated = await api(`/notebooks/${notebookId}`, { method: 'PUT', body: JSON.stringify({ category, revision: notebook.revision }) })
    Object.assign(notebook, updated)
    return true
  } catch (error) {
    console.error(error)
    notebook.category = before.category
    renderNoteList()
    showToast("Couldn't move it. Try again.")
    try { Object.assign(notebook, { revision: (await api('/notebooks')).find((item) => item.id === notebookId)?.revision ?? notebook.revision }) } catch {}
    return false
  }
}

// Opening a note in a folded section unfolds it, so the row you are on is never hidden.
function revealNotebook(notebookId) {
  const notebook = state.notebooks.find((item) => item.id === notebookId)
  if (notebook && !isSectionOpen(state.sectionOpen, notebook.category)) setSectionOpen(notebook.category, true)
  if (notebook && state.notebookOpen[notebook.id] !== true) setNotebookOpen(notebook.id, true) // and its notebook, even when it was already the selected one
}

// Notebooks that no longer exist drop out of the remembered open record.
function pruneOpenNotebooks() {
  const known = new Set(state.notebooks.map((notebook) => String(notebook.id)))
  const stale = Object.keys(state.notebookOpen).filter((id) => !known.has(id))
  if (!stale.length) return
  stale.forEach((id) => delete state.notebookOpen[id])
  writeFolded(safeStorage(), state.notebookOpen, NOTEBOOK_FOLD_KEY)
}

function setSectionOpen(id, open) {
  state.sectionOpen[id] = open
  writeFolded(safeStorage(), state.sectionOpen)
}

// The section's + names a notebook right in the list (Enter keeps it); the dialog stays for colour and editing.
async function createNotebookInline(category, name) {
  try {
    const notebook = await api('/notebooks', { method: 'POST', body: JSON.stringify({ name, category }) })
    state.notebooks.unshift(notebook)
    state.selectedNotebookId = notebook.id
    renderNoteList()
    return true
  } catch (error) {
    console.error(error)
    showToast("Couldn't make the notebook. Try again.")
    return false
  }
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
    ? 'Deleting it moves its notes to the Inbox.'
    : 'Give related notes a quiet place of their own.'
  const color = notebook?.color || '#B86B4B'
  const colorInput = document.querySelector(`[name="notebook-color"][value="${color}"]`)
  if (colorInput) colorInput.checked = true
  elements.notebookDialog.showModal()
  requestAnimationFrame(() => elements.notebookName.focus())
}

// The icon and colour picker of the notes panel (F-089): each choice is saved at once, one after another so each carries the revision the last one returned.
let notebookLookSaves = Promise.resolve()
function openNotebookIconPicker(id) {
  const notebook = state.notebooks.find((item) => item.id === id)
  if (!notebook) return
  const anchor = () => elements.list.querySelector(`[data-icon-notebook="${id}"]`)
  const save = async (patch) => {
    try {
      Object.assign(notebook, await api(`/notebooks/${id}`, { method: 'PUT', body: JSON.stringify({ ...patch, revision: notebook.revision }) }))
      renderNoteList()
      if (document.activeElement === document.body) anchor()?.focus() // the picker had closed, and the list was drawn again under its focus
    } catch {
      showToast("Couldn't change the notebook. Try again.")
      try { notebook.revision = (await api('/notebooks')).find((item) => item.id === id)?.revision ?? notebook.revision } catch {}
    }
  }
  openIconPicker({ notebook, getAnchor: anchor, onChange: (patch) => { notebookLookSaves = notebookLookSaves.then(() => save(patch)) } })
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
  pruneOpenNotebooks()
  state.selectedNotebookId = result.destinationNotebookId
  elements.notebookDialog.close()
  renderNoteList()
}

let settingsFromMenu = false // opened from the ... menu: closing it puts the focus back on the ... button
function setPropertiesOpen(open) {
  elements.properties.classList.toggle('open', open)
  elements.properties.setAttribute('aria-hidden', String(!open))
  elements.properties.inert = !open
  if (!open && settingsFromMenu) {
    settingsFromMenu = false
    if (!document.activeElement || document.activeElement === document.body) elements.shareButton.focus()
  }
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

// One Settings row for an optional download: its headline, bar, sentence and buttons are `#<name>-setup-*` and `#<name>-download|cancel|remove`.
function renderSetupRow(name, view) {
  document.querySelector(`#${name}-setup-headline`).textContent = view.headline
  document.querySelector(`#${name}-setup-detail`).textContent = view.detail
  const progress = document.querySelector(`#${name}-setup-progress`)
  progress.hidden = view.percent === null
  if (view.percent !== null) progress.value = view.percent
  for (const [action, label] of [['download', view.download], ['cancel', view.cancel], ['remove', view.remove]]) {
    const button = document.querySelector(`#${name}-${action}`)
    if (!button) continue
    button.hidden = !label
    button.querySelector('span').textContent = label || ''
  }
}

const renderVoiceSetup = (status) => renderSetupRow('voice', describeVoice(status))

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

const meaningClient = createMeaningClient(api)
let meaningPoll = null

const renderMeaningSetup = (status) => renderSetupRow('meaning', describeMeaning(status))

async function refreshMeaningSetup() {
  clearTimeout(meaningPoll)
  let status
  try {
    status = await meaningClient.status()
  } catch {
    renderMeaningSetup({ state: 'error', error: 'The local server did not answer.' })
    return
  }
  renderMeaningSetup(status)
  if (status.state === 'downloading') meaningPoll = setTimeout(refreshMeaningSetup, 1000)
  else if (indexIsCatchingUp(status)) meaningPoll = setTimeout(refreshMeaningSetup, 3000)
}

async function meaningSetupAction(action) {
  try {
    renderMeaningSetup(await action(meaningClient))
  } catch (error) {
    renderMeaningSetup({ state: 'error', error: error.message })
    return
  }
  void refreshMeaningSetup()
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
    pruneOpenNotebooks()
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

// ---- The omnibar (F-072): a slim bar at the top centre that grows into grouped results ----
const IME_KEY = 229 // a key pressed while an input method is composing reports keyCode 229
const omni = { open: false, pending: false, filter: 'All', sel: 0, groups: [], items: [], wordHits: [], meaningHits: [], meaningReady: false, meaningPending: false, wordsFailed: false }

function omniActions() {
  const note = state.notes.find((item) => item.id === state.activeNoteId)
  const actions = [
    { id: 'new-note', title: 'New note', icon: 'plus', top: true, keywords: 'create add', run: () => createNote(state.selectedNotebookId ?? undefined) },
    { id: 'quick-note', title: 'Quick note', icon: 'zap', top: true, keycap: quickNoteKeycap(navigator.platform), keywords: 'inbox capture', run: () => createNote() },
  ]
  actions.push({ id: 'focus', title: 'Focus mode', icon: 'focus', top: true, keycap: `${modifierLabel(navigator.platform)}.`, keywords: 'write quiet distraction full screen words only', run: () => { closeSearch(); toggleFocus() } })
  if (note) actions.push({ id: 'make-secure', title: note.secure ? 'Make this note ordinary' : 'Make this note secure', icon: note.secure ? 'lock-open' : 'lock', top: true, keywords: 'lock private password', run: () => toggleSecureActiveNote() })
  const current = startSkins().current
  for (const skin of SKINS) {
    actions.push({ id: `skin-${skin.id}`, title: `Skin: ${skin.name}`, icon: 'palette', hint: skin.id === current ? 'Current' : '', keywords: 'switch skin theme appearance look', run: () => { startSkins().select(skin.id); skinSwitcher.sync() } })
  }
  return actions
}

function omniRowHtml(item, index, tokens) {
  const sel = index === omni.sel
  const base = `id="omni-row-${index}" role="option" aria-selected="${sel}" data-omni="${index}" tabindex="-1"`
  const ret = '<i class="omni-ret" data-lucide="corner-down-left"></i>'
  if (item.kind === 'note' || item.kind === 'words' || item.kind === 'meaning') {
    const view = searchResultView(item)
    const sub = item.secure ? `Secure note · ${modifierLabel(navigator.platform) === '⌘' ? 'opens with Touch ID' : 'unlock to open'}` : item.kind === 'words' ? highlight(item.excerpt, tokens) : escapeHtml(item.notebookName)
    return `<button class="omni-row search-result ${view.className}${item.kind === 'meaning' ? ' is-meaning' : ''}${sel ? ' sel' : ''}" ${base} data-search-note-id="${item.id}">
      <span class="omni-ic"><i data-lucide="${view.icon}"></i></span>
      <span class="omni-copy"><span class="omni-title">${highlight(item.title, tokens)}</span><span class="omni-sub">${sub}</span></span>
      ${item.kind === 'words' || item.secure ? `<span class="omni-meta">${escapeHtml(item.notebookName)}</span>` : ''}${ret}</button>`
  }
  if (item.kind === 'notebook') {
    return `<button class="omni-row${sel ? ' sel' : ''}" ${base}><span class="omni-ic"><span class="omni-dot" style="--c:${escapeHtml(item.color || 'var(--sk-accent)')}"></span></span>
      <span class="omni-copy"><span class="omni-title">${highlight(item.name, tokens)}</span><span class="omni-sub">Notebook · ${item.noteCount} ${item.noteCount === 1 ? 'note' : 'notes'}</span></span>${ret}</button>`
  }
  return `<button class="omni-row${sel ? ' sel' : ''}" ${base}><span class="omni-ic"><i data-lucide="${item.icon}"></i></span>
    <span class="omni-copy"><span class="omni-title">${highlight(item.title, tokens)}</span></span>${item.hint ? `<span class="omni-meta">${item.hint}</span>` : ''}${item.keycap ? `<kbd>${item.keycap}</kbd>` : ''}${ret}</button>`
}

const omniKey = (item) => (item ? `${item.kind === 'words' ? 'note' : item.kind}:${item.id ?? item.title}` : '')
function omniCreateRowHtml(index, query, sel) {
  return `<button class="omni-row${sel ? ' sel' : ''}" id="omni-row-${index}" role="option" aria-selected="${sel}" data-omni="${index}" tabindex="-1"><span class="omni-ic"><i data-lucide="plus"></i></span><span class="omni-copy"><span class="omni-title">New note “${escapeHtml(query)}”</span></span><i class="omni-ret" data-lucide="corner-down-left"></i></button>`
}

function renderOmni() {
  const keep = omniKey(omni.items[omni.sel]) // the selection stays on the same item when more results land
  const query = elements.searchInput.value.trim()
  const tokens = queryTokens(query)
  const notes = state.notes.filter((note) => note.id !== pendingDelete?.note.id)
  const wordHits = omni.wordHits.filter((hit) => hit.id !== pendingDelete?.note.id)
  const searchesNotes = omni.filter === 'All' || omni.filter === 'Notes'
  omni.groups = buildGroups({ query, filter: omni.filter, notes, notebooks: state.notebooks, actions: omniActions(), wordHits, meaningHits: omni.meaningHits, wordsPending: omni.pending })
  omni.items = flatten(omni.groups)
  const kept = omni.items.findIndex((item) => omniKey(item) === keep)
  if (kept >= 0) omni.sel = kept
  const onlyCreate = omni.items.length === 1 && omni.items[0].kind === 'create'
  const waiting = (omni.pending || omni.meaningPending) && searchesNotes // a search is still out: no "nothing" yet
  document.querySelector('#omni-chips').innerHTML = FILTERS.map((name) => `<button type="button" class="omni-chip" data-omni-chip="${name}" aria-pressed="${name === omni.filter}">${name}</button>`).join('')
  let html = ''
  if (!omni.items.length) {
    if (!waiting) html = `<div class="omni-none"><strong>${query ? `Nothing matches “${escapeHtml(query)}”` : 'Nothing here yet'}</strong><span>Secure notes match by title only.</span></div>`
  } else {
    let index = 0
    omni.sel = onlyCreate ? 0 : Math.min(omni.sel, omni.items.length - 1)
    // Only a New note row: say nothing matched, once no search is still out (the row itself is there at once, so Enter never waits).
    if (onlyCreate && !waiting) html = `<div class="omni-none"><strong>Nothing matches “${escapeHtml(query)}”</strong><span>Secure notes match by title only.</span></div>`
    html += omni.groups.map((group) => group.key === 'create'
      ? `<div class="omni-group">${omniCreateRowHtml(index++, group.items[0].title, omni.sel === index - 1)}</div>`
      : `<div class="omni-group" role="group" aria-label="${group.label}"><h4>${group.label}</h4>${group.items.map((item) => omniRowHtml(item, index++, tokens)).join('')}</div>`).join('')
  }
  if (omni.wordsFailed && query) html += '<p class="omni-note">Couldn’t search inside notes.</p>'
  elements.searchResults.innerHTML = html
  createIcons({ icons })
  if (omni.items.length) elements.searchInput.setAttribute('aria-activedescendant', `omni-row-${omni.sel}`)
  else elements.searchInput.removeAttribute('aria-activedescendant')
}

function setOmniSelection(index, { scroll = true } = {}) {
  if (!omni.items.length) return
  omni.sel = index
  elements.searchResults.querySelectorAll('.omni-row').forEach((row, i) => { row.classList.toggle('sel', i === index); row.setAttribute('aria-selected', String(i === index)) })
  elements.searchInput.setAttribute('aria-activedescendant', `omni-row-${index}`)
  if (scroll) document.querySelector(`#omni-row-${index}`)?.scrollIntoView({ block: 'nearest' })
}

function openSearch() {
  const bar = elements.searchButton.getBoundingClientRect()
  const panel = elements.searchBackdrop.firstElementChild
  // The panel opens large, centred on the window, from the bar's top edge (a phone fills the screen instead, see chrome.css).
  panel.style.setProperty('--omni-top', `${Math.max(0, Math.round(bar.top) - 2)}px`)
  Object.assign(omni, { open: true, filter: 'All', sel: 0, wordHits: [], meaningHits: [], meaningPending: false, wordsFailed: false })
  api('/search-meaning/status').then((status) => { omni.meaningReady = status.state === 'ready' }, () => { omni.meaningReady = false })
  elements.searchInput.value = ''
  elements.searchBackdrop.hidden = false
  elements.searchButton.setAttribute('aria-expanded', 'true')
  renderOmni()
  elements.searchInput.focus()
  requestAnimationFrame(() => elements.searchBackdrop.classList.add('open'))
}

function closeSearch() {
  omni.open = false
  omni.pending = false
  searchSequence += 1
  clearTimeout(searchTimer)
  cancelMeaningSearch()
  elements.searchBackdrop.classList.remove('open')
  elements.searchButton.setAttribute('aria-expanded', 'false')
  setTimeout(() => { if (!elements.searchBackdrop.classList.contains('open')) elements.searchBackdrop.hidden = true }, 160)
}

let searchTimer
let searchSequence = 0
let meaningTimer
const meaningRequest = latestRequest()
const MEANING_DEBOUNCE_MS = 250
const MEANING_MIN_CHARS = 3
// Typing shows the title, notebook and action matches at once; the word matches (the full-text search) fill in when they arrive.
function queueSearch() {
  clearTimeout(searchTimer)
  const query = elements.searchInput.value.trim()
  const sequence = ++searchSequence
  omni.sel = 0
  omni.wordsFailed = false
  omni.wordHits = [] // word matches belong to the query they were found for
  omni.meaningHits = [] // and so do the meaning matches
  queueMeaningSearch(query)
  omni.pending = Boolean(query)
  omni.items = []
  if (!query) return renderOmni()
  renderOmni()
  searchTimer = setTimeout(async () => {
    try {
      const results = await api(`/search?q=${encodeURIComponent(query)}`)
      if (sequence !== searchSequence) return
      omni.wordHits = results
    } catch (error) {
      if (sequence !== searchSequence) return
      console.error(error)
      omni.wordHits = []
      omni.wordsFailed = true
    }
    omni.pending = false
    renderOmni()
  }, 120)
}

// "By meaning" (F-080) fills in below everything else, never blocking it: a quiet request after a pause in typing, aborted when the query
// changes, its answer dropped if it is not the newest. Without the download the server answers [] at once and nothing shows. When it is
// installed, a query with no other match shows nothing (not "Nothing matches") while the answer is on its way, for 6 s at most.
const MEANING_WAIT_MS = 6000
let meaningGiveUp
function cancelMeaningSearch() {
  clearTimeout(meaningTimer)
  clearTimeout(meaningGiveUp)
  meaningRequest.cancel()
  omni.meaningPending = false
}

function queueMeaningSearch(query) {
  cancelMeaningSearch()
  if (query.length < MEANING_MIN_CHARS) return
  omni.meaningPending = omni.meaningReady
  meaningGiveUp = setTimeout(() => {
    meaningRequest.cancel() // after the wait an answer would only move the list under the cursor: drop it
    if (omni.meaningPending) { omni.meaningPending = false; renderOmni() }
  }, MEANING_WAIT_MS)
  meaningTimer = setTimeout(async () => {
    const request = meaningRequest.start()
    try {
      const hits = await api(`/search/meaning?q=${encodeURIComponent(query)}&limit=10`, { signal: request.signal })
      if (!request.current() || !omni.open) return
      omni.meaningHits = hits
    } catch {
      if (!request.current()) return // aborted by a newer query; no answer: the omnibar stays as it is
    }
    omni.meaningPending = false
    renderOmni()
  }, MEANING_DEBOUNCE_MS)
}

function runOmniItem(item) {
  if (!item) return
  closeSearch()
  if (item.kind === 'note' || item.kind === 'words' || item.kind === 'meaning') void selectNote(item.id)
  else if (item.kind === 'notebook') {
    revealNotebook(item.id)
    state.selectedNotebookId = item.id
    renderNoteList()
    setSidebarOpen(true)
    requestAnimationFrame(() => elements.list.querySelector(`[data-nbk="${item.id}"]`)?.scrollIntoView({ block: 'nearest' }))
  } else if (item.kind === 'create') void createNote(state.selectedNotebookId ?? undefined, 'canvas', item.title)
  else if (item.kind === 'action') Promise.resolve(item.run()).catch((error) => { console.error(error); showToast(error.message || 'Something went wrong') })
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
  if (pending.page) { pageEditor?.history(-1); return }
  if (pending.mindmap) {
    await mountActiveMindMap(pending.mindmap)
    queueSave()
  } else if (pending.canvas) stepHistory(-1) // the clear is the last step: no other edit has been made since (an edit ends the Undo)
}

async function clearActiveNote() {
  if (!state.activeNoteId) return
  await commitPendingDelete()
  if (state.activeNoteType === 'page') {
    if (!pageEditor?.clear()) return
    pendingClearUndo = { noteId: state.activeNoteId, page: true }
    showToast('Note cleared', 'Undo', undoClear)
    return
  }
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
// sticky), Leafer's own (the select tool), the words being typed and the ink surface.
function onCanvasInput(type, handler, options) {
  inputSurface.addEventListener(type, handler, options)
  leaferHost.addEventListener(type, handler, options)
  elements.paper.querySelector('.leafer-editor-layer')?.addEventListener(type, handler, options)
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
  if (state.activeNoteType !== 'canvas' || event.target.closest?.('.tool-dock, .history-island, .zoom-control, .properties-panel, .sidebar')) return
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
const MIDDLE_PASTE_GUARD = 400 + 300 // the longest click (400 ms) plus the time the browser needs to start its paste
let middleSettlesAt = 0 // a paste the browser starts from the middle press (Linux primary selection) is dropped until this time
const middleClick = createMiddleClick() // F-071: a middle click that does not travel toggles writing and pen like double-tap Cmd
onCanvasInput('pointerdown', (event) => {
  if (event.button !== 1 || event.pointerType === 'touch' || state.activeNoteType !== 'canvas') return
  middleSettlesAt = performance.now() + MIDDLE_PASTE_GUARD
  middleClick.down({ x: event.clientX, y: event.clientY, time: event.timeStamp })
  middlePan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX: viewportOffsetX, offsetY: viewportOffsetY }
  event.currentTarget.setPointerCapture(event.pointerId)
  event.currentTarget.style.cursor = 'grabbing'
  event.preventDefault()
  event.stopImmediatePropagation()
}, { capture: true })
onCanvasInput('pointermove', (event) => {
  if (middlePan?.pointerId !== event.pointerId) return
  middleClick.move({ x: event.clientX, y: event.clientY })
  setCanvasViewportOffset(middlePan.offsetX + event.clientX - middlePan.x, middlePan.offsetY + event.clientY - middlePan.y)
  event.preventDefault()
  event.stopImmediatePropagation()
}, { capture: true })
function endMiddlePan(event) {
  if (middlePan?.pointerId !== event.pointerId) return
  middlePan = null
  middleSettlesAt = performance.now() + 300 // bounded: the guard never outlives the release by more than this
  event.currentTarget.style.cursor = event.currentTarget === inputSurface ? toolCursor() : ''
  event.stopImmediatePropagation()
  const clicked = event.type === 'pointerup' && middleClick.up({ time: event.timeStamp })
  if (event.type === 'pointercancel') middleClick.cancel()
  if (clicked) toggleWritingAndPen()
}
onCanvasInput('pointerup', endMiddlePan, { capture: true })
onCanvasInput('pointercancel', endMiddlePan, { capture: true })
onCanvasInput('mousedown', (event) => { if (event.button === 1) event.preventDefault() })
const inPaper = (target) => target instanceof Node && elements.paper.contains(target)
onCanvasInput('lostpointercapture', (event) => { if (middlePan?.pointerId === event.pointerId) { middlePan = null; middleClick.cancel(); middleSettlesAt = 0 } }) // capture lost with no release: nothing stays guarded
window.addEventListener('blur', () => { middleSettlesAt = 0 })
for (const type of ['paste', 'beforeinput']) window.addEventListener(type, (event) => {
  if (performance.now() >= middleSettlesAt || !inPaper(event.target) || (type === 'beforeinput' && event.inputType !== 'insertFromPaste')) return
  event.preventDefault()
  event.stopImmediatePropagation()
}, true)
// No Linux primary-selection paste into the words and no browser autoscroll from a middle press (those run on the mouse events).
for (const type of ['mousedown', 'mouseup', 'auxclick']) window.addEventListener(type, (event) => { if (event.button === 1 && state.activeNoteType === 'canvas' && inPaper(event.target)) event.preventDefault() }, true)

// A press with the mouse places a sticky or starts a text where the page is pressed. A finger or a pen places on the click that ends the
// tap (below): a phone only raises its keyboard for focus given at the end of a gesture, and the compatibility mouse events a tap sends
// are not relied on.
inputSurface.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.pointerType !== 'mouse') return
  if (state.tool === 'sticky') placeSticky(leaferCanvas.pageAt(event.clientX, event.clientY))
  else if (state.tool === 'shape') placeShape(leaferCanvas.pageAt(event.clientX, event.clientY))
  else if (state.tool === 'text') {
    const at = leaferCanvas.pageAt(event.clientX, event.clientY)
    if (leaferCanvas.toggleFoldAt(at)) return // F-051: a teal word folds or opens what is linked to it, with any tool that writes or picks
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
  else if (state.tool === 'text' && !leaferCanvas.toggleFoldAt(at) && !leaferCanvas.editText(at, { select: false })) leaferCanvas.createText(at, { select: false })
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
elements.dockMore.addEventListener('click', () => {
  closeInkOptions()
  setFlyoutOpen(elements.dockFlyout.hidden)
})
elements.dockFlyout.addEventListener('click', (event) => { if (event.target.closest('button')) setFlyoutOpen(false) })
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

// The notes panel floats over the desk at every width. `remember` is for the person's own choice (button, Esc, a click on the desk); it is kept for wide windows only.
function setSidebarOpen(open, remember = false) {
  const isOpen = open
  if (remember && !mobileLayout.matches) savePanelOpen(safeStorage(), isOpen)
  const wasOpen = elements.sidebar.classList.contains('open')
  // Move focus before the drawer becomes inert so it never gets stranded inside it.
  if (!isOpen && wasOpen && elements.sidebar.contains(document.activeElement)) elements.sidebarToggle.focus()
  elements.shell.classList.toggle('sidebar-open', isOpen)
  elements.sidebar.classList.toggle('open', isOpen)
  elements.sidebar.inert = !isOpen
  elements.sidebarToggle.setAttribute('aria-expanded', String(isOpen))
  elements.sidebarToggle.setAttribute('aria-label', isOpen ? 'Close notebooks' : 'Open notebooks')
  if (isOpen && !wasOpen) requestAnimationFrame(() => document.querySelector('#rail-new-note').focus())
}

const restoredSidebar = () => !mobileLayout.matches && loadPanelOpen(safeStorage())
elements.sidebarToggle.addEventListener('click', () => setSidebarOpen(!elements.sidebar.classList.contains('open'), true))
document.querySelector('#close-sidebar').addEventListener('click', () => setSidebarOpen(false, true))
elements.sidebarScrim.addEventListener('click', () => setSidebarOpen(false, true))
mobileLayout.addEventListener('change', () => setSidebarOpen(restoredSidebar()))
setSidebarOpen(restoredSidebar())

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
  if (open) requestAnimationFrame(() => elements.shareMenu.querySelector('button:not(:disabled):not([hidden])')?.focus())
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
  if (event.key === 'Tab') return setShareMenuOpen(false) // tabbing out of the menu closes it
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  const items = [...elements.shareMenu.querySelectorAll('button:not(:disabled):not([hidden])')]
  const index = items.indexOf(document.activeElement)
  items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
})
document.querySelector('#top-properties').addEventListener('click', () => {
  const open = !elements.properties.classList.contains('open')
  setPropertiesOpen(open)
  settingsFromMenu = open
})
document.querySelector('#close-properties').addEventListener('click', () => setPropertiesOpen(false))
document.querySelector('#top-properties').addEventListener('click', () => {
  if (elements.properties.classList.contains('open')) { void refreshVoiceSetup(); void refreshMeaningSetup() }
})
document.querySelector('#meaning-download').addEventListener('click', () => void meaningSetupAction((client) => client.install()))
document.querySelector('#meaning-cancel').addEventListener('click', () => void meaningSetupAction((client) => client.cancel()))
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

// Takes the switches into the open canvas and draws the open note again with them (the sticky shadows are made at load).
// `document` (the speed test's comparison): the document every mode starts from; it replaces what the canvas and the history hold. Changes are applied one
// after another, and the note is drawn again only when the canvas shows a loaded canvas note (otherwise the next load picks the switches up).
let renderModeQueue = Promise.resolve()
function applyRenderMode(name, document = null) {
  renderModeQueue = renderModeQueue.catch(() => {}).then(async () => {
    setPerfSwitches(name)
    if (!leaferCanvas) return
    leaferCanvas.finishTextEdit()
    leaferCanvas.applyPerf()
    if (!state.loading && state.activeNoteId && state.activeNoteType === 'canvas' && leaferSource.noteId === state.activeNoteId && leaferEdits?.doc) {
      if (document) {
        leaferEdits.open(state.activeNoteId, JSON.parse(JSON.stringify(document)))
        leaferBase = leaferEdits.doc
      }
      leaferCanvas.load(leaferEdits.doc)
      leaferCanvas.adopt(leaferEdits.doc)
      await leaferCanvas.whenSettled()
    }
  })
  return renderModeQueue
}
elements.settingsRenderMode.value = state.renderMode
elements.settingsRenderMode.addEventListener('change', () => {
  state.renderMode = elements.settingsRenderMode.value
  savePreferences()
  void applyRenderMode(state.renderMode)
})

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
        setRenderMode: (name, document) => applyRenderMode(name === 'saved' ? state.renderMode : name, document),
        setView: async ({ zoom, wait = true }) => {
          if (zoom === 'fit') fitAllPages()
          else { state.canvasZoom = zoom; setCanvasViewportOffset(viewSize.width / 2 - 430 * getCanvasScale(), 104) }
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          if (wait) await leaferCanvas.whenBitmapsReady() // (hybrid: the page bitmaps of the new view are made in idle time, as for a person who pauses before the next pan)
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
  const target = item.dataset.moveToNotebook
  await moveNote(state.activeNoteId, target === 'inbox' ? null : Number(target))
})
document.addEventListener('click', (event) => {
  if (!elements.shareMenu.hidden && !event.target.closest('.share-wrap')) setShareMenuOpen(false)
  if (!event.target.closest('.notebook-picker-wrap')) {
    elements.notebookPickerMenu.hidden = true
    elements.notebookPicker.setAttribute('aria-expanded', 'false')
  }
  if (!event.target.closest('.ink-options-popover, #ink-options-trigger, [data-tool-options]')) closeInkOptions()
  if (!event.target.closest('.dock-flyout, #dock-more')) setFlyoutOpen(false)
})
// F-083: the notes panel sits beside the note, so Esc first leaves the tool being used on the note (as it always did) when the last press was on
// the note, and closes the panel when the last press was in the panel or on its button.
let lastPressInNote = false
// What Esc would do on the note after a press on it: a canvas leaves its tool or clears its selection; a page or mind-map note has its own
// Esc handling while focus is inside it (typing, a drawing mode, a node being edited).
function noteWantsEsc() {
  if (!lastPressInNote || mobileLayout.matches) return false
  if (state.activeNoteType === 'canvas') return state.tool !== 'select' || (leaferCanvas?.selection() ?? []).length > 0
  return Boolean(document.activeElement?.closest?.('.page-host, .mindmap-host'))
}
document.addEventListener('pointerdown', (event) => { lastPressInNote = Boolean(event.target.closest('.main-view')) && !event.target.closest('#toggle-sidebar') }, true) // (capture: editors may stop the event)
document.addEventListener('pointerdown', (event) => {
  const target = event.target
  if (
    mobileLayout.matches // (wide: the panel sits beside the note, so using the note must not close it)
    && elements.sidebar.classList.contains('open')
    && target.closest('.main-view')
    && !target.closest('#toggle-sidebar')
  ) setSidebarOpen(false, true)

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
    if (mobileLayout.matches) setSidebarOpen(false)
    return
  }
  const newNote = event.target.closest('[data-new-note-in]')
  if (newNote) return void createNote(Number(newNote.dataset.newNoteIn))
  const add = event.target.closest('[data-new-notebook]')
  if (add) return openNotebookDialog(null, add.dataset.newNotebook) // (with the + naming in place, this is Shift+click)
  const iconButton = event.target.closest('[data-icon-notebook]')
  if (iconButton) return void openNotebookIconPicker(Number(iconButton.dataset.iconNotebook))
  const edit = event.target.closest('[data-edit-notebook]')
  if (edit) return openNotebookDialog(state.notebooks.find((notebook) => notebook.id === Number(edit.dataset.editNotebook)))
  const notebook = event.target.closest('[data-notebook-select]')
  if (notebook) {
    toggleNotebook(Number(notebook.dataset.notebookSelect))
  }
})
shelves = mountShelves(elements.list, {
  isOpen: (id) => isSectionOpen(state.sectionOpen, id),
  setOpen: setSectionOpen,
  moveNote,
  moveNotebook,
  noteNotebookId: (id) => state.notes.find((note) => note.id === id)?.notebookId ?? null,
  notebookCategory: (id) => state.notebooks.find((notebook) => notebook.id === id)?.category,
  createNotebook: createNotebookInline,
  openDialog: (category, name) => { openNotebookDialog(null, category); elements.notebookName.value = name },
})

// Cancel and the X are plain buttons, so the empty Name never blocks them and Enter reaches Create.
elements.notebookForm.querySelectorAll('.notebook-dialog-close').forEach((button) => button.addEventListener('click', () => elements.notebookDialog.close()))
elements.notebookForm.addEventListener('submit', (event) => {
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
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    setOmniSelection(moveSelection(omni.sel, event.key === 'ArrowDown' ? 1 : -1, omni.items.length))
  } else if (event.key === 'Enter' && !event.isComposing && event.keyCode !== IME_KEY) {
    event.preventDefault()
    if (!(omni.pending && omni.items[omni.sel]?.kind === 'create')) runOmniItem(omni.items[omni.sel])
  }
})
// The mouse moves the selection (so Enter acts on what is under it) and a click picks. Mouse down keeps the typing focus.
elements.searchBackdrop.addEventListener('mousedown', (event) => { if (event.target.closest('.omni-row, .omni-chip')) event.preventDefault() })
elements.searchResults.addEventListener('mousemove', (event) => {
  const row = event.target.closest('[data-omni]')
  if (row && Number(row.dataset.omni) !== omni.sel) setOmniSelection(Number(row.dataset.omni), { scroll: false })
})
elements.searchResults.addEventListener('click', (event) => {
  const row = event.target.closest('[data-omni]')
  if (row) runOmniItem(omni.items[Number(row.dataset.omni)])
})
document.querySelector('#omni-chips').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-omni-chip]')
  if (!chip) return
  omni.filter = chip.dataset.omniChip
  omni.sel = 0
  renderOmni()
  elements.searchInput.focus()
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
  const button = event.target.closest?.('.tool-dock button, .zoom-control button, .history-island button')
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

// F-070: double-tap the command key (Control on Linux and Windows) toggles writing and the last pen tool, even with the caret in the words.
// Nothing here stops the keys: a shortcut that uses the modifier still runs as it did, and cancels the tap.
// ---- Focus mode (F-073): only the words, in a centred column on paper. Nothing in the note changes; leaving puts everything back.
// Canvas notes: the text being written, else the one text selected, else the topmost text (a new, empty one for an empty note). The other
// objects and the page furniture are only not drawn while focus is on, so saved content is never moved or reflowed. Page notes are all
// words already: the toolbar and sheet marks go, the paper becomes the column, and drawing is switched off.
const focusStrip = document.querySelector('#focus-strip')
let focusTextId = null
let focusStartedEditing = false
let focusEnteredFullscreen = false
let focusCountTimer = 0
let focusScroll = 0 // how far the words have been scrolled to keep the caret in sight (canvas pixels of view)
let focusKeepFrame = 0
const isPageNote = () => state.activeNoteType === 'page'

function focusCandidate(saved) {
  const objects = (leaferEdits.doc?.objects ?? []).filter(Boolean)
  const texts = objects.filter((object) => object.type === 'text' && object.geometry)
  const byId = (id) => texts.find((object) => object.id === id)
  const topmost = [...texts].sort((a, b) => Number(b.format === 'markdown') - Number(a.format === 'markdown') || a.geometry.y - b.geometry.y || a.geometry.x - b.geometry.x)[0]
  return byId(saved.caret?.id) ?? (saved.selection.length === 1 ? byId(saved.selection[0]) : null) ?? topmost ?? null
}
function focusBox() {
  const text = (leaferEdits.doc?.objects ?? []).find((object) => object?.id === focusTextId)
  if (text?.geometry) return { x: text.geometry.x, y: text.geometry.y, width: text.geometry.width ?? writingBox({ x: text.geometry.x }).width }
  return { y: 80, ...writingBox({ x: 80 }) }
}
function layoutFocus() {
  const view = focusView({ viewW: viewSize.width, text: focusBox(), scale: state.displayScale })
  setViewTo({ ...view, y: view.y + focusScroll })
}

// The line being typed stays in the window, with room below it (the view moves, never the words).
function caretRect() {
  const selection = getSelection()
  if (!selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  let rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
  if (!rect || (!rect.height && !rect.width)) {
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
    rect = (node?.closest?.('.cm-line') ?? node)?.getBoundingClientRect()
  }
  return rect && rect.height > 0 && rect.height < 300 ? rect : null
}
function keepCaretInView() {
  if (!focusActive || isPageNote()) return
  cancelAnimationFrame(focusKeepFrame)
  focusKeepFrame = requestAnimationFrame(() => {
    const editor = document.querySelector('.leafer-text-editor')
    if (!focusActive || !editor || (!editor.contains(document.activeElement) && document.activeElement !== editor)) return
    const rect = caretRect()
    if (!rect) return
    const top = 72
    const bottom = viewSize.height - Math.max(120, viewSize.height * 0.22)
    const dy = rect.bottom > bottom ? bottom - rect.bottom : rect.top < top ? top - rect.top : 0
    if (dy) { focusScroll += dy; layoutFocus() }
  })
}
document.addEventListener('selectionchange', keepCaretInView)
document.addEventListener('input', keepCaretInView, true)

const isFullscreenNow = () => Boolean(document.fullscreenElement) || document.documentElement.classList.contains('chrome-mac-fullscreen')
// Full screen changes one move at a time: asks that come while a move is under way leave only the last one wanted, done when it ends.
let fullscreenWanted = null
let fullscreenBusy = false
async function setWindowFullscreen(on) {
  fullscreenWanted = on
  if (fullscreenBusy) return
  fullscreenBusy = true
  let last = null // (what this burst of asks last did: the same ask again is not repeated)
  try {
    while (fullscreenWanted !== null) {
      const want = fullscreenWanted
      fullscreenWanted = null
      if (want === last) continue
      last = want
      const bridge = window.pywebview?.api?.set_full_screen // the Mac app's own full screen
      try {
        if (bridge) await bridge(want)
        else if (want) await document.documentElement.requestFullscreen?.()
        else if (document.fullscreenElement) await document.exitFullscreen()
      } catch { /* the window said no: focus mode works the same without full screen */ }
    }
  } finally { fullscreenBusy = false }
}

function refreshFocusCount() {
  const editor = document.querySelector('.leafer-text-editor')
  const source = isPageNote() ? pageEditor?.getDocument()?.markdown : editor ? editor.value ?? editor.textContent : (leaferEdits.doc?.objects ?? []).find((object) => object?.id === focusTextId)?.content
  const words = countWords(source)
  document.querySelector('#focus-count').textContent = `${words} ${words === 1 ? 'word' : 'words'}`
  document.querySelector('#focus-title').textContent = document.querySelector('#note-title')?.value || 'Untitled note'
}

const focus = createFocusMode({
  canFocus: () => !state.loading && !state.noteLocked && !leaferSwitching && elements.printPreview.hidden && !document.querySelector('dialog[open]') && !elements.searchBackdrop.classList.contains('open')
    && (state.activeNoteType === 'canvas' ? Boolean(leaferCanvas) : isPageNote() && Boolean(pageEditor)),
  capture: () => isPageNote()
    ? { page: true, draw: elements.pageHost.classList.contains('page-drawing-mode'), scroll: elements.pageHost.querySelector('.page-desk')?.scrollTop ?? 0,
        focused: elements.pageHost.contains(document.activeElement), sidebarOpen: elements.sidebar.classList.contains('open'), propertiesOpen: elements.properties.classList.contains('open'), fullscreen: isFullscreenNow() }
    : {
        tool: state.tool, zoom: state.canvasZoom, view: { x: viewportOffsetX, y: viewportOffsetY, scale: getCanvasScale() },
        selection: leaferCanvas.selection(), caret: leaferCanvas.textCaret(), sidebarOpen: elements.sidebar.classList.contains('open'),
        propertiesOpen: elements.properties.classList.contains('open'), fullscreen: isFullscreenNow(),
      },
  enter(saved) {
    focusActive = true
    focusScroll = 0
    setSidebarOpen(false)
    setPropertiesOpen(false)
    setShareMenuOpen(false)
    closeInkOptions()
    if (saved.page) {
      elements.shell.classList.add('focus-mode')
      pageEditor.setNoDrawing(true) // (drawing is off, and the drawings are not shown)
      if (!saved.focused) pageEditor.focus()
      focusStartedEditing = !saved.focused
    } else {
      const text = focusCandidate(saved)
      focusTextId = text?.id ?? null
      leaferInk?.cancel()
      leaferConnect?.cancel()
      setTool('text')
      elements.shell.classList.add('focus-mode')
      leaferCanvas.setFocusLook(true, focusTextId)
      handleWorkspaceResize() // (the sidebar's room is the window's now; this also lays the words out)
      focusStartedEditing = !leaferCanvas.isEditingText()
      if (focusStartedEditing) {
        if (focusTextId) leaferCanvas.editText(focusTextId, { select: false })
        else leaferCanvas.createText({ x: 80, y: 80 }, { select: false })
      }
    }
    focusEnteredFullscreen = !saved.fullscreen
    if (focusEnteredFullscreen) void setWindowFullscreen(true)
    refreshFocusCount()
    clearInterval(focusCountTimer)
    focusCountTimer = setInterval(() => { if (focusStrip.matches(':hover')) refreshFocusCount() }, 400)
  },
  leave(saved) {
    focusActive = false
    clearInterval(focusCountTimer)
    cancelAnimationFrame(focusKeepFrame)
    elements.shell.classList.remove('focus-mode')
    if (saved.page) {
      pageEditor?.setNoDrawing(false)
      if (saved.draw) elements.pageHost.querySelector('[data-page-mode="draw"]')?.click()
      if (focusStartedEditing && elements.pageHost.contains(document.activeElement)) document.activeElement.blur()
    } else {
      if (focusStartedEditing && leaferCanvas.isEditingText()) leaferCanvas.finishTextEdit() // (the words are kept; an untouched text changes nothing)
      leaferCanvas.setFocusLook(false)
      setTool(saved.tool)
      if (saved.selection.length && !leaferCanvas.isEditingText()) leaferCanvas.select(saved.selection)
      if (saved.caret && !leaferCanvas.isEditingText()) leaferCanvas.resumeText(saved.caret) // (the writing was closed during focus: it opens again where the caret was)
    }
    setSidebarOpen(saved.sidebarOpen)
    if (saved.propertiesOpen) setPropertiesOpen(true)
    if (focusEnteredFullscreen) void setWindowFullscreen(false)
    focusEnteredFullscreen = false
    focusTextId = null
    focusLastCaret = null
    clearTimeout(focusRestore?.timer)
    focusRestore = { view: saved.view, scroll: saved.scroll, timer: 0 }
    if (saved.page) settleFocusRestore()
    else handleWorkspaceResize() // (the sidebar's room is back; the saved view is put on again here, and again after the window has settled)
  },
})
function settleFocusRestore() {
  if (!focusRestore) return
  const put = () => {
    if (focusRestore.view) setViewTo(focusRestore.view)
    if (focusRestore.scroll !== undefined) { const desk = elements.pageHost.querySelector('.page-desk'); if (desk) desk.scrollTop = focusRestore.scroll }
  }
  put()
  clearTimeout(focusRestore.timer)
  focusRestore.timer = setTimeout(() => { put(); focusRestore = null }, 450)
}
const tryFocus = () => { if (!focus.enter() && !['canvas', 'page'].includes(state.activeNoteType)) showToast('Focus mode is for notes you write on the page') }
function toggleFocus() { if (focusActive) focus.leave(); else tryFocus() } // (the shortcut, the top-bar button and the omnibar's action)
document.querySelector('#focus-button').addEventListener('click', tryFocus)
document.querySelector('#focus-leave').addEventListener('click', () => focus.leave())
document.querySelector('#focus-kbd').textContent = /mac|iphone|ipad/i.test(navigator.platform) ? '⌘ .' : 'Ctrl .'
document.querySelector('#focus-button').title = `Focus mode (${/mac|iphone|ipad/i.test(navigator.platform) ? '⌘.' : 'Ctrl+.'})`
document.addEventListener('fullscreenchange', () => { if (focusActive && focusEnteredFullscreen && !document.fullscreenElement) focus.leave() }) // (the browser's own Esc left full screen)
window.addEventListener('keydown', (event) => {
  if (focusShortcut(event, navigator.platform)) {
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) toggleFocus()
  } else if (focusActive && event.key === 'Escape' && !event.isComposing && !document.querySelector('dialog[open]')) {
    event.preventDefault()
    event.stopPropagation()
    focus.leave()
  } else if (focusActive && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') focus.leave() // (search opens on the full window)
}, true)
for (const type of ['wheel', 'pointerdown']) window.addEventListener(type, () => { if (focusRestore && !focusActive) { clearTimeout(focusRestore.timer); focusRestore = null } }, { capture: true, passive: true }) // (the person moved the view: theirs wins)
// Only the words take the pointer in focus mode: a press anywhere else must not start a new text, close the one being written or move the caret.
// On a page note the pen and Alt-drag (which would draw) are turned away.
for (const type of ['pointerdown', 'mousedown']) {
  window.addEventListener(type, (event) => {
    if (!focusActive) return
    const turnAway = isPageNote() ? (event.pointerType === 'pen' || event.altKey) && event.target.closest?.('.page-host') : !event.target.closest?.('.leafer-text-editor, .cm-editor, .focus-strip')
    if (turnAway) {
      event.preventDefault(); event.stopImmediatePropagation()
      if (!event.target.closest?.('.focus-strip')) resumeFocusWriting(event) // (the edit closed, e.g. the window blurred: the press opens it again at the press)
    }
  }, true)
}
// F-085: the focus text always takes the writing. If its edit has closed (the Mac's full-screen switch blurs the window, and a blur ends a text edit),
// a press on the words or the paper opens it again with the caret at the press, and coming back to the window resumes where the caret was.
let focusLastCaret = null
function resumeFocusWriting(press) {
  if (!focusActive || isPageNote() || !leaferCanvas || leaferCanvas.isEditingText()) return
  const at = press ? leaferCanvas.pageAt(press.clientX, press.clientY) : null
  const textId = focusTextId // (null while focus began on a note with no text and nothing was typed yet: then a new one is made)
  if (textId && leaferCanvas.editText(textId, { select: false, point: at ?? undefined })) {
    if (!at && focusLastCaret?.id === textId) leaferCanvas.resumeText(focusLastCaret)
  } else leaferCanvas.createText(at ?? { x: 80, y: 80 }, { select: false })
}
document.addEventListener('selectionchange', () => {
  if (!focusActive || !leaferCanvas?.isEditingText()) return
  focusLastCaret = leaferCanvas.textCaret() ?? focusLastCaret
  if (!focusTextId && focusLastCaret) focusTextId = focusLastCaret.id // (focus made this text: it is the focus text from now on)
})
window.addEventListener('focus', () => resumeFocusWriting())

const doubleTap = createDoubleTap({ key: tapKeyFor(navigator.platform) })
let toolPillTimer = 0
function flashToolPill(label) {
  elements.toolPill.textContent = label
  elements.toolPill.hidden = false
  clearTimeout(toolPillTimer)
  toolPillTimer = setTimeout(() => { elements.toolPill.hidden = true }, 900)
}
function toggleWritingAndPen() {
  if (focusActive) { flashToolPill('Drawing is off in focus mode'); return } // (focus is for words: the double-tap and the middle click change nothing)
  if (state.activeNoteType !== 'canvas' || state.loading || state.noteLocked || leaferSwitching || !leaferCanvas || !elements.printPreview.hidden || document.querySelector('dialog[open]') || !elements.searchBackdrop.hidden) return
  if (PEN_TOOLS.has(state.tool)) {
    togglingTool = true
    try { setTool('text') } finally { togglingTool = false }
    flashToolPill('Text')
    const spot = writingSpot
    writingSpot = null
    if (spot && spot.noteId === state.activeNoteId) leaferCanvas.resumeText(spot)
    return
  }
  const caret = leaferCanvas.textCaret()
  leaferCanvas.finishTextEdit() // the words typed so far become an edit before drawing starts
  togglingTool = true
  try { setTool(lastPenTool ?? 'pen') } finally { togglingTool = false }
  writingSpot = caret ? { noteId: state.activeNoteId, ...caret } : null
  flashToolPill(state.tool === 'highlight' ? 'Highlight' : state.tool === 'eraser' ? 'Eraser' : 'Pen')
}
window.addEventListener('keydown', (event) => doubleTap.keydown({ key: event.key, repeat: event.repeat, time: event.timeStamp }), true)
window.addEventListener('keyup', (event) => { if (doubleTap.keyup({ key: event.key, time: event.timeStamp })) toggleWritingAndPen() }, true)
window.addEventListener('pointerdown', () => doubleTap.interrupt(), true)
window.addEventListener('wheel', () => doubleTap.interrupt(), { capture: true, passive: true }) // (Cmd/Ctrl + scroll zooms)
window.addEventListener('blur', () => doubleTap.reset())

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
    if (omni.open) closeSearch()
    else openSearch()
  } else if (event.key === 'Escape' && omni.open && !event.isComposing && event.keyCode !== IME_KEY) {
    closeSearch()
  } else if (event.key === 'Escape' && elements.properties.classList.contains('open')) {
    setPropertiesOpen(false)
  } else if (event.key === 'Escape' && !elements.inkOptionsPopover.hidden) {
    closeInkOptions()
  } else if (event.key === 'Escape' && !elements.dockFlyout.hidden) {
    setFlyoutOpen(false)
    elements.dockMore.focus()
  } else if (event.key === 'Escape' && !elements.noteCreateMenu.hidden) {
    setNoteCreateMenuOpen(false)
    document.querySelector('#rail-new-note').focus()
  } else if (event.key === 'Escape' && elements.sidebar.classList.contains('open') && !noteWantsEsc() && !event.isComposing && event.keyCode !== IME_KEY && !document.querySelector('dialog[open]') && !event.target.matches?.('.namer, .namer *')) { // (Esc in a dialog or the naming row closes only that)
    setSidebarOpen(false, true)
  } else if (pendingClearUndo && !isTyping && (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    undoClear()
  } else if (state.activeNoteType === 'mindmap' || state.activeNoteType === 'page') {
    return
  } else if (!isTyping && canPanFromKeyboard(activeElement) && handleLeaferKey(event)) {
    event.preventDefault()
  } else if (event.key === 'Escape' && leaferConnect?.active) {
    leaferConnect.cancel()
  } else if (event.key === 'Escape' && !isTyping && isDrawingTool(state.tool) && state.activeNoteType === 'canvas' && window.innerWidth > 800) {
    setTool('text') // F-059: Esc from drawing goes back to writing, at 100%
    backToWriting()
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

async function initialize() {
  await prepareCanvasFonts()
  refreshPageColors()
  resizePaper()
  resetCanvasView()
  syncDefaultTypographySettings()
  syncTypographyControls()
  loadCapabilitySettings()
  try {
    // A page that opens (or reloads) starts with every secure note locked, whatever an earlier page left unlocked on the server.
    await api('/secure/lock', { method: 'POST' }).catch(() => {})
    await secure.resetCapture() // and the window may be shared again (a Mac window an earlier page left hidden)
    ;[state.notebooks, state.notes] = await Promise.all([api('/notebooks'), api('/notes')])
    pruneOpenNotebooks()
    state.selectedNotebookId = state.notes[0]?.notebookId ?? null
    if (!state.notes.length) await createNote()
    else await selectNote(state.notes[0].id)
    agentSync = mountAgentSync({
      api,
      saveStateElement: elements.saveState,
      chipAnchor: document.querySelector('.topbar-title'),
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
  document.querySelector('#focus-top-kbd').textContent = `${modifier}${glue}.`
  document.querySelector('#print-kbd').textContent = `${modifier}${glue}P`
  elements.searchButton.title = `Search or jump to (${modifier}${glue}K)`
}

document.fonts.ready.then(refreshCanvasTextMetrics)
document.fonts.addEventListener('loadingdone', refreshCanvasTextMetrics)
// F-083: when the notes panel opens or closes beside the note, the area's left edge moves; the page then keeps its place in the middle of the area.
let areaLeft = elements.workspace.getBoundingClientRect().left
function handleWorkspaceResize() {
  const left = elements.workspace.getBoundingClientRect().left
  const areaMoved = left !== areaLeft
  areaLeft = left
  const oldSize = { width: viewSize.width, height: viewSize.height }
  if (state.activeNoteType === 'page' && focusRestore && !focusActive) return settleFocusRestore()
  if (state.activeNoteType !== 'canvas') return
  const previous = { x: viewportOffsetX, y: viewportOffsetY, scale: getCanvasScale() }
  state.displayScale = getDisplayScale()
  syncCanvasSize()
  refreshPageColors()
  if (focusActive) return layoutFocus() // F-073: the words stay in the middle of the window
  if (focusRestore) return settleFocusRestore() // F-073: coming back, the view is the one that was left
  const center = { x: viewSize.width / 2, y: viewSize.height / 2 }
  let next
  if (areaMoved) {
    next = moveWithCentre(previous, oldSize, viewSize, PAGE_ISLAND_CLEARANCE, panelOwed())
    panelGaveWay = next.owed
  } else next = zoomAtPoint(previous, getCanvasScale(), center)
  setCanvasViewportOffset(next.x, next.y)
  if (areaMoved) gaveWayAt = { x: viewportOffsetX, scale: getCanvasScale() }
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
if (import.meta.env.DEV) window.__personalNote = { voiceBoxPoint: () => pageBoundedTextLayout(currentVoiceInsertPoint(), { pageWidth: PAGE_WIDTH }), selectNote, leaferBase: () => leaferBase, inputSurface, viewSize, state, leaferEdits, leaferSource: () => leaferSource, encodeDocument, createNote, setLeaferSourceNoteId: (id) => { leaferSource.noteId = id }, leaferCanvas: () => leaferCanvas, setTool, getCanvasScale, setCanvasViewportOffset, setViewTo, pageExtents: () => pageExtentsNow, pageExtentsTarget, refreshWorkspaceLists }
initialize().then(async () => { await speedTestStatus; if (speedTestInstance && new URLSearchParams(location.search).get('speedtest') === '1') setTimeout(() => void startSpeedTest(), 800) }) // `npm run speedtest` opens the page this way
