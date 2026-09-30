// A dragged object "lifts": it is drawn with a slight tilt and a deeper shadow. This is purely a
// paint-time effect. The object's own render is wrapped for the duration of the drag, so its
// saved angle, position and JSON never change and nothing is added to the document.

const TILT = (2 * Math.PI) / 180
const SHADOW_BLUR = 26
const SHADOW_OFFSET = 14
const SHADOW_ALPHA = 0.3

export function liftAmount(progress) {
  const t = Math.min(1, Math.max(0, progress))
  return t * t * (3 - 2 * t)
}

export function createLiftEffect({
  requestRender,
  reducedMotion = () => false,
  pixelRatio = () => globalThis.devicePixelRatio || 1,
  duration = 140,
  now = () => performance.now(),
  raf = (callback) => requestAnimationFrame(callback),
}) {
  let lifted = null
  let hadOwnRender = false
  let originalRender = null
  let progress = 0
  let direction = 0
  let lastFrame = 0
  let looping = false

  function restore() {
    if (!lifted) return
    if (hadOwnRender) lifted.render = originalRender
    else delete lifted.render
    lifted = null
    originalRender = null
    progress = 0
    direction = 0
    requestRender()
  }

  function frame() {
    looping = false
    if (!lifted) return
    const time = now()
    progress = Math.min(1, Math.max(0, progress + (direction * (time - lastFrame)) / duration))
    lastFrame = time
    requestRender()
    if (direction < 0 && progress <= 0) return restore()
    if ((direction > 0 && progress < 1) || direction < 0) schedule()
  }

  function schedule() {
    if (looping) return
    looping = true
    lastFrame = now()
    raf(frame)
  }

  function paint(object, ctx) {
    const amount = liftAmount(progress)
    const ratio = pixelRatio()
    ctx.save()
    const center = object.getCenterPoint()
    ctx.translate(center.x, center.y)
    ctx.rotate(TILT * amount)
    ctx.translate(-center.x, -center.y)
    ctx.shadowColor = `rgba(0, 0, 0, ${(SHADOW_ALPHA * amount).toFixed(3)})`
    ctx.shadowBlur = SHADOW_BLUR * amount * ratio
    ctx.shadowOffsetY = SHADOW_OFFSET * amount * ratio
    originalRender.call(object, ctx)
    ctx.restore()
  }

  return {
    begin(object) {
      if (lifted === object) {
        direction = 1
        if (reducedMotion()) progress = 1
        else if (progress < 1) schedule()
        return
      }
      restore()
      lifted = object
      hadOwnRender = Object.prototype.hasOwnProperty.call(object, 'render')
      originalRender = object.render
      object.render = function liftedRender(ctx) { paint(this, ctx) }
      direction = 1
      progress = reducedMotion() ? 1 : 0
      if (progress < 1) schedule()
      requestRender()
    },
    end() {
      if (!lifted) return
      if (reducedMotion()) return restore()
      direction = -1
      schedule()
    },
    active: () => lifted !== null,
  }
}
