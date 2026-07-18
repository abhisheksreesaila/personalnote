async function loadLandingNote() {
  const response = await fetch('/landing-note.html')
  if (!response.ok) throw new Error('Could not load the landing page')

  const source = await response.text()
  const page = new DOMParser().parseFromString(source, 'text/html')

  document.title = page.title
  const description = page.querySelector('meta[name="description"]')
  if (description) document.querySelector('meta[name="description"]')?.setAttribute('content', description.content)

  page.head.querySelectorAll('link[rel="preconnect"], link[rel="stylesheet"]').forEach((link) => {
    if (!document.head.querySelector(`link[href="${link.href}"]`)) document.head.append(link.cloneNode(true))
  })

  const style = page.querySelector('style')
  if (style) {
    const liveStyle = document.createElement('style')
    liveStyle.dataset.landingNote = 'true'
    liveStyle.textContent = style.textContent
    document.head.append(liveStyle)
  }

  page.body.querySelectorAll('script').forEach((script) => script.remove())
  document.querySelector('#app').innerHTML = page.body.innerHTML
  document.querySelectorAll('a[href="/login"]').forEach((link) => link.setAttribute('href', '/notes'))

  window.joinWaitlist = () => { window.location.href = '/notes' }

  ;[
    ['n0', 300], ['n1', 800], ['n2', 1400],
    ['n3', 1950], ['n4', 2550], ['n5', 3100],
  ].forEach(([id, delay]) => {
    setTimeout(() => document.getElementById(id)?.classList.add('show'), delay)
  })
  setTimeout(() => document.getElementById('note-demo')?.classList.add('show'), 3700)

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) entry.target.classList.add('visible')
    })
  }, { threshold: 0.1 })
  document.querySelectorAll('.fade-up').forEach((element) => observer.observe(element))

  document.querySelector('#wl-email')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') window.joinWaitlist()
  })
}

loadLandingNote().catch((error) => {
  console.error(error)
  document.querySelector('#app').innerHTML = '<p>Personal Note could not be opened.</p>'
})