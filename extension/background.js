import { getSettings, activeKey, activeModel, pickPreferredModel, PROVIDERS } from './shared.js';
import { translateUnits, listModels, ApiError } from './providers.js';

// Short-lived in-memory cache: unit JSON -> translated unit.
const cache = new Map();
const CACHE_LIMIT = 20000;

function cacheKey(provider, model, lang, unit) {
  return `${provider}|${model}|${lang}|${JSON.stringify(unit)}`;
}

async function handleTranslate(units, { noCache = false } = {}) {
  const settings = await getSettings();
  const key = activeKey(settings);
  const model = activeModel(settings);
  if (!key) {
    const err = new Error(`No API key for ${PROVIDERS[settings.provider].label}. Open the extension settings and add one.`);
    err.code = 'NO_KEY';
    throw err;
  }

  const params = { provider: settings.provider, key, model, lang: settings.targetLanguage };
  const result = new Array(units.length);
  const missing = [];
  units.forEach((unit, i) => {
    const hit = !noCache && cache.get(cacheKey(params.provider, model, params.lang, unit));
    if (hit) result[i] = hit;
    else missing.push(i);
  });

  if (missing.length) {
    const translated = await translateWithModelRecovery(settings, params, missing.map(i => units[i]));
    missing.forEach((i, j) => {
      result[i] = translated[j];
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(cacheKey(params.provider, params.model, params.lang, units[i]), translated[j]);
    });
  }
  return result;
}

function isModelUnavailable(err) {
  return err instanceof ApiError && (err.status === 404 ||
    (err.status === 400 && /model|not found|no longer available/i.test(err.message)));
}

// When the selected model is retired or unknown (HTTP 404), switch to the
// newest suitable model from the provider's list, remember it and retry once.
async function translateWithModelRecovery(settings, params, units) {
  try {
    return await translateUnits(params, units);
  } catch (err) {
    const provider = params.provider;
    if (!isModelUnavailable(err) || settings[`${provider}Custom`]) throw err;
    let models;
    try {
      models = await listModels(provider, params.key);
    } catch {
      throw err;
    }
    const replacement = pickPreferredModel(provider, models.filter(m => m !== params.model));
    if (!replacement) throw err;
    await chrome.storage.local.set({ [`${provider}Model`]: replacement, [`${provider}Models`]: models });
    params.model = replacement;
    return translateUnits(params, units);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'translate') {
    handleTranslate(msg.units, { noCache: Boolean(msg.noCache) }).then(
      async result => sendResponse({ ok: true, result, model: activeModel(await getSettings()) }),
      err => sendResponse({ ok: false, error: err.message, code: err.code || null })
    );
    return true;
  }
  if (msg?.type === 'listModels') {
    listModels(msg.provider, msg.key).then(
      models => sendResponse({ ok: true, models }),
      err => sendResponse({ ok: false, error: err.message })
    );
    return true;
  }
  if (msg?.type === 'getConfig') {
    getSettings().then(s => sendResponse({
      ok: true,
      provider: s.provider,
      model: activeModel(s),
      hasKey: Boolean(activeKey(s)),
      showButton: s.showButton,
      concurrency: s.concurrency
    }));
    return true;
  }
  if (msg?.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    return false;
  }
  return false;
});

// Ensures the content script is present (tabs opened before install) and toggles translation.
export async function toggleInTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'toggle' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'toggle' });
  }
}

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'translate-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) toggleInTab(tab.id).catch(() => {});
});
