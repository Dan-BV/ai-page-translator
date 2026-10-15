import { PROVIDERS, DEFAULT_SETTINGS, getSettings, pickPreferredModel } from './shared.js';

const $ = sel => document.querySelector(sel);
const statusEl = $('#status');
let settings = null;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function save(patch) {
  Object.assign(settings, patch);
  return chrome.storage.local.set(patch);
}

function fillModels(provider) {
  const select = $(`#${provider}Model`);
  const fetched = settings[`${provider}Models`];
  const list = fetched && fetched.length ? [...fetched] : [...PROVIDERS[provider].defaultModels];
  const current = settings[`${provider}Model`];
  if (current && !list.includes(current)) list.unshift(current);
  select.replaceChildren(...list.map(id => new Option(id, id, false, id === current)));
}

function showProvider(provider) {
  document.querySelectorAll('input[name=provider]').forEach(r => { r.checked = r.value === provider; });
  document.querySelectorAll('section[data-provider]').forEach(s => { s.hidden = s.dataset.provider !== provider; });
}

async function refreshModels(provider) {
  const key = settings[`${provider}Key`];
  if (!key) {
    setStatus(`Enter the ${PROVIDERS[provider].label} API key first.`, 'err');
    return;
  }
  setStatus('Loading models…');
  const res = await chrome.runtime.sendMessage({ type: 'listModels', provider, key });
  if (!res?.ok) {
    setStatus(`Could not load models: ${res?.error || 'no response'}`, 'err');
    return;
  }
  if (!res.models.length) {
    setStatus('The API returned no models, keeping the default list.', 'err');
    return;
  }
  const firstFetch = !settings[`${provider}Models`]?.length;
  await save({ [`${provider}Models`]: res.models });
  // On the first load replace the built-in default with the newest suitable model.
  if (firstFetch || !res.models.includes(settings[`${provider}Model`])) {
    await save({ [`${provider}Model`]: pickPreferredModel(provider, res.models) });
  }
  fillModels(provider);
  setStatus(`Loaded ${res.models.length} models.`, 'ok');
}

async function toggleActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^(https?|file):/.test(tab.url || '')) {
    setStatus('This page cannot be translated (browser-internal page).', 'err');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  }
  window.close();
}

async function testConnection() {
  setStatus('Testing…');
  const res = await chrome.runtime.sendMessage({
    type: 'translate',
    noCache: true,
    units: [['Hello, ', 'world', '! The connection works.']]
  });
  if (res?.ok) {
    setStatus(`OK (${res.model}): ${res.result[0].join('')}`, 'ok');
    // The background may have switched away from a retired model.
    settings = await getSettings();
    for (const provider of Object.keys(PROVIDERS)) fillModels(provider);
  }
  else setStatus(`Error: ${res?.error || 'no response'}`, 'err');
}

async function init() {
  settings = await getSettings();
  showProvider(settings.provider);
  for (const provider of Object.keys(PROVIDERS)) {
    $(`#${provider}Key`).value = settings[`${provider}Key`];
    $(`#${provider}Custom`).value = settings[`${provider}Custom`] || '';
    fillModels(provider);

    $(`#${provider}Key`).addEventListener('change', async e => {
      await save({ [`${provider}Key`]: e.target.value.trim() });
      if (settings[`${provider}Key`]) refreshModels(provider);
    });
    $(`#${provider}Model`).addEventListener('change', e => save({ [`${provider}Model`]: e.target.value }));
    $(`#${provider}Custom`).addEventListener('change', e => save({ [`${provider}Custom`]: e.target.value.trim() }));
  }

  document.querySelectorAll('input[name=provider]').forEach(r => r.addEventListener('change', e => {
    save({ provider: e.target.value });
    showProvider(e.target.value);
    setStatus('');
  }));
  document.querySelectorAll('.refresh').forEach(b => b.addEventListener('click', () => refreshModels(b.dataset.provider)));
  document.querySelectorAll('.reveal').forEach(b => b.addEventListener('click', () => {
    const input = $(`#${b.dataset.for}`);
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    b.textContent = hidden ? 'Hide' : 'Show';
  }));

  $('#showButton').checked = settings.showButton;
  $('#showButton').addEventListener('change', e => save({ showButton: e.target.checked }));
  $('#concurrency').value = settings.concurrency;
  $('#concurrency').addEventListener('change', e => {
    const n = Math.max(1, Math.min(8, parseInt(e.target.value, 10) || DEFAULT_SETTINGS.concurrency));
    e.target.value = n;
    save({ concurrency: n });
  });
  $('#testBtn').addEventListener('click', testConnection);
  $('#translateBtn').addEventListener('click', () => toggleActiveTab().catch(err => setStatus(err.message, 'err')));

  if (settings[`${settings.provider}Key`] && !settings[`${settings.provider}Models`]?.length) {
    refreshModels(settings.provider);
  }

  // The translate button only makes sense in the toolbar popup, not in the options tab.
  chrome.tabs.getCurrent(tab => { if (tab) $('#translateBtn').hidden = true; });
}

init();
