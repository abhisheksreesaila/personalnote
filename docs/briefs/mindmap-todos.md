# Mind map to-dos: icons and a pencil strike

Status: approved
<!-- 2026-10-30, captain: "I want to be able to [add a] small open source icon on the box or branches. I use it for TODOs and mark as complete,
and get a good feeling ... I need a strike through on the labels ... with a friction like how you do with a pencil, to get a satisfying feeling."
Clarify: swipe to strike, small to-do set, strike means done, "Go". Then added: due dates + reminders, x of y done, several icons per node. -->

## Why (the mission)
- Why: the captain uses mind maps as to-do boards, and crossing a task off should feel as good as crossing it off on paper.
- If it disappeared: emoji typed into labels and no sense of finishing.

## Who it's for
- The captain, planning in a mind map on desktop or phone, ticking off branches as they get done.

## What it does
1. **Icons on a node** (a box or a branch label), up to 3 per node (assumed), from a small set of Lucide icons (MIT, already a dependency): to-do box, done check, flag, star, alert, question, clock, idea, heart, pin, fire, X. They sit before the label in the node's colour, and the box grows to fit them. Tap an icon in the node toolbar to toggle it on or off.
2. **A pencil strike**: swipe across a selected node's label and a pencil line follows the pointer: graphite grey, a little wobble and uneven pressure, a short scratchy sound and a tiny haptic on phones (assumed). Let go past about 60% of the label's width and the line finishes itself across the label; stop short and it fades back.
3. **Strike means done**: a finished strike marks the node `done`. Its to-do icon turns into the done check, and the label dims slightly. Swiping across a struck label again, or tapping the done check, clears it. Done saves with the map (`done: true` on the node) and goes through backup and export like the rest of the map.
4. **x of y done**: a node with tasks under it (children or deeper, a task being any node with the to-do icon or struck through) shows a small mono badge like `3/7`. When all are done the badge turns into a check (assumed: it counts the whole subtree, not just direct children).
5. **Due dates**: give a node a date (and an optional time) from the node toolbar. A small date chip shows by the label ("Fri", "Nov 3"): it turns amber on the day and red when overdue, and disappears once the node is struck.
6. **Reminders**: a node with a due time sends a system notification at that time ("Personal Note: Call the bank, in the 'Week plan' map"); clicking it opens the map on that node. Assumed: reminders fire while the app is running (the server keeps a list of due nodes from every mind map). If the app was closed at the time, you get one "you missed 2 reminders" notice the next time it opens. Nothing leaves the machine.
- Also (bug, no brief needed): the box fits its text. Width comes from the measured text, not a character-count guess, so it grows with font size, and labels longer than about 28 characters wrap onto more lines, with the height growing to fit.
- Out of scope: searching all Lucide icons, repeating reminders, snooze, reminders while the app is fully quit, a list of every due task across maps, strikes on canvas notes.

## How it should look and feel
- Three words: tactile, quiet, satisfying.
- Feels like: crossing out a line in a Moleskine; Things 3's check-off.
- House style: omxqua motion (a settle spring for the strike finishing, a fade when reduced motion is on); the skins keep their colours.
- The one moment that matters: the swipe across a label on the phone.

## How we'll know it worked
- The captain uses icons and strikes on their own to-do maps, and says it feels good.
- Done for v1: on desktop and phone, in the real app, you can add icons, strike a label with a swipe, see the parent's count change, give a node a due time and get the notification, see it all stay after a reload, and undo it.

## Constraints and risks
- Riskiest: telling a strike swipe apart from dragging the node or panning. The strike only starts on an already-selected node's label, going mostly sideways; anything else stays a drag. Test it with a real mouse and real touch.
- Reminders need the server to read due dates out of every mind map (a small derived table filled on save, like the search index, never in backup). Notifications go through the desktop shell (`notify-send` on Linux, the system notification on macOS and Windows).
- Icons are drawn from inlined Lucide SVG paths inside the mind-map chunk; no `import 'lucide'` (it would split a first-load chunk). Bundle budget must hold.

## Decisions and trade-offs
- Swipe to strike, not a tap: the most satisfying, but it has to win against node drag, so it only works on a selected node.
- Reminders only while the app runs: no background service to install, but a reminder due while the app is quit only shows up as "missed" at the next start.
- A fixed set of 12 icons: fast to pick and small to ship, but you can't add your own.
- Strike = done (one state, two looks): the icon and the strike can't disagree, but a strike can't be used for anything other than done.
- Sound on by default (assumed), short and quiet; it follows the system mute.

## Open questions
- (none)
