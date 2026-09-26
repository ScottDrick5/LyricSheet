// Voice lists shown in the popup. Pick "Custom…" in the popup to type a name that isn't listed.
// For ChatGPT the value is sent to ChatGPT's read-aloud service, so it must be the lowercase voice id.
const VOICES = {
  chatgpt: [
    { id: 'arbor', name: 'Arbor' },
    { id: 'breeze', name: 'Breeze' },
    { id: 'cove', name: 'Cove' },
    { id: 'ember', name: 'Ember' },
    { id: 'juniper', name: 'Juniper' },
    { id: 'maple', name: 'Maple' },
    { id: 'sol', name: 'Sol' },
    { id: 'spruce', name: 'Spruce' },
    { id: 'vale', name: 'Vale' }
  ],
  // Claude's read-aloud voices. If Claude's request carries a voice setting it's switched to this one;
  // otherwise Claude uses the voice from its own settings and this names the saved file.
  claude: [
    { id: 'buttery', name: 'Buttery' },
    { id: 'airy', name: 'Airy' },
    { id: 'mellow', name: 'Mellow' },
    { id: 'glassy', name: 'Glassy' },
    { id: 'rounded', name: 'Rounded' }
  ]
};

const DEFAULTS = {
  chatgptVoice: 'ember',
  chatgptCustomVoice: '',
  chatgptFormat: 'aac',
  claudeVoice: 'buttery',
  claudeCustomVoice: '',
  showPlayerChatgpt: true,
  showPlayerClaude: true
};
