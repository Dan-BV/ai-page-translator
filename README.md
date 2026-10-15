# AI Page Translator (RU)

A Chrome / Edge (Manifest V3) extension that adds a floating button to every page.
One click translates the whole page into Russian with Google Gemini or Anthropic Claude;
another click brings the original back.

## How it keeps the layout intact

- Only the **values of text nodes** and a few attributes (`placeholder`, `title`, `alt`,
  `aria-label`, button `value`) are replaced. No elements are added, removed or re-wrapped,
  so CSS, event handlers and frameworks such as React keep working.
- Text is grouped by block element: a sentence split by `<a>`, `<b>`, `<span>` … is sent
  as one unit of fragments, translated with full context and then written back fragment
  by fragment. Leading/trailing whitespace of every fragment is preserved.
- Skipped: `script`, `style`, `code`, `pre`, `kbd`, `textarea` content, `svg`, editable areas,
  `translate="no"`, `.notranslate`, and text that is already Russian, numbers or URLs.
- Content added later (infinite scroll, SPA navigation) is translated automatically
  while the page is in translated mode.
- Text on screen is translated first, in small batches, so you can start reading within
  seconds; the page's main text goes before menus. The queue follows scrolling: whatever is
  on screen now is translated next. Off-screen text goes in larger batches to save requests.
- Gemini "thinking" is turned off (or set to the minimum) for translation, and rate-limit
  responses (HTTP 429) are retried after the delay the API asks for.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`) and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension` folder.
3. Click the extension icon in the toolbar and set it up:
   - choose the provider (Gemini or Claude);
   - paste the API key;
   - pick a model (**Refresh** loads the list of models available to your key) or type a
     custom model id;
   - press **Test connection**.

API keys are required; a consumer subscription (Claude Pro, Gemini Advanced) does not give
API access.

- Gemini key: <https://aistudio.google.com/app/apikey> (has a free tier).
- Claude key: <https://console.anthropic.com/settings/keys>.

Keys are stored in `chrome.storage.local` of this browser profile and are sent only to the
selected provider's API.

## Usage

- Click the round **RU** button (right edge of the page). It shows progress, turns green
  (**EN**) when done; click again to show the original.
- Drag the button vertically to move it; the position is remembered.
- Hover the button and click **×** to hide it on the current page; disable it globally in
  the settings.
- Shortcut: **Alt+Shift+T**. The toolbar popup also has a translate button that works even
  in tabs opened before the extension was installed.

## Files

| File | Purpose |
| --- | --- |
| `extension/manifest.json` | Manifest V3 definition |
| `extension/content.js` | Floating button, text collection, in-place replacement, MutationObserver |
| `extension/background.js` | Service worker: message routing, cache, keyboard shortcut |
| `extension/providers.js` | Gemini and Claude API calls, retries, response validation |
| `extension/shared.js` | Settings defaults and helpers |
| `extension/options.*` | Settings page / toolbar popup |
| `test/test-page.html` | Manual test page with a stubbed `chrome` API |
| `tools-make-icons.mjs` | Regenerates the PNG icons |

## Testing

### End-to-end (real Chromium, real websites)

`test/e2e.mjs` loads the unpacked extension into Chromium with Playwright, checks the
settings page (model list refresh, provider switch, Test connection) and translates
Wikipedia, Hacker News, MDN, GitHub, Python docs and BBC News. For every page it verifies
that the DOM node count is unchanged, that no element overflows the viewport horizontally,
and that "show original" restores the exact text. Screenshots go to `test/out/`.

```bash
cd test && npm install && npx playwright install chromium && node e2e.mjs
```

Without keys the provider APIs are stubbed inside the service worker with a
pseudo-translation (Cyrillic, ~25% longer) in the exact Gemini/Claude response formats.
To translate with the real models, pass keys through the environment:

```bash
GEMINI_API_KEY=... ANTHROPIC_API_KEY=... node e2e.mjs
```

`GEMINI_MODEL` / `CLAUDE_MODEL` override the models; `CHROMIUM_PATH` points to a custom
Chromium build.

### Content script only

`test/test-page.html` loads `content.js` with a fake `chrome` API that prefixes every
fragment with `RU:`. Serve the repository root (for example `python -m http.server 8765`)
and open `http://localhost:8765/test/test-page.html`.
