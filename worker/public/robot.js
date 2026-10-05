// GuessBot: a 60-second 8-bit loop shown while Guestimator works out a price. A little robot
// checks four antiques with a magnifying glass, then researches them on an old computer and
// finds the price (the in-app loop stops short of a price; see drawFrame). Everything is drawn with fillRect on a 160x90 canvas and scaled up with
// image-rendering: pixelated, so it is a few KB and stays crisp at any size. drawFrame(ctx, t)
// is pure (t in seconds), so the same code renders the MP4 frame by frame.
(function (root) {
  "use strict";
  const W = 160, H = 90, LOOP = 60, FPS = 12;
  const C = {
    wall: "#F4ECDC", stripe: "#EFE3CC", floor: "#B98F5E", plank: "#A67D4F", ink: "#241B10",
    metal: "#8FB3C9", metalD: "#5E8199", metalL: "#C4DBE8", visor: "#1D2A35", eye: "#7CF2D4",
    gold: "#E0B458", goldD: "#B8862F", glass: "#BFE8FF", green: "#0F6B59", greenL: "#3FBBA0",
    cobalt: "#1E44C4", rust: "#B4552B", red: "#E0503A", white: "#FFFFFF", wood: "#7A5230", woodD: "#5B3B20",
    beige: "#D9CFB4", beigeD: "#B3A784", screen: "#0B2A22", scrL: "#3DF2A0", scrD: "#1C7A55", shadow: "rgba(36,27,16,.18)",
  };
  // 3x5 pixel font: only the characters the scenes use.
  const F = {
    A: ["010", "101", "111", "101", "101"], C: ["011", "100", "100", "100", "011"], E: ["111", "100", "110", "100", "111"],
    G: ["011", "100", "101", "101", "011"], H: ["101", "101", "111", "101", "101"], I: ["111", "010", "010", "010", "111"],
    K: ["101", "110", "100", "110", "101"], L: ["100", "100", "100", "100", "111"], M: ["101", "111", "111", "101", "101"],
    N: ["110", "101", "101", "101", "101"], O: ["010", "101", "101", "101", "010"], P: ["110", "101", "110", "100", "100"],
    R: ["110", "101", "110", "101", "101"], S: ["011", "100", "010", "001", "110"], T: ["111", "010", "010", "010", "010"],
    U: ["101", "101", "101", "101", "111"], V: ["101", "101", "101", "101", "010"], W: ["101", "101", "111", "111", "101"],
    Y: ["101", "101", "010", "010", "010"], D: ["110", "101", "101", "101", "110"], F: ["111", "100", "110", "100", "100"],
    0: ["111", "101", "101", "101", "111"], 1: ["010", "110", "010", "010", "111"], 2: ["110", "001", "010", "100", "111"],
    3: ["110", "001", "010", "001", "110"], 4: ["101", "101", "111", "001", "001"], 5: ["111", "100", "110", "001", "110"],
    6: ["011", "100", "111", "101", "111"], 7: ["111", "001", "010", "010", "010"], 8: ["111", "101", "111", "101", "111"],
    9: ["111", "101", "111", "001", "110"], $: ["011", "110", "010", "011", "110"], "?": ["110", "001", "010", "000", "010"],
    "!": ["010", "010", "010", "000", "010"], "-": ["000", "000", "111", "000", "000"], ".": ["000", "000", "000", "000", "010"],
    " ": ["000", "000", "000", "000", "000"], ":": ["000", "010", "000", "010", "000"],
  };

  let g;   // the 2D context for the frame being drawn
  const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); };
  const P = (x, y, c) => R(x, y, 1, 1, c);
  function text(s, x, y, c, scale = 1) {
    let cx = Math.round(x);
    for (const ch of String(s).toUpperCase()) {
      const gl = F[ch] || F[" "];
      for (let r = 0; r < 5; r++) for (let k = 0; k < 3; k++) if (gl[r][k] === "1") R(cx + k * scale, y + r * scale, scale, scale, c);
      cx += 4 * scale;
    }
  }
  const textW = (s, scale = 1) => String(s).length * 4 * scale - scale;
  function ring(cx, cy, r, c, fill) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const d = Math.sqrt(x * x + y * y);
      if (fill && d < r - 0.5) P(cx + x, cy + y, fill);
      if (d >= r - 0.5 && d < r + 0.5) P(cx + x, cy + y, c);
    }
  }
  const step = t => Math.floor(t * FPS) / FPS;            // movement snaps to 12 fps, like old hardware
  const lerp = (a, b, k) => a + (b - a) * Math.max(0, Math.min(1, k));
  const blinkOn = t => (t % 3.1) < 0.12;

  // ---------- the robot ----------
  // x = left edge, feet on y=FLOOR. pose: walk | inspect | type | cheer | idle. lens: {x,y} when inspecting.
  const FLOOR = 74;
  function robot(x, t, pose, o = {}) {
    x = Math.round(x);
    const hop = pose === "cheer" ? Math.round(Math.abs(Math.sin(t * 7)) * 4) : 0;
    const bob = pose === "walk" ? (Math.floor(t * 8) % 2) : 0;
    const top = FLOOR - 30 - hop + bob;
    // shadow
    R(x + 1, FLOOR, 16, 1, C.shadow);
    // legs
    const lp = pose === "walk" ? (Math.floor(t * 8) % 2 ? 1 : -1) : 0;
    R(x + 4 + lp, top + 24, 3, 6 - bob - (lp > 0 ? 1 : 0), C.metalD);
    R(x + 11 - lp, top + 24, 3, 6 - bob - (lp < 0 ? 1 : 0), C.metalD);
    R(x + 3 + lp, top + 29 - bob, 5, 1, C.ink); R(x + 10 - lp, top + 29 - bob, 5, 1, C.ink);
    // body
    R(x + 2, top + 13, 14, 11, C.ink); R(x + 3, top + 14, 12, 9, C.metal); R(x + 3, top + 14, 12, 2, C.metalL);
    R(x + 6, top + 17, 6, 4, C.metalD);
    P(x + 7, top + 18, Math.floor(t * 3) % 2 ? C.greenL : C.gold); P(x + 10, top + 19, C.red);
    // head
    R(x + 1, top + 1, 16, 12, C.ink); R(x + 2, top + 2, 14, 10, C.metal); R(x + 2, top + 2, 14, 2, C.metalL);
    R(x + 4, top + 5, 10, 5, C.visor);
    const look = o.look ?? 1;   // eyes shift toward what it looks at
    if (!blinkOn(t)) { R(x + 5 + look, top + 6, 2, 3, C.eye); R(x + 10 + look, top + 6, 2, 3, C.eye); }
    else { R(x + 5 + look, top + 8, 2, 1, C.eye); R(x + 10 + look, top + 8, 2, 1, C.eye); }
    if (pose === "cheer") { R(x + 6, top + 9, 6, 1, C.eye); }      // smile on the visor
    // antenna
    R(x + 8, top - 3, 2, 4, C.ink); R(x + 7, top - 5, 4, 3, (Math.floor(t * 2) % 2) ? C.red : C.gold);
    // ears
    R(x, top + 5, 1, 4, C.metalD); R(x + 17, top + 5, 1, 4, C.metalD);
    // arms
    if (pose === "cheer") {
      R(x - 1, top + 6, 3, 9, C.metalD); R(x + 16, top + 6, 3, 9, C.metalD);
      R(x - 2, top + 4, 5, 3, C.ink); R(x + 15, top + 4, 5, 3, C.ink);
    } else if (pose === "type") {
      const a = Math.floor(t * 10) % 2;
      R(x + 15, top + 15, 7, 3, C.metalD); R(x + 21, top + 16 + a, 3, 2, C.ink);
      R(x + 13, top + 17, 7, 3, C.metalD); R(x + 19, top + 18 + (1 - a), 3, 2, C.ink);
    } else {
      const swing = pose === "walk" ? (Math.floor(t * 8) % 2 ? 1 : -1) : 0;
      R(x, top + 15 + swing, 2, 7, C.metalD); R(x - 1, top + 21 + swing, 3, 2, C.ink);
      if (pose === "inspect" && o.lens) {
        // arm reaches out to the magnifying glass held over the item
        const hx = x + 16, hy = top + 16, lx = o.lens.x, ly = o.lens.y;
        const n = Math.max(Math.abs(lx - hx), Math.abs(ly - hy));
        for (let i = 0; i <= n; i++) R(hx + (lx - hx) * i / n, hy + (ly - hy) * i / n, 2, 2, C.metalD);
        magnifier(lx, ly - 6, t);
      } else {
        R(x + 16, top + 15 - swing, 2, 7, C.metalD); R(x + 16, top + 21 - swing, 3, 2, C.ink);
        if (pose !== "type" && o.carry !== false) magnifier(x + 21, top + 15 - swing, t, true);
      }
    }
  }
  function magnifier(x, y, t, small) {
    const r = small ? 3 : 6;
    R(x - 1, y + r - 1, 2, small ? 4 : 7, C.wood);              // handle
    ring(x, y - (small ? 1 : 0), r, C.goldD, "rgba(191,232,255,.45)");
    if (!small) { P(x - 3, y - 3, C.white); P(x - 2, y - 4, C.white); if (Math.floor(t * 4) % 4 === 0) P(x + 3, y + 2, C.white); }
  }

  // ---------- scene 1: the antique table ----------
  const ITEMS = [
    { x: 46, draw: vase, name: "VASE" }, { x: 76, draw: clock, name: "CLOCK" },
    { x: 106, draw: teapot, name: "TEAPOT" }, { x: 134, draw: lamp, name: "LAMP" },
  ];
  function vase(x, y) { R(x + 3, y - 12, 4, 2, C.cobalt); R(x + 2, y - 10, 6, 1, C.cobalt); R(x + 1, y - 9, 8, 7, C.cobalt); R(x + 2, y - 2, 6, 2, C.cobalt); R(x + 3, y - 7, 4, 2, C.white); R(x + 2, y - 8, 1, 4, "#4F72E0"); }
  function clock(x, y) { R(x, y - 12, 11, 12, C.wood); R(x + 1, y - 13, 9, 1, C.wood); R(x + 2, y - 10, 7, 7, C.white); R(x + 5, y - 9, 1, 3, C.ink); R(x + 5, y - 7, 2, 1, C.ink); R(x, y - 1, 11, 1, C.woodD); }
  function teapot(x, y) { R(x + 2, y - 8, 8, 7, C.rust); R(x + 4, y - 10, 4, 2, C.rust); R(x + 5, y - 11, 2, 1, C.goldD); R(x + 10, y - 7, 2, 2, C.rust); R(x + 11, y - 9, 1, 2, C.rust); R(x, y - 7, 2, 4, C.rust); R(x + 3, y - 6, 2, 1, "#E07A50"); }
  function lamp(x, y) { R(x + 4, y - 2, 4, 2, C.goldD); R(x + 5, y - 10, 2, 8, C.gold); R(x + 1, y - 15, 10, 5, C.green); R(x + 2, y - 16, 8, 1, C.green); R(x + 2, y - 14, 2, 3, C.greenL); }
  const TABLE_Y = 58;
  function tableScene(t) {
    // wall with stripes, window, floor
    R(0, 0, W, FLOOR, C.wall);
    for (let x = 4; x < W; x += 10) R(x, 0, 3, FLOOR, C.stripe);
    R(8, 10, 22, 18, C.woodD); R(10, 12, 18, 14, "#A9D8F0"); R(18, 12, 2, 14, C.woodD); R(10, 18, 18, 2, C.woodD);
    R(0, FLOOR, W, H - FLOOR, C.floor); for (let x = 0; x < W; x += 16) R(x + ((x / 16) % 2) * 8, FLOOR + 4, 1, 4, C.plank);
    R(0, FLOOR + 9, W, 1, C.plank);
    // table
    R(38, TABLE_Y, 118, 3, C.wood); R(38, TABLE_Y + 3, 118, 1, C.woodD); R(42, TABLE_Y + 4, 3, FLOOR - TABLE_Y - 4, C.woodD); R(149, TABLE_Y + 4, 3, FLOOR - TABLE_Y - 4, C.woodD);
    for (const it of ITEMS) it.draw(it.x, TABLE_Y);
  }
  // 0-4 s walk in; then each item: 1.4 s walk + 3.1 s inspect (4.5 s), four items -> 22 s.
  function tablePhase(t) {
    const stand = i => ITEMS[i].x - 22;
    if (t < 4) return { x: lerp(-20, stand(0), t / 4), pose: "walk" };
    const k = t - 4, i = Math.min(3, Math.floor(k / 4.5)), u = k - i * 4.5;
    const from = i === 0 ? stand(0) : stand(i - 1);
    if (u < 1.4 && i > 0) return { x: lerp(from, stand(i), u / 1.4), pose: "walk", item: i };
    return { x: stand(i), pose: "inspect", item: i, u: i === 0 ? u : u - 1.4 };
  }
  function bubble(x, y, s, c = C.ink) {
    const w = textW(s) + 4;
    R(x - 1, y - 1, w + 2, 9, C.ink); R(x, y, w, 7, C.white); P(x + 2, y + 7, C.ink); P(x + 2, y + 8, C.ink);
    text(s, x + 2, y + 1, c);
  }

  // ---------- scene 2: the computer ----------
  const RESULTS = [["CROCK", 48], ["CROCK", 39], ["CROCK", 62], ["JUG", 55], ["CROCK", 44]];
  function deskScene(t) {
    R(0, 0, W, FLOOR, C.wall);
    for (let x = 4; x < W; x += 10) R(x, 0, 3, FLOOR, C.stripe);
    // shelf with books
    R(10, 20, 40, 2, C.wood); [C.rust, C.cobalt, C.green, C.gold, C.rust, C.green].forEach((c, i) => R(12 + i * 5, 10 + (i % 2), 4, 10 - (i % 2), c));
    R(0, FLOOR, W, H - FLOOR, C.floor); for (let x = 0; x < W; x += 16) R(x + ((x / 16) % 2) * 8, FLOOR + 4, 1, 4, C.plank);
    R(0, FLOOR + 9, W, 1, C.plank);
    // desk
    R(70, 56, 86, 3, C.wood); R(70, 59, 86, 1, C.woodD); R(74, 60, 3, FLOOR - 60, C.woodD); R(149, 60, 3, FLOOR - 60, C.woodD);
    // computer: beige CRT
    R(88, 18, 62, 38, C.beigeD); R(89, 19, 60, 35, C.beige); R(92, 22, 54, 28, C.screen);
    R(112, 54, 14, 2, C.beigeD); R(84, 52, 26, 4, C.beigeD); R(85, 52, 24, 2, C.beige);   // base + keyboard
    for (let k = 0; k < 6; k++) R(87 + k * 4, 52, 2, 1, C.beigeD);
    P(144, 51, Math.floor(t * 2) % 2 ? C.greenL : C.scrD);   // power light
  }
  // what the screen shows, by time into the scene
  function screen(u, t) {
    const X = 93, Y = 23, SW = 52;
    const scan = Math.floor(t * 12) % 26;
    if (u < 4) {                       // typing the search
      text("SEARCH", X + 1, Y + 1, C.scrD);
      R(X + 1, Y + 8, SW - 2, 7, C.scrD); R(X + 2, Y + 9, SW - 4, 5, C.screen);
      const q = "CROCK 3 GAL".slice(0, Math.floor(u * 3.5));
      text(q, X + 3, Y + 9, C.scrL);
      if (Math.floor(t * 4) % 2) R(X + 3 + textW(q) + 1, Y + 9, 2, 5, C.scrL);
    } else if (u < 13) {               // results scrolling in, prices ticking
      text("SOLD COMPS", X + 1, Y + 1, C.scrL);
      const n = Math.min(RESULTS.length, Math.floor((u - 4) * 1.2) + 1);
      for (let i = 0; i < n; i++) {
        const yy = Y + 8 + i * 6 - Math.max(0, Math.floor((u - 8) * 3));
        if (yy < Y + 7 || yy > Y + 21) continue;
        R(X + 1, yy + 1, 3, 2, i % 2 ? C.gold : C.rust);
        R(X + 6, yy + 1, 16 + (i * 5) % 9, 1, C.scrD);
        text("$" + RESULTS[i][1], X + 34, yy - 1, C.scrL);
      }
    } else if (u < 19) {               // bar chart of prices growing
      text("PRICES", X + 1, Y + 1, C.scrL);
      const bars = [39, 44, 48, 55, 62];
      bars.forEach((v, i) => { const h = Math.round(lerp(0, (v - 30) / 2, (u - 13) / 2.5)); R(X + 6 + i * 9, Y + 25 - h, 6, h, i === 2 ? C.gold : C.scrL); });
      R(X + 3, Y + 25, SW - 6, 1, C.scrD);
    } else {                           // the answer
      text("WORTH", X + 1, Y + 1, C.scrD);
      const on = u > 19.6 || Math.floor(t * 8) % 2;
      if (on) text("$40-60", X + 3, Y + 10, C.gold, 2);
    }
    R(X, Y + scan, SW, 1, "rgba(61,242,160,.08)");   // scanline
  }

  // ---------- frame ----------
  function caption(s, t) {
    const dots = ".".repeat(1 + Math.floor(t * 2) % 3);
    const str = s + dots, w = textW(s + "...");
    R(W / 2 - w / 2 - 3, 2, w + 6, 9, C.ink);
    text(str, W / 2 - w / 2, 4, C.gold);
  }
  function drawFrame(ctx, time, opts = {}) {
    g = ctx;
    // In the app the real price isn't known yet, so it never shows a made-up answer: it loops
    // the looking and researching (first 45 s) until the estimate arrives. The MP4 plays it all.
    const len = opts.inApp ? 45 : LOOP;
    const t = step(((time % len) + len) % len);
    g.imageSmoothingEnabled = false;
    if (t < 24) {
      tableScene(t);
      const ph = tablePhase(Math.min(t, 22));
      if (t >= 22) { robot(lerp(ITEMS[3].x - 22, W + 4, (t - 22) / 2), t, "walk"); }
      else if (ph.pose === "inspect") {
        const it = ITEMS[ph.item], u = ph.u;
        const sweep = Math.round(Math.sin(u * 3) * 2);
        const lens = { x: it.x + 5 + sweep, y: TABLE_Y - 2 };
        robot(ph.x, t, "inspect", { lens, look: 2 });
        if (u > 0.4 && u < 1.8) bubble(it.x - 2, TABLE_Y - 26, "?");
        if (u >= 1.8) bubble(it.x - 2, TABLE_Y - 26, "!", C.green);
        // magnified glint over the item
        if (u > 0.3) { P(lens.x - 2, lens.y - 8, C.white); }
      } else robot(ph.x, t, "walk");
      if (opts.caption !== false) caption(t < 22 ? "LOOKING CLOSELY" : "TO THE COMPUTER", t);
      if (t < 0.6) { g.fillStyle = `rgba(36,27,16,${1 - t / 0.6})`; g.fillRect(0, 0, W, H); }   // fade in from the loop's end
    } else if (t < 50) {
      deskScene(t);
      const u = t - 24;
      if (u < 2) robot(lerp(-20, 62, u / 2), t, "walk", { carry: true });
      else { robot(62, t, "type", { look: 2 }); screen(u - 2, t); }
      if (u >= 21 && u < 26) bubble(66, 31, "!", C.green);
      if (opts.caption !== false) caption(u < 21 ? "RESEARCHING" : "FOUND IT", t);
    } else {
      deskScene(t);
      const u = t - 50;
      screen(25, t);
      robot(62, t, u < 7 ? "cheer" : "idle", { look: 1 });
      // confetti stars
      for (let i = 0; i < 14; i++) {
        const sx = (i * 37 + 11) % W, sy = ((u * 22 + i * 13) % 70);
        if (u < 7) R(sx, sy, 2, 2, [C.gold, C.rust, C.cobalt, C.greenL][i % 4]);
      }
      if (opts.caption !== false) caption("PRICE READY", t);
      if (u > 9) { g.fillStyle = `rgba(36,27,16,${Math.min(1, (u - 9) / 1)})`; g.fillRect(0, 0, W, H); }   // fade to loop
    }
  }

  // ---------- in the app: mount on a canvas, run until stopped ----------
  function mount(canvas, opts = {}) {
    canvas.width = W; canvas.height = H;
    canvas.style.imageRendering = "pixelated";
    const ctx = canvas.getContext("2d");
    const reduce = root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t0 = performance.now() - (opts.start || 0) * 1000;
    let raf = 0, last = -1, alive = true;
    const tick = now => {
      if (!alive) return;
      if (!canvas.isConnected) { alive = false; return; }     // screen changed: stop by itself
      const t = reduce ? 30 : (now - t0) / 1000;
      const f = Math.floor(t * FPS);
      if (f !== last) { last = f; drawFrame(ctx, t, opts); }
      if (!reduce) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }
  root.GuessBot = { drawFrame, mount, W, H, LOOP, FPS };
})(typeof window !== "undefined" ? window : globalThis);
