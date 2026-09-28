// Cloudflare Pages "Advanced Mode" worker.
// Handles /api/pagespeed and /api/submit-report ourselves, and falls back
// to serving the static assets (index.html etc.) for everything else.
// This file format is reliably picked up by the dashboard's drag-and-drop
// zip uploader, unlike a separate functions/ directory.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/pagespeed' && request.method === 'GET') {
      return handlePagespeed(request, env);
    }
    if (url.pathname === '/api/submit-report' && request.method === 'POST') {
      return handleSubmitReport(request, env);
    }

    // Everything else: serve the static site (index.html, etc.)
    return env.ASSETS.fetch(request);
  },
};

async function handlePagespeed(request, env) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get('url');

  if (!targetUrl) {
    return json({ error: 'Missing url parameter' }, 400);
  }
  if (!/^https?:\/\//i.test(targetUrl)) {
    return json({ error: 'url must start with http:// or https://' }, 400);
  }
  if (!env.PAGESPEED_API_KEY) {
    return json({ error: 'Server is not configured (missing PAGESPEED_API_KEY).' }, 500);
  }

  const apiUrl =
    'https://www.googleapis.com/pagespeedonline/v5/runPagespeed' +
    '?url=' + encodeURIComponent(targetUrl) +
    '&strategy=mobile' +
    '&key=' + env.PAGESPEED_API_KEY;

  try {
    const res = await fetch(apiUrl);
    const data = await res.json();

    if (data.error) {
      return json({ error: data.error.message || 'PageSpeed API error' }, 502);
    }
    return json(data, 200);
  } catch (err) {
    return json({ error: 'Could not reach PageSpeed API.' }, 502);
  }
}

async function handleSubmitReport(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { email, cfTurnstileResponse, url, performance, lcp } = body;

  if (!email || !email.includes('@')) {
    return json({ error: 'A valid email is required.' }, 400);
  }
  if (!url) {
    return json({ error: 'Missing report data — run the speed check first.' }, 400);
  }

  // Verify Turnstile (skipped automatically if the secret isn't configured yet)
  if (env.TURNSTILE_SECRET_KEY) {
    if (!cfTurnstileResponse) {
      return json({ error: 'Please complete the verification and try again.' }, 400);
    }
    const verifyRes = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: env.TURNSTILE_SECRET_KEY,
          response: cfTurnstileResponse,
          remoteip: request.headers.get('CF-Connecting-IP') || '',
        }),
      }
    );
    const verifyJson = await verifyRes.json();
    if (!verifyJson.success) {
      return json({ error: 'Verification failed. Please try again.' }, 400);
    }
  }

  // Push to Brevo
  if (env.BREVO_API_KEY) {
    try {
      const brevoBody = {
        email,
        attributes: {
          WEBSITE_URL: url,
          PAGESPEED_SCORE: performance,
          LCP: lcp,
        },
        updateEnabled: true,
      };
      if (env.BREVO_LIST_ID) {
        brevoBody.listIds = [Number(env.BREVO_LIST_ID)];
      }

      const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': env.BREVO_API_KEY,
        },
        body: JSON.stringify(brevoBody),
      });

      if (!brevoRes.ok) {
        const errJson = await brevoRes.json().catch(() => ({}));
        if (errJson.code !== 'duplicate_parameter') {
          console.error('Brevo error:', errJson);
        }
      }
    } catch (err) {
      console.error('Brevo request failed:', err);
    }
  }

  // Optional backup log to a Google Sheet
  if (env.SHEET_WEBHOOK_URL) {
    try {
      await fetch(env.SHEET_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          email,
          url,
          score: performance,
          lcp,
          ts: new Date().toISOString(),
        }),
      });
    } catch (err) {
      console.error('Sheet webhook failed:', err);
    }
  }

  return json({ ok: true }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
