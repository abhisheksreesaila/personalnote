import { createIcons, icons } from 'lucide'

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
  document.querySelector('#app').classList.add('motion-ready')
  createIcons({ icons })
  document.querySelectorAll('video[autoplay]').forEach((video) => {
    const play = () => video.play().catch(() => {})
    video.addEventListener('canplay', play, { once: true })
    video.load()
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) play()
  })

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) entry.target.classList.add('visible')
    })
  }, { threshold: 0.1 })
  document.querySelectorAll('.reveal').forEach((element) => observer.observe(element))
}

loadLandingNote().catch((error) => {
  console.error(error)
  document.querySelector('#app').innerHTML = '<p>Personal Note could not be opened.</p>'
})