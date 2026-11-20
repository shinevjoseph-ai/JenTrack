import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// A new ID for every build. It is baked into the app code and also written to
// version.json, so the login screen can tell when a newer build is live.
const BUILD_ID = String(Date.now())

const versionFile = () => ({
  name: 'jen-version-file',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) })
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), versionFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
})
