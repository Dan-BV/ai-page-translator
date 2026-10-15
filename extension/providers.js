// Translation backends: Google Gemini and Anthropic Claude.
// Every call takes a batch of "units" (arrays of text fragments) and returns
// an array of the same shape, or null for units the model mangled.

const ANTHROPIC_VERSION = '2023-06-01';

export class ApiError extends Error {
  constructor(message, status, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export class TruncatedError extends Error {}

function systemPrompt(lang) {
  return [
    `You are a professional website translator. Translate web page text into ${lang}.`,
    'The input is a JSON array of units. Each unit is an array of text fragments that appear one after another inside a single block of a web page; the fragments are split by inline HTML elements such as links, bold text or spans.',
    'Return ONLY a JSON array with exactly the same structure: the same number of units, and every unit with exactly the same number of fragments, in the same order.',
    'Translate each unit as a whole so the result reads naturally, then distribute the translation over the fragments so each output fragment carries the meaning of the matching input fragment (link text stays link text). Never merge fragments and never leave a fragment empty unless its source is empty.',
    'Keep numbers, URLs, e-mail addresses, code identifiers, file names, placeholders such as {name}, %s or {{value}}, and HTML entities unchanged. Keep brand and product names in their original form unless a well-established translation exists.',
    `Keep the tone and register of the original and keep translations concise, because they must fit the existing page layout. If a fragment is already in ${lang} or is not natural-language text, return it unchanged.`,
    'Output the JSON array only: no comments, no explanations, no markdown fences.'
  ].join('\n');
}

export function parseJsonArray(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('Model response contains no JSON array');
  return JSON.parse(s.slice(start, end + 1));
}

// Returns an array aligned with `units`; a unit whose shape does not match is null.
export function alignResult(units, parsed) {
  if (!Array.isArray(parsed)) return units.map(() => null);
  // Single-unit batches are sometimes returned unwrapped: ["a", "b"].
  if (units.length === 1 && parsed.length === units[0].length && parsed.every(p => typeof p === 'string')) {
    parsed = [parsed];
  }
  return units.map((unit, i) => {
    let out = parsed[i];
    if (typeof out === 'string' && unit.length === 1) out = [out];
    if (!Array.isArray(out) || out.length !== unit.length) return null;
    if (!out.every(f => typeof f === 'string')) return null;
    return out;
  });
}

async function readError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || JSON.stringify(body);
  } catch {
    detail = res.statusText;
  }
  const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
  return new ApiError(`HTTP ${res.status}: ${detail}`, res.status, retryable);
}

async function callGemini({ key, model, lang, units }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt(lang) }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(units) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    })
  });
  if (!res.ok) throw await readError(res);
  const data = await res.json();
  const cand = data.candidates?.[0];
  if (!cand) {
    const reason = data.promptFeedback?.blockReason;
    throw new ApiError(reason ? `Gemini blocked the request: ${reason}` : 'Gemini returned no candidates', 200);
  }
  if (cand.finishReason === 'MAX_TOKENS') throw new TruncatedError('Response truncated');
  const text = (cand.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
  return parseJsonArray(text);
}

async function callClaude({ key, model, lang, units }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      system: systemPrompt(lang),
      messages: [{ role: 'user', content: JSON.stringify(units) }]
    })
  });
  if (!res.ok) throw await readError(res);
  const data = await res.json();
  if (data.stop_reason === 'max_tokens') throw new TruncatedError('Response truncated');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return parseJsonArray(text);
}

const CALLERS = { gemini: callGemini, claude: callClaude };

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One request with retries on rate limits / transient errors / bad JSON.
async function requestWithRetry(params, attempts = 4) {
  const call = CALLERS[params.provider];
  if (!call) throw new Error(`Unknown provider: ${params.provider}`);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await call(params);
    } catch (err) {
      lastErr = err;
      if (err instanceof TruncatedError) throw err;
      const retryable = err instanceof ApiError ? err.retryable : err instanceof SyntaxError || /JSON/.test(err.message);
      if (!retryable || i === attempts - 1) throw err;
      await sleep(1000 * 2 ** i + Math.random() * 500);
    }
  }
  throw lastErr;
}

// Translates units, splitting the batch on truncation and retrying
// mismatched units fragment by fragment. Never returns nulls: anything that
// still fails falls back to the source text.
export async function translateUnits(params, units) {
  if (units.length === 0) return [];
  let parsed;
  try {
    parsed = await requestWithRetry({ ...params, units });
  } catch (err) {
    if (err instanceof TruncatedError && units.length > 1) {
      const mid = Math.ceil(units.length / 2);
      const [a, b] = await Promise.all([
        translateUnits(params, units.slice(0, mid)),
        translateUnits(params, units.slice(mid))
      ]);
      return a.concat(b);
    }
    if (err instanceof TruncatedError) return units;
    throw err;
  }

  const aligned = alignResult(units, parsed);
  const bad = [];
  aligned.forEach((r, i) => { if (!r) bad.push(i); });
  if (bad.length === 0) return aligned;

  // Retry broken units with every fragment as an independent unit.
  const flat = [];
  for (const i of bad) for (const frag of units[i]) flat.push([frag]);
  let retry = null;
  try {
    retry = alignResult(flat, await requestWithRetry({ ...params, units: flat }));
  } catch {
    retry = null;
  }
  let k = 0;
  for (const i of bad) {
    aligned[i] = units[i].map(frag => {
      const r = retry?.[k++];
      return r ? r[0] : frag;
    });
  }
  return aligned;
}

export async function listModels(provider, key) {
  if (provider === 'gemini') {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      headers: { 'x-goog-api-key': key }
    });
    if (!res.ok) throw await readError(res);
    const data = await res.json();
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(id => id.startsWith('gemini') && !/embedding|image|tts|audio|live/i.test(id))
      .sort();
  }
  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true'
      }
    });
    if (!res.ok) throw await readError(res);
    const data = await res.json();
    return (data.data || []).map(m => m.id);
  }
  throw new Error(`Unknown provider: ${provider}`);
}
