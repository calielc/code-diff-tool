import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Content security policy of file 05 section 8 rule 5: scripts, styles and images from the app only.
// Injected at build time only, because the dev server needs inline scripts for hot reload.
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'"
].join('; ')

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], resolve: { alias: { '@shared': resolve('src/shared') } } },
  preload: { plugins: [externalizeDepsPlugin()], resolve: { alias: { '@shared': resolve('src/shared') } } },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [
      react(),
      {
        name: 'inject-csp',
        apply: 'build',
        transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }]
      }
    ]
  }
})
