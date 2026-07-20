function distance(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y)
}

function strokeLength(points) {
  return points.slice(1).reduce((total, point, index) => total + distance(points[index], point), 0)
}

function boundsFor(points) {
  const xs = points.map(point => point.x)
  const ys = points.map(point => point.y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  const right = Math.max(...xs)
  const bottom = Math.max(...ys)
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

function rectangleError(points, bounds) {
  const scale = Math.max(1, Math.min(bounds.width, bounds.height))
  const total = points.reduce((sum, point) => sum + Math.min(
    Math.abs(point.x - bounds.left),
    Math.abs(point.x - bounds.right),
    Math.abs(point.y - bounds.top),
    Math.abs(point.y - bounds.bottom),
  ) / scale, 0)
  return total / points.length
}

function ellipseError(points, bounds) {
  const radiusX = bounds.width / 2
  const radiusY = bounds.height / 2
  const centerX = bounds.left + radiusX
  const centerY = bounds.top + radiusY
  const total = points.reduce((sum, point) => {
    const radial = Math.hypot((point.x - centerX) / radiusX, (point.y - centerY) / radiusY)
    return sum + Math.abs(radial - 1)
  }, 0)
  return total / points.length
}

function analyzeArrow(points, bounds) {
  const start = points[0]
  let tipIndex = 0
  let shaftDistance = 0
  points.forEach((point, index) => {
    const candidateDistance = distance(start, point)
    if (candidateDistance > shaftDistance) {
      shaftDistance = candidateDistance
      tipIndex = index
    }
  })
  if (tipIndex < 2 || tipIndex > points.length - 3 || shaftDistance < 36) return null
  const tip = points[tipIndex]
  const shaftPoints = points.slice(0, tipIndex + 1)
  const shaftLength = strokeLength(shaftPoints)
  if (shaftDistance / shaftLength < 0.82) return null

  const shaftX = tip.x - start.x
  const shaftY = tip.y - start.y
  const candidates = points.slice(tipIndex + 1).filter((point) => {
    const wingLength = distance(tip, point)
    if (wingLength < shaftDistance * 0.09 || wingLength > shaftDistance * 0.45) return false
    const wingX = point.x - tip.x
    const wingY = point.y - tip.y
    const pointsBackward = (shaftX * wingX + shaftY * wingY) / (shaftDistance * wingLength) < -0.45
    const hasAngle = Math.abs(shaftX * wingY - shaftY * wingX) / (shaftDistance * wingLength) > 0.18
    return pointsBackward && hasAngle
  })
  const leftWing = candidates.find(point => shaftX * (point.y - tip.y) - shaftY * (point.x - tip.x) < 0)
  const rightWing = candidates.find(point => shaftX * (point.y - tip.y) - shaftY * (point.x - tip.x) > 0)
  if (!leftWing || !rightWing) return null
  return {
    kind: 'arrow',
    confidence: Math.min(0.97, 0.72 + (shaftDistance / shaftLength - 0.82)),
    bounds,
    start,
    end: tip,
    wings: [leftWing, rightWing],
  }
}

export function analyzeDiagramStroke(points) {
  if (!Array.isArray(points) || points.length < 5) return null
  const bounds = boundsFor(points)
  const length = strokeLength(points)
  const diagonal = Math.hypot(bounds.width, bounds.height)
  if (length < 42 || diagonal < 28) return null

  const arrow = analyzeArrow(points, bounds)
  if (arrow) return arrow

  const endpointDistance = distance(points[0], points.at(-1))
  const straightness = endpointDistance / length
  const lineThickness = Math.min(bounds.width, bounds.height) / Math.max(bounds.width, bounds.height, 1)
  if (straightness > 0.9 && lineThickness < 0.18) {
    return {
      kind: 'connector',
      confidence: Math.min(0.98, straightness),
      bounds,
      start: points[0],
      end: points.at(-1),
    }
  }

  const closure = endpointDistance / diagonal
  if (closure > 0.24 || bounds.width < 34 || bounds.height < 34) return null
  const boxError = rectangleError(points, bounds)
  const ovalError = ellipseError(points, bounds)
  const kind = boxError + 0.035 < ovalError ? 'rounded-box' : 'ellipse'
  const error = Math.min(boxError, ovalError)
  if (error > 0.22) return null
  return {
    kind,
    confidence: Math.max(0.55, Math.min(0.97, 1 - error * 2 - closure * 0.35)),
    bounds,
  }
}

function roundedBoxPath(bounds) {
  const { left, top, right, bottom, width, height } = bounds
  const radius = Math.min(22, width * 0.13, height * 0.22)
  const sway = Math.min(3, Math.min(width, height) * 0.025)
  return [
    `M ${left + radius} ${top + sway}`,
    `C ${left + width * 0.38} ${top - sway} ${left + width * 0.68} ${top + sway} ${right - radius} ${top}`,
    `Q ${right + sway} ${top} ${right} ${top + radius}`,
    `C ${right - sway} ${top + height * 0.4} ${right + sway} ${top + height * 0.7} ${right} ${bottom - radius}`,
    `Q ${right} ${bottom + sway} ${right - radius} ${bottom}`,
    `C ${left + width * 0.66} ${bottom - sway} ${left + width * 0.34} ${bottom + sway} ${left + radius} ${bottom}`,
    `Q ${left - sway} ${bottom} ${left} ${bottom - radius}`,
    `C ${left + sway} ${top + height * 0.7} ${left - sway} ${top + height * 0.35} ${left} ${top + radius}`,
    `Q ${left} ${top} ${left + radius} ${top + sway} Z`,
  ].join(' ')
}

function ellipsePath(bounds) {
  const centerX = bounds.left + bounds.width / 2
  const centerY = bounds.top + bounds.height / 2
  const radiusX = bounds.width / 2
  const radiusY = bounds.height / 2
  const kappa = 0.5522848
  const sway = Math.min(2.5, Math.min(bounds.width, bounds.height) * 0.02)
  return [
    `M ${centerX} ${bounds.top + sway}`,
    `C ${centerX + radiusX * kappa} ${bounds.top - sway} ${bounds.right + sway} ${centerY - radiusY * kappa} ${bounds.right} ${centerY}`,
    `C ${bounds.right - sway} ${centerY + radiusY * kappa} ${centerX + radiusX * kappa} ${bounds.bottom + sway} ${centerX} ${bounds.bottom}`,
    `C ${centerX - radiusX * kappa} ${bounds.bottom - sway} ${bounds.left - sway} ${centerY + radiusY * kappa} ${bounds.left} ${centerY}`,
    `C ${bounds.left + sway} ${centerY - radiusY * kappa} ${centerX - radiusX * kappa} ${bounds.top + sway} ${centerX} ${bounds.top + sway} Z`,
  ].join(' ')
}

export function diagramGuidePath(suggestion) {
  if (suggestion.kind === 'rounded-box') return roundedBoxPath(suggestion.bounds)
  if (suggestion.kind === 'ellipse') return ellipsePath(suggestion.bounds)
  if (suggestion.kind === 'connector') {
    const midpointX = (suggestion.start.x + suggestion.end.x) / 2
    const midpointY = (suggestion.start.y + suggestion.end.y) / 2
    const bend = Math.min(2.5, distance(suggestion.start, suggestion.end) * 0.015)
    return `M ${suggestion.start.x} ${suggestion.start.y} Q ${midpointX} ${midpointY + bend} ${suggestion.end.x} ${suggestion.end.y}`
  }
  if (suggestion.kind === 'arrow') {
    const midpointX = (suggestion.start.x + suggestion.end.x) / 2
    const midpointY = (suggestion.start.y + suggestion.end.y) / 2
    const bend = Math.min(2.5, distance(suggestion.start, suggestion.end) * 0.015)
    const [leftWing, rightWing] = suggestion.wings
    return [
      `M ${suggestion.start.x} ${suggestion.start.y} Q ${midpointX} ${midpointY + bend} ${suggestion.end.x} ${suggestion.end.y}`,
      `M ${leftWing.x} ${leftWing.y} L ${suggestion.end.x} ${suggestion.end.y} L ${rightWing.x} ${rightWing.y}`,
    ].join(' ')
  }
  throw new Error(`Unsupported diagram guide: ${suggestion.kind}`)
}