// This file is the Cloudflare Pages "Advanced Mode" function for the
// speed.adcomp.xyz Pages project itself (this repo). It is SEPARATE from
// the standalone `black-limit-3a10` Worker, which has zone-level Routes
// (speed.adcomp.xyz/api/*, /pagespeed/report/*) that intercept those two
// paths before Pages ever sees them. Because of that route precedence,
// the /api/* and /pagespeed/report/* handling below never actually runs
// in production right now — but this file's fetch() still governs EVERY
// OTHER request on the domain, including "/", so it MUST fall back to
// env.ASSETS.fetch(request) for anything it doesn't explicitly handle.
// Removing that fallback breaks the entire live site (this happened once
// — don't repeat it).
//
// This worker is a PRODUCER only — it does NOT process the queue itself.
// pagespeed-worker (adcomp.xyz) is the consumer of pagespeed-queue and
// already has OPENAI_API_KEY / CF_AIG_TOKEN configured, so the AI
// diagnosis + email + R2 write all happen over there. This worker just
// needs to: check score, verify Turnstile, rate-limit, and enqueue —
// then later serve the finished report back from the shared R2 bucket.
//
// Needs only ONE new secret here: TURNSTILE_SECRET_KEY.
// Bindings needed: PAGESPEED_CACHE (KV), REPORTS (R2), QUEUE — same
// resources as pagespeed-worker uses, so reports/rate-limits are shared.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (path === '/api/pagespeed' && method === 'GET') {
      return handlePagespeed(request, env);
    }

    if (path === '/api/submit-report' && method === 'POST') {
      return handleSubmitReport(request, env, ctx);
    }

    if (method === 'GET' && path.startsWith('/pagespeed/report/')) {
      return handleReportFetch(path, env);
    }

    // Everything else: serve the static site (index.html, etc.)
    return env.ASSETS.fetch(request);
  },
};

// ─── Instant score check (unchanged) ─────────────────────────────────

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

// ─── Submission: verify → rate-limit → queue for async processing ────

async function handleSubmitReport(request, env, ctx) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { email, cfTurnstileResponse, url, performance } = body;

  if (!email || !email.includes('@')) {
    return json({ error: 'A valid email is required.' }, 400);
  }
  if (!url) {
    return json({ error: 'Missing report data — run the speed check first.' }, 400);
  }
  if (performance == null || performance === '') {
    return json({ error: 'Missing performance score — run the speed check first.' }, 400);
  }

  // ── Turnstile: actually enforced now, not just called ──────────────
  if (env.TURNSTILE_SECRET_KEY) {
    const passed = await verifyTurnstile(cfTurnstileResponse, ip, env);
    if (!passed) {
      return json({ error: 'Verification failed. Please try again.' }, 400);
    }
  }

  // ── Rate limit: same 3/hour/IP policy as the adcomp.xyz worker ─────
  if (env.PAGESPEED_CACHE) {
    const limited = await rateLimit(ip, env);
    if (limited) {
      return json({ error: 'Too many requests. Please try again in an hour.' }, 429);
    }
  }

  // ── Enqueue for pagespeed-worker's consumer to process ──────────────
  // (AI diagnosis, R2 write, and email all happen over there — this
  // worker just needs to hand off the submission.)
  if (!env.QUEUE) {
    return json({ error: 'Report queue is not configured yet.' }, 500);
  }
  await env.QUEUE.send({ ...body, origin: new URL(request.url).origin });

  // ── Backup log to the Page_Speed_main Google Sheet ──────────────────
  // Fire-and-forget via waitUntil so it never delays the response or
  // blocks submission if the Sheet/Apps Script is slow or down.
  if (env.SHEET_WEBHOOK_URL) {
    const logPromise = fetch(env.SHEET_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        email,
        url,
        score: performance,
        lcp: body.lcp,
        ts: new Date().toISOString(),
      }),
    }).catch((err) => console.error('Sheet webhook failed:', err));

    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(logPromise);
    } else {
      await logPromise;
    }
  }

  return json({ ok: true }, 200, true);
}

// ─── Report fetch (R2, UUID-gated, private) ──────────────────────────

async function handleReportFetch(path, env) {
  const reportKey = path.slice('/pagespeed/report/'.length);
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!reportKey || !uuidRegex.test(reportKey)) {
    return new Response('Not found', { status: 404 });
  }
  if (!env.REPORTS) {
    return new Response('Reports storage is not configured yet.', { status: 500 });
  }

  const obj = await env.REPORTS.get(`${reportKey}.html`);
  if (!obj) return new Response('Report not found.', { status: 404 });

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex',
      'Cache-Control': 'private, no-store',
    },
  });
}

// ─── Rate limiting (KV) ───────────────────────────────────────────────

async function rateLimit(ip, env) {
  const key = `rl:speed:${ip}`;
  const limit = 3;
  const windowMs = 3600000;
  const windowSecs = 3600;
  const now = Date.now();

  const raw = await env.PAGESPEED_CACHE.get(key);
  const hits = raw ? JSON.parse(raw) : [];
  const recent = hits.filter((t) => t > now - windowMs);

  if (recent.length >= limit) return true;

  recent.push(now);
  await env.PAGESPEED_CACHE.put(key, JSON.stringify(recent), { expirationTtl: windowSecs });
  return false;
}

// ─── Turnstile verification ───────────────────────────────────────────

async function verifyTurnstile(token, ip, env) {
  if (!token) return false;
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: ip,
    }),
  });
  const data = await resp.json();
  return data.success === true;
}

function json(obj, status, cors = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (cors) headers['Access-Control-Allow-Origin'] = '*';
  return new Response(JSON.stringify(obj), { status, headers });
}
