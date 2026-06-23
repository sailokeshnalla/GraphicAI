import { NextResponse } from 'next/server';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GROK_MODEL = 'grok-3';

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseModelJson(raw) {
  if (!raw) return null;
  let text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

const normKey = (s) => s.replace(/[{}\s]/g, '').toLowerCase();

// Trim to a hard character limit, preferring a sentence boundary then a word boundary.
function capLength(value, limit) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (!limit || v.length <= limit) return v;

  // Try to end at a complete sentence (. ! ?)
  const sliced = v.slice(0, limit);
  const lastSentence = Math.max(
    sliced.lastIndexOf('. '),
    sliced.lastIndexOf('! '),
    sliced.lastIndexOf('? ')
  );
  if (lastSentence > limit * 0.5) return sliced.slice(0, lastSentence + 1).trimEnd();

  // Fall back to a word boundary
  const lastSpace = sliced.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? sliced.slice(0, lastSpace) : sliced).trimEnd();
}

function buildPrompt(brief, placeholders) {
  const spec = placeholders
    .map((p) => {
      const limit = p.char_limit ? `${p.char_limit} characters max` : 'no strict limit';
      const kind = p.is_multiline ? 'multi-line' : 'single line';
      return `- "${p.placeholder}" (role: ${p.role}, ${kind}, ${limit})`;
    })
    .join('\n');

  const system =
    'You are a senior presentation copywriter. You fill placeholders on a single slide ' +
    'with concise, polished, professional copy derived from the user\'s brief.';

  const user =
    `USER BRIEF:\n${brief}\n\n` +
    `PLACEHOLDERS TO FILL:\n${spec}\n\n` +
    `RULES:\n` +
    `1. NEVER exceed the character limit. Count characters precisely before responding.\n` +
    `2. ALWAYS write complete, finished sentences or phrases — never cut off mid-word or mid-sentence.\n` +
    `3. Match the role:\n` +
    `   - "title" = a short punchy slide title (complete phrase, no trailing words).\n` +
    `   - "heading" or "option" = a concise label of 2–5 complete words.\n` +
    `   - "description" = one or two complete sentences that end with a full stop. If the limit is tight, write ONE strong sentence rather than starting a second one you cannot finish.\n` +
    `4. If the character limit is very tight, prioritise a complete short sentence over a longer incomplete one.\n` +
    `5. Base every value on the brief. Where the brief is thin, infer reasonable, on-topic professional content.\n` +
    `6. Do not include curly braces or placeholder names in your output — only the replacement copy.\n` +
    `7. Return ONLY a JSON object mapping each EXACT placeholder string (with its braces) to its text. ` +
    `No markdown, no code fences, no commentary, no extra keys.`;

  return { system, user };
}

// ── Provider calls ───────────────────────────────────────────────────────────

async function callGemini(apiKey, system, user) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini request failed (${res.status}).`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callGrok(apiKey, system, user) {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROK_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || err?.error || `Grok request failed (${res.status}).`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ── Route ────────────────────────────────────────────────────────────────────

export async function POST(req) {
  try {
    const { brief, placeholders, provider, apiKey } = await req.json();

    if (!apiKey) {
      return NextResponse.json({ error: 'Missing API key.' }, { status: 400 });
    }
    if (!brief || !brief.trim()) {
      return NextResponse.json({ error: 'Brief is empty.' }, { status: 400 });
    }
    if (!Array.isArray(placeholders) || placeholders.length === 0) {
      return NextResponse.json({ error: 'No placeholders provided.' }, { status: 400 });
    }

    const { system, user } = buildPrompt(brief, placeholders);

    const raw =
      provider === 'grok'
        ? await callGrok(apiKey, system, user)
        : await callGemini(apiKey, system, user);

    const parsed = parseModelJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      return NextResponse.json(
        { error: 'The model did not return usable content. Please try again.' },
        { status: 502 }
      );
    }

    const normalizedReturned = {};
    for (const [k, v] of Object.entries(parsed)) normalizedReturned[normKey(k)] = v;

    const content = {};
    for (const p of placeholders) {
      const value = parsed[p.placeholder] ?? normalizedReturned[normKey(p.placeholder)] ?? '';
      content[p.placeholder] = capLength(value, p.char_limit);
    }

    return NextResponse.json({ content });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || 'AI generation failed.' },
      { status: 500 }
    );
  }
}