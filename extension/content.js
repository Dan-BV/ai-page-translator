// Content script: floating button + in-place page translation.
// Only text node values and a few attributes are replaced, the DOM structure
// is never touched, so the page layout and its scripts keep working.
(() => {
  if (window.__aiPageTranslator) return;
  window.__aiPageTranslator = true;

  const HOST_TAG = 'ai-page-translator';
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'textarea', 'code', 'pre', 'kbd', 'samp', 'var',
    'svg', 'math', 'iframe', 'object', 'canvas', HOST_TAG,
    '[translate="no"]', '.notranslate', '[contenteditable=""]', '[contenteditable="true"]'
  ].join(',');
  const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset']);
  const MAX_UNIT_FRAGMENTS = 40;
  const MAX_UNIT_CHARS = 1500;
  const MAX_BATCH_CHARS = 4000;
  const MAX_BATCH_UNITS = 80;
  const VISIBLE_BATCH_CHARS = 800;
  const VISIBLE_BATCH_UNITS = 15;

  const LETTER_RE = /\p{L}/u;
  const CYRILLIC_RE = /[Ѐ-ӿ]/g;
  const LATIN_LIKE_RE = /[\p{L}]/gu;
  const URLISH_RE = /^(https?:\/\/|www\.)\S+$|^[\w.+-]+@[\w-]+\.[\w.]+$/i;

  // ---------- state ----------
  // record: { kind: 'text', node, orig, tr } | { kind: 'attr', el, name, orig, tr }
  const records = [];
  const textRecords = new WeakMap(); // Text -> record
  const attrRecords = new WeakMap(); // Element -> Map(name -> record)
  let mode = 'original'; // 'original' | 'translating' | 'translated'
  let runId = 0;
  let observer = null;
  let pendingRoots = new Set();
  let pendingTimer = null;
  let config = { showButton: true, concurrency: 4 };

  // ---------- text filtering ----------
  function needsTranslation(text) {
    const core = text.trim();
    if (!core || !LETTER_RE.test(core)) return false;
    if (URLISH_RE.test(core)) return false;
    const letters = core.match(LATIN_LIKE_RE)?.length || 0;
    const cyr = core.match(CYRILLIC_RE)?.length || 0;
    return cyr / letters < 0.5;
  }

  function splitWhitespace(value) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
    return { lead: m[1], core: m[2], trail: m[3] };
  }

  function isSkipped(el) {
    return !el || el.closest(SKIP_SELECTOR) !== null;
  }

  // ---------- block grouping ----------
  const displayCache = new WeakMap();
  function isInlineEl(el) {
    let d = displayCache.get(el);
    if (d === undefined) {
      d = getComputedStyle(el).display;
      displayCache.set(el, d);
    }
    return d === 'inline' || d === 'contents';
  }

  function blockOf(node) {
    let el = node.parentElement;
    while (el && el !== document.body && isInlineEl(el)) el = el.parentElement;
    return el || document.body;
  }

  // ---------- collection ----------
  function textNeedsWork(node) {
    const rec = textRecords.get(node);
    const value = node.nodeValue;
    if (rec && value === rec.tr) return false;
    return needsTranslation(value);
  }

  // Returns units: { items: [{ rec, lead, trail }], texts: [core], block }
  function collectUnits(root) {
    const units = [];
    if (!root) return units;
    const startEl = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
    if (startEl && isSkipped(startEl)) return units;

    const byBlock = new Map();
    const pushText = node => {
      const parent = node.parentElement;
      if (!parent || isSkipped(parent)) return;
      if (!textNeedsWork(node)) return;
      const block = blockOf(node);
      let list = byBlock.get(block);
      if (!list) { list = []; byBlock.set(block, list); }
      list.push(node);
    };

    if (root.nodeType === Node.TEXT_NODE) {
      pushText(root);
    } else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode(n) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            return n.matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) pushText(n);
    }

    for (const [block, nodes] of byBlock) {
      let unit = null;
      for (const node of nodes) {
        const { lead, core, trail } = splitWhitespace(node.nodeValue);
        if (!unit || unit.texts.length >= MAX_UNIT_FRAGMENTS || unit.chars + core.length > MAX_UNIT_CHARS) {
          unit = { items: [], texts: [], chars: 0, block };
          units.push(unit);
        }
        let rec = textRecords.get(node);
        if (!rec) {
          rec = { kind: 'text', node, orig: node.nodeValue, tr: null };
          textRecords.set(node, rec);
          records.push(rec);
        } else {
          // The page replaced the text itself: this is the new original.
          rec.orig = node.nodeValue;
          rec.tr = null;
        }
        unit.items.push({ rec, lead, trail });
        unit.texts.push(core);
        unit.chars += core.length;
      }
    }

    collectAttrs(root, units);
    return units;
  }

  function collectAttrs(root, units) {
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const selector = TRANSLATABLE_ATTRS.map(a => `[${a}]`).join(',') + ',input[value]';
    const els = Array.from(root.querySelectorAll(selector));
    if (root.matches(selector)) els.unshift(root);
    for (const el of els) {
      const skipRoot = el.closest(SKIP_SELECTOR);
      if (skipRoot && !(skipRoot === el && el.tagName === 'TEXTAREA')) continue;
      const names = TRANSLATABLE_ATTRS.filter(a => el.hasAttribute(a));
      if (el.tagName === 'INPUT' && BUTTON_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase())) {
        names.push('value');
      }
      for (const name of names) {
        const value = el.getAttribute(name);
        let map = attrRecords.get(el);
        let rec = map?.get(name);
        if (rec && value === rec.tr) continue;
        if (!needsTranslation(value)) continue;
        if (!map) { map = new Map(); attrRecords.set(el, map); }
        if (!rec) {
          rec = { kind: 'attr', el, name, orig: value, tr: null };
          map.set(name, rec);
          records.push(rec);
        } else {
          rec.orig = value;
          rec.tr = null;
        }
        const { lead, core, trail } = splitWhitespace(value);
        units.push({ items: [{ rec, lead, trail }], texts: [core], chars: core.length, block: el });
      }
    }
  }

  // ---------- applying ----------
  function writeRecord(rec, value) {
    if (rec.kind === 'text') {
      if (rec.node.nodeValue !== value) rec.node.nodeValue = value;
    } else if (rec.el.getAttribute(rec.name) !== value) {
      rec.el.setAttribute(rec.name, value);
    }
  }

  function readRecord(rec) {
    return rec.kind === 'text' ? rec.node.nodeValue : rec.el.getAttribute(rec.name);
  }

  function applyUnit(unit, translated) {
    unit.items.forEach((item, i) => {
      const t = translated[i];
      if (typeof t !== 'string' || !t.trim()) return;
      const rec = item.rec;
      // Skip if the page changed this text while the request was in flight.
      if (readRecord(rec) !== rec.orig) return;
      rec.tr = item.lead + t.trim() + item.trail;
      writeRecord(rec, rec.tr);
    });
  }

  function showOriginal() {
    for (const rec of records) {
      if (rec.tr != null && readRecord(rec) === rec.tr) writeRecord(rec, rec.orig);
    }
  }

  function showTranslation() {
    for (const rec of records) {
      if (rec.tr != null && readRecord(rec) === rec.orig) writeRecord(rec, rec.tr);
    }
  }

  // ---------- translation pipeline ----------
  // 0 for units on screen, otherwise the distance in px from the viewport.
  // Recomputed on every pick, so scrolling re-prioritises the queue at once.
  function viewportDistance(u) {
    const el = u.block;
    if (!el || !el.getBoundingClientRect) return 0; // document.title
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return Infinity; // hidden: translate last
    const h = window.innerHeight;
    if (r.bottom >= 0 && r.top <= h) {
      // Collapsed menus and invisible popups still have a box: they are not "on screen".
      const shown = !el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      return shown ? 0 : 1e6;
    }
    return r.top > h ? r.top - h : (-r.bottom) * 2; // below the screen goes before above it
  }

  // Among units at the same distance, the page's main text goes before navigation.
  const MAIN_SELECTOR = 'main, article, [role="main"], #content, #main, .content, .post, .entry';
  function contentRank(u) {
    if (u.rank === undefined) {
      const el = u.block;
      const inMain = el && el.closest ? el.closest(MAIN_SELECTOR) !== null : false;
      u.rank = inMain || u.chars >= 80 ? 0 : 1;
    }
    return u.rank;
  }

  // Takes the next batch from the queue: small for on-screen text so it shows up fast,
  // large for off-screen text to keep the number of requests low.
  function takeBatch(queue) {
    if (!queue.length) return null;
    const scored = queue.map((u, i) => ({ u, i, d: viewportDistance(u) }));
    scored.sort((a, b) => a.d - b.d || contentRank(a.u) - contentRank(b.u) || a.u.order - b.u.order);
    const visible = scored[0].d === 0;
    const maxChars = visible ? VISIBLE_BATCH_CHARS : MAX_BATCH_CHARS;
    const maxUnits = visible ? VISIBLE_BATCH_UNITS : MAX_BATCH_UNITS;
    const batch = [];
    let chars = 0;
    for (const s of scored) {
      if (batch.length && (chars + s.u.chars > maxChars || batch.length >= maxUnits)) break;
      if (visible && s.d !== 0 && batch.length) break;
      batch.push(s);
      chars += s.u.chars;
    }
    const taken = new Set(batch.map(s => s.i));
    const rest = queue.filter((_, i) => !taken.has(i));
    queue.length = 0;
    queue.push(...rest);
    return batch.map(s => s.u);
  }

  async function requestTranslation(batch) {
    const res = await chrome.runtime.sendMessage({ type: 'translate', units: batch.map(u => u.texts) });
    if (!res) throw new Error('No response from the extension background');
    if (!res.ok) {
      const err = new Error(res.error);
      err.code = res.code;
      throw err;
    }
    return res.result;
  }

  async function runUnits(units, { onProgress } = {}) {
    units.forEach((u, i) => { u.order = i; });
    const queue = units.slice();
    const total = units.length;
    let done = 0;
    let firstError = null;
    let stop = false;
    const myRun = runId;

    async function worker() {
      while (!stop && myRun === runId) {
        const batch = takeBatch(queue);
        if (!batch) return;
        try {
          const result = await requestTranslation(batch);
          if (myRun !== runId) return;
          batch.forEach((u, i) => applyUnit(u, result[i]));
        } catch (err) {
          firstError = firstError || err;
          if (err.code === 'NO_KEY') { stop = true; return; }
        }
        done += batch.length;
        onProgress?.(done / total);
      }
    }

    const workers = [];
    const n = Math.max(1, Math.min(config.concurrency || 4, units.length));
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);
    return { total, error: firstError };
  }

  async function translatePage() {
    const myRun = ++runId;
    mode = 'translating';
    ui.setState('busy', 0);
    showTranslation();
    startObserver();
    const units = collectUnits(document.body);
    collectTitle(units);
    const { error } = await runUnits(units, { onProgress: p => ui.setState('busy', p) });
    if (myRun !== runId || mode !== 'translating') return;
    mode = 'translated';
    if (pendingRoots.size && !pendingTimer) pendingTimer = setTimeout(flushPending, 0);
    if (error) {
      ui.setState('error');
      ui.toast(error.code === 'NO_KEY' ? error.message : `Some text was not translated: ${error.message}`, error.code === 'NO_KEY');
      if (error.code === 'NO_KEY') {
        mode = 'original';
        stopObserver();
      }
    } else {
      ui.setState('done');
    }
  }

  // document.title is a text node inside <head>, translate it too.
  function collectTitle(units) {
    const titleEl = document.querySelector('head > title');
    if (titleEl?.firstChild?.nodeType === Node.TEXT_NODE) {
      const node = titleEl.firstChild;
      if (!textNeedsWork(node)) return;
      let rec = textRecords.get(node);
      if (!rec) {
        rec = { kind: 'text', node, orig: node.nodeValue, tr: null };
        textRecords.set(node, rec);
        records.push(rec);
      }
      const { lead, core, trail } = splitWhitespace(node.nodeValue);
      units.push({ items: [{ rec, lead, trail }], texts: [core], chars: core.length, block: null });
    }
  }

  function restorePage() {
    runId++;
    mode = 'original';
    stopObserver();
    showOriginal();
    ui.setState('idle');
  }

  function toggle() {
    if (mode === 'original') translatePage();
    else restorePage();
  }

  // ---------- dynamic content ----------
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === 'characterData') {
          pendingRoots.add(m.target);
        } else if (m.type === 'attributes') {
          pendingRoots.add(m.target);
        } else {
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) pendingRoots.add(n);
          }
        }
      }
      if (pendingRoots.size && !pendingTimer) pendingTimer = setTimeout(flushPending, 600);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRS, 'value']
    });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingRoots = new Set();
  }

  async function flushPending() {
    pendingTimer = null;
    if (mode === 'translating') return; // picked up when the main run ends
    if (mode !== 'translated') return;
    const roots = Array.from(pendingRoots).filter(n => n.isConnected);
    pendingRoots = new Set();
    // Drop roots contained in other roots.
    const top = roots.filter(n => !roots.some(o => o !== n && o.contains(n)));
    const units = [];
    for (const r of top) units.push(...collectUnits(r));
    if (!units.length) return;
    ui.setState('busy-quiet');
    const { error } = await runUnits(units);
    if (mode === 'translated') ui.setState(error ? 'error' : 'done');
  }

  // ---------- floating button ----------
  const ui = (() => {
    const host = document.createElement(HOST_TAG);
    host.setAttribute('translate', 'no');
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 16px; top: 60%; width: 0; height: 0;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: absolute; right: 0; top: 0; transform: translateY(-50%); display: flex; align-items: center; gap: 8px; flex-direction: row-reverse;
          font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        .main { position: relative; width: 44px; height: 44px; border-radius: 50%; border: none; cursor: grab; padding: 0;
          background: #1f6feb; color: #fff; font: inherit; font-size: 14px; letter-spacing: .02em;
          box-shadow: 0 4px 14px rgba(0,0,0,.25); transition: background .2s, transform .15s, opacity .2s; opacity: .85;
          touch-action: none; user-select: none; display: grid; place-items: center; }
        .main:hover { opacity: 1; transform: scale(1.06); }
        .main:active { cursor: grabbing; }
        .main.busy { background: #6e40c9; }
        .main.done { background: #1a7f37; }
        .main.error { background: #cf222e; }
        .ring { position: absolute; inset: -3px; width: 50px; height: 50px; transform: rotate(-90deg); pointer-events: none; display: none; }
        .main.busy .ring { display: block; }
        .ring circle { fill: none; stroke: #fff; stroke-width: 3; stroke-linecap: round; stroke-dasharray: 150.8; transition: stroke-dashoffset .3s; }
        .label { pointer-events: none; font-size: 13px; }
        .close { position: absolute; top: -6px; left: -6px; width: 18px; height: 18px; border-radius: 50%; border: none; padding: 0;
          background: #24292f; color: #fff; font: 700 12px/18px system-ui, sans-serif; cursor: pointer; display: none; }
        .holder { position: relative; }
        .holder:hover .close { display: block; }
        .toast { max-width: 280px; background: #24292f; color: #fff; padding: 8px 10px; border-radius: 8px; font-weight: 500; font-size: 12px;
          box-shadow: 0 4px 14px rgba(0,0,0,.25); display: none; cursor: default; white-space: normal; }
        .toast.show { display: block; }
        .toast a { color: #79c0ff; cursor: pointer; text-decoration: underline; }
      </style>
      <div class="wrap">
        <div class="holder">
          <button class="main" type="button" aria-label="Translate page to Russian">
            <svg class="ring" viewBox="0 0 50 50"><circle cx="25" cy="25" r="24" style="stroke-dashoffset:150.8"></circle></svg>
            <span class="label">RU</span>
          </button>
          <button class="close" type="button" title="Hide the button on this page">×</button>
        </div>
        <div class="toast" role="status"></div>
      </div>`;

    const main = shadow.querySelector('.main');
    const label = shadow.querySelector('.label');
    const circle = shadow.querySelector('.ring circle');
    const close = shadow.querySelector('.close');
    const toastEl = shadow.querySelector('.toast');
    let toastTimer = null;

    const TITLES = {
      idle: 'Translate page to Russian (Alt+Shift+T). Drag to move.',
      busy: 'Translating… click to cancel and show the original',
      done: 'Translated. Click to show the original',
      error: 'Click to show the original'
    };

    function setState(state, progress) {
      if (state === 'busy-quiet') return;
      main.classList.remove('busy', 'done', 'error');
      if (state !== 'idle') main.classList.add(state);
      main.title = TITLES[state] || '';
      if (state === 'busy') {
        const p = Math.max(0, Math.min(1, progress || 0));
        label.textContent = `${Math.round(p * 100)}%`;
        circle.style.strokeDashoffset = String(150.8 * (1 - p));
      } else if (state === 'idle') {
        label.textContent = 'RU';
      } else if (state === 'done') {
        label.textContent = 'EN';
      } else if (state === 'error') {
        label.textContent = '!';
      }
    }

    function toast(message, withSettingsLink = false) {
      toastEl.textContent = message;
      if (withSettingsLink) {
        toastEl.append(' ');
        const a = document.createElement('a');
        a.textContent = 'Open settings';
        a.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openOptions' }));
        toastEl.append(a);
      }
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('show'), 8000);
    }

    // Drag vertically; a click without movement toggles translation.
    let drag = null;
    main.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      drag = { y: e.clientY, startTop: host.getBoundingClientRect().top, moved: false };
      main.setPointerCapture(e.pointerId);
    });
    main.addEventListener('pointermove', e => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      if (Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        const top = Math.max(30, Math.min(window.innerHeight - 30, drag.startTop + dy));
        host.style.top = `${top}px`;
      }
    });
    main.addEventListener('pointerup', () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (moved) {
        const ratio = parseFloat(host.style.top) / window.innerHeight;
        chrome.storage.local.set({ buttonTopRatio: ratio });
      } else {
        toggle();
      }
    });
    main.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    close.addEventListener('click', () => host.remove());

    function mount() {
      if (!host.isConnected && config.showButton) document.documentElement.appendChild(host);
    }
    function unmount() { host.remove(); }
    function setTopRatio(r) {
      if (typeof r === 'number' && r > 0 && r < 1) host.style.top = `${r * 100}%`;
    }

    return { setState, toast, mount, unmount, setTopRatio };
  })();

  // ---------- wiring ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'toggle') {
      toggle();
      sendResponse({ ok: true, mode });
    } else if (msg?.type === 'status') {
      sendResponse({ ok: true, mode });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.showButton) {
      config.showButton = changes.showButton.newValue;
      config.showButton ? ui.mount() : ui.unmount();
    }
    if (changes.concurrency) config.concurrency = changes.concurrency.newValue;
  });

  chrome.storage.local.get({ showButton: true, concurrency: 4, buttonTopRatio: null }).then(s => {
    config.showButton = s.showButton;
    config.concurrency = s.concurrency;
    ui.setTopRatio(s.buttonTopRatio);
    ui.setState('idle');
    ui.mount();
  });

  // Exposed for automated tests only.
  window.__aiPageTranslatorTest = { collectUnits, toggle, getMode: () => mode, records };
})();
