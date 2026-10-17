// F-097: the settings panels that are not the notebook itself (AI, X bookmarks, the Plugins rows and the setup rows plugins draw). The shell
// imports this file after the first screen is drawn (or at once when Settings, the omnibar or a plugin's button is used before that), so none of it
// is in the first load.
export { mountAISettings } from '../ai/ai-settings.js'
export { mountXSettings } from '../x/x-settings.js'
export { mountPluginSettings } from './plugins-settings.js'
export { createIslandDownload, createSetupSection, renderSetupRow } from './setup-row.js'
