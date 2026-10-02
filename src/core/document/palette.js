// The five object colours of each skin (--sk-c1..5 in skins.css). Stickies and shapes store the raw colour of the skin they
// were made in; the key says which palette slot it was, so a later engine can re-tint by slot. The colours are all different,
// so a colour finds its slot without knowing the skin.
export const SKIN_PALETTES = Object.freeze({
  crayon: Object.freeze(['#ffd60a', '#30d158', '#64b5ff', '#bf5af2', '#ff6b3d']),
  paper: Object.freeze(['#ffd66b', '#9fe0c0', '#a9cfff', '#cdb8ff', '#ff9c85']),
  night: Object.freeze(['#ffc877', '#7ee7c8', '#9db4ff', '#d3a6ff', '#ff8fb1']),
})

const KEY_BY_COLOR = new Map(Object.values(SKIN_PALETTES).flatMap((colors) => colors.map((color, index) => [color, `c${index + 1}`])))

export function paletteKeyFor(color) {
  return typeof color === 'string' ? KEY_BY_COLOR.get(color.toLowerCase()) ?? null : null
}
