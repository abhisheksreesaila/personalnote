// Check scripts: Settings is a window with one section on show at a time (F-102; a phone drills in from a list). `showSection` makes
// the section that holds a control the one on screen, whichever way Settings was opened, so a script can then use the control's own id.
// Close Settings from wherever it is: a phone drilled into a section has its own close button (the title row, with the other one, is on the list).
export async function closeSettings(page) {
  const close = page.locator('#close-properties')
  await ((await close.isVisible()) ? close : page.locator('.sw-close')).click()
}

export async function showSection(page, id) {
  await page.locator('.sw-item').first().waitFor({ state: 'attached', timeout: 15000 }) // (the section list arrives with the settings chunk)
  const here = page.locator(`.sw-page[data-sw-page="${id}"]`)
  if (await here.isVisible()) return
  if (!(await page.locator('.sw-nav').isVisible())) await page.click('.sw-back') // (a phone drilled into another section)
  await page.click(`.sw-item[data-sw-item="${id}"]`)
  await here.waitFor({ state: 'visible', timeout: 5000 })
}
