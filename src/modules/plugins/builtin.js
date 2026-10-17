// The plugins that ship inside the app (ADR 0006). The shell reads this list; it never names a plugin's feature itself.
import { renderMindMapReadOnly } from './mindmap-readonly.js'

export const BUILTIN_PLUGINS = [
  {
    id: 'mindmap',
    name: 'Mind maps',
    description: 'Draw ideas as a branching map.',
    icon: 'git-fork',
    defaultOn: true,
    needs: [],
    noteKinds: [{
      type: 'mindmap',
      label: 'Mind map',
      icon: 'git-fork',
      defaultTitle: 'Untitled mind map',
      mount: async (host, options) => (await import('../mindmap.js')).mountMindMapModule(host, options), // the editor chunk, only when asked
      readOnly: renderMindMapReadOnly,
    }],
  },
]
