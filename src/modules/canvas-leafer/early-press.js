// F-098: a press on the page (to place words, a sticky or a shape) that comes before the canvas engine is held here and placed once the note it was
// made on is drawn. It belongs to one note pick (the shell's select sequence): a press made before any pick takes the first one; a different pick
// (another note chosen while the first loads, or any later one) drops it, so it can never land in a note the person did not press on.
export function createEarlyPress() {
  let held = null
  return {
    // `press`: { x, y, tool, now? } in window pixels; `sequence`: the pick being loaded now (0 when none has begun).
    hold(press, sequence) { held = { ...press, sequence: sequence || null } },
    // A note pick begins: the press is for the first pick it sees, and for no other.
    pick(sequence) {
      if (!held) return
      if (held.sequence === null) held.sequence = sequence
      else if (held.sequence !== sequence) held = null
    },
    // The note of `sequence` is drawn: the press if it is that note's, once.
    take(sequence) {
      const press = held
      held = null
      return press && press.sequence === sequence ? press : null
    },
    isHeld: () => held !== null,
  }
}
