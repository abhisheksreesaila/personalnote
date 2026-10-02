// A dragged object "lifts": it is drawn with a slight tilt and a deeper shadow. This is purely a paint-time effect; the object's saved
// angle and position never change and nothing is added to the document (canvas-leafer/scene.js draws it).

export const LIFT_TILT_DEGREES = 2
export const LIFT_SHADOW = { blur: 26, offsetY: 14, alpha: 0.3 }
