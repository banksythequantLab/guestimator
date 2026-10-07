// New-seller onboarding: the welcome email sent once when someone creates a Guestimator account
// (password or Google). Only Guestimator's own sign-up paths call it - Bottle Tree shares the
// users table but never reaches this code.

import { sendAlert } from "./notify.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const WELCOME_STEPS = [
  ["📷", "Snap 2–4 photos", "Front, back, any labels or maker's marks. Add anything you know about it."],
  ["💲", "Get a Guestimate", "A price range from what's actually selling now, plus the shipping box and weight."],
  ["🛒", "List it on eBay", "We write the listing on your own eBay account. You check it before it goes up."],
];

// Same rule as worker.js signupCredits: SIGNUP_CREDITS, default 5.
const freeN = env => { const n = Number(env.SIGNUP_CREDITS ?? 5); return Number.isFinite(n) && n > 0 ? Math.min(20, Math.floor(n)) : 0; };
export const freeCreditsLine = n => `${Number(n) || 0} free credit${Number(n) === 1 ? "" : "s"}`;

export function welcomeEmail(env, email, origin) {
  const link = `${origin}/`;
  const demo = /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(String(env.DEMO_VIDEO_URL || "")) ? env.DEMO_VIDEO_URL : null;
  const text = [
    "Welcome to Guestimator!", "",
    "Here's how to sell your first thing:",
    ...WELCOME_STEPS.map(([, t, d], i) => `${i + 1}. ${t} - ${d}`), "",
    "Free, no credits needed: garage & estate sale pages with QR price tags, buyers who pay online, and discounted shipping labels.",
    ...(freeN(env) ? [`You start with ${freeCreditsLine(freeN(env))}. They're already in your account. Rate an estimate and get another free credit.`] : []),
    "After that, estimates and eBay listings use credits - pick a pack in the app, or enter a code if you have one.", "",
    `Start here: ${link}`,
    ...(demo ? [`See it work in 30 seconds: ${demo}`] : []),
    ...(env.SUPPORT_EMAIL ? ["", "Just reply to this email if you get stuck."] : []),
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#ffffff;margin:0;padding:24px;color:#241b10">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:14px;padding:22px">
<div style="font-weight:800;font-size:20px;margin-bottom:6px">Welcome to Guestimator</div>
<div style="color:#6a5b44;font-size:14px;margin-bottom:14px">Here's how to sell your first thing.</div>
${WELCOME_STEPS.map(([i, t, d], n) => `<div style="display:flex;gap:10px;margin:10px 0"><div style="font-size:22px">${i}</div><div><b>${n + 1}. ${esc(t)}</b><div style="font-size:14px;color:#4a3d2a">${esc(d)}</div></div></div>`).join("")}
<div style="margin:16px 0;padding:12px;border-radius:10px;background:#efe4cc;font-size:14px"><b>Free, no credits needed:</b> garage &amp; estate sale pages with QR price tags, buyers who pay online, and discounted shipping labels.${freeN(env) ? `<br><b>You start with ${esc(freeCreditsLine(freeN(env)))}.</b> They're already in your account. Rate an estimate and get another free credit.` : ""}<br><span style="color:#6a5b44">After that, estimates and eBay listings use credits - pick a pack in the app, or enter a code if you have one.</span></div>
<a href="${esc(link)}" style="display:inline-block;background:#d97757;color:#ffffff;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px">Guestimate something</a>
${demo ? `<div style="margin-top:12px;font-size:14px"><a href="${esc(demo)}" style="color:#241b10;font-weight:700">&#9654; See it work in 30 seconds</a></div>` : ""}
${env.SUPPORT_EMAIL ? `<div style="margin-top:14px;font-size:12px;color:#6a5b44">Just reply to this email if you get stuck.</div>` : ""}</div></body></html>`;
  return sendAlert(env, { to: email, subject: "Welcome to Guestimator - sell your first thing", text, html, replyTo: env.SUPPORT_EMAIL || undefined });
}
