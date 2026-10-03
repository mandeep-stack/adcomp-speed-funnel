# AdComp PageSpeed funnel — Cloudflare Pages

## What changed from your original file
- Split into `public/index.html` (the page) and two server-side `functions/api/*.js` files.
- **Your Google PageSpeed API key and Google Apps Script URL were hardcoded in the page's JavaScript** (obfuscated as split string arrays, but fully reconstructable by anyone who opens dev tools). Moved both server-side — the browser now calls your own `/api/pagespeed` and `/api/submit-report` instead.
- Everything else — layout, styling, the three tracking events (`only_click`, `pre_email_submission`, `speed_report_generated`), Turnstile, the CAPI worker call — is unchanged.

## Deploy (Cloudflare dashboard, no CLI needed)
1. Go to **Workers & Pages → Create → Pages → Upload assets**.
2. Upload the **`public`** folder's contents as the site (or the whole `cf-pages` folder if Pages asks for the project root — it auto-detects `functions/`).
3. Name the project (e.g. `adcomp-speed-check`).

## Add the subdomain
1. Open the project → **Custom domains → Set up a domain**.
2. Enter `check.yourdomain.com` (or whatever you want).
3. If DNS is on Cloudflare, the CNAME is added for you. If not, add a CNAME: `check` → `<project>.pages.dev`.

## Set environment variables
Project → **Settings → Environment variables** (set for **Production**):

| Variable | Required | Value |
|---|---|---|
| `PAGESPEED_API_KEY` | Yes | Your Google PageSpeed Insights API key |
| `TURNSTILE_SECRET_KEY` | Recommended | Your Cloudflare Turnstile **secret** key (the page already has the site key) |
| `BREVO_API_KEY` | Yes, to reach Brevo | Your Brevo API key |
| `BREVO_LIST_ID` | Optional | Numeric Brevo list ID to add leads to |
| `SHEET_WEBHOOK_URL` | Optional | Your existing Google Apps Script `/exec` URL, if you still want a backup log |

After adding variables, click **Retry deployment** so the Functions pick them up.

## Test
1. Visit `check.yourdomain.com`, enter a URL, click Check Score.
2. Confirm the score renders and the email modal opens.
3. Submit an email — confirm it lands in Brevo.
4. Check GTM/Pixel events fire once (not twice) — this is where your "Once per page" trigger fix applies.

## ₹199 audit checkout (Razorpay popup)
- The four "Book Audit" buttons open an on-page form, then the Razorpay popup — no redirect to rzp.io.
- Order creation + payment verification run in `audit-worker/worker.js` (separate Cloudflare Worker, `adcomp-audit-worker`). Secrets (`WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`) live in that Worker's dashboard settings, never in this repo.
- The Worker's CORS allowlist includes `https://adcomp.xyz` and `https://speed.adcomp.xyz`. **Redeploy the Worker after merging** or the popup will fail silently on this subdomain.
- After payment the visitor is redirected to `https://adcomp.xyz/website-audit-scheduler/` (absolute URL, still on WordPress).
