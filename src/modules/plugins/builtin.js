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
  {
    id: 'voice',
    name: 'Voice',
    description: 'Dictate into a note with your voice. Audio is never kept, only the words.',
    icon: 'mic',
    defaultOn: true,
    needs: [{ kind: 'download', text: 'about 750 MB download (the Nemotron speech model), runs on this computer' }],
    activate: async (shell) => (await import('../voice/voice-plugin.js')).activateVoice(shell), // the voice code arrives only when it is on
  },
  {
    id: 'meaning',
    name: 'Search by meaning',
    description: 'Find notes by what they mean, not only their words.',
    icon: 'search',
    defaultOn: true,
    needs: [{ kind: 'download', text: 'about 315 MB download (the EmbeddingGemma model), runs on this computer' }],
    activate: async (shell) => (await import('../search/meaning-plugin.js')).activateMeaning(shell),
  },
]
