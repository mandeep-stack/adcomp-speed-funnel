// AdComp Audit Order Worker
//
// Two jobs, routed by URL path on this same Worker:
//   POST /create-order   — called when the popup form is submitted.
//                          Creates the WooCommerce order + the matching
//                          Razorpay order, returns both IDs to the browser.
//   POST /verify-payment — called after Razorpay's popup succeeds.
//                          Verifies the payment signature and marks the
//                          WooCommerce order paid/completed.
//
// WHY BOTH LIVE HERE: the WordPress host (MilesWeb) reliably crashes
// (502) whenever WordPress's own PHP code calls Razorpay's API directly.
// Cloudflare Workers don't have that problem. Keeping creation AND
// verification in the same place also means both use the exact same
// Razorpay Key Secret — a mismatch between two different places storing
// that secret is what caused verification to fail before.
//
// SECURITY NOTES:
// - The Razorpay charge amount is NEVER taken from the browser. The
//   WooCommerce order is created first (priced from the real product),
//   and THAT order's real total is used for the Razorpay amount.
// - WooCommerce and Razorpay credentials live only in this Worker's
//   secrets (Cloudflare dashboard → Settings → Variables and Secrets),
//   never in this file.
// - CORS is locked to an allowlist (adcomp.xyz + speed.adcomp.xyz), not '*'.
// - This Worker has no Route bound to adcomp.xyz or speed.adcomp.xyz —
//   it only answers on its own workers.dev address, so it can't
//   intercept or conflict with any other Worker or Pages project.

// Both the WordPress page and the Cloudflare Pages subdomain call this Worker.
const ALLOWED_ORIGINS = ['https://adcomp.xyz', 'https://speed.adcomp.xyz'];
const WC_SITE_URL = 'https://adcomp.xyz';
const AUDIT_PRODUCT_ID = 996;

// Meta Conversions API (server-side Purchase on verified payment)
const META_PIXEL_ID = '797898887488783';
const META_API_VERSION = 'v20.0';

export default {
  async fetch(request, env, ctx) {
    const res = await route(request, env, ctx);
    // Echo back the caller's origin only if it is on the allowlist.
    const origin = request.headers.get('Origin') || '';
    const headers = new Headers(res.headers);
    if (ALLOWED_ORIGINS.includes(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
    } else {
      headers.delete('Access-Control-Allow-Origin');
    }
    headers.append('Vary', 'Origin');
    return new Response(res.body, { status: res.status, headers });
  },
};

async function route(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return corsResponse(null, 204);
  }
  if (request.method !== 'POST') {
    return corsResponse({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);

  if (url.pathname === '/verify-payment') {
    return handleVerifyPayment(request, env, ctx);
  }
  // Default: treat any other path (including just "/") as create-order.
  return handleCreateOrder(request, env);
}

async function handleCreateOrder(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse({ error: 'Invalid JSON body' }, 400);
  }

  const name    = String(body.name    || '').trim().slice(0, 200);
  const email   = String(body.email   || '').trim().slice(0, 200);
  const phone   = String(body.phone   || '').trim().slice(0, 50);
  const website = String(body.website || '').trim().slice(0, 300);

  if (!name || !email || !email.includes('@')) {
    return corsResponse({ error: 'A valid name and email are required.' }, 400);
  }
  if (!phone) {
    return corsResponse({ error: 'Phone number is required.' }, 400);
  }
  if (!website || !/^https?:\/\//i.test(website)) {
    return corsResponse({ error: 'A valid website URL is required.' }, 400);
  }

  if (!env.WC_CONSUMER_KEY || !env.WC_CONSUMER_SECRET) {
    return corsResponse({ error: 'Store is not configured (missing WooCommerce credentials).' }, 500);
  }
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    return corsResponse({ error: 'Payment gateway is not configured (missing Razorpay credentials).' }, 500);
  }

  const nameParts = name.split(' ');
  const firstName = nameParts[0];
  const lastName  = nameParts.slice(1).join(' ');

  // ── 1. Create the WooCommerce order (source of truth for the price) ──
  let order;
  try {
    const wcAuth = 'Basic ' + btoa(`${env.WC_CONSUMER_KEY}:${env.WC_CONSUMER_SECRET}`);
    const wcRes = await fetch(`${WC_SITE_URL}/wp-json/wc/v3/orders`, {
      method: 'POST',
      headers: {
        'Authorization': wcAuth,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; AdCompAuditWorker/1.0; +https://adcomp.xyz)',
      },
      body: JSON.stringify({
        status: 'pending',
        payment_method: 'razorpay',
        payment_method_title: 'Razorpay',
        set_paid: false,
        billing: {
          first_name: firstName,
          last_name: lastName,
          email: email,
          phone: phone,
        },
        line_items: [
          { product_id: AUDIT_PRODUCT_ID, quantity: 1 },
        ],
        meta_data: [
          { key: '_billing_website', value: website },
        ],
      }),
    });

    if (!wcRes.ok) {
      const errText = await wcRes.text();
      return corsResponse({ error: 'Could not create order.', detail: errText }, 502);
    }
    order = await wcRes.json();
  } catch (e) {
    return corsResponse({ error: 'Could not reach the store to create the order.' }, 502);
  }

  const wcOrderId = order.id;
  const orderKey  = order.order_key;
  const totalRupees = parseFloat(order.total);
  const amountPaise = Math.round(totalRupees * 100);

  if (!wcOrderId || !amountPaise) {
    return corsResponse({ error: 'Order was created but has no valid total.' }, 500);
  }

  // ── 2. Create the matching Razorpay order ──────────────────────────
  let rzpData;
  try {
    const rzpAuth = 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Authorization': rzpAuth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        receipt: 'wc_' + wcOrderId,
        notes: { wc_order_id: String(wcOrderId) },
      }),
    });

    rzpData = await rzpRes.json();
    if (!rzpRes.ok || !rzpData.id) {
      return corsResponse({ error: 'Payment gateway error creating order.', detail: rzpData }, 502);
    }
  } catch (e) {
    return corsResponse({ error: 'Could not reach the payment gateway.' }, 502);
  }

  // ── 3. Save the Razorpay order ID back onto the WooCommerce order ──
  // (best-effort — verification below doesn't strictly need this, the
  // signature check is the real proof)
  try {
    const wcAuth = 'Basic ' + btoa(`${env.WC_CONSUMER_KEY}:${env.WC_CONSUMER_SECRET}`);
    await fetch(`${WC_SITE_URL}/wp-json/wc/v3/orders/${wcOrderId}`, {
      method: 'PUT',
      headers: {
        'Authorization': wcAuth,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; AdCompAuditWorker/1.0; +https://adcomp.xyz)',
      },
      body: JSON.stringify({
        meta_data: [
          { key: '_razorpay_order_id', value: rzpData.id },
        ],
      }),
    });
  } catch (e) {
    // non-fatal, ignore
  }

  return corsResponse({
    wc_order_id: wcOrderId,
    order_key: orderKey,
    razorpay_order_id: rzpData.id,
    amount: rzpData.amount,
    currency: rzpData.currency,
    key_id: env.RAZORPAY_KEY_ID,
  }, 200);
}

async function handleVerifyPayment(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return corsResponse({ verified: false, error: 'Invalid JSON body' }, 400);
  }

  const wcOrderId    = parseInt(body.wc_order_id, 10);
  const orderKey     = String(body.order_key || '');
  const rzpOrderId   = String(body.razorpay_order_id   || '');
  const rzpPaymentId = String(body.razorpay_payment_id || '');
  const rzpSignature = String(body.razorpay_signature  || '');

  if (!wcOrderId || !rzpOrderId || !rzpPaymentId || !rzpSignature) {
    return corsResponse({ verified: false, error: 'Missing payment fields.' }, 400);
  }
  if (!env.RAZORPAY_KEY_SECRET) {
    return corsResponse({ verified: false, error: 'Payment gateway is not configured.' }, 500);
  }

  // This is the step that proves the payment is real — the same secret
  // that created the Razorpay order is used here, so there's no
  // mismatch possible (unlike when WordPress tried to do this with a
  // separately-configured copy of the secret).
  const expectedSignature = await hmacSha256Hex(env.RAZORPAY_KEY_SECRET, `${rzpOrderId}|${rzpPaymentId}`);
  if (expectedSignature !== rzpSignature) {
    await markOrderFailed(env, wcOrderId, 'Razorpay signature verification failed.');
    return corsResponse({ verified: false, error: 'Signature mismatch.' }, 400);
  }

  // Payment is proven real: send the Purchase to Meta in the background.
  // waitUntil keeps it off the response path, so it can never slow down or
  // break the customer's redirect.
  const metaTask = sendMetaPurchase(env, request, body, rzpOrderId, rzpPaymentId, wcOrderId);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(metaTask);

  // ── Mark the WooCommerce order paid ─────────────────────────────
  try {
    const wcAuth = 'Basic ' + btoa(`${env.WC_CONSUMER_KEY}:${env.WC_CONSUMER_SECRET}`);
    const wcRes = await fetch(`${WC_SITE_URL}/wp-json/wc/v3/orders/${wcOrderId}`, {
      method: 'PUT',
      headers: {
        'Authorization': wcAuth,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; AdCompAuditWorker/1.0; +https://adcomp.xyz)',
      },
      body: JSON.stringify({
        status: 'completed',
        set_paid: true,
        transaction_id: rzpPaymentId,
      }),
    });
    if (!wcRes.ok) {
      const errText = await wcRes.text();
      return corsResponse({ verified: true, fulfilled: false, error: 'Payment verified but order update failed.', detail: errText }, 200);
    }
  } catch (e) {
    return corsResponse({ verified: true, fulfilled: false, error: 'Payment verified but could not reach the store to update the order.' }, 200);
  }

  const redirectUrl = `${WC_SITE_URL}/website-audit-scheduler/`;

  return corsResponse({
    verified: true,
    fulfilled: true,
    order_id: wcOrderId,
    redirect_url: redirectUrl,
  }, 200);
}

// Sends a server-side Purchase to Meta. Never throws: any failure is logged
// and ignored so it cannot affect order handling.
async function sendMetaPurchase(env, request, body, rzpOrderId, rzpPaymentId, wcOrderId) {
  try {
    if (!env.META_ACCESS_TOKEN) {
      console.warn('[META PURCHASE] META_ACCESS_TOKEN not set — skipping');
      return;
    }

    // Amount, email and phone come straight from Razorpay (the source of
    // truth for what was actually charged), not from the browser.
    const rzpAuth = 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
    const payRes = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(rzpPaymentId)}`, {
      headers: { 'Authorization': rzpAuth },
    });
    const pay = await payRes.json();
    if (!payRes.ok || !pay || !pay.amount || pay.status === 'failed') {
      console.error('[META PURCHASE] Could not confirm payment with Razorpay', JSON.stringify(pay));
      return;
    }

    const userData = {};
    const email = String(pay.email || '').trim();
    if (email) userData.em = [await sha256Hex(email)];

    // Meta wants digits only, with country code (Indian numbers → 91…).
    let phone = String(pay.contact || '').replace(/\D/g, '');
    if (phone.length === 10) phone = '91' + phone;
    if (phone) userData.ph = [await sha256Hex(phone)];

    const fbp = String(body.fbp || '').slice(0, 200);
    const fbc = String(body.fbc || '').slice(0, 300);
    if (fbp) userData.fbp = fbp;
    if (fbc) userData.fbc = fbc;

    const ip = request.headers.get('CF-Connecting-IP') || '';
    const ua = request.headers.get('User-Agent') || '';
    if (ip) userData.client_ip_address = ip;
    if (ua) userData.client_user_agent = ua;

    const cf = request.cf || {};
    if (cf.country)    userData.country = [await sha256Hex(cf.country)];
    if (cf.region)     userData.st = [await sha256Hex(cf.region)];
    if (cf.city)       userData.ct = [await sha256Hex(String(cf.city).replace(/\s+/g, ''))];
    if (cf.postalCode) userData.zp = [await sha256Hex(cf.postalCode)];

    const sourceUrl = /^https:\/\//i.test(String(body.event_source_url || ''))
      ? String(body.event_source_url).slice(0, 500)
      : 'https://speed.adcomp.xyz/';

    const payload = {
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        // Razorpay payment id: unique per payment, so retries can't double count.
        event_id: rzpPaymentId,
        event_source_url: sourceUrl,
        action_source: 'website',
        user_data: userData,
        custom_data: {
          value: pay.amount / 100,
          currency: pay.currency || 'INR',
          content_type: 'product',
          content_ids: [String(AUDIT_PRODUCT_ID)],
          content_name: 'Website Audit Call',
          num_items: 1,
          order_id: String(wcOrderId),
        },
      }],
    };
    // Optional: set META_TEST_EVENT_CODE to see events in Events Manager → Test Events.
    if (env.META_TEST_EVENT_CODE) payload.test_event_code = env.META_TEST_EVENT_CODE;

    const metaRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    const metaData = await metaRes.json();
    if (!metaRes.ok || metaData.error) console.error('[META PURCHASE ERROR]', JSON.stringify(metaData));
    else console.log('[META PURCHASE OK] events_received:', metaData.events_received, 'payment:', rzpPaymentId);
  } catch (e) {
    console.error('[META PURCHASE FETCH ERROR]', e && e.message);
  }
}

// Plain SHA-256 (lowercase, trimmed) as Meta requires for user data.
async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text).trim().toLowerCase());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function markOrderFailed(env, wcOrderId, note) {
  try {
    const wcAuth = 'Basic ' + btoa(`${env.WC_CONSUMER_KEY}:${env.WC_CONSUMER_SECRET}`);
    await fetch(`${WC_SITE_URL}/wp-json/wc/v3/orders/${wcOrderId}`, {
      method: 'PUT',
      headers: {
        'Authorization': wcAuth,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; AdCompAuditWorker/1.0; +https://adcomp.xyz)',
      },
      body: JSON.stringify({ status: 'failed' }),
    });
  } catch (e) {
    // non-fatal, ignore
  }
}

// Web Crypto HMAC-SHA256, returned as lowercase hex (matches Razorpay's
// signature format exactly, same as PHP's hash_hmac('sha256', ...)).
async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const bytes = new Uint8Array(sigBuffer);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function corsResponse(data, status) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (data === null) {
    return new Response(null, { status, headers });
  }
  headers['Content-Type'] = 'application/json';
  return new Response(JSON.stringify(data), { status, headers });
}