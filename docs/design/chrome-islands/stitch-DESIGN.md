# Personal Note — design system (Paper skin)

A calm, local spatial notebook. Paper on a desk: the note is the hero, chrome floats quietly above it.

## Colour
- Desk (app background): #e9e4da with a faint dot grid rgba(60,45,20,.10)
- Panel / floating chrome surface: #fffdf8, 1px edge #e2dbcd
- Paper (the note page): #fbfaf5
- Ink: #1f1b16 · soft ink #4a443b · muted #6b6357 · hairline #e2dbcd
- Accent: #1f1b16 (ink-black pill) with text #fffdf8; accent soft #ece6da
- Danger #b93a27 · Secure (locked notes) #6a46c9 on #efe9fb
- Ink swatches for drawing: black #1f1b16, red #d64a3b, orange #e08a2e, green #3c7d55, blue #2f73b5
- Notebook dots: terracotta #b86b4b and other muted earth tones

## Type
- Display (note titles): Bricolage Grotesque 700, tight tracking -0.02em
- UI: Geist 13–14px, 500/600 for labels
- Mono for shortcuts (Ctrl K, Alt N): Geist Mono 11px in a hairline-bordered key cap
- Note body text: a book serif (Newsreader / Source Serif), 22px

## Shape
- Floating panels: radius 14px, soft shadow 0 1px 0 rgba(31,27,22,.04), 0 12px 32px -12px rgba(60,40,10,.22)
- Controls: radius 8px; icon buttons 36–44px square; touch targets at least 44px
- Pills fully rounded; the primary action is a solid ink pill
- Pages: radius 4px, flat paper with a very soft shadow

## Icons
Lucide line icons, 1.75px stroke, 18–20px. Never emoji.

## Layers and motion
- Two layers only: the desk and paper below, floating chrome islands above. Islands never touch the screen edge (12–16px inset).
- Laptop: motion is a short fade (120–180ms), no zoom, blur or springs.
- Phone: spring motion for sheets and the dock expanding.
