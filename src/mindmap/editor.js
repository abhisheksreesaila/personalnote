import { BRANCH_COLORS, childrenOf, cleanLayout, descendantsOf, makeNode, nodeById, normalizeDocument } from './model.js'
import { MindMapRenderer } from './renderer.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const OPPOSITE_PORT = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' }

function template() {
  return `
    <div class="mindmap-editor">
      <section class="mindmap-stage" data-map-stage aria-label="Mind map canvas">
        <svg class="mindmap-canvas" data-map-canvas xmlns="http://www.w3.org/2000/svg" role="tree">
          <defs>
            <filter id="mindmap-node-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="5" stdDeviation="7" flood-color="#382f28" flood-opacity=".15"/></filter>
            <pattern id="mindmap-dot-pattern" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#66736f" opacity=".24"/></pattern>
          </defs>
          <g data-map-viewport>
            <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#mindmap-dot-pattern)"></rect>
            <g data-map-branches></g><g data-map-nodes></g>
          </g>
        </svg>
        <div class="mindmap-branch-chooser" data-map-branch-chooser role="group" aria-label="New branch style" hidden>
          <button data-map-branch-choice="branch" aria-label="Show as branch"><i data-lucide="git-branch"></i><span>Branch</span></button>
          <button data-map-branch-choice="box" aria-label="Show as box"><i data-lucide="square"></i><span>Box</span></button>
        </div>
        <div class="mindmap-hint">Drag an anchor to draw. Hold an idea to switch Box or Branch.</div>
        <div class="mindmap-zoom" aria-label="Zoom controls">
          <button data-map-action="zoom-out" title="Zoom out" aria-label="Zoom out"><i data-lucide="minus"></i></button>
          <button data-map-action="zoom-reset" class="mindmap-zoom-label">100%</button>
          <button data-map-action="zoom-in" title="Zoom in" aria-label="Zoom in"><i data-lucide="plus"></i></button>
        </div>
        <svg class="mindmap-minimap" data-map-minimap viewBox="0 0 220 130" aria-label="Map overview"></svg>
      </section>
      <input data-map-file type="file" accept="application/json" hidden>
      <input data-map-image type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      <div class="mindmap-toast" data-map-toast role="status"></div>
    </div>`
}

function inspectorTemplate() {
  return `
    <div class="mindmap-inspector" data-map-inspector aria-label="Branch inspector">
      <header><span>Selected branch</span><strong data-map-node-title>Central idea</strong></header>
      <section><label>Branch colour</label><div class="mindmap-swatches" data-map-swatches></div></section>
      <section><label>Presentation</label><div class="mindmap-segments"><button data-map-presentation="box">Box</button><button data-map-presentation="branch">On branch</button></div></section>
      <section><label>Typography</label><div class="mindmap-segments"><button data-map-font="hand">Handwritten</button><button data-map-font="clean">Clean</button></div><div class="mindmap-format"><button data-map-format="bold"><strong>B</strong></button><button data-map-format="italic"><em>I</em></button><input data-map-font-size type="range" min="14" max="36" value="22" aria-label="Font size"></div></section>
      <section><label>Branch shape <output data-map-curve-output>Organic</output></label><input data-map-curve type="range" min="0" max="100" value="78" aria-label="Branch curvature"></section>
      <section><label class="mindmap-toggle">Collapse descendants <input data-map-collapse type="checkbox"></label></section>
      <footer><button data-map-action="focus"><i data-lucide="focus"></i><span>Focus</span></button><button class="danger" data-map-action="delete"><i data-lucide="trash-2"></i><span>Delete</span></button></footer>
    </div>`
}

export function mountMindMap(root, { documentValue, onChange, createIcons, inspectorRoot = root, controlsRoot = root }) {
  root.innerHTML = template()
  inspectorRoot.innerHTML = inspectorTemplate()
  const controller = new AbortController()
  const { signal } = controller
  const eventRoots = [...new Set([root, inspectorRoot, controlsRoot])]
  const query = (selector) => eventRoots.map((eventRoot) => eventRoot.querySelector(selector)).find(Boolean)
  const queryAll = (selector) => eventRoots.flatMap((eventRoot) => [...eventRoot.querySelectorAll(selector)])
  const svg = query('[data-map-canvas]')
  const stage = query('[data-map-stage]')
  const renderer = new MindMapRenderer(svg)
  let mindmap = normalizeDocument(structuredClone(documentValue))
  let selectedId = mindmap.rootId
  let focusId = null
  let history = []
  let future = []
  let gesture = null
  const touchPointers = new Map()
  let pinchGesture = null
  let spacePressed = false
  let changeTimer = null
  let lastNodePress = null
  let pendingBranchId = null

  const selectedNode = () => nodeById(mindmap, selectedId)
  const snapshot = () => JSON.stringify(mindmap)
  const updateHistoryButtons = () => {
    query('[data-map-action="undo"]').disabled = !history.length
    query('[data-map-action="redo"]').disabled = !future.length
  }
  const checkpoint = () => {
    history.push(snapshot())
    if (history.length > 80) history.shift()
    future = []
    updateHistoryButtons()
  }
  const scheduleChange = () => {
    clearTimeout(changeTimer)
    changeTimer = setTimeout(() => {
      mindmap.updatedAt = new Date().toISOString()
      onChange(structuredClone(mindmap))
    }, 180)
  }
  const mutate = (action) => {
    checkpoint()
    action()
    render()
    scheduleChange()
  }
  const restore = (value) => {
    hideBranchChooser()
    mindmap = normalizeDocument(JSON.parse(value))
    if (!nodeById(mindmap, selectedId)) selectedId = mindmap.rootId
    render()
    scheduleChange()
  }
  const undo = () => {
    if (!history.length) return
    future.push(snapshot())
    restore(history.pop())
    updateHistoryButtons()
  }
  const redo = () => {
    if (!future.length) return
    history.push(snapshot())
    restore(future.pop())
    updateHistoryButtons()
  }

  function toast(message) {
    const element = query('[data-map-toast]')
    element.textContent = message
    element.classList.add('visible')
    setTimeout(() => element.classList.remove('visible'), 1800)
  }

  function updateInspector() {
    const node = selectedNode()
    query('[data-map-inspector]').classList.toggle('empty', !node)
    if (!node) return
    query('[data-map-node-title]').textContent = node.text
    queryAll('[data-map-color]').forEach((button) => button.classList.toggle('active', button.dataset.mapColor === node.color))
    const presentation = node.parentId === null ? 'box' : node.presentation
    queryAll('[data-map-presentation]').forEach((button) => {
      button.classList.toggle('active', button.dataset.mapPresentation === presentation)
      button.disabled = node.parentId === null
    })
    queryAll('[data-map-font]').forEach((button) => button.classList.toggle('active', button.dataset.mapFont === node.font))
    queryAll('[data-map-format]').forEach((button) => button.classList.toggle('active', Boolean(node[button.dataset.mapFormat])))
    query('[data-map-font-size]').value = node.fontSize
    query('[data-map-curve]').value = node.curve ?? 78
    query('[data-map-curve-output]').textContent = (node.curve ?? 78) > 55 ? 'Organic' : 'Direct'
    query('[data-map-collapse]').checked = Boolean(node.collapsed)
    query('[data-map-collapse]').disabled = !childrenOf(mindmap, node.id).length
    query('[data-map-action="delete"]').disabled = node.parentId === null
  }

  function updateMinimap() {
    const minimap = query('[data-map-minimap]')
    minimap.replaceChildren()
    const box = renderer.bounds()
    const scale = Math.min(200 / Math.max(1, box.maxX - box.minX), 110 / Math.max(1, box.maxY - box.minY))
    const offsetX = 110 - (box.minX + box.maxX) / 2 * scale
    const offsetY = 65 - (box.minY + box.maxY) / 2 * scale
    mindmap.nodes.forEach((node) => {
      const circle = document.createElementNS(SVG_NS, 'circle')
      circle.setAttribute('cx', node.x * scale + offsetX)
      circle.setAttribute('cy', node.y * scale + offsetY)
      circle.setAttribute('r', node.id === mindmap.rootId ? 4 : 2)
      circle.setAttribute('fill', node.color)
      minimap.append(circle)
    })
    const canvasRect = svg.getBoundingClientRect()
    const view = document.createElementNS(SVG_NS, 'rect')
    view.setAttribute('class', 'mindmap-minimap-view')
    view.setAttribute('x', (-renderer.transform.x / renderer.transform.scale) * scale + offsetX)
    view.setAttribute('y', (-renderer.transform.y / renderer.transform.scale) * scale + offsetY)
    view.setAttribute('width', canvasRect.width / renderer.transform.scale * scale)
    view.setAttribute('height', canvasRect.height / renderer.transform.scale * scale)
    minimap.append(view)
  }

  function render() {
    renderer.render(mindmap, selectedId, focusId)
    updateInspector()
    updateMinimap()
    query('.mindmap-zoom-label').textContent = `${Math.round(renderer.transform.scale * 100)}%`
    svg.setAttribute('aria-label', `${mindmap.title} mind map`)
  }

  function hideBranchChooser() {
    const chooser = query('[data-map-branch-chooser]')
    chooser.hidden = true
    chooser.querySelectorAll('[data-map-branch-choice]').forEach((button) => button.classList.remove('active'))
    pendingBranchId = null
  }

  function branchChoiceAt(clientX, clientY) {
    return queryAll('[data-map-branch-choice]').find((button) => {
      const rect = button.getBoundingClientRect()
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    })?.dataset.mapBranchChoice || null
  }

  function previewBranchChoice(id, choice) {
    if (!choice) return
    const node = nodeById(mindmap, id)
    if (!node) return
    node.presentation = choice
    queryAll('[data-map-branch-choice]').forEach((button) => button.classList.toggle('active', button.dataset.mapBranchChoice === choice))
    renderer.render(mindmap, selectedId, focusId)
  }

  function showBranchChooser(branchGesture) {
    if (gesture !== branchGesture) return
    const chooser = query('[data-map-branch-chooser]')
    const stageRect = stage.getBoundingClientRect()
    const node = nodeById(mindmap, branchGesture.id)
    chooser.hidden = false
    chooser.style.left = `${Math.min(stageRect.width - 88, Math.max(88, branchGesture.holdX - stageRect.left))}px`
    chooser.style.top = `${Math.min(stageRect.height - 12, Math.max(104, branchGesture.holdY - stageRect.top))}px`
    chooser.querySelectorAll('[data-map-branch-choice]').forEach((button) => {
      const selected = button.dataset.mapBranchChoice === node?.presentation
      button.classList.toggle('active', selected)
      button.setAttribute('aria-pressed', String(selected))
    })
    branchGesture.chooserShown = true
  }

  function scheduleBranchChooser(branchGesture, clientX, clientY) {
    clearTimeout(branchGesture.holdTimer)
    branchGesture.holdX = clientX
    branchGesture.holdY = clientY
    branchGesture.holdTimer = setTimeout(() => showBranchChooser(branchGesture), 480)
  }

  function chooseBranchPresentation(id, choice) {
    const node = nodeById(mindmap, id)
    if (!node || !['box', 'branch'].includes(choice)) return
    node.presentation = choice
    selectedId = id
    hideBranchChooser()
    render()
    scheduleChange()
    setTimeout(() => editNode(id), 0)
  }

  function setZoom(nextScale, anchor = null) {
    const rect = svg.getBoundingClientRect()
    const old = renderer.transform
    const scale = Math.min(2.2, Math.max(0.25, nextScale))
    const point = anchor || { x: rect.width / 2, y: rect.height / 2 }
    const worldX = (point.x - old.x) / old.scale
    const worldY = (point.y - old.y) / old.scale
    renderer.setTransform({ scale, x: point.x - worldX * scale, y: point.y - worldY * scale })
    render()
  }

  function fitMap(animate = false) {
    renderer.fit(window.matchMedia('(max-width: 800px)').matches ? 30 : 80, animate)
    render()
  }

  function focusActiveMobileBranch(id) {
    if (!window.matchMedia('(max-width: 800px)').matches || id === mindmap.rootId) return false
    focusId = id
    render()
    fitMap(true)
    return true
  }

  function editNode(id) {
    const node = nodeById(mindmap, id)
    if (!node || query('.mindmap-node-editor')) return
    const nodeElement = svg.querySelector(`g.map-node[data-node-id="${CSS.escape(id)}"]`)
    const editTarget = nodeElement?.querySelector('.map-idea-card, .map-root-card, .map-node-label, .map-root-label')
    if (!editTarget) return
    const targetRect = editTarget.getBoundingClientRect()
    const stageRect = stage.getBoundingClientRect()
    const input = document.createElement('input')
    input.className = 'mindmap-node-editor'
    input.value = node.text
    Object.assign(input.style, {
      left: `${targetRect.left - stageRect.left}px`,
      top: `${targetRect.top - stageRect.top}px`,
      width: `${Math.max(100, targetRect.width)}px`,
      height: `${Math.max(38, targetRect.height)}px`,
      borderColor: node.color,
      fontFamily: node.font === 'clean' ? '"IBM Plex Sans", sans-serif' : '"Source Serif 4", serif',
      fontSize: `${node.fontSize * renderer.transform.scale}px`,
      fontWeight: node.bold ? '700' : '500',
      fontStyle: node.italic ? 'italic' : 'normal',
    })
    nodeElement.classList.add('editing')
    stage.append(input)
    input.focus()
    input.select()
    let done = false
    const finish = (commit) => {
      if (done) return
      done = true
      const text = input.value.trim()
      input.remove()
      if (commit && text && text !== node.text) mutate(() => { node.text = text })
      else render()
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') finish(true)
      if (event.key === 'Escape') finish(false)
    }, { signal })
    input.addEventListener('blur', () => finish(true), { once: true, signal })
  }

  function addNode(sibling = false, sourceId = selectedId) {
    const source = nodeById(mindmap, sourceId)
    const node = source && makeNode(mindmap, source, sibling)
    if (!node) return
    mutate(() => {
      mindmap.nodes.push(node)
      selectedId = node.id
    })
    focusActiveMobileBranch(node.id)
    setTimeout(() => editNode(node.id), 0)
  }

  function deleteSelected() {
    const node = selectedNode()
    if (!node?.parentId) return
    const next = node.parentId
    mutate(() => {
      const removing = new Set([node.id, ...descendantsOf(mindmap, node.id).map((item) => item.id)])
      mindmap.nodes = mindmap.nodes.filter((item) => !removing.has(item.id))
      selectedId = next
    })
  }

  function download(content, type, extension) {
    const blob = content instanceof Blob ? content : new Blob([content], { type })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${mindmap.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.${extension}`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }

  function exportPng() {
    const clone = svg.cloneNode(true)
    const box = renderer.bounds()
    const padding = 70
    clone.setAttribute('width', box.maxX - box.minX + padding * 2)
    clone.setAttribute('height', box.maxY - box.minY + padding * 2)
    clone.setAttribute('viewBox', `${box.minX - padding} ${box.minY - padding} ${box.maxX - box.minX + padding * 2} ${box.maxY - box.minY + padding * 2}`)
    clone.querySelector('[data-map-viewport]').removeAttribute('transform')
    clone.querySelectorAll('.map-node-selection,.map-branch-hit,.map-add-handle,.map-branch-controls').forEach((element) => element.remove())
    const source = new XMLSerializer().serializeToString(clone)
    const image = new Image()
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }))
    image.onload = () => {
      const output = document.createElement('canvas')
      output.width = image.naturalWidth * 2
      output.height = image.naturalHeight * 2
      const context = output.getContext('2d')
      context.scale(2, 2)
      context.fillStyle = '#f8f6ef'
      context.fillRect(0, 0, image.naturalWidth, image.naturalHeight)
      context.drawImage(image, 0, 0)
      output.toBlob((blob) => download(blob, 'image/png', 'png'), 'image/png')
      URL.revokeObjectURL(url)
    }
    image.src = url
  }

  BRANCH_COLORS.forEach((color) => {
    const button = document.createElement('button')
    button.dataset.mapColor = color
    button.style.setProperty('--map-swatch', color)
    button.setAttribute('aria-label', color)
    button.addEventListener('click', () => mutate(() => {
      const node = selectedNode()
      node.color = color
      descendantsOf(mindmap, node.id).forEach((child) => { child.color = color })
    }), { signal })
    query('[data-map-swatches]').append(button)
  })

  function runAction(action) {
    if (action === 'undo') undo()
    else if (action === 'redo') redo()
    else if (action === 'clean') { mutate(() => cleanLayout(mindmap)); fitMap(); toast('Branches cleaned up') }
    else if (action === 'fit' || action === 'zoom-reset') { focusId = null; fitMap() }
    else if (action === 'zoom-in') setZoom(renderer.transform.scale * 1.15)
    else if (action === 'zoom-out') setZoom(renderer.transform.scale / 1.15)
    else if (action === 'delete') deleteSelected()
    else if (action === 'focus') { focusId = focusId === selectedId ? null : selectedId; fitMap(window.matchMedia('(max-width: 800px)').matches) }
    else if (action === 'image') query('[data-map-image]').click()
    else if (action === 'import') query('[data-map-file]').click()
    else if (action === 'export-json') download(JSON.stringify(mindmap, null, 2), 'application/json', 'json')
    else if (action === 'export-png') exportPng()
  }

  eventRoots.forEach((eventRoot) => eventRoot.addEventListener('click', (event) => {
    const branchChoice = event.target.closest('[data-map-branch-choice]')
    const presentation = event.target.closest('[data-map-presentation]')
    const font = event.target.closest('[data-map-font]')
    const format = event.target.closest('[data-map-format]')
    const action = event.target.closest('[data-map-action]')?.dataset.mapAction
    if (branchChoice && pendingBranchId) chooseBranchPresentation(pendingBranchId, branchChoice.dataset.mapBranchChoice)
    else if (presentation && selectedNode()?.parentId) mutate(() => { selectedNode().presentation = presentation.dataset.mapPresentation })
    else if (font && selectedNode()) mutate(() => { selectedNode().font = font.dataset.mapFont })
    else if (format && selectedNode()) mutate(() => { selectedNode()[format.dataset.mapFormat] = !selectedNode()[format.dataset.mapFormat] })
    else if (action) runAction(action)
  }, { signal }))

  query('[data-map-font-size]').addEventListener('change', (event) => mutate(() => { selectedNode().fontSize = Number(event.target.value) }), { signal })
  query('[data-map-curve]').addEventListener('change', (event) => mutate(() => {
    selectedNode().curve = Number(event.target.value)
    selectedNode().branchAnchors = null
  }), { signal })
  query('[data-map-collapse]').addEventListener('change', (event) => mutate(() => { selectedNode().collapsed = event.target.checked }), { signal })
  query('[data-map-image]').addEventListener('change', (event) => {
    const file = event.target.files[0]
    if (!file?.type.startsWith('image/')) return
    if (file.size > 2_500_000) return toast('Choose an image under 2.5 MB')
    const reader = new FileReader()
    reader.onload = () => mutate(() => { selectedNode().image = reader.result })
    reader.readAsDataURL(file)
    event.target.value = ''
  }, { signal })
  query('[data-map-file]').addEventListener('change', (event) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        checkpoint()
        mindmap = normalizeDocument(JSON.parse(reader.result))
        selectedId = mindmap.rootId
        focusId = null
        fitMap()
        scheduleChange()
        toast('Mind map imported')
      } catch (error) {
        toast(error.message)
      }
    }
    reader.readAsText(event.target.files[0])
    event.target.value = ''
  }, { signal })

  function beginPinch() {
    const [first, second] = [...touchPointers.values()]
    if (!first || !second) return
    const abandonedGesture = gesture
    clearTimeout(abandonedGesture?.holdTimer)
    if (abandonedGesture?.type === 'branch') {
      mindmap.nodes = mindmap.nodes.filter((node) => node.id !== abandonedGesture.id)
      selectedId = abandonedGesture.sourceId
    }
    if (abandonedGesture && abandonedGesture.type !== 'pan') history.pop()
    hideBranchChooser()
    gesture = null
    updateHistoryButtons()
    const centerX = (first.x + second.x) / 2
    const centerY = (first.y + second.y) / 2
    const rect = svg.getBoundingClientRect()
    const center = { x: centerX - rect.left, y: centerY - rect.top }
    pinchGesture = {
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      center,
      transform: { ...renderer.transform },
    }
    svg.classList.add('dragging')
  }

  function updatePinch() {
    if (!pinchGesture || touchPointers.size < 2) return false
    const [first, second] = [...touchPointers.values()]
    const rect = svg.getBoundingClientRect()
    const center = {
      x: (first.x + second.x) / 2 - rect.left,
      y: (first.y + second.y) / 2 - rect.top,
    }
    const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y))
    const scale = Math.min(2.2, Math.max(0.25, pinchGesture.transform.scale * distance / Math.max(1, pinchGesture.distance)))
    const worldX = (pinchGesture.center.x - pinchGesture.transform.x) / pinchGesture.transform.scale
    const worldY = (pinchGesture.center.y - pinchGesture.transform.y) / pinchGesture.transform.scale
    renderer.setTransform({ scale, x: center.x - worldX * scale, y: center.y - worldY * scale })
    updateMinimap()
    return true
  }

  svg.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch') {
      touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touchPointers.size === 2) {
        beginPinch()
        svg.setPointerCapture(event.pointerId)
        event.preventDefault()
        return
      }
    }
    const addHandle = event.target.closest('[data-add-child-id]')
    const curveHandle = event.target.closest('[data-branch-anchor-id]')
    if (addHandle && !spacePressed) {
      const sourceId = addHandle.dataset.addChildId
      const sourcePort = addHandle.dataset.sourcePort || 'right'
      const node = makeNode(mindmap, nodeById(mindmap, sourceId), false)
      const point = renderer.screenToWorld(event.clientX, event.clientY)
      node.x = point.x
      node.y = point.y
      node.presentation = 'box'
      node.branchPorts = { source: sourcePort, target: OPPOSITE_PORT[sourcePort] }
      checkpoint()
      mindmap.nodes.push(node)
      selectedId = node.id
      gesture = { type: 'branch', id: node.id, sourceId, startX: event.clientX, startY: event.clientY, moved: false, chooserShown: false, holdTimer: null }
    } else if (curveHandle && !spacePressed) {
      const node = nodeById(mindmap, curveHandle.dataset.branchAnchorId)
      const index = Number(curveHandle.dataset.anchorIndex)
      checkpoint()
      if (!node.branchAnchors?.length) node.branchAnchors = renderer.branchAnchorFromWorld(node, renderer.screenToWorld(event.clientX, event.clientY), index).defaults
      gesture = { type: 'curve', id: node.id, index, moved: false }
    } else {
      const nodeElement = event.target.closest('[data-node-id]')
      const id = nodeElement?.dataset.nodeId
      if (id && !spacePressed) {
        selectedId = id
        const now = performance.now()
        if (lastNodePress?.id === id && now - lastNodePress.at < 420) {
          lastNodePress = null
          gesture = null
          document.addEventListener('pointerup', () => setTimeout(() => editNode(id), 0), { once: true, capture: true, signal })
          return
        }
        lastNodePress = { id, at: now }
        const node = nodeById(mindmap, id)
        const point = renderer.screenToWorld(event.clientX, event.clientY)
        checkpoint()
        gesture = { type: 'node', id, startX: event.clientX, startY: event.clientY, dx: node.x - point.x, dy: node.y - point.y, moved: false, chooserShown: false, holdTimer: null }
        if (node.parentId) {
          const nodeRect = nodeElement.getBoundingClientRect()
          scheduleBranchChooser(gesture, nodeRect.left + nodeRect.width / 2, nodeRect.top)
        }
      } else {
        gesture = { type: 'pan', startX: event.clientX, startY: event.clientY, origin: { ...renderer.transform }, moved: false }
        svg.classList.add('dragging')
      }
    }
    svg.setPointerCapture(event.pointerId)
    render()
  }, { signal })

  svg.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch' && touchPointers.has(event.pointerId)) {
      touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (updatePinch()) {
        event.preventDefault()
        return
      }
    }
    if (!gesture) return
    if (gesture.type === 'pan') {
      const dx = event.clientX - gesture.startX
      const dy = event.clientY - gesture.startY
      gesture.moved ||= Math.hypot(dx, dy) > 4
      renderer.setTransform({ ...gesture.origin, x: gesture.origin.x + dx, y: gesture.origin.y + dy })
      updateMinimap()
      return
    }
    if (gesture.type === 'node') {
      if (gesture.chooserShown) {
        previewBranchChoice(gesture.id, branchChoiceAt(event.clientX, event.clientY))
        return
      }
      const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY)
      if (!gesture.moved && distance <= 7) return
      clearTimeout(gesture.holdTimer)
      gesture.moved = true
      const node = nodeById(mindmap, gesture.id)
      const point = renderer.screenToWorld(event.clientX, event.clientY)
      node.x = point.x + gesture.dx
      node.y = point.y + gesture.dy
    } else if (gesture.type === 'branch') {
      if (gesture.chooserShown) {
        previewBranchChoice(gesture.id, branchChoiceAt(event.clientX, event.clientY))
        return
      }
      const node = nodeById(mindmap, gesture.id)
      const point = renderer.screenToWorld(event.clientX, event.clientY)
      node.x = point.x
      node.y = point.y
      const wasMoved = gesture.moved
      gesture.moved ||= Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 12
      if (!wasMoved && gesture.moved) scheduleBranchChooser(gesture, event.clientX, event.clientY)
      else if (gesture.moved && Math.hypot(event.clientX - gesture.holdX, event.clientY - gesture.holdY) > 8) {
        scheduleBranchChooser(gesture, event.clientX, event.clientY)
      }
    } else if (gesture.type === 'curve') {
      const node = nodeById(mindmap, gesture.id)
      node.branchAnchors[gesture.index] = renderer.branchAnchorFromWorld(node, renderer.screenToWorld(event.clientX, event.clientY), gesture.index).anchor
      gesture.moved = true
    }
    renderer.render(mindmap, selectedId, focusId)
  }, { signal })

  const finishGesture = (event, cancelled = false) => {
    const wasPinching = Boolean(pinchGesture)
    if (event.pointerType === 'touch') touchPointers.delete(event.pointerId)
    if (wasPinching) {
      if (touchPointers.size < 2) {
        pinchGesture = null
        svg.classList.remove('dragging')
      }
      return
    }
    if (!gesture) return
    const finished = gesture
    gesture = null
    clearTimeout(finished.holdTimer)
    svg.classList.remove('dragging')
    if (cancelled && finished.type === 'branch') {
      history.pop()
      mindmap.nodes = mindmap.nodes.filter((node) => node.id !== finished.id)
      selectedId = finished.sourceId
      hideBranchChooser()
      updateHistoryButtons()
      render()
      return
    }
    if ((finished.type === 'branch' || finished.type === 'node') && finished.chooserShown) {
      const choice = branchChoiceAt(event.clientX, event.clientY)
      if (choice) chooseBranchPresentation(finished.id, choice)
      else {
        pendingBranchId = finished.id
        render()
      }
      updateHistoryButtons()
      return
    }
    if (finished.type === 'pan') {
      if (!finished.moved) selectedId = null
    } else if (!finished.moved) {
      history.pop()
      if (finished.type === 'branch') {
        mindmap.nodes = mindmap.nodes.filter((node) => node.id !== finished.id)
        selectedId = finished.sourceId
      }
    } else scheduleChange()
    updateHistoryButtons()
    const focusedBranch = (finished.type === 'node' || (finished.moved && finished.type === 'branch'))
      && focusActiveMobileBranch(finished.id)
    if (!focusedBranch) render()
    if (finished.type === 'branch' && finished.moved) editNode(finished.id)
  }
  svg.addEventListener('pointerup', finishGesture, { signal })
  svg.addEventListener('pointercancel', (event) => finishGesture(event, true), { signal })
  svg.addEventListener('wheel', (event) => {
    event.preventDefault()
    const rect = svg.getBoundingClientRect()
    setZoom(renderer.transform.scale * (event.deltaY > 0 ? 0.9 : 1.1), { x: event.clientX - rect.left, y: event.clientY - rect.top })
  }, { passive: false, signal })

  document.addEventListener('keydown', (event) => {
    if (!root.isConnected || event.target.matches('input, textarea, select')) return
    if (event.code === 'Space') { spacePressed = true; event.preventDefault() }
    else if (event.key === 'Tab') { event.preventDefault(); addNode(false) }
    else if (event.key === 'Enter') { event.preventDefault(); addNode(true) }
    else if (event.key === 'F2') { event.preventDefault(); editNode(selectedId) }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected() }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
  }, { signal })
  document.addEventListener('keyup', (event) => { if (event.code === 'Space') spacePressed = false }, { signal })

  const resizeObserver = new ResizeObserver(() => {
    if (renderer.document) fitMap()
  })
  resizeObserver.observe(stage)
  createIcons()
  renderer.render(mindmap, selectedId)
  requestAnimationFrame(fitMap)

  return {
    getDocument: () => structuredClone(mindmap),
    setTitle: (title) => { mindmap.title = title || 'Untitled mind map' },
    runAction,
    undo,
    redo,
    destroy() {
      clearTimeout(changeTimer)
      controller.abort()
      resizeObserver.disconnect()
      root.replaceChildren()
      if (inspectorRoot !== root) inspectorRoot.replaceChildren()
    },
  }
}