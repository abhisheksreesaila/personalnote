import './style.css'
import { Canvas, Circle, FabricObject, IText, Path, PencilBrush, Point, StaticCanvas } from 'fabric'
import { createIcons, icons } from 'lucide'
import { AmbientTelemetry } from './intelligence/ambient-telemetry.js'
import { calendarDraftToIcs, parseCalendarDraft } from './intelligence/calendar-draft.js'

const PAGE_WIDTH = 860
const PAGE_HEIGHT = 1080
const CANVAS_OVERSCAN = 48
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

FabricObject.customProperties = Array.from(new Set([
  ...FabricObject.customProperties,
  'inkPoints',
  'isInk',
]))

document.querySelector('#app').innerHTML = `
  <div class="app-shell">
    <nav class="side-rail" aria-label="Workspace">
      <button class="rail-brand" id="toggle-sidebar" title="Notebooks" aria-label="Open notebooks" aria-expanded="false">P</button>
      <div class="rail-group">
        <button class="rail-button" id="rail-new-note" title="New note" aria-label="New note"><i data-lucide="square-pen"></i></button>
        <button class="rail-button" id="rail-notebooks" title="Notebooks" aria-label="Open notebooks"><i data-lucide="notebook-tabs"></i></button>
      </div>
      <div class="rail-group rail-bottom">
        <button class="rail-button" id="rail-print" title="Print preview" aria-label="Open print preview"><i data-lucide="printer"></i></button>
        <button class="rail-button" id="rail-settings" title="Settings" aria-label="Open settings"><i data-lucide="settings"></i></button>
      </div>
    </nav>
    <aside class="sidebar" id="sidebar" inert>
      <div class="brand-row">
        <span class="brand-name">Personal Note</span>
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
              <button class="icon-button" id="new-note" title="New note" aria-label="New note"><i data-lucide="square-pen"></i></button>
              <button class="icon-button" id="edit-selected-notebook" title="Edit notebook" aria-label="Edit selected notebook"><i data-lucide="more-horizontal"></i></button>
            </div>
          </div>
          <div class="note-list" id="note-list"></div>
        </section>
      </div>
      <div class="sidebar-footer"><span class="storage-dot"></span>Saved on this device</div>
    </aside>

    <main class="main-view">
      <header class="topbar">
        <input class="note-title" id="note-title" value="Untitled note" aria-label="Note title" />
        <div class="save-state" id="save-state"><span></span>Saved</div>
        <button class="icon-button properties-trigger" id="top-properties" title="Note properties" aria-label="Open note properties" aria-controls="properties-panel" aria-expanded="false"><i data-lucide="sliders-horizontal"></i></button>
      </header>

      <section class="workspace" id="workspace">
        <div class="tool-dock" role="toolbar" aria-label="Canvas tools">
          <div class="tool-group">
            <button class="tool-button" data-tool="select" title="Select (V)" aria-label="Select"><i data-lucide="mouse-pointer-2"></i></button>
            <button class="tool-button active" data-tool="text" data-tool-options title="Text (T) - hold for color" aria-label="Text"><i data-lucide="type"></i></button>
            <button class="tool-button" data-tool="pen" data-tool-options title="Pen (D or P) - hold for color and width" aria-label="Pen"><i data-lucide="pencil"></i></button>
            <button class="tool-button" data-tool="highlight" data-tool-options title="Highlighter (H) - hold for color and width" aria-label="Highlighter"><i data-lucide="highlighter"></i></button>
            <button class="tool-button" data-tool="eraser" title="Stroke eraser (E)" aria-label="Stroke eraser"><i data-lucide="eraser"></i></button>
          </div>
          <div class="dock-divider"></div>
          <button class="tool-button ink-options-trigger" id="ink-options-trigger" title="Ink options" aria-label="Open ink options" aria-haspopup="dialog" aria-expanded="false"><span class="ink-options-dot" id="ink-options-dot"></span></button>
          <div class="dock-divider"></div>
          <div class="tool-group">
            <button class="tool-button" id="undo" title="Undo" aria-label="Undo"><i data-lucide="undo-2"></i></button>
            <button class="tool-button" id="redo" title="Redo" aria-label="Redo"><i data-lucide="redo-2"></i></button>
          </div>
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

        <button class="search-button" id="search-button" title="Search notes (Ctrl+K)" aria-label="Search notes"><i data-lucide="search"></i></button>
        <button class="voice-button" id="voice-button" title="Voice dictation" aria-label="Start voice dictation" aria-pressed="false"><i data-lucide="mic"></i></button>
        <div class="voice-caption" id="voice-caption" role="status" hidden><span class="voice-pulse"></span><span id="voice-status">Listening</span></div>
        <div class="eraser-cursor" id="eraser-cursor" hidden></div>
        <button class="intelligence-presence" id="intelligence-presence" title="Related note available" aria-label="Show related note" hidden><i data-lucide="sparkles"></i></button>
        <aside class="intelligence-card" id="intelligence-card" aria-live="polite" hidden>
          <header>
            <span><i data-lucide="sparkles"></i>Related thought</span>
            <button id="dismiss-intelligence" title="Dismiss" aria-label="Dismiss related note"><i data-lucide="x"></i></button>
          </header>
          <strong id="intelligence-title"></strong>
          <p id="intelligence-excerpt"></p>
          <div class="intelligence-reason" id="intelligence-reason"></div>
          <footer>
            <span id="intelligence-source"></span>
            <button id="open-intelligence-source"><span>Open note</span><i data-lucide="arrow-up-right"></i></button>
          </footer>
        </aside>
        <button class="intelligence-presence entity-presence" id="entity-presence" title="Person context available" aria-label="Show person context" hidden><i data-lucide="user-round"></i></button>
        <aside class="intelligence-card entity-card" id="entity-card" aria-live="polite" hidden>
          <header>
            <span><i data-lucide="user-round"></i>Person</span>
            <button id="dismiss-entity" title="Dismiss" aria-label="Dismiss person context"><i data-lucide="x"></i></button>
          </header>
          <strong id="entity-name"></strong>
          <p id="entity-context"></p>
          <footer>
            <span id="entity-source"></span>
            <button id="open-entity-source"><span>Open note</span><i data-lucide="arrow-up-right"></i></button>
          </footer>
        </aside>
        <button class="intelligence-presence calendar-presence" id="calendar-presence" title="Calendar draft available" aria-label="Show calendar draft" hidden><i data-lucide="calendar-clock"></i></button>
        <aside class="intelligence-card calendar-card" id="calendar-card" aria-live="polite" hidden>
          <header>
            <span><i data-lucide="calendar-clock"></i>Calendar draft</span>
            <button id="dismiss-calendar" title="Dismiss" aria-label="Dismiss calendar draft"><i data-lucide="x"></i></button>
          </header>
          <strong id="calendar-title"></strong>
          <p id="calendar-when"></p>
          <footer>
            <span>Draft · Not added</span>
            <button id="download-calendar"><span>Download .ics</span><i data-lucide="download"></i></button>
          </footer>
        </aside>

        <div class="paper" id="paper">
          <canvas id="note-canvas"></canvas>
        </div>
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
      <section class="property-section">
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
      <section class="property-section property-note-info">
        <div><span>Canvas</span><strong>Expands automatically</strong></div>
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
        <p class="settings-section-label">Intelligence</p>
        <div class="setting-row"><span><i data-lucide="sparkles"></i>Framework</span><small>Mastra</small></div>
        <div class="setting-row"><span><i data-lucide="cpu"></i>Provider</span><small id="settings-intelligence-provider">Checking</small></div>
        <div class="setting-row"><span><i data-lucide="key-round"></i>Bring your own key</span><small id="settings-intelligence-key">Checking</small></div>
        <div class="setting-row"><span><i data-lucide="timer"></i>Last response</span><small id="settings-intelligence-latency">No sample</small></div>
      </section>
      <section class="settings-section">
        <p class="settings-section-label">Privacy & access</p>
        <div class="setting-row"><span><i data-lucide="log-in"></i>Google sign-in</span><small id="settings-auth-mode">Checking</small></div>
        <div class="setting-row"><span><i data-lucide="hard-drive"></i>Storage</span><small id="settings-storage">SQLite</small></div>
        <div class="setting-row"><span><i data-lucide="lock-keyhole"></i>Encryption</span><small id="settings-encryption">Checking</small></div>
      </section>
      <div class="settings-footer-status" id="settings-footer-status"><span></span>Configuration stays on the server</div>
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
      <p class="clear-note-copy">This removes every text and ink object and returns the canvas to one page. The note title and notebook stay in place.</p>
      <p class="dialog-note">You can undo this immediately from the writing dock.</p>
      <div class="dialog-actions">
        <button class="dialog-cancel" value="cancel">Cancel</button>
        <button class="dialog-danger" id="confirm-clear-note" value="default">Clear all</button>
      </div>
    </form>
  </dialog>
`

createIcons({ icons })

const elements = {
  shell: document.querySelector('.app-shell'),
  workspace: document.querySelector('#workspace'),
  paper: document.querySelector('#paper'),
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
  notebookForm: document.querySelector('#notebook-form'),
  notebookName: document.querySelector('#notebook-name'),
  sidebarToggle: document.querySelector('#toggle-sidebar'),
  properties: document.querySelector('#properties-panel'),
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
  intelligenceCard: document.querySelector('#intelligence-card'),
  intelligencePresence: document.querySelector('#intelligence-presence'),
  intelligenceTitle: document.querySelector('#intelligence-title'),
  intelligenceExcerpt: document.querySelector('#intelligence-excerpt'),
  intelligenceReason: document.querySelector('#intelligence-reason'),
  intelligenceSource: document.querySelector('#intelligence-source'),
  entityCard: document.querySelector('#entity-card'),
  entityPresence: document.querySelector('#entity-presence'),
  entityName: document.querySelector('#entity-name'),
  entityContext: document.querySelector('#entity-context'),
  entitySource: document.querySelector('#entity-source'),
  calendarCard: document.querySelector('#calendar-card'),
  calendarPresence: document.querySelector('#calendar-presence'),
  calendarTitle: document.querySelector('#calendar-title'),
  calendarWhen: document.querySelector('#calendar-when'),
  printPreview: document.querySelector('#print-preview'),
  printSheetList: document.querySelector('#print-sheet-list'),
  printPaper: document.querySelector('#print-paper'),
}

const state = {
  notes: [],
  notebooks: [],
  activeNoteId: null,
  selectedNotebookId: null,
  pages: { columns: 1, rows: 1 },
  tool: 'text',
  color: '#20201e',
  penWidth: 3,
  highlightWidth: 20,
  fontFamily: 'Source Serif 4',
  fontSize: 24,
  displayScale: 1,
  recognition: null,
  listening: false,
  voiceTarget: null,
  voiceError: null,
  drawingGesture: null,
  eraserActive: false,
  eraserChanged: false,
  eraserLastPoint: null,
  creatingNote: false,
  loading: false,
  history: [],
  historyIndex: -1,
  relatedSuggestion: null,
  dismissedRelated: new Set(),
  entitySuggestion: null,
  dismissedEntities: new Set(),
  calendarDraft: null,
  dismissedCalendarDrafts: new Set(),
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
  width: PAGE_WIDTH,
  height: PAGE_HEIGHT,
  backgroundColor: 'transparent',
  preserveObjectStacking: false,
  selectionColor: 'rgba(28, 112, 168, 0.08)',
  selectionBorderColor: '#1c70a8',
})

canvas.freeDrawingBrush = new PencilBrush(canvas)

function api(path, options = {}) {
  return fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  }).then(async (response) => {
    if (!response.ok) throw new Error((await response.json()).error || 'Request failed')
    return response.status === 204 ? null : response.json()
  })
}

let ambientTimer
let ambientCollapseTimer
let ambientRequest
let ambientSequence = 0
const ambientTelemetry = new AmbientTelemetry()
let entityPrefetchTimer
let entityPresentTimer
let entityCollapseTimer
let entityRequest
let entitySequence = 0
let entityQueuedAt = 0
let entityCandidate = null
let calendarPresentTimer
let calendarCollapseTimer

function publishAmbientTelemetry(event, snapshot = ambientTelemetry.snapshot()) {
  const sample = snapshot.last
  const latency = sample
    ? `${sample.presentationMs ?? sample.requestMs ?? sample.server?.serverMs ?? 0} ms · ${sample.server?.mode || 'local'}`
    : 'No sample'
  document.querySelector('#settings-intelligence-latency').textContent = latency
  console.debug('event=intelligence.latency', { event, ...snapshot })
}

function cancelAmbientWork() {
  const hadPendingWork = Boolean(ambientTimer || ambientRequest)
  clearTimeout(ambientTimer)
  ambientTimer = null
  ambientRequest?.abort()
  ambientRequest = null
  ambientSequence += 1
  if (hadPendingWork) publishAmbientTelemetry('cancelled', ambientTelemetry.cancel())
}

function clearEntityPeek({ keepPresence = false } = {}) {
  clearTimeout(entityCollapseTimer)
  elements.entityCard.classList.remove('open')
  elements.entityCard.hidden = true
  elements.entityPresence.hidden = !keepPresence || !state.entitySuggestion
}

function calendarDraftKey(draft) {
  return draft ? `${draft.title}:${draft.startAt}` : ''
}

function clearCalendarDraft({ keepPresence = false } = {}) {
  clearTimeout(calendarCollapseTimer)
  elements.calendarCard.classList.remove('open')
  elements.calendarCard.hidden = true
  elements.calendarPresence.hidden = !keepPresence || !state.calendarDraft
}

function collapseCalendarDraft() {
  if (!state.calendarDraft) return clearCalendarDraft()
  elements.calendarCard.classList.remove('open')
  setTimeout(() => {
    if (!elements.calendarCard.classList.contains('open')) {
      elements.calendarCard.hidden = true
      elements.calendarPresence.hidden = false
    }
  }, 180)
}

function showCalendarDraft(draft) {
  const date = new Date(draft.startAt)
  const dateOptions = draft.hasExplicitTime
    ? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', month: 'short', day: 'numeric' }
  elements.calendarTitle.textContent = draft.title
  elements.calendarWhen.textContent = new Intl.DateTimeFormat(undefined, dateOptions).format(date)
  state.entitySuggestion = null
  entityCandidate = null
  entitySequence += 1
  clearTimeout(entityPresentTimer)
  entityRequest?.abort()
  clearEntityPeek()
  clearRelatedNote()
  elements.calendarPresence.hidden = true
  elements.calendarCard.hidden = false
  requestAnimationFrame(() => elements.calendarCard.classList.add('open'))
  clearTimeout(calendarCollapseTimer)
  calendarCollapseTimer = setTimeout(collapseCalendarDraft, 8500)
}

function queueCalendarCheck() {
  clearTimeout(calendarPresentTimer)
  clearCalendarDraft()
  const draft = parseCalendarDraft(activePhraseSnapshot())
  state.calendarDraft = draft && !state.dismissedCalendarDrafts.has(calendarDraftKey(draft)) ? draft : null
  if (state.calendarDraft) {
    calendarPresentTimer = setTimeout(() => showCalendarDraft(state.calendarDraft), 850)
  }
}

function collapseEntityPeek() {
  if (!state.entitySuggestion) return clearEntityPeek()
  elements.entityCard.classList.remove('open')
  setTimeout(() => {
    if (!elements.entityCard.classList.contains('open')) {
      elements.entityCard.hidden = true
      elements.entityPresence.hidden = false
    }
  }, 180)
}

function showEntityPeek(person) {
  const source = person.sources[0]
  if (!source) return
  state.entitySuggestion = { ...person, source }
  elements.entityName.textContent = person.name
  elements.entityContext.textContent = source.context
  elements.entitySource.textContent = `${source.notebookName} · ${person.sourceCount} source${person.sourceCount === 1 ? '' : 's'}`
  clearRelatedNote()
  elements.entityPresence.hidden = true
  elements.entityCard.hidden = false
  requestAnimationFrame(() => elements.entityCard.classList.add('open'))
  clearTimeout(entityCollapseTimer)
  entityCollapseTimer = setTimeout(collapseEntityPeek, 8500)
}

function presentEntityCandidate(sequence) {
  if (sequence !== entitySequence || !entityCandidate || state.calendarDraft) return
  const source = entityCandidate.sources[0]
  const dismissalKey = source ? `${state.activeNoteId}:${entityCandidate.name.toLocaleLowerCase()}:${source.noteId}` : ''
  if (!source || state.dismissedEntities.has(dismissalKey)) return
  showEntityPeek(entityCandidate)
}

async function prefetchEntityContext(sequence) {
  const noteId = state.activeNoteId
  const text = activePhraseSnapshot()
  if (sequence !== entitySequence || !noteId || text.length < 4) return
  entityRequest = new AbortController()
  const request = entityRequest
  try {
    const result = await api('/intelligence/entities', {
      method: 'POST',
      body: JSON.stringify({ noteId, text }),
      signal: request.signal,
    })
    if (sequence !== entitySequence || noteId !== state.activeNoteId) return
    entityCandidate = result.people?.[0] || null
    if (entityCandidate && performance.now() - entityQueuedAt >= 850) presentEntityCandidate(sequence)
  } catch (error) {
    if (error.name !== 'AbortError') console.debug('Person listener stayed quiet.', error)
  } finally {
    if (entityRequest === request) entityRequest = null
  }
}

function queueEntityCheck() {
  clearTimeout(entityPrefetchTimer)
  clearTimeout(entityPresentTimer)
  entityRequest?.abort()
  entityCandidate = null
  state.entitySuggestion = null
  clearEntityPeek()
  const sequence = ++entitySequence
  entityQueuedAt = performance.now()
  entityPrefetchTimer = setTimeout(() => prefetchEntityContext(sequence), 250)
  entityPresentTimer = setTimeout(() => presentEntityCandidate(sequence), 850)
}

function activeTextSnapshot() {
  const canvasText = canvas.getObjects()
    .map((object) => typeof object.text === 'string' ? object.text : '')
    .filter(Boolean)
    .join(' ')
  return `${elements.title.value.trim()} ${canvasText}`.trim()
}

function activePhraseSnapshot() {
  if (document.activeElement === elements.title) return elements.title.value.trim()
  const activeObject = canvas.getActiveObject()
  if (isEditableText(activeObject) && activeObject.isEditing) return activeObject.text.trim()
  return activeTextSnapshot()
}

function clearRelatedNote({ keepPresence = false } = {}) {
  clearTimeout(ambientCollapseTimer)
  elements.intelligenceCard.classList.remove('open')
  elements.intelligenceCard.hidden = true
  elements.intelligencePresence.hidden = !keepPresence || !state.relatedSuggestion
}

function collapseRelatedNote() {
  if (!state.relatedSuggestion) return clearRelatedNote()
  elements.intelligenceCard.classList.remove('open')
  setTimeout(() => {
    if (!elements.intelligenceCard.classList.contains('open')) {
      elements.intelligenceCard.hidden = true
      elements.intelligencePresence.hidden = false
    }
  }, 180)
}

function showRelatedNote(suggestion) {
  state.relatedSuggestion = suggestion
  elements.intelligenceTitle.textContent = suggestion.title
  elements.intelligenceExcerpt.textContent = suggestion.excerpt || 'A previous note touches the same thought.'
  elements.intelligenceReason.textContent = suggestion.reason
  elements.intelligenceSource.textContent = suggestion.notebookName
  elements.intelligencePresence.hidden = true
  elements.intelligenceCard.hidden = false
  requestAnimationFrame(() => elements.intelligenceCard.classList.add('open'))
  clearTimeout(ambientCollapseTimer)
  ambientCollapseTimer = setTimeout(collapseRelatedNote, 8500)
}

async function refreshRelatedNote() {
  const noteId = state.activeNoteId
  const text = activeTextSnapshot()
  ambientTimer = null
  if (!noteId || state.notes.length < 2 || text.length < 24) {
    publishAmbientTelemetry('silent', ambientTelemetry.silent())
    return clearRelatedNote()
  }
  ambientRequest?.abort()
  ambientRequest = new AbortController()
  const request = ambientRequest
  const sequence = ++ambientSequence
  ambientTelemetry.requestStarted()
  try {
    const result = await api('/intelligence/related', {
      method: 'POST',
      body: JSON.stringify({ noteId, text }),
      signal: request.signal,
    })
    ambientTelemetry.response(result.timing)
    if (sequence !== ambientSequence || noteId !== state.activeNoteId) {
      publishAmbientTelemetry('cancelled', ambientTelemetry.cancel())
      return
    }
    const suggestion = result.suggestion
    const dismissalKey = suggestion ? `${noteId}:${suggestion.noteId}` : ''
    if (!suggestion || state.dismissedRelated.has(dismissalKey)) {
      publishAmbientTelemetry('silent', ambientTelemetry.silent())
      return clearRelatedNote()
    }
    if (state.entitySuggestion || state.calendarDraft) {
      publishAmbientTelemetry('silent', ambientTelemetry.silent())
      return
    }
    showRelatedNote(suggestion)
    publishAmbientTelemetry('presented', ambientTelemetry.presented())
  } catch (error) {
    if (error.name !== 'AbortError') {
      publishAmbientTelemetry('failed', ambientTelemetry.silent())
      console.debug('Related-note listener stayed quiet.', error)
    }
  } finally {
    if (ambientRequest === request) ambientRequest = null
  }
}

function queueAmbientCheck() {
  clearTimeout(ambientTimer)
  ambientTelemetry.queue()
  ambientTimer = setTimeout(refreshRelatedNote, 1100)
}

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

function setupToolDockMagnification() {
  const dock = document.querySelector('.tool-dock')
  const controls = [...dock.querySelectorAll('.tool-button, .color-swatch')]
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let frame
  let restingRects = []

  controls.forEach((control) => control.classList.add('dock-control'))

  const reset = () => {
    cancelAnimationFrame(frame)
    dock.classList.remove('is-magnifying')
    restingRects = []
    controls.forEach((control) => {
      control.classList.remove('is-dock-magnified', 'is-dock-peak')
      control.style.removeProperty('--dock-control-scale')
      control.style.removeProperty('--dock-control-shift')
      control.style.removeProperty('--dock-control-layer')
    })
  }

  const magnifyAt = (pointerX) => {
    if (window.innerWidth <= 800 || !finePointer.matches || reducedMotion.matches) return reset()
    if (!restingRects.length) {
      restingRects = controls.map((control) => {
        const rect = control.getBoundingClientRect()
        return { center: rect.left + rect.width / 2, width: rect.width }
      })
    }
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      dock.classList.add('is-magnifying')
      const influences = restingRects.map(({ center }) => {
        const distance = Math.abs(pointerX - center)
        return distance < 82 ? (1 + Math.cos(Math.PI * distance / 82)) / 2 : 0
      })
      const scales = influences.map((influence) => 1 + influence * 0.32)
      const peakIndex = influences.indexOf(Math.max(...influences))
      const centers = restingRects.map(({ center }) => center)

      for (let index = peakIndex - 1; index >= 0; index -= 1) {
        const baseGap = restingRects[index + 1].center - restingRects[index].center
          - (restingRects[index].width + restingRects[index + 1].width) / 2
        const requiredDistance = restingRects[index].width * scales[index] / 2
          + restingRects[index + 1].width * scales[index + 1] / 2
          + Math.max(2, baseGap)
        centers[index] = Math.min(restingRects[index].center, centers[index + 1] - requiredDistance)
      }
      for (let index = peakIndex + 1; index < controls.length; index += 1) {
        const baseGap = restingRects[index].center - restingRects[index - 1].center
          - (restingRects[index].width + restingRects[index - 1].width) / 2
        const requiredDistance = restingRects[index].width * scales[index] / 2
          + restingRects[index - 1].width * scales[index - 1] / 2
          + Math.max(2, baseGap)
        centers[index] = Math.max(restingRects[index].center, centers[index - 1] + requiredDistance)
      }

      controls.forEach((control, index) => {
        const influence = influences[index]
        control.style.setProperty('--dock-control-scale', scales[index].toFixed(3))
        control.style.setProperty('--dock-control-shift', `${(centers[index] - restingRects[index].center).toFixed(2)}px`)
        control.style.setProperty('--dock-control-layer', String(Math.round(10 + influence * 90)))
        control.classList.toggle('is-dock-magnified', influence > 0.08)
        control.classList.toggle('is-dock-peak', influence > 0.78)
      })
    })
  }

  dock.addEventListener('pointermove', (event) => magnifyAt(event.clientX))
  dock.addEventListener('pointerleave', reset)
  dock.addEventListener('focusin', (event) => {
    const control = event.target.closest('.tool-button, .color-swatch')
    if (control) magnifyAt(control.getBoundingClientRect().left + control.getBoundingClientRect().width / 2)
  })
  dock.addEventListener('focusout', (event) => {
    if (!dock.contains(event.relatedTarget)) reset()
  })
  finePointer.addEventListener('change', reset)
  reducedMotion.addEventListener('change', reset)
  window.addEventListener('resize', reset)
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
      <i data-lucide="file-text"></i>
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

let resizeTimer
let viewportMotionFrame
let viewportOffsetX = 0
let viewportOffsetY = 0
let renderedPaperWidth = PAGE_WIDTH
let renderedPaperHeight = PAGE_HEIGHT
function getDisplayScale() {
  if (window.innerWidth > 800) return 1
  return Math.min(1, Math.max(220, elements.workspace.clientWidth - 24) / PAGE_WIDTH)
}

function setCanvasDisplaySize(width, height) {
  const scaledWidth = (width + CANVAS_OVERSCAN) * state.displayScale
  const scaledHeight = (height + CANVAS_OVERSCAN) * state.displayScale
  canvas.setDimensions({ width: scaledWidth, height: scaledHeight })
  canvas.setViewportTransform([
    state.displayScale, 0, 0, state.displayScale,
    viewportOffsetX, viewportOffsetY,
  ])
}

function setCanvasViewportOffset(offsetX = 0, offsetY = 0) {
  viewportOffsetX = offsetX
  viewportOffsetY = offsetY
  const zoom = state.displayScale
  canvas.setViewportTransform([zoom, 0, 0, zoom, offsetX, offsetY])
  canvas.requestRenderAll()
}

function animateViewportCompensation(deltaX, deltaY, duration = PAGE_EXPAND_DURATION) {
  cancelAnimationFrame(viewportMotionFrame)
  const scaledDeltaX = deltaX * state.displayScale
  const scaledDeltaY = deltaY * state.displayScale
  if (!scaledDeltaX && !scaledDeltaY) return setCanvasViewportOffset()

  const startScrollLeft = elements.workspace.scrollLeft
  const startScrollTop = elements.workspace.scrollTop
  const startOffsetX = viewportOffsetX - scaledDeltaX
  const startOffsetY = viewportOffsetY - scaledDeltaY
  const targetScrollLeft = Math.max(0, startScrollLeft + scaledDeltaX - viewportOffsetX)
  const targetScrollTop = Math.max(0, startScrollTop + scaledDeltaY - viewportOffsetY)
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setCanvasViewportOffset()
    elements.workspace.scrollLeft = targetScrollLeft
    elements.workspace.scrollTop = targetScrollTop
    return
  }
  const startedAt = performance.now()

  setCanvasViewportOffset(startOffsetX, startOffsetY)
  const frame = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration)
    const eased = progress * progress * (3 - 2 * progress)
    setCanvasViewportOffset(startOffsetX * (1 - eased), startOffsetY * (1 - eased))
    elements.workspace.scrollLeft = startScrollLeft + (targetScrollLeft - startScrollLeft) * eased
    elements.workspace.scrollTop = startScrollTop + (targetScrollTop - startScrollTop) * eased
    if (progress < 1) viewportMotionFrame = requestAnimationFrame(frame)
    else {
      setCanvasViewportOffset()
      elements.workspace.scrollLeft = targetScrollLeft
      elements.workspace.scrollTop = targetScrollTop
    }
  }
  viewportMotionFrame = requestAnimationFrame(frame)
}

function resizePaper(animate = false) {
  const width = state.pages.columns * PAGE_WIDTH
  const height = state.pages.rows * PAGE_HEIGHT
  const currentWidth = renderedPaperWidth
  const currentHeight = renderedPaperHeight
  const isExpanding = width > currentWidth || height > currentHeight
  const isShrinking = width < currentWidth || height < currentHeight
  const resizeDuration = isExpanding ? PAGE_EXPAND_DURATION : PAGE_RESIZE_DURATION
  state.displayScale = getDisplayScale()
  clearTimeout(resizeTimer)
  elements.paper.classList.toggle('is-expanding', animate && isExpanding)
  elements.paper.classList.toggle('is-shrinking', animate && isShrinking)

  if (animate && (width !== currentWidth || height !== currentHeight)) {
    setCanvasDisplaySize(Math.max(width, currentWidth), Math.max(height, currentHeight))
    resizeTimer = setTimeout(() => {
      setCanvasDisplaySize(width, height)
      elements.paper.classList.remove('is-expanding')
      elements.paper.classList.remove('is-shrinking')
      canvas.requestRenderAll()
    }, resizeDuration)
  } else {
    setCanvasDisplaySize(width, height)
    elements.paper.classList.remove('is-expanding')
    elements.paper.classList.remove('is-shrinking')
  }

  renderedPaperWidth = width
  renderedPaperHeight = height
  elements.paper.style.width = `${width * state.displayScale}px`
  elements.paper.style.height = `${height * state.displayScale}px`
  elements.paper.style.setProperty('--page-width', `${PAGE_WIDTH * state.displayScale}px`)
  elements.paper.style.setProperty('--page-height', `${PAGE_HEIGHT * state.displayScale}px`)
  const count = state.pages.columns * state.pages.rows
  elements.pageCount.textContent = `${state.pages.columns} x ${state.pages.rows} / ${count} ${count === 1 ? 'page' : 'pages'}`
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

function isEditableText(object) {
  return Boolean(object && typeof object.text === 'string' && typeof object.enterEditing === 'function')
}

function findEditableTextAt(point) {
  return [...canvas.getObjects()].reverse().find((object) => (
    isEditableText(object) && object.containsPoint(point)
  ))
}

function normalizeNotebookFonts() {
  let changed = false
  canvas.getObjects().forEach((object) => {
    if (isEditableText(object) && object.text === 'Start typing') {
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
    resizePaper(true)
    animateViewportCompensation(viewportDeltaX, viewportDeltaY)
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
    resizePaper(true)
    animateViewportCompensation(prependColumns * PAGE_WIDTH, prependRows * PAGE_HEIGHT)
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
    fontSize: state.fontSize,
    lineHeight: 1.45,
    padding: 8,
    cornerColor: '#1c70a8',
    cornerStyle: 'circle',
    transparentCorners: false,
  })
  text.on('editing:exited', () => {
    if (!text.text.trim() && canvas.getObjects().includes(text)) {
      canvas.remove(text)
      canvas.discardActiveObject()
      reconcilePages()
      recordHistory()
    }
  })
  canvas.add(text)
  canvas.setActiveObject(text)
  if (beginEditing) {
    text.enterEditing()
    text.setSelectionStart(0)
    text.setSelectionEnd(0)
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
  return fragment
}

function splitStrokeAt(path, point) {
  const points = getPathScenePoints(path)
  const strokeScale = (Math.abs(path.scaleX || 1) + Math.abs(path.scaleY || 1)) / 2
  const radius = ERASER_RADIUS / state.displayScale + (path.strokeWidth || 1) * strokeScale / 2
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
      const radius = Math.max(object.getScaledWidth(), object.getScaledHeight()) / 2 + ERASER_RADIUS / state.displayScale
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
  const steps = Math.max(1, Math.ceil(distanceBetween(start, end) / (ERASER_RADIUS * 0.45 / state.displayScale)))
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
  canvas.add(dot)
  canvas.requestRenderAll()
  return dot
}

function setTool(tool) {
  state.tool = tool
  document.querySelectorAll('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool))
  canvas.isDrawingMode = tool === 'pen' || tool === 'highlight'
  canvas.selection = tool === 'select'
  canvas.defaultCursor = tool === 'text' ? 'text' : tool === 'eraser' ? 'none' : 'default'
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
  canvas.discardActiveObject()
  canvas.requestRenderAll()
}

let saveTimer
async function saveActiveNote() {
  if (!state.activeNoteId || state.loading) return
  setSaveState('Saving')
  try {
    const title = elements.title.value.trim() || 'Untitled note'
    await api(`/notes/${state.activeNoteId}`, {
      method: 'PUT',
      body: JSON.stringify({
        title,
        content: canvas.toJSON(),
        pageState: state.pages,
        notebookId: state.notes.find((item) => item.id === state.activeNoteId)?.notebookId,
      }),
    })
    const note = state.notes.find((item) => item.id === state.activeNoteId)
    if (note) note.title = title
    renderNoteList()
    setSaveState('Saved')
    queueAmbientCheck()
  } catch (error) {
    console.error(error)
    setSaveState('Could not save', true)
  }
}

function queueSave() {
  if (state.loading) return
  cancelAmbientWork()
  queueCalendarCheck()
  queueEntityCheck()
  setSaveState('Saving')
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveActiveNote, 650)
}

let historyTimer
function snapshot() {
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
  if (state.loading || index < 0 || index >= state.history.length) return
  state.loading = true
  state.historyIndex = index
  const entry = JSON.parse(state.history[index])
  state.pages = entry.pages
  resizePaper(true)
  await canvas.loadFromJSON(entry.content)
  setTool('text')
  state.loading = false
  canvas.requestRenderAll()
  queueSave()
}

async function selectNote(id) {
  if (id === state.activeNoteId) return
  clearTimeout(saveTimer)
  cancelAmbientWork()
  clearTimeout(entityPrefetchTimer)
  clearTimeout(entityPresentTimer)
  entityRequest?.abort()
  entityRequest = null
  entityCandidate = null
  entitySequence += 1
  state.entitySuggestion = null
  clearEntityPeek()
  clearTimeout(calendarPresentTimer)
  state.calendarDraft = null
  clearCalendarDraft()
  state.relatedSuggestion = null
  clearRelatedNote()
  state.activeNoteId = id
  renderNoteList()
  state.loading = true
  let normalizedNote = false
  try {
    const note = await api(`/notes/${id}`)
    const summary = state.notes.find((item) => item.id === id)
    if (summary) summary.notebookId = note.notebookId
    state.selectedNotebookId = note.notebookId
    elements.title.value = note.title
    state.pages = note.pageState || { columns: 1, rows: 1 }
    resizePaper()
    await canvas.loadFromJSON(note.content || { objects: [] })
    normalizedNote = normalizeNotebookFonts()
    normalizedNote = reconcilePages(true) || normalizedNote
    state.history = [snapshot()]
    state.historyIndex = 0
    setTool('text')
    setSaveState('Saved')
    renderNoteList()
    requestAnimationFrame(() => {
      elements.workspace.scrollTo({
        left: Math.max(0, (elements.paper.offsetWidth - elements.workspace.clientWidth) / 2),
        top: 38,
      })
    })
  } catch (error) {
    console.error(error)
    setSaveState('Could not load', true)
  } finally {
    state.loading = false
    if (normalizedNote) queueSave()
  }
}

async function createNote(notebookId) {
  if (state.creatingNote) return
  state.creatingNote = true
  const activeNote = state.notes.find((note) => note.id === state.activeNoteId)
  const destinationId = Number(notebookId) || state.selectedNotebookId || activeNote?.notebookId || state.notebooks[0]?.id
  try {
    const note = await api('/notes', {
      method: 'POST',
      body: JSON.stringify({ title: 'Untitled note', notebookId: destinationId }),
    })
    state.notes.unshift(note)
    state.selectedNotebookId = note.notebookId
    state.activeNoteId = null
    await selectNote(note.id)
    setSidebarOpen(false)
    addText({ x: 72, y: 72 })
  } finally {
    state.creatingNote = false
  }
}

async function moveNote(noteId, notebookId) {
  const note = state.notes.find((item) => item.id === noteId)
  if (!note || note.notebookId === notebookId) return
  await api(`/notes/${noteId}/notebook`, {
    method: 'PATCH',
    body: JSON.stringify({ notebookId }),
  })
  note.notebookId = notebookId
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
    const updated = await api(`/notebooks/${id}`, { method: 'PUT', body: JSON.stringify({ name, color }) })
    Object.assign(state.notebooks.find((notebook) => notebook.id === id), updated)
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
  state.notes.forEach((note) => {
    if (note.notebookId === id) note.notebookId = result.destinationNotebookId
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
  const providerNames = {
    'azure-openai': 'Azure OpenAI',
    'openai-compatible': 'OpenAI compatible',
    'local-retrieval': 'Local retrieval',
  }
  const intelligence = capabilities.intelligence || {}
  const authentication = capabilities.authentication || {}
  const storage = capabilities.storage || {}
  document.querySelector('#settings-intelligence-provider').textContent = providerNames[intelligence.provider] || 'Unavailable'
  document.querySelector('#settings-intelligence-key').textContent = intelligence.provider === 'local-retrieval'
    ? 'Not required'
    : intelligence.credentialsConfigured ? 'Configured' : 'Needs setup'
  document.querySelector('#settings-auth-mode').textContent = authentication.enabled
    ? authentication.configured ? 'Google OAuth' : 'Needs setup'
    : 'Off in development'
  document.querySelector('#settings-storage').textContent = storage.engine === 'sqlite' ? 'SQLite · This device' : 'Unavailable'
  document.querySelector('#settings-encryption').textContent = storage.encryption === 'not-enabled' ? 'Not enabled' : 'Enabled'
}

async function loadCapabilitySettings() {
  try {
    updateCapabilitySettings(await api('/settings/capabilities'))
  } catch {
    document.querySelector('#settings-intelligence-provider').textContent = 'Unavailable'
    document.querySelector('#settings-intelligence-key').textContent = 'Unavailable'
    document.querySelector('#settings-auth-mode').textContent = 'Unavailable'
    document.querySelector('#settings-encryption').textContent = 'Unavailable'
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

function applyTypography(property, value) {
  const text = selectedTextObject()
  state[property] = value
  if (text) {
    text.set(property, value)
    text.setCoords()
    canvas.requestRenderAll()
    recordHistory()
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
  elements.paper.classList.toggle('voice-listening', listening)
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

function insertVoiceTranscript(transcript) {
  if (!transcript) return
  if (!state.voiceTarget || !canvas.getObjects().includes(state.voiceTarget)) {
    state.voiceTarget = addText(voiceInsertPoint(), transcript, false)
    setTool('select')
  } else {
    const separator = state.voiceTarget.text.trim() ? ' ' : ''
    state.voiceTarget.set('text', `${state.voiceTarget.text}${separator}${transcript}`)
    state.voiceTarget.setCoords()
    canvas.requestRenderAll()
  }
  reconcilePages()
  recordHistory()
}

function showVoiceNotice(message) {
  elements.voiceCaption.hidden = false
  elements.voiceStatus.textContent = message
  clearTimeout(showVoiceNotice.timer)
  showVoiceNotice.timer = setTimeout(() => {
    if (!state.listening) elements.voiceCaption.hidden = true
  }, 2600)
}

function setupVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SpeechRecognition) {
    elements.voiceButton.addEventListener('click', () => showVoiceNotice('Voice input is unavailable in this browser'))
    return
  }

  const recognition = new SpeechRecognition()
  recognition.continuous = true
  recognition.interimResults = true
  recognition.lang = navigator.language || 'en-US'
  state.recognition = recognition

  recognition.onstart = () => setVoiceListening(true)
  recognition.onresult = (event) => {
    let interim = ''
    let finalText = ''
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0].transcript.trim()
      if (event.results[index].isFinal) finalText += `${transcript} `
      else interim += `${transcript} `
    }
    elements.voiceStatus.textContent = interim.trim() || finalText.trim() || 'Listening'
    if (finalText.trim()) insertVoiceTranscript(finalText.trim())
  }
  recognition.onerror = (event) => {
    state.voiceError = event.error === 'not-allowed' ? 'Microphone permission is required' : 'Voice input stopped'
  }
  recognition.onend = () => {
    setVoiceListening(false)
    if (state.voiceError) {
      showVoiceNotice(state.voiceError)
      state.voiceError = null
    }
  }

  elements.voiceButton.addEventListener('click', () => {
    if (state.listening) {
      recognition.stop()
      return
    }
    state.voiceTarget = selectedTextObject()
    try {
      recognition.start()
    } catch {
      recognition.stop()
    }
  })
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
          <span class="search-result-icon" style="--notebook-color:${result.notebookColor}"><i data-lucide="file-text"></i></span>
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
  requestAnimationFrame(() => {
    elements.searchBackdrop.classList.add('open')
    elements.searchInput.focus()
    elements.searchInput.select()
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

function clearActiveNote() {
  if (!state.activeNoteId || !canvas.getObjects().length) return elements.clearNoteDialog.close()
  clearTimeout(historyTimer)
  canvas.discardActiveObject()
  canvas.clear()
  state.pages = { columns: 1, rows: 1 }
  resizePaper(true)
  setTool('text')
  clearRelatedNote()
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

canvas.on('before:path:created', ({ path }) => {
  const points = canvas.freeDrawingBrush?._points || []
  path.inkPoints = points.map(({ x, y }) => ({ x, y }))
  path.isInk = true
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

;['object:modified', 'path:created', 'text:changed'].forEach((eventName) => {
  canvas.on(eventName, () => {
    elements.paper.classList.remove('is-dragging')
    elements.workspace.classList.remove('is-object-dragging')
    reconcilePages()
    recordHistory()
  })
})
;['object:moving', 'object:scaling', 'object:rotating'].forEach((eventName) => {
  canvas.on(eventName, expandPagesDuringTransform)
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

document.querySelector('#new-note').addEventListener('click', () => createNote())
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
document.querySelector('#undo').addEventListener('click', () => restoreHistory(state.historyIndex - 1))
document.querySelector('#redo').addEventListener('click', () => restoreHistory(state.historyIndex + 1))
function setSidebarOpen(open) {
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
document.querySelector('#rail-new-note').addEventListener('click', () => createNote())
document.querySelector('#search-button').addEventListener('click', openSearch)
document.querySelector('#rail-print').addEventListener('click', () => openPrintPreview())
document.querySelector('#rail-settings').addEventListener('click', () => setSettingsOpen(!elements.settings.classList.contains('open')))
document.querySelector('#top-properties').addEventListener('click', () => setPropertiesOpen(!elements.properties.classList.contains('open')))
document.querySelector('#close-properties').addEventListener('click', () => setPropertiesOpen(false))
document.querySelector('#close-settings').addEventListener('click', () => setSettingsOpen(false))
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
elements.title.addEventListener('input', queueSave)
elements.intelligencePresence.addEventListener('click', () => {
  if (state.relatedSuggestion) showRelatedNote(state.relatedSuggestion)
})
document.querySelector('#dismiss-intelligence').addEventListener('click', () => {
  const suggestion = state.relatedSuggestion
  if (suggestion) state.dismissedRelated.add(`${state.activeNoteId}:${suggestion.noteId}`)
  publishAmbientTelemetry('dismissed', ambientTelemetry.interaction('dismiss'))
  state.relatedSuggestion = null
  clearRelatedNote()
})
document.querySelector('#open-intelligence-source').addEventListener('click', () => {
  const sourceId = state.relatedSuggestion?.noteId
  publishAmbientTelemetry('opened', ambientTelemetry.interaction('open'))
  state.relatedSuggestion = null
  clearRelatedNote()
  if (sourceId) selectNote(sourceId)
})
elements.entityPresence.addEventListener('click', () => {
  if (state.entitySuggestion) showEntityPeek(state.entitySuggestion)
})
document.querySelector('#dismiss-entity').addEventListener('click', () => {
  const suggestion = state.entitySuggestion
  if (suggestion) {
    state.dismissedEntities.add(`${state.activeNoteId}:${suggestion.name.toLocaleLowerCase()}:${suggestion.source.noteId}`)
  }
  state.entitySuggestion = null
  clearEntityPeek()
})
document.querySelector('#open-entity-source').addEventListener('click', () => {
  const sourceId = state.entitySuggestion?.source.noteId
  state.entitySuggestion = null
  clearEntityPeek()
  if (sourceId) selectNote(sourceId)
})
elements.calendarPresence.addEventListener('click', () => {
  if (state.calendarDraft) showCalendarDraft(state.calendarDraft)
})
document.querySelector('#dismiss-calendar').addEventListener('click', () => {
  if (state.calendarDraft) state.dismissedCalendarDrafts.add(calendarDraftKey(state.calendarDraft))
  state.calendarDraft = null
  clearCalendarDraft()
})
document.querySelector('#download-calendar').addEventListener('click', () => {
  const draft = state.calendarDraft
  if (!draft) return
  const blob = new Blob([calendarDraftToIcs(draft)], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${draft.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'event'}.ics`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
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
  } else if (event.key === 'Escape' && activeText?.isEditing) {
    event.preventDefault()
    activeText.exitEditing()
    setTool('select')
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
    const shortcuts = { v: 'select', t: 'text', p: 'pen', d: 'pen', h: 'highlight', e: 'eraser' }
    if (shortcuts[event.key.toLowerCase()]) setTool(shortcuts[event.key.toLowerCase()])
  }
})

async function initialize() {
  resizePaper()
  syncDefaultTypographySettings()
  loadCapabilitySettings()
  try {
    ;[state.notebooks, state.notes] = await Promise.all([api('/notebooks'), api('/notes')])
    state.selectedNotebookId = state.notes[0]?.notebookId || state.notebooks[0]?.id || null
    if (!state.notes.length) await createNote()
    else await selectNote(state.notes[0].id)
  } catch (error) {
    console.error(error)
    setSaveState('Database offline', true)
  }
}

document.fonts.ready.then(() => canvas.requestRenderAll())
window.addEventListener('resize', () => resizePaper())
setupVoiceInput()
setupToolOptionGestures()
setupToolDockMagnification()
initialize()
