// End-to-end check: loads the unpacked extension into Chromium and translates real web pages.
//
// Default mode stubs the provider APIs inside the service worker with a pseudo-translation
// (Cyrillic, ~25% longer, acronyms kept) in the exact Gemini / Claude response formats, so the
// layout can be stress-tested without API keys.
// Real mode: set GEMINI_API_KEY and/or ANTHROPIC_API_KEY to translate with the real models
// (optionally GEMINI_MODEL / CLAUDE_MODEL).
//
//   cd test && npm install && npx playwright install chromium && node e2e.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../extension');
const OUT = path.resolve(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const REAL = { gemini: process.env.GEMINI_API_KEY || '', claude: process.env.ANTHROPIC_API_KEY || '' };

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-translator-')), {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
console.log('extension id', extId);

async function installFakeApis() {
  await sw.evaluate(() => {
    if (self.__realFetch) return;
    self.__realFetch = self.fetch;
    self.__log = [];
    self.__pending = 0;
    const map = { a: 'а', b: 'б', c: 'ц', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'й', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'ы', z: 'з' };
    // Like a real model: acronyms and identifiers stay, words grow ~25%.
    const pseudo = s => s.replace(/[A-Za-z][A-Za-z0-9]*/g, w => {
      if (w.length < 2 || /[0-9]/.test(w) || /^[A-Z]+s?$/.test(w) || /[a-z][A-Z]/.test(w)) return w;
      let t = [...w.toLowerCase()].map(ch => map[ch] || ch).join('');
      t = t.replace(/кс/g, 'х');
      if (w.length > 3) t += 'а'.repeat(Math.max(1, Math.round(w.length * 0.25)));
      return w[0] === w[0].toUpperCase() ? t[0].toUpperCase() + t.slice(1) : t;
    });
    self.fetch = async (url, init = {}) => {
      url = String(url);
      const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
      if (!/googleapis|anthropic/.test(url)) return self.__realFetch(url, init);
      self.__pending++;
      try {
        await new Promise(r => setTimeout(r, 150));
        const headers = init.headers || {};
        self.__log.push({ url, method: init.method || 'GET', headers: Object.keys(headers) });
        if (url.includes('/models?')) {
          return url.includes('anthropic')
            ? json({ data: [{ id: 'claude-haiku-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }] })
            : json({ models: [
                { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
              ] });
        }
        const body = JSON.parse(init.body);
        const units = JSON.parse(url.includes('anthropic') ? body.messages[0].content : body.contents[0].parts[0].text);
        const text = JSON.stringify(units.map(u => u.map(pseudo)));
        return url.includes('anthropic')
          ? json({ content: [{ type: 'text', text }], stop_reason: 'end_turn' })
          : json({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
      } finally {
        self.__pending--;
      }
    };
  });
}

async function setSettings(s) { await sw.evaluate(s => chrome.storage.local.set(s), s); }
const swState = () => sw.evaluate(() => ({ pending: self.__pending, calls: self.__log.length }));

async function waitIdle() {
  let stable = 0, last = -1;
  for (let i = 0; i < 240 && stable < 6; i++) {
    await new Promise(r => setTimeout(r, 250));
    const s = await swState();
    if (s.pending === 0 && s.calls === last && s.calls > 0) stable++; else stable = 0;
    last = s.calls;
  }
}

if (REAL.gemini || REAL.claude) {
  await realMode();
  await ctx.close();
  process.exit(0);
}

async function realMode() {
  const runs = [];
  if (REAL.gemini) runs.push(['gemini', { geminiKey: REAL.gemini, geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash' }]);
  if (REAL.claude) runs.push(['claude', { claudeKey: REAL.claude, claudeModel: process.env.CLAUDE_MODEL || 'claude-haiku-5-5' }]);
  await sw.evaluate(() => {
    self.__log = []; self.__pending = 0;
    const real = self.fetch;
    self.fetch = async (url, init) => {
      self.__pending++;
      try { self.__log.push({ url: String(url) }); return await real(url, init); } finally { self.__pending--; }
    };
  });
  for (const [provider, s] of runs) {
    await setSettings({ provider, ...s });
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    await opt.click('#testBtn');
    await opt.waitForFunction(() => /^(OK|Error)/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
    console.log('REAL TEST', provider, await opt.textContent('#status'));
    await opt.close();
    const page = await ctx.newPage();
    await page.goto('https://en.wikipedia.org/wiki/Web_browser', { waitUntil: 'load' });
    const before = await page.evaluate(metrics);
    await sw.evaluate(() => { self.__log = []; });
    const vp = page.viewportSize();
    await page.mouse.click(vp.width - 16 - 22, Math.round(vp.height * 0.6));
    await waitIdle();
    const after = await page.evaluate(metrics);
    await page.screenshot({ path: `${OUT}/real-${provider}.png` });
    const sample = await page.evaluate(() => document.querySelector('#mw-content-text p:not(.mw-empty-elt)')?.innerText.slice(0, 300));
    console.log('REAL PAGE', provider, JSON.stringify({ before, after, sample }));
    await page.close();
  }
}

await installFakeApis();

// ---------- options page ----------
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options.html`);
await opt.screenshot({ path: `${OUT}/options-gemini.png`, fullPage: true });
await opt.fill('#geminiKey', 'test-key-gemini');
await opt.locator('#geminiKey').dispatchEvent('change');
await opt.click('.refresh[data-provider=gemini]');
await opt.waitForFunction(() => /Loaded/.test(document.querySelector('#status').textContent));
const geminiModels = await opt.$$eval('#geminiModel option', o => o.map(x => x.value));
await opt.selectOption('#geminiModel', 'gemini-2.5-pro');
await opt.click('#testBtn');
await opt.waitForFunction(() => /^(OK|Error)/.test(document.querySelector('#status').textContent));
const geminiTest = await opt.textContent('#status');
await opt.check('input[value=claude]');
await opt.fill('#claudeKey', 'test-key-claude');
await opt.locator('#claudeKey').dispatchEvent('change');
await opt.click('.refresh[data-provider=claude]');
await opt.waitForFunction(() => /Loaded/.test(document.querySelector('#status').textContent));
await opt.selectOption('#claudeModel', 'claude-sonnet-5-5');
await opt.click('#testBtn');
await opt.waitForFunction(() => /^(OK|Error)/.test(document.querySelector('#status').textContent));
const claudeTest = await opt.textContent('#status');
await opt.screenshot({ path: `${OUT}/options-claude.png`, fullPage: true });
const stored = await sw.evaluate(() => chrome.storage.local.get(null));
const optLog = await sw.evaluate(() => self.__log.map(l => l.url.replace(/\?.*/, '')));
console.log('OPTIONS', JSON.stringify({ geminiModels, geminiTest, claudeTest, provider: stored.provider, geminiModel: stored.geminiModel, claudeModel: stored.claudeModel, requests: optLog }, null, 1));

// ---------- real pages ----------
const SITES = [
  ['wikipedia', 'https://en.wikipedia.org/wiki/Web_browser', 'gemini'],
  ['hn', 'https://news.ycombinator.com/', 'claude'],
  ['mdn', 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/table', 'gemini'],
  ['github', 'https://github.com/microsoft/playwright', 'claude'],
  ['pydocs', 'https://docs.python.org/3/tutorial/introduction.html', 'gemini'],
  ['bbc', 'https://www.bbc.com/news', 'claude']
];

function metrics() {
  const els = document.body.getElementsByTagName('*');
  const text = document.body.innerText;
  const letters = (text.match(/\p{L}/gu) || []).length;
  const cyr = (text.match(/[\u0400-\u04FF]/g) || []).length;
  return {
    nodes: els.length,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    cyrShare: +(cyr / Math.max(1, letters)).toFixed(2),
    title: document.title.slice(0, 60),
    overflowing: Array.from(els).filter(e => {
      if (e.closest('ai-page-translator')) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > document.documentElement.clientWidth + 1 && getComputedStyle(e).position !== 'fixed';
    }).slice(0, 4).map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}:${Math.round(e.getBoundingClientRect().right)}`)
  };
};

for (const [name, url, provider] of SITES) {
  const page = await ctx.newPage();
  try {
    await setSettings({ provider });
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(1500);
    const before = await page.evaluate(metrics);
    await page.screenshot({ path: `${OUT}/${name}-before.png` });
    await sw.evaluate(() => { self.__log = []; });
    const vp = page.viewportSize();
    const hostTag = await page.evaluate(() => !!document.querySelector('ai-page-translator'));
    await page.mouse.click(vp.width - 16 - 22, Math.round(vp.height * 0.6));
    await waitIdle();
    await page.waitForTimeout(800);
    const after = await page.evaluate(metrics);
    const calls = (await swState()).calls;
    const hostOf = (await sw.evaluate(() => self.__log.map(l => new URL(l.url).host)))[0];
    await page.screenshot({ path: `${OUT}/${name}-after.png` });
    // Toggle back to the original.
    await page.mouse.click(vp.width - 16 - 22, Math.round(vp.height * 0.6));
    await page.waitForTimeout(500);
    const restored = await page.evaluate(metrics);
    console.log('SITE', name, JSON.stringify({ provider, apiHost: hostOf, buttonPresent: hostTag, calls, before, after, restored }));
  } catch (e) {
    console.log('SITE', name, 'FAILED', e.message.split('\n')[0]);
  }
  await page.close();
}

// ---------- real network: invalid key must surface as an error ----------
await sw.evaluate(() => { self.fetch = self.__realFetch; delete self.__realFetch; });
await setSettings({ provider: 'gemini', geminiKey: 'invalid-key', geminiModel: 'gemini-2.5-flash', geminiCustom: '' });
const opt2 = await ctx.newPage();
await opt2.goto(`chrome-extension://${extId}/options.html`);
await opt2.click('#testBtn');
await opt2.waitForFunction(() => /^(OK|Error)/.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
console.log('REAL GEMINI (invalid key):', await opt2.textContent('#status'));
await setSettings({ provider: 'claude', claudeKey: 'invalid-key', claudeCustom: '' });
await opt2.reload();
await opt2.click('#testBtn');
await opt2.waitForFunction(() => /^(OK|Error)/.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
console.log('REAL CLAUDE (invalid key):', await opt2.textContent('#status'));

await ctx.close();
