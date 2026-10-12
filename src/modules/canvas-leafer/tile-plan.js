// How sharp each page's bitmap is made (hybrid mode, tiles.js): by how near the page is to the window and what the memory budget allows. Pure rules,
// tested without a browser.
//
// Tier 0 = the pages on screen: the device resolution (`full`, in bitmap pixels per page pixel) while they fit in 80% of the budget.
// Tier 1 = the pages next to them (what a pan shows next): what is left, up to tier 0's sharpness.
// Tier 2 = the rest of the note: what is left after that, never sharper than tier 1.
// `crisp` is true when the pages on screen can be made at CRISP of the device resolution or better: if not, the view is zoomed so far in that a bitmap of
// the page cannot be sharp inside the budget, and the vectors carry the view (few objects are on screen then, so they are cheap).
export const CRISP = 0.75
export const MIN_SCALE = 0.1

// `area`: bytes of one page's bitmap at scale 1 (its width x height x 4); `budget`: bytes for the whole note.
export function planScales({ full, strict, near, far, area, budget }) {
  const fit = (bytes, count) => (count > 0 ? Math.sqrt(Math.max(0, bytes) / (count * area)) : Infinity)
  const clamp = (value) => Math.max(MIN_SCALE, value)
  const s0 = clamp(Math.min(full, fit(budget * 0.8, strict)))
  let left = budget - strict * area * s0 * s0
  const s1 = clamp(Math.min(s0, fit(left * 0.75, near)))
  left -= near * area * s1 * s1
  const s2 = clamp(Math.min(s1, fit(left, far)))
  return { scales: [s0, s1, s2], crisp: s0 >= full * CRISP }
}
