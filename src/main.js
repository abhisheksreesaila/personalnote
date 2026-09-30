import './style.css'
import './workspace-theme.css'
import './skins.css'
import { mountSkinSwitcher, startSkins } from './skins.js'
import { ActiveSelection, cache, Canvas, Circle, FabricObject, IText, Path, PencilBrush, Point, StaticCanvas, Textbox, util } from 'fabric'
import { createIcons, icons } from 'lucide'
import { api, downloadWorkspaceFile } from './core/api.js'
import { mountMindMapModule } from './modules/mindmap.js'
import { DictationSession } from './modules/voice/transcript-session.js'
import { createMobileHoldController } from './modules/voice/mobile-hold-controller.js'
import { pageBoundedTextLayout } from './modules/voice/text-layout.js'
import { flushPendingHistory } from './modules/editor/history.js'
import { mountAgentSync } from './modules/sync/index.js'
import { mergeRemoteAppends, pickFlagBlock } from './modules/sync/changes.js'
import { prettifySelection } from './modules/editor/prettify.js'
import { Connector, drawArrow } from './modules/editor/connector-object.js'
import {
  ConnectorIndex,
  connectorBox,
  connectorEndpoints,
  connectorsLeftDangling,
} from './modules/editor/connectors.js'
import {
  clampView,
  easeInOut,
  lerpExtents,
  pageExtents,
  parseBoxShadow,
  shadowBands,
  shiftExtents,
  viewMargins,
  wheelPanDelta,
  zoomAtPoint,
} from './modules/editor/viewport.js'

const PAGE_WIDTH = 860
const PAGE_HEIGHT = 1080
const CANVAS_ZOOM_MIN = 0.25
const CANVAS_ZOOM_MAX = 4
const EDGE_OVERFLOW = 6
const EDGE_SHRINK = 0
const TRANSFORM_EDGE_MARGIN = 24
const PAGE_EXPAND_DURATION = 560
const PAGE_RESIZE_DURATION = 560
const ERASER_RADIUS = 13
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

FabricObject.customProperties = Array.from(new Set([
  ...FabricObject.customProperties,
  'inkPoints',
  'isInk',
  'inkTool',
  'semanticId',
]))

document.querySelector('#app').innerHTML = `
  <div class="app-shell">
    <nav class="side-rail" aria-label="Workspace">
      <button class="rail-brand" id="toggle-sidebar" title="Notebooks" aria-label="Open notebooks" aria-expanded="false">P</button>
      <div class="rail-group">
        <div class="rail-create-control">
          <button class="rail-button hold-create-button" id="rail-new-note" title="New canvas note - hold for more types" aria-label="Create new canvas note. Press and hold for more note types" aria-haspopup="menu" aria-expanded="false"><i data-lucide="square-pen"></i></button>
        </div>
        <button class="rail-button" id="rail-notebooks" title="Notebooks" aria-label="Open notebooks"><i data-lucide="notebook-tabs"></i></button>
      </div>
      <div class="rail-group mindmap-rail-actions" id="mindmap-rail-actions" aria-label="Mind map tools" hidden>
        <button class="rail-button" data-map-action="image" title="Add image" aria-label="Add image"><i data-lucide="image-plus"></i></button>
        <button class="rail-button" data-map-action="import" title="Import JSON" aria-label="Import JSON"><i data-lucide="folder-open"></i></button>
        <button class="rail-button" data-map-action="export-json" title="Export JSON" aria-label="Export JSON"><i data-lucide="braces"></i></button>
        <button class="rail-button" data-map-action="export-png" title="Export PNG" aria-label="Export PNG"><i data-lucide="image-down"></i></button>
        <button class="rail-button" data-map-action="undo" title="Undo" aria-label="Undo"><i data-lucide="undo-2"></i></button>
        <button class="rail-button" data-map-action="redo" title="Redo" aria-label="Redo"><i data-lucide="redo-2"></i></button>
        <button class="rail-button" data-map-action="clean" title="Clean up layout" aria-label="Clean up layout"><i data-lucide="wand-sparkles"></i></button>
        <button class="rail-button" data-map-action="fit" title="Fit map" aria-label="Fit map"><i data-lucide="scan"></i></button>
      </div>
      <div class="rail-group rail-bottom">
        <button class="rail-button" id="rail-print" title="Print preview" aria-label="Open print preview"><i data-lucide="printer"></i></button>
        <button class="rail-button" id="rail-settings" title="Settings" aria-label="Open settings"><i data-lucide="settings"></i></button>
      </div>
    </nav>
    <div class="note-create-menu" id="note-create-menu" role="menu" aria-label="Create note as" hidden>
      <button role="menuitem" data-create-note-type="canvas"><i data-lucide="file-text"></i><span>Canvas note</span></button>
      <button role="menuitem" data-create-note-type="mindmap"><i data-lucide="git-fork"></i><span>Mind map</span></button>
    </div>
    <aside class="sidebar" id="sidebar" inert>
      <div class="brand-row">
        <button class="icon-button mobile-library-back" id="mobile-library-back" title="Back to notebooks" aria-label="Back to notebooks"><i data-lucide="arrow-left"></i></button>
        <span class="brand-name desktop-brand-name">Personal Note</span>
        <span class="mobile-library-heading" id="mobile-library-heading">Notebooks</span>
        <button class="icon-button" id="close-sidebar" title="Close notebooks" aria-label="Close notebooks"><i data-lucide="x"></i></button>
      </div>
      <div class="notebook-navigator" id="notebook-navigator">
        <section class="notebook-pane" aria-label="Notebooks">
          <div class="pane-heading">
            <span>Notebooks</span>
            <button class="sidebar-add" id="new-notebook" title="New notebook" aria-label="New notebook"><i data-lucide="plus"></i></button>
          </div>
          <div class="notebook-list" id="notebook-list"></div>
        </section>
        <section class="note-pane" aria-label="Notes">
          <div class="note-pane-heading">
            <div class="note-pane-title">
              <span class="notebook-dot" id="selected-notebook-dot"></span>
              <div><small>Notes</small><strong id="selected-notebook-name">Notebook</strong></div>
            </div>
            <div class="note-pane-actions">
              <div class="sidebar-create-control">
                <button class="icon-button hold-create-button" id="new-note" title="New canvas note - hold for more types" aria-label="Create new canvas note. Press and hold for more note types" aria-haspopup="menu" aria-expanded="false"><i data-lucide="square-pen"></i></button>
              </div>
              <button class="icon-button" id="edit-selected-notebook" title="Edit notebook" aria-label="Edit selected notebook"><i data-lucide="more-horizontal"></i></button>
            </div>
          </div>
          <div class="note-list" id="note-list"></div>
        </section>
      </div>
      <div class="sidebar-footer"><span class="storage-dot"></span>Saved on this device<span class="skin-switcher" id="skin-switcher"></span></div>
    </aside>

    <main class="main-view">
      <header class="topbar">
        <button class="icon-button mobile-editor-back" id="mobile-editor-back" title="Back to notes" aria-label="Back to notes"><i data-lucide="arrow-left"></i></button>
        <input class="note-title" id="note-title" value="Untitled note" aria-label="Note title" />
        <div class="save-state" id="save-state"><span></span>Saved</div>
        <button class="icon-button properties-trigger" id="top-properties" title="Note properties" aria-label="Open note properties" aria-controls="properties-panel" aria-expanded="false"><i data-lucide="sliders-horizontal"></i></button>
      </header>

      <section class="workspace" id="workspace">
        <div class="tool-dock" role="toolbar" aria-label="Canvas tools">
          <div class="tool-group">
            <button class="tool-button mobile-hand-tool" data-tool="hand" title="Move canvas" aria-label="Move canvas"><i data-lucide="hand"></i></button>
            <button class="tool-button" data-tool="select" title="Select (V)" aria-label="Select"><i data-lucide="mouse-pointer-2"></i></button>
            <button class="tool-button active" data-tool="text" data-tool-options title="Text (T) - hold for color" aria-label="Text"><i data-lucide="type"></i></button>
            <button class="tool-button" data-tool="pen" data-tool-options title="Pen (D or P) - hold for color and width" aria-label="Pen"><i data-lucide="pencil"></i></button>
            <button class="tool-button" data-tool="highlight" data-tool-options title="Highlighter (H) - hold for color and width" aria-label="Highlighter"><i data-lucide="highlighter"></i></button>
            <button class="tool-button" data-tool="connect" title="Connect (C) - drag from one object to another" aria-label="Connect"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="5.5" r="2"/><path d="M7.5 16.5c4-1 3-8 9-9"/></svg></button>
            <button class="tool-button" data-tool="eraser" title="Stroke eraser (E)" aria-label="Stroke eraser"><i data-lucide="eraser"></i></button>
          </div>
          <div class="dock-divider"></div>
          <button class="tool-button ink-options-trigger" id="ink-options-trigger" title="Ink options" aria-label="Open ink options" aria-haspopup="dialog" aria-expanded="false"><span class="ink-options-dot" id="ink-options-dot"></span></button>
          <div class="dock-divider"></div>
          <div class="tool-group">
            <button class="tool-button prettify-button" id="prettify" title="Prettify selected text or this note" aria-label="Prettify selected text or this note"><i data-lucide="align-left"></i></button>
            <button class="tool-button" id="undo" title="Undo" aria-label="Undo"><i data-lucide="undo-2"></i></button>
            <button class="tool-button" id="redo" title="Redo" aria-label="Redo"><i data-lucide="redo-2"></i></button>
          </div>
        </div>
        <div class="mobile-capture-controls" aria-label="Canvas capture controls">
          <button class="mobile-draw-button" id="mobile-draw" aria-label="Enable drawing"><i data-lucide="pencil"></i><span>Draw</span></button>
          <button class="mobile-speak-button" id="mobile-speak" title="Hold to speak" aria-label="Hold to speak" aria-pressed="false"><i data-lucide="mic"></i><span>Hold to speak</span></button>
        </div>
        <section class="ink-options-popover" id="ink-options-popover" role="dialog" aria-label="Ink options" hidden>
          <div class="ink-options-heading">
            <span id="ink-color-label">Text color</span>
            <button id="close-ink-options" aria-label="Close ink options"><i data-lucide="x"></i></button>
          </div>
          <div class="ink-palette" id="ink-palette" aria-label="Common colors">
            ${INK_COLORS.map(([name, color]) => `<button class="palette-swatch ${color === '#20201e' ? 'active' : ''}" data-color="${color}" style="--swatch:${color}" title="${name}" aria-label="${name}"></button>`).join('')}
          </div>
          <div class="stroke-options" id="stroke-options" hidden>
            <span id="stroke-options-label">Pen width</span>
            <div class="stroke-widths" id="stroke-widths"></div>
          </div>
        </section>

        <button class="search-button" id="search-button" title="Search notes (Ctrl+K)" aria-label="Search notes"><i data-lucide="search"></i><span>Search notes</span><kbd>Ctrl K</kbd></button>
        <button class="voice-button" id="voice-button" title="Dictate into this note" aria-label="Start voice dictation" aria-pressed="false"><span class="voice-button-icon voice-mic-icon"><i data-lucide="mic"></i></span></button>
        <div class="voice-caption" id="voice-caption" role="status" hidden><span class="voice-pulse"></span><span id="voice-status">Listening</span></div>
        <div class="eraser-cursor" id="eraser-cursor" hidden></div>

        <div class="paper" id="paper">
          <div class="writing-guide" id="writing-guide" aria-hidden="true"></div>
          <canvas id="note-canvas"></canvas>
        </div>
        <div class="mindmap-host" id="mindmap-host" hidden></div>
        <div class="page-count" id="page-count">1 page</div>
      </section>
    </main>

    <aside class="properties-panel" id="properties-panel" aria-label="Note properties" aria-hidden="true" inert>
      <div class="properties-heading">
        <div><span>Inspector</span><h2>Note properties</h2></div>
        <button class="icon-button" id="close-properties" title="Close properties" aria-label="Close note properties"><i data-lucide="x"></i></button>
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
          <button data-font-family="Source Serif 4" class="active" title="Serif" aria-label="Serif">Ag</button>
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
      <div class="properties-footer">
        <button class="clear-note-action" id="clear-note"><i data-lucide="eraser"></i><span>Clear all</span></button>
        <button class="delete-note-action" id="delete-note"><i data-lucide="trash-2"></i><span>Delete note</span></button>
      </div>
    </aside>

    <aside class="settings-panel" id="settings-panel" aria-label="Settings" aria-hidden="true" inert>
      <div class="properties-heading">
        <div><span>Workspace</span><h2>Settings</h2></div>
        <button class="icon-button" id="close-settings" title="Close settings" aria-label="Close settings"><i data-lucide="x"></i></button>
      </div>
      <section class="settings-section">
        <p class="settings-section-label">Writing</p>
        <div class="setting-field-heading"><span>Default text</span><small>New objects</small></div>
        <div class="font-family-control settings-font-control" aria-label="Default font family">
          <button data-default-font-family="Source Serif 4" class="active" title="Serif" aria-label="Serif">Ag</button>
          <button data-default-font-family="IBM Plex Sans" title="Sans serif" aria-label="Sans serif">Ag</button>
          <button data-default-font-family="monospace" title="Monospace" aria-label="Monospace">Ag</button>
        </div>
        <label class="font-size-row settings-font-size-row" for="settings-font-size">
          <span>Size</span><output id="settings-font-size-value">24</output>
          <input id="settings-font-size" type="range" min="12" max="72" step="1" value="24" />
        </label>
      </section>
      <section class="settings-section">
        <p class="settings-section-label">Built-in modules</p>
        <div class="setting-row"><span><i data-lucide="git-fork"></i>Mind maps</span><small id="settings-mindmap">On demand</small></div>
        <div class="setting-row"><span><i data-lucide="mic"></i>Voice capture</span><small id="settings-voice">Transcript only</small></div>
        <div class="setting-row"><span><i data-lucide="audio-lines"></i>Audio retention</span><small>None</small></div>
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
      <div class="settings-footer-status" id="settings-footer-status"><span></span>Saved locally · exports stay under your control</div>
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

  <dialog class="notebook-dialog clear-note-dialog" id="clear-note-dialog" aria-labelledby="clear-note-title">
    <form method="dialog">
      <div class="dialog-heading-row">
        <div>
          <p class="dialog-eyebrow">Current note</p>
          <h2 id="clear-note-title">Clear all content?</h2>
        </div>
        <button class="icon-button" value="cancel" aria-label="Close"><i data-lucide="x"></i></button>
      </div>
      <p class="clear-note-copy" id="clear-note-copy">This removes every text and ink object and returns the canvas to one page. The note title and notebook stay in place.</p>
      <p class="dialog-note">You can undo this immediately from the writing dock.</p>
      <div class="dialog-actions">
        <button class="dialog-cancel" value="cancel">Cancel</button>
        <button class="dialog-danger" id="confirm-clear-note" value="default">Clear all</button>
      </div>
    </form>
  </dialog>

  <style id="editor-polish-screen">
    .writing-guide{position:absolute;z-index:3;pointer-events:none;opacity:.28;background:repeating-linear-gradient(to bottom,transparent 0 calc(1.45em - 1px),#8ca1a0 calc(1.45em - 1px) 1.45em)}.writing-guide[hidden]{display:none}
  </style>
`

createIcons({ icons })
mountSkinSwitcher(document.querySelector('#skin-switcher'))

const elements = {
  shell: document.querySelector('.app-shell'),
  workspace: document.querySelector('#workspace'),
  paper: document.querySelector('#paper'),
  writingGuide: document.querySelector('#writing-guide'),
  mindmapHost: document.querySelector('#mindmap-host'),
  title: document.querySelector('#note-title'),
  list: document.querySelector('#notebook-navigator'),
  notebookList: document.querySelector('#notebook-list'),
  noteList: document.querySelector('#note-list'),
  saveState: document.querySelector('#save-state'),
  pageCount: document.querySelector('#page-count'),
  sidebar: document.querySelector('#sidebar'),
  notebookPicker: document.querySelector('#notebook-picker'),
  notebookPickerMenu: document.querySelector('#notebook-picker-menu'),
  searchBackdrop: document.querySelector('#search-backdrop'),
  searchInput: document.querySelector('#search-input'),
  searchResults: document.querySelector('#search-results'),
  notebookDialog: document.querySelector('#notebook-dialog'),
  clearNoteDialog: document.querySelector('#clear-note-dialog'),
  mobileSpeak: document.querySelector('#mobile-speak'),
  notebookForm: document.querySelector('#notebook-form'),
  notebookName: document.querySelector('#notebook-name'),
  sidebarToggle: document.querySelector('#toggle-sidebar'),
  properties: document.querySelector('#properties-panel'),
  canvasTypographyProperties: document.querySelector('#canvas-typography-properties'),
  noteSurfaceLabel: document.querySelector('#note-surface-label'),
  noteSurfaceDetail: document.querySelector('#note-surface-detail'),
  clearNoteCopy: document.querySelector('#clear-note-copy'),
  printButton: document.querySelector('#rail-print'),
  settings: document.querySelector('#settings-panel'),
  fontSize: document.querySelector('#font-size-control'),
  fontSizeValue: document.querySelector('#font-size-value'),
  settingsFontSize: document.querySelector('#settings-font-size'),
  settingsFontSizeValue: document.querySelector('#settings-font-size-value'),
  voiceButton: document.querySelector('#voice-button'),
  voiceCaption: document.querySelector('#voice-caption'),
  voiceStatus: document.querySelector('#voice-status'),
  eraserCursor: document.querySelector('#eraser-cursor'),
  inkOptionsTrigger: document.querySelector('#ink-options-trigger'),
  inkOptionsDot: document.querySelector('#ink-options-dot'),
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
  pages: { columns: 1, rows: 1 },
  tool: 'text',
  color: '#20201e',
  penWidth: 3,
  highlightWidth: 20,
  fontFamily: 'Source Serif 4',
  fontSize: 24,
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
  drawingGesture: null,
  eraserActive: false,
  eraserChanged: false,
  eraserLastPoint: null,
  creatingNote: false,
  loading: false,
  history: [],
  historyIndex: -1,
}

let mindmapEditor = null

function setActiveNoteType(noteType) {
  state.activeNoteType = noteType === 'mindmap' ? 'mindmap' : 'canvas'
  const isMindMap = state.activeNoteType === 'mindmap'
  elements.shell.classList.toggle('mindmap-active', isMindMap)
  elements.paper.hidden = isMindMap
  elements.mindmapHost.hidden = !isMindMap
  elements.pageCount.hidden = isMindMap
  elements.canvasTypographyProperties.hidden = isMindMap
  elements.mindmapProperties.hidden = !isMindMap
  elements.mindmapRailActions.hidden = !isMindMap
  elements.properties.querySelector('.properties-heading span').textContent = isMindMap ? 'Mind map' : 'Inspector'
  elements.properties.querySelector('.properties-heading h2').textContent = isMindMap ? 'Node properties' : 'Note properties'
  elements.noteSurfaceLabel.textContent = isMindMap ? 'Mind map' : 'Canvas'
  elements.noteSurfaceDetail.textContent = isMindMap ? 'Infinite SVG workspace' : 'Expands automatically'
  elements.clearNoteCopy.textContent = isMindMap
    ? 'This removes every branch and returns the map to one starting topic. The note title and notebook stay in place.'
    : 'This removes every text and ink object and returns the canvas to one page. The note title and notebook stay in place.'
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

const PREFERENCES_KEY = 'personal-note.preferences.v1'
const FONT_FAMILIES = new Set(['Source Serif 4', 'IBM Plex Sans', 'monospace'])

function loadPreferences() {
  try {
    const preferences = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}')
    if (FONT_FAMILIES.has(preferences.fontFamily)) state.fontFamily = preferences.fontFamily
    const fontSize = Number(preferences.fontSize)
    if (Number.isFinite(fontSize)) state.fontSize = Math.min(72, Math.max(12, Math.round(fontSize)))
  } catch {
    localStorage.removeItem(PREFERENCES_KEY)
  }
}

function savePreferences() {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
    fontFamily: state.fontFamily,
    fontSize: state.fontSize,
  }))
}

loadPreferences()

const canvas = new Canvas('note-canvas', {
  width: elements.workspace.clientWidth || PAGE_WIDTH,
  height: elements.workspace.clientHeight || PAGE_HEIGHT,
  backgroundColor: 'transparent',
  preserveObjectStacking: false,
  renderOnAddRemove: false,
  skipOffscreen: true,
  selectionColor: 'rgba(28, 112, 168, 0.08)',
  selectionBorderColor: '#1c70a8',
})

const CANVAS_FONT_SPECS = [
  '400 24px "Source Serif 4"',
  '600 24px "Source Serif 4"',
  '400 24px "IBM Plex Sans"',
  '600 24px "IBM Plex Sans"',
]
let canvasFontLoadPromise

function loadCanvasFonts() {
  canvasFontLoadPromise ||= Promise.allSettled(
    CANVAS_FONT_SPECS.map((spec) => document.fonts.load(spec)),
  )
  return canvasFontLoadPromise
}

function refreshCanvasTextMetrics() {
  cache.clearFontCache()
  canvas.getObjects().forEach((object) => {
    if (!isEditableText(object)) return
    object.initDimensions()
    object.setCoords()
  })
  canvas.requestRenderAll()
}

async function prepareCanvasFonts() {
  await Promise.race([
    loadCanvasFonts(),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ])
  refreshCanvasTextMetrics()
}

canvas.freeDrawingBrush = new PencilBrush(canvas)

let inkOptionsCloseTimer

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
  elements.inkColorLabel.textContent = state.tool === 'text' ? 'Text color' : 'Ink color'
  document.querySelectorAll('.palette-swatch').forEach((swatch) => {
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

function renderNoteList() {
  const activeNote = state.notes.find((note) => note.id === state.activeNoteId)
  const selectedNotebook = state.notebooks.find((notebook) => notebook.id === state.selectedNotebookId)
    || state.notebooks.find((notebook) => notebook.id === activeNote?.notebookId)
    || state.notebooks[0]
  if (selectedNotebook) state.selectedNotebookId = selectedNotebook.id

  elements.notebookList.innerHTML = state.notebooks.map((notebook) => {
    const count = state.notes.filter((note) => note.notebookId === notebook.id).length
    return `
      <button class="notebook-tab ${notebook.id === selectedNotebook?.id ? 'active' : ''}" data-notebook-select="${notebook.id}" data-notebook-drop="${notebook.id}">
        <span class="notebook-dot" style="--notebook-color:${notebook.color}"></span>
        <span class="notebook-name">${escapeHtml(notebook.name)}</span>
        <span class="notebook-count">${count}</span>
      </button>
    `
  }).join('')

  const selectedNotes = state.notes.filter((note) => note.notebookId === selectedNotebook?.id)
  elements.noteList.innerHTML = selectedNotes.length ? selectedNotes.map((note) => `
    <button class="note-list-item ${note.id === state.activeNoteId ? 'active' : ''}" data-note-id="${note.id}" draggable="true">
      <i data-lucide="${note.noteType === 'mindmap' ? 'git-fork' : 'file-text'}"></i>
      <span>${escapeHtml(note.title || 'Untitled note')}</span>
    </button>
  `).join('') : '<div class="empty-notebook"><i data-lucide="file-plus-2"></i><span>No notes yet</span></div>'

  document.querySelector('#selected-notebook-name').textContent = selectedNotebook?.name || 'Notebook'
  document.querySelector('#selected-notebook-dot').style.setProperty('--notebook-color', selectedNotebook?.color || '#B86B4B')
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

function setSaveState(status, isError = false) {
  elements.saveState.classList.toggle('error', isError)
  elements.saveState.innerHTML = status === 'Saving'
    ? '<span class="saving-spinner"></span>Saving'
    : `<span></span>${status}`
}

let viewportOffsetX = 0
let viewportOffsetY = 0
let pageExtentsNow = pageExtents(1, 1, PAGE_WIDTH, PAGE_HEIGHT)
let pageAnimation = null
let pageColors = { paper: '#fbfaf5', grid: '#c9c5bc', edge: '#2c2c34', shadows: [] }
let lastViewportScrollTop = 0
let voiceOutline = false

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
    grid: '#c9c5bc',
    accent: read('--accent', '#4D839C'),
    edge: highContrast ? read('--line', '#2c2c34') : read('--sk-edge', read('--line', '#2c2c34')),
    shadows: parseBoxShadow(read('--sk-shadow', 'none')).map(resolveShadowLayer),
  }
}

// The Fabric canvas is always exactly as large as the workspace. Page growth
// only changes the page count and the tiles drawn behind the objects.
function syncCanvasSize() {
  const width = Math.max(1, elements.workspace.clientWidth)
  const height = Math.max(1, elements.workspace.clientHeight)
  if (canvas.getWidth() === width && canvas.getHeight() === height) return false
  canvas.setDimensions({ width, height })
  return true
}

function pageExtentsTarget() {
  return pageExtents(state.pages.columns, state.pages.rows, PAGE_WIDTH, PAGE_HEIGHT)
}

function clampedViewOffset(offsetX, offsetY, keep = false) {
  const target = pageExtentsTarget()
  return clampView({ x: offsetX, y: offsetY }, {
    viewW: canvas.getWidth(),
    viewH: canvas.getHeight(),
    contentW: target.right,
    contentH: target.bottom,
    scale: getCanvasScale(),
    margins: viewMargins(window.innerWidth),
    keep,
  })
}

function notifyViewportScrolled() {
  const scrollTop = viewMargins(window.innerWidth).top - viewportOffsetY
  handleWorkspaceScroll(scrollTop, lastViewportScrollTop)
  lastViewportScrollTop = scrollTop
}

function setCanvasViewportOffset(offsetX = viewportOffsetX, offsetY = viewportOffsetY, keep = false) {
  const next = clampedViewOffset(offsetX, offsetY, keep)
  const moved = next.y !== viewportOffsetY
  viewportOffsetX = next.x
  viewportOffsetY = next.y
  const scale = getCanvasScale()
  canvas.setViewportTransform([scale, 0, 0, scale, next.x, next.y])
  canvas.requestRenderAll()
  if (writingGuideText) showWritingGuide(writingGuideText)
  if (moved) notifyViewportScrolled()
}

function resetCanvasView() {
  const scale = getCanvasScale()
  const target = pageExtentsTarget()
  viewportOffsetX = (canvas.getWidth() - target.right * scale) / 2
  viewportOffsetY = viewMargins(window.innerWidth).top - 38
  lastViewportScrollTop = 38
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

function stepPageAnimation(now) {
  if (!pageAnimation) return
  const progress = (now - pageAnimation.startedAt) / PAGE_EXPAND_DURATION
  pageExtentsNow = lerpExtents(pageAnimation.from, pageAnimation.to, easeInOut(progress))
  canvas.requestRenderAll()
  if (progress < 1) pageAnimation.frame = requestAnimationFrame(stepPageAnimation)
  else pageAnimation = null
}

// Retargets the drawn page tiles. `shift` is the world distance every object
// moved when pages were prepended, so the view is compensated and nothing jumps.
function resizePaper(animate = false, shiftX = 0, shiftY = 0) {
  state.displayScale = getDisplayScale()
  syncCanvasSize()
  const target = pageExtentsTarget()
  const from = shiftExtents(pageExtentsNow, shiftX, shiftY)
  if (pageAnimation) cancelAnimationFrame(pageAnimation.frame)
  pageAnimation = null
  const changed = from.left !== target.left || from.top !== target.top
    || from.right !== target.right || from.bottom !== target.bottom
  if (animate && changed && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    pageExtentsNow = from
    pageAnimation = { from, to: target, startedAt: performance.now(), frame: 0 }
    pageAnimation.frame = requestAnimationFrame(stepPageAnimation)
  } else {
    pageExtentsNow = target
  }
  const scale = getCanvasScale()
  if (shiftX || shiftY) {
    viewportOffsetX -= shiftX * scale
    viewportOffsetY -= shiftY * scale
  }
  setCanvasViewportOffset(viewportOffsetX, viewportOffsetY, Boolean(shiftX || shiftY || animate))
  const count = state.pages.columns * state.pages.rows
  elements.pageCount.textContent = `${state.pages.columns} x ${state.pages.rows} / ${count} ${count === 1 ? 'page' : 'pages'}`
}

function drawPageTiles(ctx) {
  const extents = pageExtentsNow
  const width = extents.right - extents.left
  const height = extents.bottom - extents.top
  if (width <= 0 || height <= 0) return
  const scale = getCanvasScale()
  const hairline = 1 / scale
  const v = canvas.viewportTransform
  ctx.save()
  ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5])
  // The skin's page shadow, as stacked translucent rects (see shadowBands).
  for (const layer of pageColors.shadows) {
    ctx.fillStyle = layer.rgb
    const previousAlpha = ctx.globalAlpha
    for (const band of shadowBands({ blur: layer.blur, spread: layer.spread, alpha: layer.peak })) {
      const grow = band.grow / scale
      ctx.globalAlpha = band.alpha
      ctx.fillRect(extents.left - grow + layer.x / scale, extents.top - grow + layer.y / scale, width + grow * 2, height + grow * 2)
    }
    ctx.globalAlpha = previousAlpha
  }
  ctx.fillStyle = pageColors.edge
  ctx.fillRect(extents.left - hairline, extents.top - hairline, width + hairline * 2, height + hairline * 2)
  ctx.fillStyle = pageColors.paper
  ctx.fillRect(extents.left, extents.top, width, height)
  ctx.fillStyle = pageColors.grid
  const firstColumn = Math.max(1, Math.ceil((extents.left + 1) / PAGE_WIDTH))
  for (let x = firstColumn * PAGE_WIDTH; x < extents.right; x += PAGE_WIDTH) {
    ctx.fillRect(x - hairline, extents.top, hairline, height)
  }
  const firstRow = Math.max(1, Math.ceil((extents.top + 1) / PAGE_HEIGHT))
  for (let y = firstRow * PAGE_HEIGHT; y < extents.bottom; y += PAGE_HEIGHT) {
    ctx.fillRect(extents.left, y - hairline, width, hairline)
  }
  if (voiceOutline) {
    // Voice-listening outline follows the page extents, not the whole workspace.
    ctx.strokeStyle = pageColors.accent
    ctx.lineWidth = 2 / scale
    ctx.strokeRect(extents.left - 3 / scale, extents.top - 3 / scale, width + 6 / scale, height + 6 / scale)
  }
  ctx.restore()
}

function moveAllObjects(deltaX, deltaY) {
  canvas.getObjects().forEach((object) => {
    object.set({ left: object.left + deltaX, top: object.top + deltaY })
    object.setCoords()
  })
}

function getContentBounds() {
  const objects = canvas.getObjects()
  if (!objects.length) return null
  return objects.reduce((bounds, object) => {
    const rect = object.getBoundingRect()
    return {
      left: Math.min(bounds.left, rect.left),
      top: Math.min(bounds.top, rect.top),
      right: Math.max(bounds.right, rect.left + rect.width),
      bottom: Math.max(bounds.bottom, rect.top + rect.height),
    }
  }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity })
}

const LEGACY_TEXT_PLACEHOLDER = 'Start typing'

function isEditableText(object) {
  return Boolean(object && typeof object.text === 'string' && typeof object.enterEditing === 'function')
}

function isPlaceholderText(value) {
  const trimmed = String(value || '').trim()
  return !trimmed || trimmed === LEGACY_TEXT_PLACEHOLDER
}

function findEditableTextAt(point) {
  return [...canvas.getObjects()].reverse().find((object) => (
    isEditableText(object) && object.containsPoint(point)
  ))
}

let writingGuideText = null

// Positioned with the same world-to-screen mapping as the canvas (scale plus
// viewport offset) and re-run on every pan and zoom.
function showWritingGuide(text) {
  writingGuideText = text
  const scale = getCanvasScale()
  const corner = text.getCoords()[0]
  elements.writingGuide.style.left = `${corner.x * scale + viewportOffsetX}px`
  elements.writingGuide.style.top = `${(corner.y + text.padding) * scale + viewportOffsetY}px`
  elements.writingGuide.style.width = `${Math.max(120, text.getScaledWidth() * scale)}px`
  elements.writingGuide.style.height = `${Math.max(text.fontSize * text.lineHeight * scale, text.getScaledHeight() * scale)}px`
  elements.writingGuide.hidden = false
}

function hideWritingGuide() {
  writingGuideText = null
  elements.writingGuide.hidden = true
}

function bindTextEditingLifecycle(text) {
  if (text.__personalNoteTextBound) return
  text.__personalNoteTextBound = true
  text.on('editing:entered', () => showWritingGuide(text))
  text.on('editing:exited', () => {
    hideWritingGuide()
    if (isPlaceholderText(text.text) && canvas.getObjects().includes(text)) {
      canvas.remove(text)
      canvas.discardActiveObject()
      reconcilePages()
      recordHistory()
    }
  })
}

function bindCanvasTextObjects() {
  canvas.getObjects().forEach((object) => {
    if (isEditableText(object)) bindTextEditingLifecycle(object)
  })
}

function normalizeNotebookFonts() {
  let changed = false
  canvas.getObjects().forEach((object) => {
    if (isEditableText(object) && isPlaceholderText(object.text)) {
      canvas.remove(object)
      changed = true
      return
    }
    if (isEditableText(object) && object.fontFamily === 'Georgia') {
      object.set('fontFamily', 'Source Serif 4')
      object.setCoords()
      changed = true
    }
  })
  return changed
}

function reconcilePages(force = false) {
  if (state.loading && !force) return false
  let bounds = getContentBounds()
  if (!bounds) {
    const changed = state.pages.columns !== 1 || state.pages.rows !== 1
    state.pages = { columns: 1, rows: 1 }
    if (changed) resizePaper(true)
    return changed
  }

  let changed = false
  let viewportDeltaX = 0
  let viewportDeltaY = 0
  const prependColumns = bounds.left < -EDGE_OVERFLOW
    ? Math.ceil((-EDGE_OVERFLOW - bounds.left) / PAGE_WIDTH)
    : 0
  const prependRows = bounds.top < -EDGE_OVERFLOW
    ? Math.ceil((-EDGE_OVERFLOW - bounds.top) / PAGE_HEIGHT)
    : 0
  if (prependColumns || prependRows) {
    state.pages.columns += prependColumns
    state.pages.rows += prependRows
    moveAllObjects(prependColumns * PAGE_WIDTH, prependRows * PAGE_HEIGHT)
    viewportDeltaX += prependColumns * PAGE_WIDTH
    viewportDeltaY += prependRows * PAGE_HEIGHT
    changed = true
  }

  bounds = getContentBounds()
  let currentWidth = state.pages.columns * PAGE_WIDTH
  let currentHeight = state.pages.rows * PAGE_HEIGHT
  if (bounds.right > currentWidth + EDGE_OVERFLOW) {
    const appendColumns = Math.ceil((bounds.right - currentWidth - EDGE_OVERFLOW) / PAGE_WIDTH)
    state.pages.columns += appendColumns
    currentWidth += appendColumns * PAGE_WIDTH
    changed = true
  }
  if (bounds.bottom > currentHeight + EDGE_OVERFLOW) {
    const appendRows = Math.ceil((bounds.bottom - currentHeight - EDGE_OVERFLOW) / PAGE_HEIGHT)
    state.pages.rows += appendRows
    currentHeight += appendRows * PAGE_HEIGHT
    changed = true
  }

  bounds = getContentBounds()
  if (state.pages.columns > 1 && bounds.left > PAGE_WIDTH + EDGE_SHRINK) {
    state.pages.columns -= 1
    moveAllObjects(-PAGE_WIDTH, 0)
    viewportDeltaX -= PAGE_WIDTH
    changed = true
  } else if (state.pages.columns > 1 && bounds.right < (state.pages.columns - 1) * PAGE_WIDTH - EDGE_SHRINK) {
    state.pages.columns -= 1
    changed = true
  }
  bounds = getContentBounds()
  if (state.pages.rows > 1 && bounds.top > PAGE_HEIGHT + EDGE_SHRINK) {
    state.pages.rows -= 1
    moveAllObjects(0, -PAGE_HEIGHT)
    viewportDeltaY -= PAGE_HEIGHT
    changed = true
  } else if (state.pages.rows > 1 && bounds.bottom < (state.pages.rows - 1) * PAGE_HEIGHT - EDGE_SHRINK) {
    state.pages.rows -= 1
    changed = true
  }

  if (changed) {
    resizePaper(true, viewportDeltaX, viewportDeltaY)
  }
  canvas.requestRenderAll()
  return changed
}

function expandPagesDuringTransform() {
  if (state.loading) return
  const bounds = getContentBounds()
  if (!bounds) return
  elements.workspace.classList.add('is-object-dragging')

  let changed = false
  const prependColumns = Math.max(0, Math.ceil((TRANSFORM_EDGE_MARGIN - bounds.left) / PAGE_WIDTH))
  const prependRows = Math.max(0, Math.ceil((TRANSFORM_EDGE_MARGIN - bounds.top) / PAGE_HEIGHT))

  if (prependColumns || prependRows) {
    state.pages.columns += prependColumns
    state.pages.rows += prependRows
    moveAllObjects(prependColumns * PAGE_WIDTH, prependRows * PAGE_HEIGHT)
    changed = true
  }

  const shiftedRight = bounds.right + prependColumns * PAGE_WIDTH
  const shiftedBottom = bounds.bottom + prependRows * PAGE_HEIGHT
  let currentWidth = state.pages.columns * PAGE_WIDTH
  let currentHeight = state.pages.rows * PAGE_HEIGHT
  while (shiftedRight > currentWidth - TRANSFORM_EDGE_MARGIN) {
    state.pages.columns += 1
    currentWidth += PAGE_WIDTH
    changed = true
  }
  while (shiftedBottom > currentHeight - TRANSFORM_EDGE_MARGIN) {
    state.pages.rows += 1
    currentHeight += PAGE_HEIGHT
    changed = true
  }

  if (changed) {
    resizePaper(true, prependColumns * PAGE_WIDTH, prependRows * PAGE_HEIGHT)
  }
  elements.paper.classList.add('is-dragging')
  canvas.requestRenderAll()
}

function addText(point, value = '', beginEditing = true) {
  const text = new IText(value, {
    left: point.x,
    top: point.y,
    fill: state.color,
    fontFamily: state.fontFamily,
    fontSize: getInputFontSize(),
    lineHeight: 1.45,
    padding: 8,
    cornerColor: '#1c70a8',
    cornerStyle: 'circle',
    transparentCorners: false,
  })
  bindTextEditingLifecycle(text)
  canvas.add(text)
  canvas.setActiveObject(text)
  if (beginEditing) {
    text.enterEditing()
    if (value) {
      text.setSelectionStart(0)
      text.setSelectionEnd(0)
    }
  }
  canvas.requestRenderAll()
  return text
}

function distanceBetween(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y)
}

function samplePathCommands(path) {
  const points = []
  let current = { x: 0, y: 0 }
  let subpathStart = current
  const push = (point) => {
    const previous = points[points.length - 1]
    if (!previous || distanceBetween(previous, point) > 0.01) points.push(point)
  }
  const sampleCurve = (steps, resolver) => {
    for (let step = 1; step <= steps; step += 1) push(resolver(step / steps))
  }

  path.path.forEach((command) => {
    if (command[0] === 'M') {
      current = { x: command[1], y: command[2] }
      subpathStart = current
      push(current)
    } else if (command[0] === 'L') {
      current = { x: command[1], y: command[2] }
      push(current)
    } else if (command[0] === 'Q') {
      const start = current
      const control = { x: command[1], y: command[2] }
      const end = { x: command[3], y: command[4] }
      const steps = Math.max(2, Math.ceil((distanceBetween(start, control) + distanceBetween(control, end)) / 5))
      sampleCurve(steps, (time) => {
        const inverse = 1 - time
        return {
          x: inverse * inverse * start.x + 2 * inverse * time * control.x + time * time * end.x,
          y: inverse * inverse * start.y + 2 * inverse * time * control.y + time * time * end.y,
        }
      })
      current = end
    } else if (command[0] === 'C') {
      const start = current
      const first = { x: command[1], y: command[2] }
      const second = { x: command[3], y: command[4] }
      const end = { x: command[5], y: command[6] }
      const steps = Math.max(3, Math.ceil((distanceBetween(start, first) + distanceBetween(first, second) + distanceBetween(second, end)) / 5))
      sampleCurve(steps, (time) => {
        const inverse = 1 - time
        return {
          x: inverse ** 3 * start.x + 3 * inverse ** 2 * time * first.x + 3 * inverse * time ** 2 * second.x + time ** 3 * end.x,
          y: inverse ** 3 * start.y + 3 * inverse ** 2 * time * first.y + 3 * inverse * time ** 2 * second.y + time ** 3 * end.y,
        }
      })
      current = end
    } else if (command[0] === 'Z') {
      current = subpathStart
      push(current)
    }
  })
  return points
}

function densifyPoints(points, spacing = 4) {
  if (points.length < 2) return points
  const dense = [points[0]]
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]
    const end = points[index]
    const steps = Math.max(1, Math.ceil(distanceBetween(start, end) / spacing))
    for (let step = 1; step <= steps; step += 1) {
      const amount = step / steps
      dense.push({
        x: start.x + (end.x - start.x) * amount,
        y: start.y + (end.y - start.y) * amount,
      })
    }
  }
  return dense
}

function getPathScenePoints(path) {
  const rawPoints = Array.isArray(path.inkPoints) && path.inkPoints.length > 1
    ? path.inkPoints
    : samplePathCommands(path)
  const matrix = path.calcTransformMatrix()
  const offset = path.pathOffset
  const scenePoints = rawPoints.map((point) => new Point(point.x - offset.x, point.y - offset.y).transform(matrix))
  return densifyPoints(scenePoints)
}

function createStrokeFragment(points, source) {
  const pathData = [
    ['M', points[0].x, points[0].y],
    ...points.slice(1).map((point) => ['L', point.x, point.y]),
  ]
  const strokeScale = (Math.abs(source.scaleX || 1) + Math.abs(source.scaleY || 1)) / 2
  const fragment = new Path(pathData, {
    fill: null,
    stroke: source.stroke,
    strokeWidth: (source.strokeWidth || 1) * strokeScale,
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    strokeDashArray: source.strokeDashArray,
    opacity: source.opacity,
    globalCompositeOperation: source.globalCompositeOperation,
    selectable: false,
    evented: false,
  })
  fragment.inkPoints = points.map(({ x, y }) => ({ x, y }))
  fragment.isInk = true
  fragment.inkTool = source.inkTool
  return fragment
}

function splitStrokeAt(path, point) {
  const points = getPathScenePoints(path)
  const strokeScale = (Math.abs(path.scaleX || 1) + Math.abs(path.scaleY || 1)) / 2
  const radius = ERASER_RADIUS + (path.strokeWidth || 1) * strokeScale / 2
  if (!points.some((candidate) => distanceBetween(candidate, point) <= radius)) return false

  const runs = []
  let run = []
  points.forEach((candidate) => {
    if (distanceBetween(candidate, point) > radius) {
      run.push(candidate)
    } else if (run.length) {
      if (run.length > 1) runs.push(run)
      run = []
    }
  })
  if (run.length > 1) runs.push(run)

  const stackIndex = canvas.getObjects().indexOf(path)
  canvas.remove(path)
  runs.forEach((points, index) => canvas.insertAt(stackIndex + index, createStrokeFragment(points, path)))
  return true
}

function eraseAt(point, render = true) {
  let changed = false
  ;[...canvas.getObjects()].forEach((object) => {
    if (object instanceof Path && object.stroke && object.fill == null) {
      changed = splitStrokeAt(object, point) || changed
    } else if (object instanceof Circle && object.isInk) {
      const center = object.getCenterPoint()
      const radius = Math.max(object.getScaledWidth(), object.getScaledHeight()) / 2 + ERASER_RADIUS
      if (distanceBetween(center, point) <= radius) {
        canvas.remove(object)
        changed = true
      }
    }
  })
  if (changed && render) canvas.requestRenderAll()
  return changed
}

function eraseBetween(start, end) {
  const steps = Math.max(1, Math.ceil(distanceBetween(start, end) / (ERASER_RADIUS * 0.45)))
  let changed = false
  for (let step = 1; step <= steps; step += 1) {
    const amount = step / steps
    changed = eraseAt({
      x: start.x + (end.x - start.x) * amount,
      y: start.y + (end.y - start.y) * amount,
    }, false) || changed
  }
  if (changed) canvas.requestRenderAll()
  return changed
}

function createInkDot(point, tool) {
  const width = tool === 'highlight' ? state.highlightWidth : state.penWidth
  const dot = new Circle({
    left: point.x - width / 2,
    top: point.y - width / 2,
    radius: width / 2,
    fill: tool === 'highlight' ? `${state.color}55` : state.color,
    selectable: false,
    evented: false,
  })
  dot.isInk = true
  dot.inkTool = tool
  canvas.add(dot)
  canvas.requestRenderAll()
  return dot
}

function setTool(tool) {
  state.tool = tool
  document.querySelectorAll('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool))
  canvas.isDrawingMode = tool === 'pen' || tool === 'highlight'
  canvas.selection = tool === 'select'
  canvas.defaultCursor = tool === 'hand' ? 'grab' : tool === 'text' ? 'text' : tool === 'eraser' ? 'none' : tool === 'connect' ? 'crosshair' : 'default'
  canvas.forEachObject((object) => {
    const textEditable = tool === 'text' && isEditableText(object)
    object.selectable = tool === 'select' || textEditable
    object.evented = tool === 'select' || textEditable
  })
  if (canvas.isDrawingMode) {
    canvas.freeDrawingBrush.color = tool === 'highlight' ? `${state.color}55` : state.color
    canvas.freeDrawingBrush.width = tool === 'highlight' ? state.highlightWidth : state.penWidth
    canvas.freeDrawingBrush.decimate = 0.8
  }
  updateInkOptions()
  if (tool !== 'eraser') elements.eraserCursor.hidden = true
  connectDraft = null
  connectHover = null
  canvas.discardActiveObject()
  canvas.requestRenderAll()
}

// Connectors: arrows between two canvas objects, joined by semanticId. The index maps
// an object to its connectors so a drag refreshes only the arrows it owns.
const connectorIndex = new ConnectorIndex()
const objectsById = new Map()
let connectDraft = null
let connectHover = null

const isConnector = (object) => object instanceof Connector

function ensureObjectId(object) {
  if (!object.semanticId) object.semanticId = `res_${crypto.randomUUID().replaceAll('-', '')}`
  return object.semanticId
}

function objectBounds(object) {
  object.setCoords()
  return object.getBoundingRect()
}

function refreshConnector(connector) {
  const from = objectsById.get(connector.fromId)
  const to = objectsById.get(connector.toId)
  if (!from || !to) return
  const ends = connectorEndpoints(objectBounds(from), objectBounds(to))
  connector.visible = ends.visible
  if (!ends.visible) return
  connector.applyBox(connectorBox(ends.start, ends.end))
}

// Refresh the connectors of the given objects (an ActiveSelection is unpacked).
function refreshConnectorsOf(target) {
  if (!target || !connectorIndex.byId.size) return
  const objects = target instanceof ActiveSelection ? target.getObjects() : [target]
  const ids = objects.map((object) => object.semanticId).filter(Boolean)
  connectorIndex.forObjects(ids).forEach(refreshConnector)
}

// After any load: re-index, drop connectors whose endpoints are gone, recompute geometry.
function rebuildConnectors() {
  objectsById.clear()
  const connectors = []
  canvas.getObjects().forEach((object) => {
    if (isConnector(object)) {
      ensureObjectId(object)
      connectors.push(object)
    } else if (object.semanticId) {
      objectsById.set(object.semanticId, object)
    }
  })
  const dangling = new Set(connectorsLeftDangling(connectors, new Set(objectsById.keys())))
  dangling.forEach((connector) => canvas.remove(connector))
  const live = connectors.filter((connector) => !dangling.has(connector))
  connectorIndex.rebuild(live)
  live.forEach((connector) => {
    connector.selectable = connector.evented = state.tool === 'select'
    refreshConnector(connector)
  })
  return dangling.size > 0
}

function createConnector(from, to) {
  if (!from || !to || from === to || isConnector(from) || isConnector(to)) return null
  const fromId = ensureObjectId(from)
  const toId = ensureObjectId(to)
  if (connectorIndex.has(fromId, toId)) return null
  objectsById.set(fromId, from)
  objectsById.set(toId, to)
  const connector = new Connector({ fromId, toId, color: state.color, semanticId: `res_${crypto.randomUUID().replaceAll('-', '')}` })
  refreshConnector(connector)
  if (!connector.visible) return null
  connector.selectable = connector.evented = state.tool === 'select'
  connectorIndex.add(connector)
  canvas.add(connector)
  return connector
}

// Topmost non-ink object under the point; ink (whose box is loose) only as a fallback.
function connectTargetAt(point, exclude = null) {
  const objects = canvas.getObjects()
  let ink = null
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const object = objects[index]
    if (object === exclude || isConnector(object) || !object.visible || !object.containsPoint(point)) continue
    if (object.isInk) ink ||= object
    else return object
  }
  return ink
}

function cancelConnectDraft() {
  if (!connectDraft && !connectHover) return false
  const wasDrafting = Boolean(connectDraft)
  connectDraft = null
  connectHover = null
  canvas.requestRenderAll()
  return wasDrafting
}

function drawConnectOverlay(ctx) {
  if (state.tool !== 'connect' || (!connectDraft && !connectHover)) return
  const v = canvas.viewportTransform
  const scale = v[0]
  const accent = pageColors.accent
  ctx.save()
  ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5])
  const outline = (object) => {
    const box = objectBounds(object)
    ctx.strokeStyle = accent
    ctx.lineWidth = 2 / scale
    ctx.strokeRect(box.left - 4 / scale, box.top - 4 / scale, box.width + 8 / scale, box.height + 8 / scale)
    return box
  }
  const dot = (point) => {
    ctx.fillStyle = accent
    ctx.beginPath()
    ctx.arc(point.x, point.y, 5 / scale, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5 / scale
    ctx.stroke()
  }
  if (connectDraft) {
    const source = objectBounds(connectDraft.source)
    outline(connectDraft.source)
    const target = connectHover
    const goal = target ? objectBounds(target) : { left: connectDraft.pointer.x, top: connectDraft.pointer.y, width: 0, height: 0 }
    const ends = connectorEndpoints(source, goal, target ? undefined : 0)
    if (target) outline(target)
    if (ends.visible) {
      ctx.globalAlpha = 0.75
      drawArrow(ctx, ends.start, ends.end, { color: accent })
      ctx.globalAlpha = 1
      dot(ends.start)
      if (target) dot(ends.end)
    }
  } else if (connectHover) {
    const box = outline(connectHover)
    dot({ x: box.left + box.width / 2, y: box.top + box.height / 2 })
  }
  ctx.restore()
}

let saveTimer
let saveInFlight = false
let saveQueued = false
// Agent sync: edits not yet saved, and the object ids the server last agreed on.
let unsavedEdits = false
let syncedIds = new Set()
let agentSync = null

function canvasObjectIds(document) {
  return new Set((document?.objects || []).map((object) => object?.semanticId).filter(Boolean))
}

function ensureCanvasObjectIds() {
  canvas.getObjects().forEach((object) => {
    if (!object.semanticId) object.semanticId = `res_${crypto.randomUUID().replaceAll('-', '')}`
  })
}

async function saveActiveNote() {
  if (!state.activeNoteId || state.loading) return
  if (saveInFlight) {
    saveQueued = true
    return
  }
  saveInFlight = true
  unsavedEdits = false
  setSaveState('Saving')
  const noteId = state.activeNoteId
  const note = state.notes.find((item) => item.id === noteId)
  try {
    if (state.activeNoteType === 'canvas') ensureCanvasObjectIds()
    const title = elements.title.value.trim() || 'Untitled note'
    if (state.activeNoteType === 'mindmap') mindmapEditor?.setTitle(title)
    const savedContent = state.activeNoteType === 'mindmap' ? mindmapEditor?.getDocument() : canvas.toJSON()
    const result = await api(`/notes/${noteId}`, {
      method: 'PUT',
      body: JSON.stringify({
        title,
        content: savedContent,
        pageState: state.pages,
        notebookId: note?.notebookId,
        revision: note?.revision,
      }),
    })
    if (note) Object.assign(note, { title, revision: result.revision, resourceId: result.resourceId })
    if (state.activeNoteType === 'canvas') syncedIds = canvasObjectIds(savedContent)
    renderNoteList()
    setSaveState('Saved')
  } catch (error) {
    console.error(error)
    unsavedEdits = true
    setSaveState('Could not save', true)
    // An agent may have written first: keep the user's edits and merge its text in.
    if (/revision/i.test(error.message)) agentSync?.syncActiveNote().catch(console.error)
  } finally {
    saveInFlight = false
    if (saveQueued) {
      saveQueued = false
      saveActiveNote()
    }
  }
}

function queueSave() {
  if (state.loading) return
  unsavedEdits = true
  setSaveState('Saving')
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveActiveNote, 650)
}

let historyTimer
function snapshot() {
  if (state.activeNoteType === 'mindmap') return JSON.stringify({ content: mindmapEditor?.getDocument() })
  ensureCanvasObjectIds()
  return JSON.stringify({ content: canvas.toJSON(), pages: state.pages })
}

function commitHistorySnapshot() {
  const next = snapshot()
  if (state.history[state.historyIndex] === next) return false
  state.history = state.history.slice(0, state.historyIndex + 1)
  state.history.push(next)
  state.historyIndex = state.history.length - 1
  return true
}

function recordHistory() {
  if (state.loading) return
  clearTimeout(historyTimer)
  historyTimer = setTimeout(() => {
    if (commitHistorySnapshot()) queueSave()
  }, 180)
}

async function restoreHistory(index) {
  if (state.activeNoteType === 'mindmap') return
  if (state.loading || index < 0 || index >= state.history.length) return
  state.loading = true
  state.historyIndex = index
  const entry = JSON.parse(state.history[index])
  state.pages = entry.pages
  resizePaper(true)
  await canvas.loadFromJSON(entry.content)
  bindCanvasTextObjects()
  rebuildConnectors()
  setTool('text')
  state.loading = false
  canvas.requestRenderAll()
  queueSave()
}

async function selectNote(id) {
  if (id === state.activeNoteId) return
  clearTimeout(saveTimer)
  unsavedEdits = false
  state.activeNoteId = id
  renderNoteList()
  state.loading = true
  mindmapEditor?.destroy()
  mindmapEditor = null
  let normalizedNote = false
  try {
    const note = await api(`/notes/${id}`)
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
      state.history = []
      state.historyIndex = -1
    } else {
      state.pages = note.pageState || { columns: 1, rows: 1 }
      resizePaper()
      resetCanvasView()
      await canvas.loadFromJSON(note.content || { objects: [] })
      bindCanvasTextObjects()
      normalizedNote = normalizeNotebookFonts()
      normalizedNote = rebuildConnectors() || normalizedNote
      normalizedNote = reconcilePages(true) || normalizedNote
      state.history = [snapshot()]
      state.historyIndex = 0
      syncedIds = canvasObjectIds(note.content)
      setTool('text')
    }
    setSaveState('Saved')
    renderNoteList()
    requestAnimationFrame(resetCanvasView)
  } catch (error) {
    console.error(error)
    setSaveState('Could not load', true)
  } finally {
    state.loading = false
    if (normalizedNote) queueSave()
  }
}

async function refreshWorkspaceLists() {
  const [notebooks, notes] = await Promise.all([api('/notebooks'), api('/notes')])
  state.notebooks = notebooks
  const previous = new Map(state.notes.map((note) => [note.id, note]))
  state.notes = notes.map((note) => {
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
  state.loading = true
  let reconciled = false
  try {
    elements.title.value = note.title
    state.pages = note.pageState || { columns: 1, rows: 1 }
    resizePaper()
    await canvas.loadFromJSON(note.content || { objects: [] })
    bindCanvasTextObjects()
    rebuildConnectors()
    setTool(state.tool)
    state.history = [snapshot()]
    state.historyIndex = 0
    syncedIds = canvasObjectIds(note.content)
    const summary = state.notes.find((item) => item.id === note.id)
    if (summary) Object.assign(summary, { title: note.title, revision: note.revision, resourceId: note.resourceId, updatedAt: note.updatedAt })
    reconciled = reconcilePages(true)
    setSaveState('Saved')
    renderNoteList()
  } finally {
    state.loading = false
    if (reconciled) queueSave()
  }
}

// Unsaved local edits win: add only the objects an agent appended, then save on top of the newer revision.
async function mergeRemoteNote(note) {
  if (note.id !== state.activeNoteId || state.activeNoteType !== 'canvas') return 0
  const remoteObjects = note.content?.objects || []
  const added = mergeRemoteAppends({ syncedIds, localObjects: canvas.getObjects(), remoteObjects })
  const enlivened = added.length ? await util.enlivenObjects(added) : []
  if (note.id !== state.activeNoteId) return 0
  const summary = state.notes.find((item) => item.id === note.id)
  if (summary) summary.revision = note.revision
  syncedIds = new Set([...syncedIds, ...canvasObjectIds(note.content)])
  const remotePages = note.pageState || {}
  const columns = Math.max(state.pages.columns, remotePages.columns || 1)
  const rows = Math.max(state.pages.rows, remotePages.rows || 1)
  if (columns !== state.pages.columns || rows !== state.pages.rows) {
    state.pages = { columns, rows }
    resizePaper(true)
  }
  enlivened.forEach((object) => canvas.add(object))
  bindCanvasTextObjects()
  rebuildConnectors()
  canvas.requestRenderAll()
  queueSave()
  return enlivened.length
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
    if (noteType === 'canvas') addText({ x: 72, y: 72 })
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

function openNotebookDialog(notebook = null) {
  elements.notebookForm.dataset.notebookId = notebook?.id || ''
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
  if (id) {
    const notebook = state.notebooks.find((item) => item.id === id)
    const updated = await api(`/notebooks/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name, color, revision: notebook?.revision }),
    })
    Object.assign(notebook, updated)
  } else {
    const notebook = await api('/notebooks', { method: 'POST', body: JSON.stringify({ name, color }) })
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
  if (open) setSettingsOpen(false)
  elements.properties.classList.toggle('open', open)
  elements.properties.setAttribute('aria-hidden', String(!open))
  elements.properties.inert = !open
  const trigger = document.querySelector('#top-properties')
  trigger.classList.toggle('active', open)
  trigger.setAttribute('aria-expanded', String(open))
  trigger.setAttribute('aria-label', open ? 'Close note properties' : 'Open note properties')
}

function setSettingsOpen(open) {
  if (open) setPropertiesOpen(false)
  elements.settings.classList.toggle('open', open)
  elements.settings.setAttribute('aria-hidden', String(!open))
  elements.settings.inert = !open
  document.querySelector('#rail-settings').classList.toggle('active', open)
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

function selectedTextObject() {
  const active = canvas.getActiveObject()
  return isEditableText(active) ? active : null
}

function syncTypographyControls() {
  const text = selectedTextObject()
  const fontFamily = text?.fontFamily || state.fontFamily
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
  const activeText = selectedTextObject()
  const hasSelection = activeText && activeText.selectionStart !== activeText.selectionEnd
  const textObjects = hasSelection ? [activeText] : canvas.getObjects().filter(isEditableText)
  let changed = false
  let historyFlushed = false
  textObjects.forEach((text) => {
    const selection = prettifySelection(text.text, text.selectionStart, text.selectionEnd)
    if (selection.text === text.text) return
    if (!historyFlushed) {
      flushPendingHistory({
        cancel: () => clearTimeout(historyTimer),
        commit: commitHistorySnapshot,
      })
      historyFlushed = true
    }
    text.set('text', selection.text)
    text.initDimensions()
    text.setCoords()
    if (text === activeText && text.isEditing) {
      const caret = hasSelection ? selection.start : Math.min(text.selectionStart, selection.text.length)
      text.setSelectionStart(caret)
      text.setSelectionEnd(hasSelection ? selection.end : caret)
    }
    changed = true
  })
  if (!changed) return
  reconcilePages()
  canvas.requestRenderAll()
  if (commitHistorySnapshot()) queueSave()
}

function applyTypography(property, value) {
  const text = selectedTextObject()
  state[property] = value
  if (text) {
    text.set(property, value)
    text.setCoords()
    canvas.requestRenderAll()
    if (!isPlaceholderText(text.text)) recordHistory()
  }
  syncTypographyControls()
}

async function renderPrintSheet(column, row) {
  const element = document.createElement('canvas')
  const printCanvas = new StaticCanvas(element, {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    backgroundColor: '#ffffff',
    enableRetinaScaling: false,
    renderOnAddRemove: false,
  })
  await printCanvas.loadFromJSON(canvas.toJSON())
  printCanvas.backgroundColor = '#ffffff'
  printCanvas.setViewportTransform([1, 0, 0, 1, -column * PAGE_WIDTH, -row * PAGE_HEIGHT])
  printCanvas.renderAll()
  const dataUrl = printCanvas.toDataURL({ format: 'png', multiplier: 2 })
  printCanvas.dispose()
  return dataUrl
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

async function openPrintPreview() {
  if (state.activeNoteType !== 'canvas') return
  const sequence = ++printRenderSequence
  setSidebarOpen(false)
  setPropertiesOpen(false)
  setSettingsOpen(false)
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
  elements.shell.inert = false
  document.body.classList.remove('print-preview-open')
  document.querySelector('#rail-print').focus()
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
  voiceOutline = listening
  canvas.requestRenderAll()
  elements.voiceCaption.hidden = !listening
  elements.voiceStatus.textContent = message
}

function voiceInsertPoint() {
  const bounds = getContentBounds()
  if (!bounds) return { x: 96, y: 96 }
  return {
    x: Math.max(64, Math.min(bounds.left, state.pages.columns * PAGE_WIDTH - 260)),
    y: bounds.bottom + 42,
  }
}

function createVoiceTextBox() {
  const selected = selectedTextObject()
  if (selected) return selected
  const layout = pageBoundedTextLayout(voiceInsertPoint(), { pageWidth: PAGE_WIDTH })
  const text = new Textbox('', {
    left: layout.x,
    top: layout.y,
    width: layout.width,
    fill: state.color,
    fontFamily: state.fontFamily,
    fontSize: getInputFontSize(),
    lineHeight: 1.45,
    padding: 8,
    cornerColor: '#1c70a8',
    cornerStyle: 'circle',
    transparentCorners: false,
  })
  text.__voiceDictationBox = true
  bindTextEditingLifecycle(text)
  canvas.add(text)
  canvas.setActiveObject(text)
  text.enterEditing()
  canvas.requestRenderAll()
  return text
}

function removeEmptyVoiceTextBox() {
  const target = dictationSession.target
  if (dictationSession.active && dictationSession.partial) {
    updateVoiceTextBox(dictationSession.preview(''), { create: false })
  }
  if (!target?.__voiceDictationBox || target.text.trim() || !canvas.getObjects().includes(target)) return
  target.exitEditing()
  canvas.remove(target)
  canvas.discardActiveObject()
  reconcilePages()
}

function updateVoiceTextBox(text, { record = false, create = true } = {}) {
  if (!dictationSession.target || !canvas.getObjects().includes(dictationSession.target)) {
    if (!create) return
    dictationSession.target = createVoiceTextBox()
    dictationSession.committed = ''
  }
  dictationSession.target.set('text', text)
  dictationSession.target.initDimensions()
  dictationSession.target.setSelectionStart(text.length)
  dictationSession.target.setSelectionEnd(text.length)
  dictationSession.target.setCoords()
  canvas.requestRenderAll()
  reconcilePages()
  if (record) recordHistory()
}

function previewVoiceTranscript(transcript, options) {
  updateVoiceTextBox(dictationSession.preview(transcript, options))
}

function insertVoiceTranscript(transcript) {
  if (!transcript) return
  updateVoiceTextBox(dictationSession.commit(transcript), { record: true })
}

function showVoiceNotice(message) {
  elements.voiceCaption.hidden = false
  elements.voiceStatus.textContent = message
  clearTimeout(showVoiceNotice.timer)
  showVoiceNotice.timer = setTimeout(() => {
    if (!state.listening) elements.voiceCaption.hidden = true
  }, 2600)
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

async function startLocalDictation(attempt) {
  const { LocalTranscriptionProvider, MicrophonePcmCapture } = await import('./modules/voice/capture.js')
  const provider = new LocalTranscriptionProvider()
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
    try {
      if (await startLocalDictation(attempt)) return
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

  elements.voiceButton.addEventListener('click', toggleVoiceDictation)
}

function renderSearchResults(results, query = '') {
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
  await api(`/notes/${state.activeNoteId}`, { method: 'DELETE' })
  state.notes = state.notes.filter((note) => note.id !== state.activeNoteId)
  state.activeNoteId = null
  if (!state.notes.length) await createNote()
  else await selectNote(state.notes[0].id)
}

async function clearActiveNote() {
  if (state.activeNoteType === 'mindmap') {
    if (!state.activeNoteId) return elements.clearNoteDialog.close()
    await mountActiveMindMap(structuredClone(DEFAULT_MINDMAP_DOCUMENT))
    queueSave()
    elements.clearNoteDialog.close()
    return
  }
  if (!state.activeNoteId || !canvas.getObjects().length) return elements.clearNoteDialog.close()
  clearTimeout(historyTimer)
  canvas.discardActiveObject()
  canvas.clear()
  state.pages = { columns: 1, rows: 1 }
  resizePaper(true)
  setTool('text')
  if (commitHistorySnapshot()) queueSave()
  elements.clearNoteDialog.close()
}

function updateEraserCursor(event) {
  if (state.tool !== 'eraser' || !event.e) return
  elements.eraserCursor.hidden = false
  elements.eraserCursor.style.left = `${event.e.clientX}px`
  elements.eraserCursor.style.top = `${event.e.clientY}px`
}

function finishErasing() {
  if (!state.eraserActive) return
  state.eraserActive = false
  state.eraserLastPoint = null
  if (state.eraserChanged) {
    reconcilePages()
    recordHistory()
  }
  state.eraserChanged = false
}

// A touch that starts in the gutter around the pages scrolls the view with one
// finger, as the old padded workspace did; touches on the page keep drawing.
function isOutsidePages(event) {
  const rect = canvas.upperCanvasEl.getBoundingClientRect()
  const scale = getCanvasScale()
  const worldX = (event.clientX - rect.left - viewportOffsetX) / scale
  const worldY = (event.clientY - rect.top - viewportOffsetY) / scale
  const target = pageExtentsTarget()
  return worldX < 0 || worldY < 0 || worldX > target.right || worldY > target.bottom
}

const canvasTouchPointers = new Map()
let canvasPinchGesture = null
let canvasPanGesture = null

function beginCanvasPinch() {
  const [first, second] = [...canvasTouchPointers.values()]
  if (!first || !second) return
  const rect = canvas.upperCanvasEl.getBoundingClientRect()
  const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
  const scale = getCanvasScale()
  canvasPinchGesture = {
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    center,
    zoom: state.canvasZoom,
    worldX: (center.x - rect.left - viewportOffsetX) / scale,
    worldY: (center.y - rect.top - viewportOffsetY) / scale,
    drawing: canvas.isDrawingMode,
  }
  state.drawingGesture = null
  canvasPanGesture = null
  canvas.isDrawingMode = false
  canvas.clearContext(canvas.contextTop)
  finishErasing()
}

function updateCanvasPinch() {
  if (!canvasPinchGesture || canvasTouchPointers.size < 2) return false
  const [first, second] = [...canvasTouchPointers.values()]
  const rect = canvas.upperCanvasEl.getBoundingClientRect()
  const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
  const ratio = Math.hypot(second.x - first.x, second.y - first.y) / canvasPinchGesture.distance
  state.canvasZoom = Math.min(2.5, Math.max(0.75, canvasPinchGesture.zoom * ratio))
  const scale = getCanvasScale()
  const offsetX = center.x - rect.left - canvasPinchGesture.worldX * scale
  const offsetY = center.y - rect.top - canvasPinchGesture.worldY * scale
  setCanvasViewportOffset(offsetX, offsetY)
  return true
}

canvas.upperCanvasEl.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch' || window.innerWidth > 800) return
  canvasTouchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (canvasTouchPointers.size === 2) {
    beginCanvasPinch()
    canvas.upperCanvasEl.setPointerCapture(event.pointerId)
    event.preventDefault()
    event.stopImmediatePropagation()
    return
  }
  if (state.tool !== 'hand' && !isOutsidePages(event)) return
  canvasPanGesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: viewportOffsetX,
    offsetY: viewportOffsetY,
  }
  canvas.upperCanvasEl.setPointerCapture(event.pointerId)
  event.preventDefault()
  event.stopImmediatePropagation()
}, { capture: true })

canvas.upperCanvasEl.addEventListener('pointermove', (event) => {
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

canvas.upperCanvasEl.addEventListener('pointerup', (event) => {
  if (!canvasTouchPointers.has(event.pointerId)) return
  canvasTouchPointers.delete(event.pointerId)
  if (canvasPanGesture?.pointerId === event.pointerId) canvasPanGesture = null
  if (canvasPinchGesture && !canvasTouchPointers.size) {
    canvasPinchGesture = null
    canvas.isDrawingMode = state.tool === 'pen' || state.tool === 'highlight'
  }
  event.preventDefault()
  event.stopImmediatePropagation()
}, { capture: true })

canvas.upperCanvasEl.addEventListener('pointercancel', (event) => {
  canvasTouchPointers.delete(event.pointerId)
  if (canvasPanGesture?.pointerId === event.pointerId) canvasPanGesture = null
  if (canvasPinchGesture && !canvasTouchPointers.size) {
    canvasPinchGesture = null
    canvas.isDrawingMode = state.tool === 'pen' || state.tool === 'highlight'
  }
}, { capture: true })

canvas.on('before:render', ({ ctx }) => drawPageTiles(ctx))
// renderOnAddRemove is off so bulk loads do not repaint per object; one batched
// repaint per frame covers every add and remove.
;['object:added', 'object:removed'].forEach((eventName) => {
  canvas.on(eventName, () => canvas.requestRenderAll())
})

elements.workspace.addEventListener('wheel', (event) => {
  if (state.activeNoteType !== 'canvas' || event.target.closest?.('.tool-dock, .properties-panel, .settings-panel, .sidebar')) return
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

let mousePan = null
canvas.on('mouse:down', ({ e }) => {
  if (state.tool !== 'hand' || e.pointerType === 'touch' || e.touches) return
  mousePan = { x: e.clientX, y: e.clientY, offsetX: viewportOffsetX, offsetY: viewportOffsetY }
  canvas.setCursor('grabbing')
})
canvas.on('mouse:move', ({ e }) => {
  if (!mousePan) return
  setCanvasViewportOffset(mousePan.offsetX + e.clientX - mousePan.x, mousePan.offsetY + e.clientY - mousePan.y)
})
canvas.on('mouse:up', () => {
  if (!mousePan) return
  mousePan = null
  canvas.setCursor('grab')
})

canvas.on('before:path:created', ({ path }) => {
  const points = canvas.freeDrawingBrush?._points || []
  path.inkPoints = points.map(({ x, y }) => ({ x, y }))
  path.isInk = true
  path.inkTool = state.tool
  path.selectable = false
  path.evented = false
})

canvas.on('path:created', () => {
  if (state.drawingGesture) state.drawingGesture.created = true
})

canvas.on('mouse:down', (event) => {
  if (canvas.isDrawingMode) {
    state.drawingGesture = {
      point: { x: event.scenePoint.x, y: event.scenePoint.y },
      tool: state.tool,
      created: false,
    }
  } else if (state.tool === 'eraser') {
    updateEraserCursor(event)
    state.eraserActive = true
    state.eraserLastPoint = { x: event.scenePoint.x, y: event.scenePoint.y }
    state.eraserChanged = eraseAt(state.eraserLastPoint)
  } else if (state.tool === 'text') {
    const textTarget = isEditableText(event.target) ? event.target : findEditableTextAt(event.scenePoint)
    if (textTarget) {
      canvas.setActiveObject(textTarget)
      if (!textTarget.isEditing) textTarget.enterEditing()
      canvas.requestRenderAll()
    } else {
      addText(event.scenePoint)
    }
  }
})

canvas.on('mouse:dblclick', (event) => {
  if (state.tool === 'select' && !event.target) addText(event.scenePoint)
})

canvas.on('mouse:move', (event) => {
  if (state.tool === 'eraser') {
    updateEraserCursor(event)
    if (state.eraserActive && event.e.buttons) {
      const point = { x: event.scenePoint.x, y: event.scenePoint.y }
      state.eraserChanged = eraseBetween(state.eraserLastPoint, point) || state.eraserChanged
      state.eraserLastPoint = point
    }
    return
  }
  if (!canvas.isDrawingMode || !event.e.buttons) return
  const width = state.pages.columns * PAGE_WIDTH
  const height = state.pages.rows * PAGE_HEIGHT
  let changed = false
  if (event.scenePoint.x > width + EDGE_OVERFLOW) {
    state.pages.columns += 1
    changed = true
  }
  if (event.scenePoint.y > height + EDGE_OVERFLOW) {
    state.pages.rows += 1
    changed = true
  }
  if (changed) resizePaper(true)
})

;['object:modified', 'path:created'].forEach((eventName) => {
  canvas.on(eventName, () => {
    elements.paper.classList.remove('is-dragging')
    elements.workspace.classList.remove('is-object-dragging')
    reconcilePages()
    recordHistory()
  })
})
canvas.on('text:changed', () => {
  elements.paper.classList.remove('is-dragging')
  elements.workspace.classList.remove('is-object-dragging')
  reconcilePages()
  const activeText = selectedTextObject()
  if (activeText?.isEditing) showWritingGuide(activeText)
  recordHistory()
})
;['object:moving', 'object:scaling', 'object:rotating'].forEach((eventName) => {
  canvas.on(eventName, expandPagesDuringTransform)
})
// Registered after page growth so arrows see the final, prepend-compensated positions.
;['object:moving', 'object:scaling', 'object:rotating', 'object:resizing', 'object:modified', 'text:changed'].forEach((eventName) => {
  canvas.on(eventName, ({ target }) => refreshConnectorsOf(target))
})
canvas.on('object:removed', ({ target }) => {
  if (!target) return
  if (isConnector(target)) {
    connectorIndex.remove(target.id)
    return
  }
  if (state.loading || !target.semanticId) return
  objectsById.delete(target.semanticId)
  connectorIndex.forObjects([target.semanticId]).forEach((connector) => canvas.remove(connector))
})
canvas.on('after:render', ({ ctx }) => drawConnectOverlay(ctx))
canvas.on('mouse:down', ({ e, scenePoint }) => {
  if (state.tool !== 'connect' || e.button > 0) return
  const source = connectTargetAt(scenePoint)
  if (!source) return
  connectDraft = { source, pointer: { x: scenePoint.x, y: scenePoint.y } }
  connectHover = null
  canvas.requestRenderAll()
})
canvas.on('mouse:move', ({ scenePoint }) => {
  if (state.tool !== 'connect') return
  const hover = connectTargetAt(scenePoint, connectDraft?.source)
  if (connectDraft) connectDraft.pointer = { x: scenePoint.x, y: scenePoint.y }
  if (hover === connectHover && !connectDraft) return
  connectHover = hover
  canvas.requestRenderAll()
})
canvas.on('mouse:up', ({ scenePoint }) => {
  if (state.tool !== 'connect' || !connectDraft) return
  const { source } = connectDraft
  const target = connectTargetAt(scenePoint, source)
  connectDraft = null
  connectHover = null
  if (target && createConnector(source, target)) {
    reconcilePages()
    recordHistory()
  }
  canvas.requestRenderAll()
})
canvas.on('mouse:up', () => {
  elements.paper.classList.remove('is-dragging')
  elements.workspace.classList.remove('is-object-dragging')
  finishErasing()
  if (state.drawingGesture) {
    const gesture = state.drawingGesture
    state.drawingGesture = null
    queueMicrotask(() => {
      if (gesture.created) return
      canvas.clearContext(canvas.contextTop)
      createInkDot(gesture.point, gesture.tool)
      reconcilePages()
      recordHistory()
    })
  }
})
canvas.on('mouse:out', () => {
  if (!state.eraserActive) elements.eraserCursor.hidden = true
})
document.addEventListener('pointerup', finishErasing)
;['selection:created', 'selection:updated', 'selection:cleared'].forEach((eventName) => {
  canvas.on(eventName, syncTypographyControls)
})

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
  const active = canvas.getActiveObject()
  if (active) {
    active.set('fill', state.color)
    canvas.requestRenderAll()
    recordHistory()
  }
  setTool(state.tool)
  updateInkOptions()
  if (state.tool === 'text') closeInkOptions()
  else scheduleInkOptionsClose()
}))
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

document.querySelector('#new-notebook').addEventListener('click', () => openNotebookDialog())
document.querySelector('#clear-note').addEventListener('click', () => {
  elements.clearNoteDialog.showModal()
  requestAnimationFrame(() => elements.clearNoteDialog.querySelector('.dialog-cancel').focus())
})
document.querySelector('#confirm-clear-note').addEventListener('click', (event) => {
  event.preventDefault()
  clearActiveNote()
})
document.querySelector('#delete-note').addEventListener('click', deleteActiveNote)
document.querySelector('#prettify').addEventListener('click', prettifyActiveNote)
document.querySelector('#undo').addEventListener('click', () => restoreHistory(state.historyIndex - 1))
document.querySelector('#redo').addEventListener('click', () => restoreHistory(state.historyIndex + 1))
const mobileLayout = window.matchMedia('(max-width: 800px)')

function setMobileLibraryView(view) {
  const notesView = view === 'notes'
  elements.sidebar.classList.toggle('mobile-notes-view', notesView)
  document.querySelector('#mobile-library-heading').textContent = notesView
    ? document.querySelector('#selected-notebook-name').textContent
    : 'Notebooks'
}

function setSidebarOpen(open, mobileView = 'notebooks') {
  if (open && mobileLayout.matches) setMobileLibraryView(mobileView)
  elements.shell.classList.toggle('sidebar-open', open)
  elements.sidebar.classList.toggle('open', open)
  elements.sidebar.inert = !open
  elements.sidebarToggle.setAttribute('aria-expanded', String(open))
  elements.sidebarToggle.setAttribute('aria-label', open ? 'Close notebooks' : 'Open notebooks')
  document.querySelector('#rail-notebooks').classList.toggle('active', open)
}

document.querySelector('#toggle-sidebar').addEventListener('click', () => setSidebarOpen(!elements.sidebar.classList.contains('open')))
document.querySelector('#rail-notebooks').addEventListener('click', () => setSidebarOpen(!elements.sidebar.classList.contains('open')))
document.querySelector('#close-sidebar').addEventListener('click', () => setSidebarOpen(false))
document.querySelector('#mobile-editor-back').addEventListener('click', () => {
  const activeNote = state.notes.find((note) => note.id === state.activeNoteId)
  if (activeNote) state.selectedNotebookId = activeNote.notebookId
  renderNoteList()
  setSidebarOpen(true, 'notes')
})
document.querySelector('#mobile-library-back').addEventListener('click', () => setMobileLibraryView('notebooks'))

const desktopNewNoteButtons = [document.querySelector('#rail-new-note'), document.querySelector('#new-note')]
const suppressedNewNoteClicks = new WeakSet()

function setNoteCreateMenuOpen(open, anchor) {
  elements.noteCreateMenu.hidden = !open
  desktopNewNoteButtons.forEach((button) => button.setAttribute('aria-expanded', String(open && button === anchor)))
  if (!open || !anchor) return
  const rect = anchor.getBoundingClientRect()
  const menuWidth = 168
  elements.noteCreateMenu.style.left = `${Math.min(window.innerWidth - menuWidth - 10, rect.right + 10)}px`
  elements.noteCreateMenu.style.top = `${Math.min(window.innerHeight - 108, Math.max(10, rect.top - 4))}px`
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
document.querySelector('#mobile-draw').addEventListener('click', () => setTool('pen'))
const searchButton = document.querySelector('#search-button')
const SEARCH_REVEAL_LERP = 0.18
const SEARCH_HIDE_DISTANCE = 52
const SEARCH_SHOW_UP_DELTA = -2
const SEARCH_TOP_REVEAL = 10

let searchReveal = 1
let targetSearchReveal = 1
let searchRevealFrame = null
let searchHideAccumulator = 0
const reducedMotionSearch = window.matchMedia('(prefers-reduced-motion: reduce)')

function searchRevealFromAccumulator() {
  return Math.max(0, 1 - searchHideAccumulator / SEARCH_HIDE_DISTANCE)
}

function applySearchRevealFrame() {
  const delta = targetSearchReveal - searchReveal
  if (Math.abs(delta) >= 0.003) {
    searchReveal += delta * SEARCH_REVEAL_LERP
    searchRevealFrame = requestAnimationFrame(applySearchRevealFrame)
  } else {
    searchReveal = targetSearchReveal
    searchRevealFrame = null
  }
  searchButton.style.setProperty('--search-reveal', searchReveal.toFixed(4))
  searchButton.classList.toggle('is-scroll-hidden', searchReveal < 0.12)
}

function setSearchRevealTarget(value) {
  targetSearchReveal = Math.max(0, Math.min(1, value))
  if (reducedMotionSearch.matches) {
    searchReveal = targetSearchReveal
    searchButton.style.setProperty('--search-reveal', searchReveal.toFixed(4))
    searchButton.classList.toggle('is-scroll-hidden', searchReveal < 0.12)
    return
  }
  if (!searchRevealFrame) searchRevealFrame = requestAnimationFrame(applySearchRevealFrame)
}

function revealSearchButton() {
  searchHideAccumulator = 0
  setSearchRevealTarget(1)
}

searchButton.style.setProperty('--search-reveal', '1')
searchButton.addEventListener('focus', revealSearchButton)
searchButton.addEventListener('click', openSearch)
function handleWorkspaceScroll(nextScrollTop, previousScrollTop) {
  const delta = nextScrollTop - previousScrollTop

  if (document.activeElement === searchButton) {
    revealSearchButton()
  } else if (nextScrollTop <= SEARCH_TOP_REVEAL) {
    searchHideAccumulator = 0
    setSearchRevealTarget(1)
  } else if (delta > 0) {
    searchHideAccumulator = Math.min(
      SEARCH_HIDE_DISTANCE * 1.15,
      searchHideAccumulator + delta * 0.92,
    )
    setSearchRevealTarget(searchRevealFromAccumulator())
  } else if (delta < 0) {
    searchHideAccumulator = Math.max(0, searchHideAccumulator + delta * 0.92)
    setSearchRevealTarget(searchRevealFromAccumulator())
    if (delta < SEARCH_SHOW_UP_DELTA) searchHideAccumulator = Math.max(0, searchHideAccumulator + delta)
  }

}
reducedMotionSearch.addEventListener('change', () => {
  if (searchRevealFrame) {
    cancelAnimationFrame(searchRevealFrame)
    searchRevealFrame = null
  }
  setSearchRevealTarget(targetSearchReveal)
})
document.querySelector('#rail-print').addEventListener('click', () => openPrintPreview())
document.querySelector('#rail-settings').addEventListener('click', () => setSettingsOpen(!elements.settings.classList.contains('open')))
document.querySelector('#top-properties').addEventListener('click', () => setPropertiesOpen(!elements.properties.classList.contains('open')))
document.querySelector('#close-properties').addEventListener('click', () => setPropertiesOpen(false))
document.querySelector('#close-settings').addEventListener('click', () => setSettingsOpen(false))
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
document.querySelector('#edit-selected-notebook').addEventListener('click', () => {
  openNotebookDialog(state.notebooks.find((notebook) => notebook.id === state.selectedNotebookId))
})
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
    && !target.closest('.sidebar, #toggle-sidebar, #rail-notebooks')
  ) setSidebarOpen(false)

  if (
    elements.properties.classList.contains('open')
    && !target.closest('.properties-panel, #top-properties')
  ) setPropertiesOpen(false)

  if (
    elements.settings.classList.contains('open')
    && !target.closest('.settings-panel, #rail-settings')
  ) setSettingsOpen(false)
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
  const notebook = event.target.closest('[data-notebook-select]')
  if (notebook) {
    state.selectedNotebookId = Number(notebook.dataset.notebookSelect)
    renderNoteList()
    if (mobileLayout.matches) setMobileLibraryView('notes')
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

document.addEventListener('keydown', (event) => {
  const activeText = canvas.getActiveObject()
  if (event.key === 'Escape' && isEditableText(activeText) && activeText.isEditing) {
    event.preventDefault()
    event.stopImmediatePropagation()
    activeText.exitEditing()
    setTool('select')
  }
}, true)

document.addEventListener('keydown', (event) => {
  const activeElement = document.activeElement
  const activeText = isEditableText(canvas.getActiveObject()) ? canvas.getActiveObject() : null
  const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement?.tagName)
    || activeElement?.isContentEditable
    || activeText?.isEditing
  if (!elements.printPreview.hidden) {
    if (event.key === 'Escape') closePrintPreview()
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
      event.preventDefault()
      printNote()
    }
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    openPrintPreview()
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    if (elements.searchBackdrop.hidden) openSearch()
    else closeSearch()
  } else if (event.key === 'Escape' && !elements.searchBackdrop.hidden) {
    closeSearch()
  } else if (event.key === 'Escape' && elements.properties.classList.contains('open')) {
    setPropertiesOpen(false)
  } else if (event.key === 'Escape' && elements.settings.classList.contains('open')) {
    setSettingsOpen(false)
  } else if (event.key === 'Escape' && !elements.inkOptionsPopover.hidden) {
    closeInkOptions()
  } else if (event.key === 'Escape' && elements.sidebar.classList.contains('open')) {
    setSidebarOpen(false)
  } else if (state.activeNoteType === 'mindmap') {
    return
  } else if (event.key === 'Escape' && activeText?.isEditing) {
    event.preventDefault()
    activeText.exitEditing()
    setTool('select')
  } else if (event.key === 'Escape' && connectDraft) {
    cancelConnectDraft()
  } else if (event.key === 'Escape' && !isTyping && state.tool !== 'select') {
    setTool('select')
  } else if (isTyping && (event.ctrlKey || event.metaKey)) {
    return
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    restoreHistory(state.historyIndex + (event.shiftKey ? 1 : -1))
  } else if (event.ctrlKey && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    restoreHistory(state.historyIndex + 1)
  } else if (!isTyping && (event.key === 'Delete' || event.key === 'Backspace')) {
    const activeObjects = canvas.getActiveObjects()
    if (activeObjects.length) {
      activeObjects.forEach((object) => canvas.remove(object))
      canvas.discardActiveObject()
      reconcilePages()
      recordHistory()
    }
  } else if (!isTyping && !event.ctrlKey && !event.metaKey) {
    const shortcuts = { v: 'select', t: 'text', p: 'pen', d: 'pen', h: 'highlight', e: 'eraser', c: 'connect' }
    if (shortcuts[event.key.toLowerCase()]) setTool(shortcuts[event.key.toLowerCase()])
  }
})

async function initialize() {
  await prepareCanvasFonts()
  refreshPageColors()
  resizePaper()
  resetCanvasView()
  syncDefaultTypographySettings()
  loadCapabilitySettings()
  try {
    ;[state.notebooks, state.notes] = await Promise.all([api('/notebooks'), api('/notes')])
    state.selectedNotebookId = state.notes[0]?.notebookId || state.notebooks[0]?.id || null
    if (!state.notes.length) await createNote()
    else await selectNote(state.notes[0].id)
    agentSync = mountAgentSync({
      api,
      saveStateElement: elements.saveState,
      getActive: () => {
        const note = state.notes.find((item) => item.id === state.activeNoteId)
        return note ? { id: note.id, resourceId: note.resourceId, revision: note.revision, noteType: state.activeNoteType } : null
      },
      // Also true while typing is not yet in history or a text object is being edited.
      hasUnsavedEdits: () => unsavedEdits || saveInFlight || canvas.getObjects().some((object) => object.isEditing)
        || (state.activeNoteType === 'canvas' && snapshot() !== state.history[state.historyIndex]),
      locateFlagBlock: (action) => {
        const block = pickFlagBlock(action, canvas.getObjects())
        if (!block) return null
        const corner = block.aCoords?.tl || { x: block.left, y: block.top }
        const [a, b, c, d, e, f] = canvas.viewportTransform
        const box = canvas.upperCanvasEl.getBoundingClientRect()
        const ratio = box.width / canvas.getWidth()
        const point = { x: box.left + (a * corner.x + c * corner.y + e) * ratio, y: box.top + (b * corner.x + d * corner.y + f) * ratio }
        const view = elements.workspace.getBoundingClientRect()
        const inside = point.x >= view.left && point.x <= view.right && point.y >= view.top && point.y <= view.bottom
        return inside ? point : null
      },
      onLayout: (callback) => {
        canvas.on('after:render', callback)
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

document.fonts.ready.then(refreshCanvasTextMetrics)
document.fonts.addEventListener('loadingdone', refreshCanvasTextMetrics)
function handleWorkspaceResize() {
  if (state.activeNoteType !== 'canvas') return
  const previous = { x: viewportOffsetX, y: viewportOffsetY, scale: getCanvasScale() }
  state.displayScale = getDisplayScale()
  syncCanvasSize()
  refreshPageColors()
  const center = { x: canvas.getWidth() / 2, y: canvas.getHeight() / 2 }
  const next = zoomAtPoint(previous, getCanvasScale(), center)
  setCanvasViewportOffset(next.x, next.y)
}
// Page colors and shadow come from skin tokens, so repaint when the skin changes.
const repaintPageColors = () => {
  refreshPageColors()
  canvas.requestRenderAll()
}
new MutationObserver(repaintPageColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin'] })
window.matchMedia('(prefers-contrast: more)').addEventListener('change', repaintPageColors)
window.addEventListener('resize', handleWorkspaceResize)
if (typeof ResizeObserver === 'function') new ResizeObserver(handleWorkspaceResize).observe(elements.workspace)
setupVoiceInput()
setupToolOptionGestures()
// Dev-only handle used by scripts/benchmark-canvas.mjs; stripped from production builds.
if (import.meta.env.DEV) window.__personalNote = { canvas, state, setTool, getCanvasScale, setCanvasViewportOffset, reconcilePages, snapshot, getContentBounds }
initialize()
