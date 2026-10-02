import { chromium } from 'playwright'
const headless = process.env.HEADED ? false : true
const b = await chromium.launch({ headless, executablePath: process.env.EXE, ignoreDefaultArgs: ['--disable-gpu','--use-angle=swiftshader-webgl','--enable-unsafe-swiftshader'], args: ['--ignore-gpu-blocklist','--enable-gpu-rasterization','--ozone-platform=wayland','--use-angle=vulkan','--enable-features=Vulkan'] })
const p = await b.newPage(); await p.goto('chrome://gpu')
const t = await p.evaluate(() => { const r = document.querySelector('info-view')?.shadowRoot?.textContent || document.body.innerText; return r })
console.log(t.match(/Canvas[^\n]{0,80}/g)?.slice(0,3), t.match(/GL_RENDERER[^\n]{0,120}/)?.[0], t.match(/Rasterization[^\n]{0,60}/)?.[0])
await b.close()
