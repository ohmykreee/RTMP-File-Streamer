import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

/*
 * Paint the palette the operating system asks for before the first frame: the saved
 * preference arrives over IPC a moment later and `App` corrects this if it differs,
 * so `system` (the default) never flashes the wrong one.
 */
document.documentElement.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches)

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {/* Tooltips are used across the workspace (icon-only buttons, the stat
        figures), so the provider sits at the root rather than being repeated
        per panel. */}
    <TooltipProvider delay={400}>
      <App />
    </TooltipProvider>
  </React.StrictMode>
)
