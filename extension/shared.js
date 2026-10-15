// Settings shared by the background service worker and the options/popup page.

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    defaultModels: ['gemini-3.8-flash']
  },
  claude: {
    label: 'Anthropic Claude',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModels: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']
  }
};

export const DEFAULT_SETTINGS = {
  provider: 'gemini',
  geminiKey: '',
  claudeKey: '',
  geminiModel: 'gemini-3.8-flash',
  claudeModel: 'claude-haiku-5-5',
  // Free-form model ids that override the selected model when set.
  geminiCustom: '',
  claudeCustom: '',
  // Model lists fetched from the provider APIs (empty = use defaultModels).
  geminiModels: [],
  claudeModels: [],
  targetLanguage: 'Russian',
  showButton: true,
  concurrency: 4
};

export async function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

export function activeModel(settings) {
  const p = settings.provider === 'claude' ? 'claude' : 'gemini';
  return settings[`${p}Custom`] || settings[`${p}Model`];
}

export function activeKey(settings) {
  return settings.provider === 'claude' ? settings.claudeKey : settings.geminiKey;
}

function versionOf(id, re) {
  const m = re.exec(id);
  return m ? m.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Picks a fast, current model from the list returned by the provider API:
// the newest stable "flash" for Gemini, the newest "haiku" for Claude.
export function pickPreferredModel(provider, models) {
  if (!models || !models.length) return null;
  const re = provider === 'claude'
    ? /^claude-haiku-(\d+)(?:-(\d+))?(?:-\d{8})?$/
    : /^gemini-(\d+)(?:\.(\d+))?-flash$/;
  const ranked = models
    .map(id => ({ id, v: versionOf(id, re) }))
    .filter(x => x.v)
    .sort((a, b) => compareVersions(b.v, a.v));
  if (ranked.length) return ranked[0].id;
  const fallback = provider === 'claude' ? /haiku|sonnet/ : /flash(?!-lite)/;
  return models.find(id => fallback.test(id) && !/preview|exp/.test(id)) || models[0];
}
