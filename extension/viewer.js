(() => {
  const NEON = [205, 255, 20]; // the reel's yellow-green
  const LEAD = 0.12;
  const DEPTH = 520; // world distance between consecutive lines
  const FOCAL = 700;

  let canvas, ctx, meta;
  let trackKey = '';
  let lyrics = [];
  let status = '';
  let coverAccent = null;
  let useCover = true;
  let offset = 0;
  let toastUntil = 0;
  let pulse = 0;
  let lastKey = '';
  let idleTimer;
  let lastFrame = performance.now();
  let mx = 0, my = 0, smx = 0, smy = 0;
  let camX = 0, camY = 0, camZ = 0;
  const groups = new Map();
  const bursts = [];
  try { offset = parseFloat(localStorage.getItem('ytmc-offset')) || 0; } catch { /* storage blocked */ }

  const accent = () => (useCover && coverAccent ? coverAccent : NEON);
  const rgba = (a) => { const c = accent(); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
  const hot = (a) => { const c = accent(); return `rgba(${c.map((v) => Math.round(v + (255 - v) * 0.55)).join(',')},${a})`; };
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const rng = (s) => () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  function parseLrc(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
      const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
      if (!stamps.length) continue;
      const line = raw.replace(/\[[^\]]*\]/g, '').trim();
      const words = line ? line.split(/\s+/) : [];
      for (const s of stamps) out.push({ t: +s[1] * 60 + +s[2], words });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  let player = null, recvAt = 0;
  const playerTime = () => (player ? player.t + (player.paused ? 0 : (performance.now() - recvAt) / 1000) : 0);
  const waiting = () => !player || performance.now() - recvAt > 4000;

  function onTrackChange(t) {
    lyrics = [];
    groups.clear();
    status = 'Looking for synced lyrics…';
    meta.textContent = '';
    const b = document.createElement('div');
    b.textContent = t.title;
    const s = document.createElement('small');
    s.textContent = t.artist;
    meta.append(b, s);
    const key = trackKey;
    chrome.runtime.sendMessage({ type: 'lyrics', title: t.title, artist: t.artist, duration: t.duration }, (res) => {
      if (key !== trackKey) return;
      if (chrome.runtime.lastError || !res) { status = 'No synced lyrics found for this track'; return; }
      lyrics = parseLrc(res);
      status = lyrics.length ? '' : 'No synced lyrics found for this track';
    });
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type !== 'state') return;
    player = m;
    recvAt = performance.now();
    coverAccent = m.accent || null;
    const key = m.title + '|' + m.artist;
    if (key !== trackKey) { trackKey = key; onTrackChange(m); }
  });

  // ---------- constellation for one lyric line, placed in 3D ----------
  function buildGroup(idx) {
    const line = lyrics[idx];
    const n = line.words.length;
    const r = rng(idx * 9973 + 31);
    const next = lyrics[idx + 1];
    const total = line.words.reduce((a, w) => a + w.length + 1, 0);
    const gap = next ? next.t - line.t : 4;
    const dur = Math.min(gap * 0.95, 0.4 + total * 0.075);
    const speed = n / Math.max(0.8, dur); // words per second sets the mood
    const mood = speed < 2.2 ? 'calm' : speed < 4 ? 'mid' : 'hot';
    const cx = (r() - 0.5) * 260, cy = (r() - 0.5) * 160;
    const amp = 120 + r() * 90, cyc = 0.7 + r() * 0.9, ph = r() * 6.28;
    let acc = 0;
    const nodes = line.words.map((w, i) => {
      const start = line.t + (acc / total) * dur;
      acc += w.length + 1;
      const end = line.t + (acc / total) * dur;
      const f = n === 1 ? 0.5 : i / (n - 1);
      return {
        w: mood === 'hot' ? w.toUpperCase() : w, start, end,
        // longer-held words are brighter and bigger
        emph: clamp((end - start) / (dur / n) , 0.7, 1.8) * (0.8 + Math.min(w.length, 9) / 18),
        x: cx + (f - 0.5) * 860 + (r() - 0.5) * 50,
        y: cy + amp * Math.sin(f * 6.28 * cyc + ph) + (r() - 0.5) * 70,
        z: idx * DEPTH + (r() - 0.5) * 240,
        tw: r() * 6.28,
      };
    });
    const edges = [];
    for (let i = 1; i < n; i++) { edges.push([i - 1, i]); if (i > 1 && r() < 0.25) edges.push([i - 2, i]); }
    return { idx, mood, nodes, edges, cx, cy, lastBurst: -1 };
  }
  const getGroup = (i) => {
    if (!groups.has(i)) groups.set(i, buildGroup(i));
    return groups.get(i);
  };

  function star4(x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.quadraticCurveTo(x, y, x, y + r);
    ctx.quadraticCurveTo(x, y, x - r, y);
    ctx.quadraticCurveTo(x, y, x, y - r);
    ctx.fill();
  }

  // far dust that parallaxes with the camera
  const dust = Array.from({ length: 140 }, (_, i) => { const r = rng(i * 77 + 5); return { x: r(), y: r(), z: 0.15 + r() * 0.85, p: r() * 6.28 }; });
  function drawDust(W, H, now) {
    for (const d of dust) {
      const x = (((d.x - camX * 0.00005 * d.z - smx * 0.02 * d.z) % 1) + 1) % 1 * W;
      const y = (((d.y - camY * 0.00005 * d.z - smy * 0.02 * d.z) % 1) + 1) % 1 * H;
      ctx.fillStyle = rgba((0.1 + 0.25 * d.z) * (0.6 + 0.4 * Math.sin(now / 900 + d.p)));
      ctx.fillRect(x, y, 1 + d.z, 1 + d.z);
    }
  }

  // neon glowing screen rim, like the reel
  function drawRim(W, H, k) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const d = Math.min(W, H) * 0.16;
    const a = 0.2 + 0.28 * k;
    for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [
      [0, 0, 0, d, 0, 0, W, d], [0, H, 0, H - d, 0, H - d, W, d],
      [0, 0, d, 0, 0, 0, d, H], [W, 0, W - d, 0, W - d, 0, d, H],
    ]) {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, rgba(a));
      g.addColorStop(0.18, rgba(a * 0.28));
      g.addColorStop(1, rgba(0));
      ctx.fillStyle = g;
      ctx.fillRect(rx, ry, rw, rh);
    }
    ctx.restore();
    ctx.strokeStyle = hot(0.55 + 0.35 * k);
    ctx.lineWidth = 2;
    ctx.shadowColor = rgba(0.9);
    ctx.shadowBlur = 18;
    ctx.strokeRect(1, 1, W - 2, H - 2);
    ctx.shadowBlur = 0;
  }

  function fontFor(mood, size, bold) {
    if (mood === 'calm') return `${bold ? 400 : 300} ${size}px Georgia, 'Times New Roman', serif`;
    if (mood === 'hot') return `800 ${size}px system-ui, 'Segoe UI', sans-serif`;
    return `${bold ? 600 : 400} ${size}px system-ui, 'Segoe UI', sans-serif`;
  }

  // ---------- drawing one constellation ----------
  function drawGroup(g, t, W, H, U, live, now) {
    const proj = g.nodes.map((n) => {
      const d = n.z - camZ;
      const s = FOCAL / (FOCAL + d);
      const sway = 1 + d / 900;
      return {
        d, s,
        x: W / 2 + (n.x - camX + smx * 40 * sway) * s * U,
        y: H / 2 + (n.y - camY + smy * 28 * sway) * s * U,
      };
    });
    let active = -1;
    g.nodes.forEach((n, i) => { if (t >= n.start) active = i; });
    const isLive = live && active >= 0 && t < g.nodes[g.nodes.length - 1].end + 0.8;
    const fogOf = (p) => clamp(1 - p.d / 1500, 0, 1) * clamp(1 + p.d / 320, 0, 1);

    ctx.lineCap = 'round';
    for (const [a, b] of g.edges) {
      const pa = proj[a], pb = proj[b];
      const fog = Math.min(fogOf(pa), fogOf(pb));
      if (fog <= 0.01) continue;
      const lit = t >= g.nodes[b].start;
      const k = lit ? ease(Math.min(1, (t - g.nodes[b].start) / 0.4)) : 0;
      ctx.lineWidth = Math.max(0.6, 1.4 * pa.s);
      ctx.strokeStyle = rgba(0.09 * fog);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      if (k > 0) {
        ctx.shadowColor = rgba(0.8); ctx.shadowBlur = 8;
        ctx.strokeStyle = rgba(0.55 * fog);
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pa.x + (pb.x - pa.x) * k, pa.y + (pb.y - pa.y) * k); ctx.stroke();
        ctx.shadowBlur = 0;
        if (live && b === active && k < 1) {
          ctx.fillStyle = hot(0.95);
          ctx.beginPath(); ctx.arc(pa.x + (pb.x - pa.x) * k, pa.y + (pb.y - pa.y) * k, 3.2 * pa.s * U / 1.2, 0, 6.283); ctx.fill();
        }
      }
    }

    g.nodes.forEach((n, i) => {
      const p = proj[i];
      const fog = fogOf(p);
      if (fog <= 0.01) return;
      const lit = t >= n.start;
      const tw = 0.75 + 0.25 * Math.sin(now / 520 + n.tw);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (!lit) {
        // a faint seed of the star to come
        ctx.fillStyle = rgba(0.32 * fog * tw);
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.2, 2.2 * p.s * U), 0, 6.283); ctx.fill();
        return;
      }
      if (i === active && isLive) {
        const age = t - n.start;
        let size = (40 + 40 * ease(Math.min(1, age / 0.28))) * n.emph * p.s * U;
        ctx.font = fontFor(g.mood, size, true);
        const w0 = ctx.measureText(n.w).width;
        const maxW = W * 0.8;
        if (w0 > maxW) { size *= maxW / w0; ctx.font = fontFor(g.mood, size, true); }
        const w = ctx.measureText(n.w).width;
        const x = clamp(p.x, w / 2 + 24, W - w / 2 - 24), y = clamp(p.y, size, H - size * 1.6);
        const prog = clamp((t - n.start) / Math.max(0.25, n.end - n.start), 0, 1);
        ctx.fillStyle = rgba(0.3 * fog);
        ctx.fillText(n.w, x, y);
        ctx.save();
        ctx.beginPath(); ctx.rect(x - w / 2 - 8, y - size, (w + 16) * prog, size * 2); ctx.clip();
        ctx.shadowColor = rgba(1); ctx.shadowBlur = 34;
        ctx.fillStyle = hot(fog);
        ctx.fillText(n.w, x, y);
        ctx.fillText(n.w, x, y);
        ctx.restore();
        if (age < 0.9) {
          ctx.strokeStyle = rgba(0.5 * (1 - age / 0.9)); ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(x, y + size * 0.85, 8 + age * 150 * U / 1.2, 0, 6.283); ctx.stroke();
        }
        ctx.shadowColor = rgba(1); ctx.shadowBlur = 22;
        ctx.fillStyle = hot(1);
        star4(x, y + size * 0.85, Math.max(8, size * 0.2));
        ctx.shadowBlur = 0;
        if (g.lastBurst !== i) { g.lastBurst = i; pulse = 1; if (live) bursts.push({ x, y, t0: now }); }
      } else {
        const size = Math.max(9, 24 * n.emph * p.s * U);
        ctx.font = fontFor(g.mood, size, false);
        ctx.shadowColor = rgba(0.9); ctx.shadowBlur = 9;
        ctx.fillStyle = rgba(clamp(0.7 * fog * tw, 0, 1));
        ctx.fillText(n.w, p.x, p.y);
        star4(p.x, p.y + size * 0.85, Math.max(2.5, size * 0.17));
        ctx.shadowBlur = 0;
      }
    });
  }

  function drawBursts(now) {
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      const p = (now - b.t0) / 900;
      if (p > 1) { bursts.splice(i, 1); continue; }
      ctx.fillStyle = hot((1 - p) * 0.9);
      for (let k = 0; k < 8; k++) {
        const a = k * 0.785 + b.t0;
        const r = 20 + ease(p) * 70;
        ctx.beginPath(); ctx.arc(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r * 0.6, 1.6 * (1 - p) + 0.4, 0, 6.283); ctx.fill();
      }
    }
  }

  function drawFrame(now) {
    requestAnimationFrame(drawFrame);
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    const dpr = devicePixelRatio || 1;
    const W = innerWidth, H = innerHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const U = Math.min(W / 1300, H / 760) * 1.5;
    const t = playerTime() + LEAD + offset;

    let idx = -1;
    for (let i = 0; i < lyrics.length; i++) { if (lyrics[i].t <= t) idx = i; else break; }
    const focus = Math.max(0, idx);
    const target = lyrics.length ? getGroup(focus) : null;
    smx += (mx - smx) * Math.min(1, dt * 3);
    smy += (my - smy) * Math.min(1, dt * 3);
    pulse *= Math.pow(0.04, dt);
    if (target) {
      // follow the sung word, drifting through the field
      const act = target.nodes.filter((n) => t >= n.start).pop() || target.nodes[0];
      const k = 1 - Math.pow(0.06, dt);
      camX += (act.x * 0.55 + target.cx * 0.45 - camX) * k;
      camY += (act.y * 0.55 + target.cy * 0.45 - camY) * k;
      camZ += (focus * DEPTH - camZ) * (1 - Math.pow(0.12, dt));
    }

    drawDust(W, H, now);
    drawRim(W, H, 0.5 * (0.5 + 0.5 * Math.sin(now / 1100)) + 0.5 * pulse);

    if (target) {
      const order = [];
      for (let i = focus - 1; i <= focus + 3; i++) if (i >= 0 && i < lyrics.length && lyrics[i].words.length) order.push(i);
      order.sort((a, b) => b - a); // far first
      for (const i of order) drawGroup(getGroup(i), t, W, H, U, i === idx, now);
      for (const k of groups.keys()) if (k < focus - 3) groups.delete(k);
    }
    drawBursts(now);

    if (performance.now() < toastUntil) {
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.textAlign = 'center';
      ctx.fillText(`Lyrics offset ${offset >= 0 ? '+' : ''}${offset.toFixed(1)}s`, W / 2, H - 28);
    }
    const msg = waiting() ? 'Waiting for YouTube Music… play a song in the other tab' : status;
    if (msg) {
      ctx.font = '500 16px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(msg, W / 2, H / 2);
    }
  }

  function nudge(d) {
    offset = Math.round((offset + d) * 10) / 10;
    toastUntil = performance.now() + 1500;
    try { localStorage.setItem('ytmc-offset', String(offset)); } catch { /* storage blocked */ }
  }
  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());

  function init() {
    canvas = document.getElementById('ytmc-canvas');
    ctx = canvas.getContext('2d');
    meta = document.getElementById('ytmc-meta');
    addEventListener('keydown', (e) => {
      if (e.key === '[') nudge(-0.1);
      else if (e.key === ']') nudge(0.1);
      else if (e.key === 'f' || e.key === 'F') toggleFs();
      else if (e.key === 'c' || e.key === 'C') useCover = !useCover;
    });
    addEventListener('dblclick', toggleFs);
    addEventListener('mousemove', (e) => {
      mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5;
      document.body.classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
    });
    requestAnimationFrame(drawFrame);
  }
  init();
})();
