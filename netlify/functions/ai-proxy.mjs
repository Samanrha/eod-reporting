// netlify/functions/ai-proxy.mjs
// Proxies Anthropic Messages requests through the Netlify AI Gateway.
// Written with v2 syntax so the gateway credentials (ANTHROPIC_API_KEY /
// ANTHROPIC_BASE_URL) are injected into the runtime automatically.

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!baseUrl || !apiKey) {
    return Response.json(
      { error: 'AI Gateway credentials not configured on server' },
      { status: 500 },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch (err) {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    return Response.json(data, { status: response.status });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
};
