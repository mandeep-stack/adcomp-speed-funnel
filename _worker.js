// Cloudflare Pages "Advanced Mode" worker for speed.adcomp.xyz
//
// /api/pagespeed      — instant, synchronous score check (unchanged: this is
//                        what renders on-page before the email modal).
// /api/submit-report  — now matches the adcomp.xyz "funnel-analyser" standard:
//                        Turnstile is actually verified (not just called),
//                        rate-limited via KV, queued for async AI diagnosis,
//                        stored in R2 under an unguessable UUID, and emailed
//                        as a link (not sent inline).
// GET /pagespeed/report/<uuid> — serves the generated report from R2.
// queue()             — the async consumer that builds the AI diagnosis,
//                        writes it to R2, and sends the report email.
//
// This file is written to share the SAME bindings as the adcomp.xyz
// funnel-analyser worker (see README for the binding names to wire up in
// the Cloudflare dashboard): PAGESPEED_CACHE (KV), REPORTS (R2), QUEUE.
// Using the identical resource IDs means a report generated from either
// site lands in the same bucket and is servable from either domain.

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
      return handleSubmitReport(request, env);
    }

    if (method === 'GET' && path.startsWith('/pagespeed/report/')) {
      return handleReportFetch(path, env);
    }

    // Everything else: serve the static site (index.html, etc.)
    return env.ASSETS.fetch(request);
  },

  // ─── Queue Consumer ─────────────────────────────────────────
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        await processSubmission(msg.body, env);
        msg.ack();
      } catch (e) {
        console.error('[QUEUE ERROR]', e.message);
        msg.retry();
      }
    }
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

async function handleSubmitReport(request, env) {
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

  // ── Queue for async AI diagnosis + R2 storage + email ──────────────
  if (env.QUEUE) {
    await env.QUEUE.send({ ...body, origin: url_originOf(request) });
  } else {
    // Fallback if the Queue binding isn't wired up yet: process inline so
    // nothing silently breaks while bindings are being set up.
    ctx_safeWait(processSubmission({ ...body, origin: url_originOf(request) }, env));
  }

  return json({ ok: true }, 200, true);
}

function url_originOf(request) {
  return new URL(request.url).origin;
}

// Best-effort inline fallback (no ctx.waitUntil available in this scope by
// design — this path only runs if you haven't wired the Queue binding yet,
// so don't rely on it long-term).
async function ctx_safeWait(promise) {
  try {
    await promise;
  } catch (e) {
    console.error('[INLINE PROCESS ERROR]', e.message);
  }
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

// ─── AI diagnosis (same model/prompt pattern as the adcomp.xyz worker) ─

const SYSTEM_PROMPT = `You are a senior web performance engineer and conversion optimisation expert. You work with ecommerce brands (primarily Indian D2C) to help them improve PageSpeed scores, Core Web Vitals, and ultimately conversions. You understand that every second of load time costs revenue, and you speak directly to business outcomes.

Your task: Analyse the PageSpeed Insights data provided and return a structured JSON diagnosis.

HOW TO ANALYZE:
Step 1 — Find the dominant bottleneck. Is this a render-blocking issue, image problem, server latency, layout instability, or JavaScript execution problem? One issue usually drives most of the score drop.
Step 2 — Interpret Core Web Vitals in business terms. LCP > 2.5s = visitors leaving before the page loads. High TBT = page feels frozen, kills mobile conversions. CLS > 0.1 = layout jumping destroys trust and causes mis-taps on mobile.
Step 3 — Prioritise by impact. Give 3 fixes in order of score improvement potential. Be specific about WHAT to do, not vague ("optimise images" → "convert hero image to WebP and add width/height attributes to eliminate CLS").
Step 4 — Give one operator-level insight that reframes how they think about page speed — connecting it to revenue, not just a technical metric.

TONE: Direct, technical but accessible. No filler phrases. Indian ecommerce context — mobile-first, often on 4G/Jio networks, Shopify or WooCommerce stacks are common.

Return a JSON object with EXACTLY this schema — no extra keys, no markdown, no text outside the JSON:
{
  "headline": <one sharp sentence naming the dominant issue, max 12 words>,
  "summary": <1 paragraph, 60-80 words, plain-English explanation of what is hurting this site's performance and why it matters for conversions>,
  "coreWebVitals": <1-2 paragraphs, 80-120 words, analyse LCP, CLS, TBT/FID specifically — what each score means for this site and what is likely causing it>,
  "fixes": [
    {"title": <3-6 word imperative action>, "detail": <2-3 sentences, specific and actionable — name the exact thing to change, not a category>},
    {"title": <3-6 word imperative action>, "detail": <2-3 sentences, specific and actionable>},
    {"title": <3-6 word imperative action>, "detail": <2-3 sentences, specific and actionable>}
  ],
  "insight": <1 sentence, 20-35 words, operator-level reframe connecting page speed to revenue or conversion rate>
}

DO NOT suggest booking a call. DO NOT mention AdComp by name inside the analysis. DO NOT use markdown inside JSON string values.`;

async function analyseWithAI(data, env) {
  const fmt = (v, fallback = 'not provided') => (v !== '' && v != null ? String(v) : fallback);
  const opportunitiesText =
    Array.isArray(data.opportunities) && data.opportunities.length
      ? data.opportunities.map((o) => `- ${o.title}${o.displayValue ? ': ' + o.displayValue : ''}`).join('\n')
      : 'Not provided';

  const userPrompt = `URL: ${data.url}

PageSpeed Scores (0–100):
- Performance: ${fmt(data.performance)}
- SEO: ${fmt(data.seo)}
- Accessibility: ${fmt(data.accessibility)}
- Best Practices: ${fmt(data.bestPractices)}

Core Web Vitals:
- LCP (Largest Contentful Paint): ${fmt(data.lcp)}
- FCP (First Contentful Paint): ${fmt(data.fcp)}
- CLS (Cumulative Layout Shift): ${fmt(data.cls)}
- TBT (Total Blocking Time): ${fmt(data.tbt)}
- Speed Index: ${fmt(data.si)}
- TTI (Time to Interactive): ${fmt(data.tti)}

Top Opportunities:
${opportunitiesText}

Return the JSON diagnosis now.`;

  const resp = await fetch(
    'https://gateway.ai.cloudflare.com/v1/8f30cb76465b1dfacd73a9c55dcfe17c/adcomp/openai/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1000,
        temperature: 0.6,
        response_format: { type: 'json_object' },
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI error: ${err}`);
  }
  const result = await resp.json();
  const raw = result.choices[0].message.content;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('AI returned invalid JSON');
  }
}

function scoreLabel(s) {
  return s >= 90 ? 'Good' : s >= 50 ? 'Needs Improvement' : 'Poor';
}
function scoreColor(s) {
  return s >= 90 ? '#34c759' : s >= 50 ? '#ff9500' : '#ff3b30';
}

function buildReportHTML(data, report) {
  const perf = Number(data.performance) || 0;
  const seo = Number(data.seo) || 0;
  const a11y = Number(data.accessibility) || 0;
  const bp = Number(data.bestPractices) || 0;
  const date = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  const cwvItems = [
    { label: 'LCP', value: data.lcp, good: '≤ 2.5s' },
    { label: 'FCP', value: data.fcp, good: '≤ 1.8s' },
    { label: 'CLS', value: data.cls, good: '≤ 0.1' },
    { label: 'TBT', value: data.tbt, good: '≤ 200ms' },
    { label: 'Speed Index', value: data.si, good: '≤ 3.4s' },
    { label: 'TTI', value: data.tti, good: '≤ 3.8s' },
  ].filter((m) => m.value != null && m.value !== '');

  const cwvHTML = cwvItems
    .map(
      (m) => `
    <div class="metric-card">
      <div class="metric-value">${m.value}</div>
      <div class="metric-label">${m.label}</div>
      <div class="metric-good">Good: ${m.good}</div>
    </div>`
    )
    .join('');

  const scoreItems = [
    { label: 'Performance', score: perf },
    { label: 'SEO', score: seo },
    { label: 'Accessibility', score: a11y },
    { label: 'Best Practices', score: bp },
  ];

  const scoresHTML = scoreItems
    .map(
      (s) => `
    <div class="score-pill">
      <div class="score-pill-ring" style="background:conic-gradient(${scoreColor(s.score)} ${s.score * 3.6}deg,#f2f2f7 0deg)">
        <div class="score-pill-inner">
          <span class="score-pill-num" style="color:${scoreColor(s.score)}">${s.score}</span>
        </div>
      </div>
      <div class="score-pill-label">${s.label}</div>
      <div class="score-pill-tag" style="color:${scoreColor(s.score)}">${scoreLabel(s.score)}</div>
    </div>`
    )
    .join('');

  const cwvParas = (report.coreWebVitals || '').split('\n\n').filter(Boolean).map((p) => `<p>${p}</p>`).join('');

  const fixesHTML = (report.fixes || [])
    .map(
      (fix, i) => `
    <div class="fix-item">
      <div class="fix-number">0${i + 1}</div>
      <div class="fix-body">
        <div class="fix-title">${fix.title || ''}</div>
        <div class="fix-detail">${fix.detail || ''}</div>
      </div>
    </div>`
    )
    .join('');

  const oppHTML =
    Array.isArray(data.opportunities) && data.opportunities.length
      ? data.opportunities
          .map(
            (o) => `
        <div class="opp-item">
          <span class="opp-title">${o.title}</span>
          ${o.displayValue ? `<span class="opp-value">${o.displayValue}</span>` : ''}
        </div>`
          )
          .join('')
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PageSpeed Report — ${data.url}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif;
    background: #f2f2f7;
    color: #1c1c1e;
    -webkit-font-smoothing: antialiased;
    padding: 40px 20px 80px;
  }
  .page { max-width: 680px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; }
  .logo { font-size: 16px; font-weight: 700; color: #1c1c1e; letter-spacing: -0.3px; }
  .logo span { color: #6e41e2; }
  .header-date { font-size: 13px; color: #8e8e93; }
  .eyebrow { font-size: 12px; font-weight: 600; color: #6e41e2; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 4px; }
  .page-url { font-size: 22px; font-weight: 700; color: #1c1c1e; letter-spacing: -0.4px; margin-bottom: 4px; word-break: break-all; }
  .title-block { margin-bottom: 20px; }
  .card { background: #fff; border-radius: 20px; padding: 28px; margin-bottom: 12px; }
  .card-label { font-size: 11px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: #8e8e93; margin-bottom: 16px; }
  .body-text { font-size: 15px; line-height: 1.75; color: #1c1c1e; }
  .body-text p { margin-bottom: 14px; }
  .body-text p:last-child { margin-bottom: 0; }
  .scores-row { display: flex; gap: 12px; justify-content: space-between; flex-wrap: wrap; }
  .score-pill { display: flex; flex-direction: column; align-items: center; flex: 1; min-width: 100px; }
  .score-pill-ring { width: 72px; height: 72px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-bottom: 8px; }
  .score-pill-inner { width: 56px; height: 56px; border-radius: 50%; background: #fff; display: flex; align-items: center; justify-content: center; }
  .score-pill-num { font-size: 20px; font-weight: 800; letter-spacing: -1px; }
  .score-pill-label { font-size: 12px; font-weight: 600; color: #1c1c1e; margin-bottom: 2px; text-align: center; }
  .score-pill-tag { font-size: 11px; font-weight: 500; text-align: center; }
  .metrics-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  @media (max-width: 520px) { .metrics-grid { grid-template-columns: repeat(2, 1fr); } }
  .metric-card { background: #f2f2f7; border-radius: 12px; padding: 14px 10px; text-align: center; }
  .metric-value { font-size: 17px; font-weight: 700; color: #1c1c1e; letter-spacing: -0.3px; margin-bottom: 2px; }
  .metric-label { font-size: 11px; font-weight: 600; color: #3a3a3c; margin-bottom: 2px; }
  .metric-good { font-size: 10px; color: #8e8e93; }
  .fix-item { display: flex; gap: 18px; padding: 18px 0; border-bottom: 1px solid #f2f2f7; }
  .fix-item:first-child { padding-top: 0; }
  .fix-item:last-child { border-bottom: none; padding-bottom: 0; }
  .fix-number { font-size: 30px; font-weight: 800; color: #e5e5ea; min-width: 38px; line-height: 1; letter-spacing: -1.5px; }
  .fix-title { font-size: 15px; font-weight: 600; color: #1c1c1e; margin-bottom: 5px; letter-spacing: -0.2px; }
  .fix-detail { font-size: 14px; line-height: 1.65; color: #3a3a3c; }
  .opp-item { display: flex; justify-content: space-between; align-items: baseline; padding: 10px 0; border-bottom: 1px solid #f2f2f7; gap: 12px; }
  .opp-item:last-child { border-bottom: none; padding-bottom: 0; }
  .opp-item:first-child { padding-top: 0; }
  .opp-title { font-size: 14px; color: #1c1c1e; }
  .opp-value { font-size: 13px; font-weight: 600; color: #ff9500; white-space: nowrap; }
  .insight-card { background: linear-gradient(135deg, #6e41e2, #4f8ef7); border-radius: 20px; padding: 28px; margin-bottom: 12px; }
  .insight-label { font-size: 11px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: rgba(255,255,255,0.6); margin-bottom: 12px; }
  .insight-text { font-size: 17px; font-weight: 500; color: #fff; line-height: 1.6; font-style: italic; letter-spacing: -0.1px; }
  .cta-card { background: #fff; border-radius: 20px; padding: 28px; text-align: center; margin-bottom: 12px; }
  .cta-heading { font-size: 17px; font-weight: 600; color: #1c1c1e; margin-bottom: 6px; }
  .cta-sub { font-size: 14px; color: #8e8e93; margin-bottom: 20px; line-height: 1.55; }
  .cta-btn { display: inline-block; background: #6e41e2; color: #fff; text-decoration: none; border-radius: 980px; padding: 14px 32px; font-size: 15px; font-weight: 600; cursor: pointer; -webkit-tap-highlight-color: rgba(0,0,0,0.1); touch-action: manipulation; }
  .footer { text-align: center; margin-top: 20px; }
  .footer p { font-size: 12px; color: #8e8e93; line-height: 1.7; }
  .footer a { color: #6e41e2; text-decoration: none; }
  @media (max-width: 600px) {
    body { padding: 24px 16px 60px; }
    .card { padding: 22px 20px; border-radius: 16px; }
    .page-url { font-size: 17px; }
    .scores-row { gap: 8px; }
    .score-pill-ring { width: 60px; height: 60px; }
    .score-pill-inner { width: 46px; height: 46px; }
    .score-pill-num { font-size: 17px; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="logo">Ad<span>Comp</span></div>
    <div class="header-date">${date}</div>
  </div>

  <div class="title-block">
    <div class="eyebrow">PageSpeed Report</div>
    <div class="page-url">${data.url}</div>
  </div>

  <div class="card">
    <div class="card-label">Lighthouse Scores</div>
    <div class="scores-row">${scoresHTML}</div>
  </div>

  <div class="card">
    <div class="card-label">Diagnosis</div>
    <div style="font-size:17px;font-weight:600;color:#1c1c1e;margin-bottom:12px;letter-spacing:-0.2px;">${report.headline || ''}</div>
    <div class="body-text">${report.summary || ''}</div>
  </div>

  <div class="card">
    <div class="card-label">Core Web Vitals</div>
    ${cwvHTML ? `<div class="metrics-grid" style="margin-bottom:20px;">${cwvHTML}</div>` : ''}
    <div class="body-text">${cwvParas}</div>
  </div>

  <div class="card">
    <div class="card-label">Priority Fixes</div>
    ${fixesHTML}
  </div>

  ${oppHTML ? `
  <div class="card">
    <div class="card-label">Opportunities Detected</div>
    ${oppHTML}
  </div>` : ''}

  <div class="insight-card">
    <div class="insight-label">Operator Insight</div>
    <div class="insight-text">"${report.insight || ''}"</div>
  </div>

  <div class="cta-card">
    <div class="cta-heading">Want these fixes implemented for you?</div>
    <div class="cta-sub">Get a full technical audit and fix plan for your site — done by AdComp.</div>
    <a href="https://pages.razorpay.com/webaudit" class="cta-btn" target="_blank">Book Audit - 199₹ →</a>
  </div>

  <div class="footer">
    <p>
      Generated by <a href="https://adcomp.xyz">AdComp</a> PageSpeed Audit · ${date}<br>
      You received this because you requested a PageSpeed audit at adcomp.xyz.
    </p>
  </div>
</div>
</body>
</html>`;
}

function buildEmailHTML(url, perfScore, reportUrl) {
  const color = scoreColor(perfScore);
  const label = scoreLabel(perfScore);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f7;padding:48px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td style="text-align:center;padding-bottom:24px;">
            <span style="font-size:17px;font-weight:700;color:#1c1c1e;">Ad<span style="color:#6e41e2;">Comp</span></span>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;border-radius:20px;padding:40px 36px 36px;text-align:center;">
            <div style="font-size:42px;line-height:1;margin-bottom:20px;">⚡</div>
            <h1 style="margin:0 0 10px;font-size:22px;font-weight:700;color:#1c1c1e;letter-spacing:-0.5px;line-height:1.3;">Your PageSpeed Report is Ready</h1>
            <p style="margin:0 0 6px;font-size:15px;color:#6e6e73;line-height:1.65;">We audited <strong style="color:#1c1c1e;">${url}</strong> and generated a full performance diagnosis with actionable fixes.</p>
            <p style="margin:0 0 24px;font-size:28px;font-weight:800;color:${color};">${perfScore}<span style="font-size:14px;font-weight:500;color:#8e8e93;"> / 100 — ${label}</span></p>
            <a href="${reportUrl}" style="display:inline-block;background:#6e41e2;color:#ffffff;text-decoration:none;border-radius:980px;padding:15px 36px;font-size:15px;font-weight:600;">View Full Report →</a>
          </td>
        </tr>
        <tr><td style="height:10px;"></td></tr>
        <tr>
          <td style="background:#ffffff;border-radius:20px;padding:22px 28px;text-align:center;">
            <p style="margin:0 0 10px;font-size:14px;color:#6e6e73;line-height:1.6;">Want help implementing the fixes? AdComp improves page speed, Core Web Vitals, and conversions for ecommerce brands.</p>
            <a href="https://pages.razorpay.com/webaudit" style="font-size:14px;font-weight:600;color:#6e41e2;text-decoration:none;">Book Audit - 199₹ →</a>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 0 0;text-align:center;">
            <p style="margin:0;font-size:12px;color:#8e8e93;line-height:1.7;">
              You received this because you requested a PageSpeed audit at <a href="https://adcomp.xyz" style="color:#6e41e2;text-decoration:none;">adcomp.xyz</a>.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function syncContact(email, env) {
  const resp = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
    body: JSON.stringify({
      email,
      listIds: env.BREVO_LIST_ID ? [Number(env.BREVO_LIST_ID)] : [29],
      updateEnabled: true,
    }),
  });
  if (!resp.ok) console.error('[BREVO CONTACT ERROR]', await resp.text());
  else console.log(`[BREVO CONTACT] Synced ${email}`);
}

async function sendReportEmail(email, url, perfScore, reportUrl, env) {
  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: 'Mandeep From AdComp', email: 'mandeep@mail.adcomp.xyz' },
      replyTo: { email: 'hey@adcomp.xyz' },
      to: [{ email }],
      subject: `Your PageSpeed Report — ${url}`,
      htmlContent: buildEmailHTML(url, perfScore, reportUrl),
      tags: ['pagespeed-audit', 'speed-adcomp-xyz'],
    }),
  });
  if (!resp.ok) throw new Error(`Brevo error: ${await resp.text()}`);
}

async function processSubmission(data, env) {
  const report = await analyseWithAI(data, env);
  const reportKey = crypto.randomUUID();
  const reportHtml = buildReportHTML(data, report);

  await env.REPORTS.put(`${reportKey}.html`, reportHtml, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
  });
  await env.REPORTS.put(
    `${reportKey}.json`,
    JSON.stringify({ submittedAt: new Date().toISOString(), input: data, report }),
    { httpMetadata: { contentType: 'application/json' } }
  );

  // Serve the report from whichever domain it was requested on, so both
  // adcomp.xyz and speed.adcomp.xyz can read/write the same R2 bucket
  // without stepping on each other's links.
  const origin = data.origin || 'https://speed.adcomp.xyz';
  const reportUrl = `${origin}/pagespeed/report/${reportKey}`;

  await Promise.all([
    sendReportEmail(data.email, data.url, Number(data.performance) || 0, reportUrl, env),
    env.BREVO_API_KEY ? syncContact(data.email, env) : Promise.resolve(),
  ]);

  console.log(`[PAGESPEED] Processed ${data.email} | ${data.url} | key=${reportKey}`);
}

function json(obj, status, cors = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (cors) headers['Access-Control-Allow-Origin'] = '*';
  return new Response(JSON.stringify(obj), { status, headers });
}
