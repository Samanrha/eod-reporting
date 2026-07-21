// netlify/functions/ai-proxy.mjs
// Proxies Anthropic Claude requests through the Netlify AI Gateway.
// Written in v2 syntax so the runtime injects ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL.
// The front-end sends a full Messages API body (model, max_tokens, messages) and
// reads back the raw Anthropic response, so this function forwards the body verbatim.

// Fail fast well before the platform's hard function limit so the client always
// receives JSON (a hung upstream would otherwise surface as an HTML 504 page).
const UPSTREAM_TIMEOUT_MS = 25000;

export default async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  }

  // AI Gateway injects these into the v2/v3 runtime — do not set our own key.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  if (!apiKey) {
    return Response.json({ error: 'AI Gateway credentials not available' }, { status: 500 });
  }

  let body;
  try {
    body = await req.json();
  } catch (err) {
    return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // Always return JSON so the front-end never has to parse an HTML error page.
    const data = await response.json();
    return Response.json(data, { status: response.status });
  } catch (err) {
    if (err.name === 'AbortError') {
      return Response.json(
        { error: 'Upstream request timed out', detail: `Exceeded ${UPSTREAM_TIMEOUT_MS}ms` },
        { status: 504 },
      );
    }
    return Response.json({ error: err.message }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
};
