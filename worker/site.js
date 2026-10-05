// Which front door a request came through. The Worker serves two sites from one backend and one
// set of accounts: Guestimator (app.theguestimator.com) and Instant Garage Sale (the hosts listed
// in IGS_HOSTS, comma-separated). Links the server writes - sale pages, QR tags, Stripe return
// URLs - stay on the site the seller is using.

export const igsHosts = env => String(env.IGS_HOSTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
export const isIgs = (env, url) => igsHosts(env).includes(String(url.hostname || "").toLowerCase());
export const siteOrigin = (env, url) => isIgs(env, url) ? url.origin : (env.PUBLIC_ORIGIN || url.origin);
