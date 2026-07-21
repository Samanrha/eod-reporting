// ai-proxy — Netlify Functions v2
// Forwards the request body to Anthropic's Messages API and returns JSON.
// - Uses AI Gateway credentials when Netlify injects them (ANTHROPIC_BASE_URL),
//   otherwise falls back to the self-managed ANTHROPIC_API_KEY + api.anthropic.com.
// - Aborts the upstream call at 25s so the platform never kills us with an HTML 504.
// - Every response path returns JSON, so the front-end can always response.json().

export default async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');

  if (!apiKey) {
    return Response.json({ error: 'API key not configured on server' }, { status: 500 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const upstream = await fetch(baseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = {
        error: 'Upstream returned non-JSON (status ' + upstream.status + ')',
        snippet: text.slice(0, 200)
      };
    }

    return Response.json(data, { status: upstream.status });
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return Response.json(
      { error: timedOut ? 'AI request timed out after 25s — try a smaller screenshot' : (err.message || 'Proxy error') },
      { status: timedOut ? 504 : 502 }
    );
  } finally {
    clearTimeout(timer);
  }
};
