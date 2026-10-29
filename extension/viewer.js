(() => {
  const NEON = [205, 255, 20]; // the reel's yellow-green
  const LEAD = 0.12;
  const DEPTH = 520; // world distance between consecutive lines
  const FOCAL = 700;
  const GAP_MIN = 3; // seconds of silence before the wave takes over

  let canvas, ctx, meta;
  let trackKey = '';
  let lyrics = [];
  let panelLyr = ''; // lyrics text YouTube Music itself shows (if its Lyrics tab was opened)
  const scriptOf = (s) => {
    const counts = { deva: 0, guru: 0, beng: 0, latin: 0 };
    for (const c of s.match(/\p{L}/gu) || []) { const k = c.codePointAt(0); if (k >= 0x900 && k <= 0x97f) counts.deva++; else if (k >= 0xa00 && k <= 0xa7f) counts.guru++; else if (k >= 0x980 && k <= 0x9ff) counts.beng++; else if (k < 0x250) counts.latin++; }
    const [script, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return count ? script : '';
  };
  let status = '';
  let coverAccent = null;
  let useCover = true;
  let offset = 0;
  let toastUntil = 0;
  let pulse = 0;
  let lastKey = '';
  let idleTimer;
  let rafId = 0;
  let helpVisible = false;
  let reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
  let lastFrame = performance.now();
  let mx = 0, my = 0, smx = 0, smy = 0;
  let camX = 0, camY = 0, camZ = 0;
  const groups = new Map();
  const bursts = [];
  let lrcDur = 0; // length of the LRCLIB recording the lyrics were timed against
  const offKey = () => 'lyrastra-offset:' + (trackKey || '') + (player?.duration > 0 ? '|' + Math.round(player.duration) : '');
  const loadOffset = () => { offset = 0; try { offset = parseFloat(localStorage.getItem(offKey())) || 0; } catch { /* storage blocked */ } };

  const accent = () => (useCover && coverAccent ? coverAccent : NEON);
  const rgba = (a) => { const c = accent(); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
  const hot = (a) => { const c = accent(); return `rgba(${c.map((v) => Math.round(v + (255 - v) * 0.55)).join(',')},${a})`; };
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const rng = (s) => () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  function parseLrc(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      // Ignore metadata tags while supporting multiple timestamps on one line.
      const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
      if (!stamps.length) continue;
      const line = raw.replace(/\[[^\]]*\]/g, '').trim();
      const words = line ? line.split(/\s+/) : [];
      for (const match of stamps) {
        const seconds = Number(match[2].replace(':', '.'));
        const t = Number(match[1]) * 60 + seconds;
        if (Number.isFinite(t) && t >= 0) out.push({ t, words });
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out.reduce((acc, item) => {
      const last = acc[acc.length - 1];
      if (last && Math.abs(last.t - item.t) < 0.001) { if (item.words.length) last.words = item.words; }
      else acc.push(item);
      return acc;
    }, []);
  }

  let player = null, recvAt = 0;
  const playerTime = () => (player ? player.t + (player.paused ? 0 : (performance.now() - recvAt) / 1000) : 0);
  const waiting = () => !player || performance.now() - recvAt > 4000;

  let fetchSeq = 0;
  let lastDur = 0, lastT = 0;

  function onTrackChange(t, prevDur = 0) {
    lyrics = [];
    groups.clear();
    status = 'Looking for synced lyrics…';
    meta.textContent = '';
    const b = document.createElement('div');
    b.textContent = t.title;
    const s = document.createElement('small');
    s.textContent = t.artist;
    meta.append(b, s);
    loadLyrics(t, ++fetchSeq, 0, prevDur);
  }

  // The player bar text can change before the video's duration is known, and a lookup can fail
  // transiently (service worker asleep, network). Wait for the duration, then retry a few times.
  function loadLyrics(t, seq, attempt, prevDur = 0) {
    const sameTrack = player && player.title === t.title && player.artist === t.artist;
    const dur = sameTrack && player.duration > 0 ? player.duration : (t.duration || 0);
    // on auto-advance the bar shows the new title while the player still reports the old song's
    // length: wait (briefly) for a length that is known and has moved on from the previous song
    const stale = prevDur > 0 && Math.abs(dur - prevDur) < 0.5 && player && player.t > 3;
    if ((!(dur > 0) || stale) && attempt < 6) { setTimeout(() => seq === fetchSeq && loadLyrics(t, seq, attempt + 1, prevDur), 400); return; }
    chrome.runtime.sendMessage({ type: 'lyrics', title: t.title, artist: t.artist, duration: dur, script: scriptOf(panelLyr) }, (res) => {
      if (seq !== fetchSeq) return;
      const failed = chrome.runtime.lastError || !res || res.error;
      if (failed && attempt < 4) { setTimeout(() => seq === fetchSeq && loadLyrics(t, seq, attempt + 1, 0), 1000 * (attempt + 1)); return; }
      lyrics = !failed && res.lrc ? parseLrc(res.lrc) : [];
      lrcDur = !failed && res.dur ? res.dur : 0;
      status = lyrics.length ? '' : failed ? 'Lyrics lookup failed' : 'No synced lyrics for this track';
      // never leave a song stuck: quietly look again a few times (LRCLIB may be slow or the worker asleep)
      if (!lyrics.length && attempt < 8) setTimeout(() => seq === fetchSeq && !lyrics.length && loadLyrics(t, seq, attempt + 3, 0), 15000);
    });
  }

  let playSrc = '', playAt = 0;
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type !== 'state') return;
    if (!['ytm', 'spotify'].includes(m.src) || !String(m.title || '').trim()) return;
    // Normalize fields from content scripts before using them in timing and rendering.
    m = { ...m, title: String(m.title).trim().slice(0, 300), artist: String(m.artist || '').trim().slice(0, 300), t: Number.isFinite(Number(m.t)) ? Math.max(0, Number(m.t)) : 0, duration: Number.isFinite(Number(m.duration)) ? Math.max(0, Number(m.duration)) : 0, paused: Boolean(m.paused) };
    // YouTube Music and Spotify tabs may both be open: a paused one must not override the playing one
    const now = performance.now();
    // Prefer a source that is actively playing; ignore stale paused-tab updates briefly.
    if (!m.paused) { playSrc = m.src; playAt = now; }
    else if (m.src !== playSrc && now - playAt < 2500) return;
    const prev = player;
    const previousTrackKey = trackKey;
    const previousDuration = lastDur;
    if (m.lyr) panelLyr = String(m.lyr.text || '').slice(0, 12000);
    player = m;
    recvAt = performance.now();
    coverAccent = Array.isArray(m.accent) && m.accent.length >= 3 && m.accent.slice(0, 3).every((v) => Number.isFinite(v) && v >= 0 && v <= 255) ? m.accent.slice(0, 3) : null;
    const key = String(m.src || '') + '|' + String(m.title || '').trim() + '|' + String(m.artist || '').trim();
    // Capture the previous duration before updating it. Otherwise auto-advance stale-duration
    // detection compares the new duration to itself and never gets a chance to work.
    const restarted = prev && key === previousTrackKey && m.t < lastT - 3 && m.t < 2;
    const recut = key === previousTrackKey && previousDuration > 0 && m.duration > 0 && Math.abs(m.duration - previousDuration) > 3;
    lastT = Number.isFinite(m.t) ? m.t : 0;
    if (m.duration > 0) lastDur = m.duration;
    if (key !== previousTrackKey || recut) {
      if (key !== previousTrackKey && !m.lyr) panelLyr = '';
      const pd = key !== previousTrackKey ? previousDuration : 0;
      trackKey = key;
      lastDur = m.duration || 0;
      loadOffset();
      onTrackChange(m, pd);
    } else if (restarted && !lyrics.length) onTrackChange(m);
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

  // neon rim: a bright arc orbits the screen edge and leaves a dark gap, like the reel
  // Edge light as in the reel: one lit stretch (about half the lap, even brightness, short soft
  // ends) circling the screen counter-clockwise with a dark gap behind it, ~2.5 s per lap.
  const RIM_PERIOD = 2500, RIM_ARC = 0.55, RIM_SOFT = 0.07, RIM_SEG = 48;
  const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  function rimLevel(u, head) { // u = position along the lap, head = leading end of the lit stretch
    const d = (head - u + 1) % 1; // distance behind the head
    if (d > RIM_ARC) return 0;
    return smooth(d / RIM_SOFT) * smooth((RIM_ARC - d) / RIM_SOFT) * 0.15 + 0.85 * smooth(d / RIM_SOFT) * smooth((RIM_ARC - d) / (RIM_SOFT * 2));
  }
  function drawRim(W, H, k, now) {
    const head = reducedMotion ? 0.3 : 1 - (now / RIM_PERIOD) % 1;
    const P = 2 * (W + H), dep = Math.min(W, H) * 0.04, a = 0.45 + 0.35 * k;
    const sides = [ // clockwise from the top-left corner
      { len: W, at: (t) => [t * W, 0], gx: 0, gy: 1 },
      { len: H, at: (t) => [W, t * H], gx: -1, gy: 0 },
      { len: W, at: (t) => [W - t * W, H], gx: 0, gy: -1 },
      { len: H, at: (t) => [0, H - t * H], gx: 1, gy: 0 },
    ];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'butt';
    let off = 0;
    for (const sd of sides) {
      for (let i = 0; i < RIM_SEG; i++) {
        const t0 = i / RIM_SEG, t1 = (i + 1) / RIM_SEG;
        const lv = rimLevel((off + (t0 + t1) / 2 * sd.len) / P, head);
        if (lv < 0.01) continue;
        const [x0, y0] = sd.at(t0), [x1, y1] = sd.at(t1);
        const gx = sd.gx, gy = sd.gy;
        const g = ctx.createLinearGradient(x0, y0, x0 + gx * dep, y0 + gy * dep); // inner glow
        g.addColorStop(0, rgba(a * lv * 0.55)); g.addColorStop(1, rgba(0));
        ctx.fillStyle = g;
        ctx.fillRect(Math.min(x0, x1, x0 + gx * dep), Math.min(y0, y1, y0 + gy * dep),
          Math.abs(x1 - x0) + Math.abs(gx) * dep + 0.6, Math.abs(y1 - y0) + Math.abs(gy) * dep + 0.6);
        ctx.beginPath();
        ctx.moveTo(x0 + gx * 1.5, y0 + gy * 1.5); ctx.lineTo(x1 + gx * 1.5, y1 + gy * 1.5);
        ctx.strokeStyle = hot(Math.min(1, lv)); ctx.lineWidth = 3;
        ctx.stroke();
      }
      off += sd.len;
    }
    ctx.restore();
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
    for (let i = 0; i < g.nodes.length; i++) { if (t >= g.nodes[i].start) active = i; else break; }
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
        if (fog > 0.5) { ctx.shadowColor = rgba(0.9); ctx.shadowBlur = 9; }
        ctx.fillStyle = rgba(clamp(0.7 * fog * tw, 0, 1));
        ctx.fillText(n.w, p.x, p.y);
        star4(p.x, p.y + size * 0.85, Math.max(2.5, size * 0.17));
        ctx.shadowBlur = 0;
      }
    });
  }

  // While no lyric is being sung (gaps, intro, outro, no lyrics) the constellation fades away and a
  // glowing wave takes over; when the next line begins the wave settles and the stars light up again.
  let ambient = 0; // 0..1 eased
  function drawWave(W, H, now, dt, on) {
    ambient += ((on ? 1 : 0) - ambient) * Math.min(1, dt * (on ? 2.2 : 4));
    if (ambient < 0.01) return;
    const playing = player && !player.paused;
    const cy = H / 2 + smy * 20, tm = now / 1000;
    const amp = H * 0.11 * (0.55 + 0.45 * Math.sin(tm * 1.3)) * (playing ? 1 : 0.25) + H * 0.02;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const step = Math.max(4, W / 220);
    for (let k = 0; k < 5; k++) {
      const f = k / 4;
      ctx.beginPath();
      for (let x = 0; x <= W + step; x += step) {
        const u = x / W, edge = Math.sin(u * Math.PI); // pinned to calm at both sides
        const y = cy
          + Math.sin(u * 7 + tm * (1.1 + f * 0.5) + k) * amp * edge
          + Math.sin(u * 13 - tm * (1.7 - f * 0.4) + k * 2) * amp * 0.42 * edge
          + Math.sin(u * 3 + tm * 0.6) * amp * 0.5 * edge * (k - 2) * 0.35;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      const main = k === 2;
      ctx.lineWidth = main ? 3 : 1.4;
      ctx.strokeStyle = main ? hot(0.9 * ambient) : rgba((0.45 - Math.abs(f - 0.5) * 0.5) * ambient);
      ctx.shadowColor = rgba(1); ctx.shadowBlur = main ? 22 : 10;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    // soft glow band under the wave
    const g = ctx.createLinearGradient(0, cy - amp * 2.2, 0, cy + amp * 2.2);
    g.addColorStop(0, rgba(0)); g.addColorStop(0.5, rgba(0.09 * ambient)); g.addColorStop(1, rgba(0));
    ctx.fillStyle = g;
    ctx.fillRect(0, cy - amp * 2.2, W, amp * 4.4);
    // sparks riding the wave
    for (let i = 0; i < 18; i++) {
      const u = ((i / 18) + tm * 0.04 * (1 + (i % 3) * 0.3)) % 1, edge = Math.sin(u * Math.PI);
      const y = cy + Math.sin(u * 7 + tm * 1.6 + 2) * amp * edge;
      ctx.fillStyle = hot(0.7 * ambient * edge);
      ctx.beginPath(); ctx.arc(u * W, y, 1.4 + (i % 3), 0, 6.283); ctx.fill();
    }
    ctx.restore();
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
    rafId = requestAnimationFrame(drawFrame);
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
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
    const motion = reducedMotion ? 0.12 : 1;
    smx += (mx - smx) * Math.min(1, dt * 3 * motion);
    smy += (my - smy) * Math.min(1, dt * 3 * motion);
    pulse *= Math.pow(reducedMotion ? 0.2 : 0.04, dt);
    if (target && target.nodes.length) {
      // follow the sung word, drifting through the field
      let act = target.nodes[0];
      for (const n of target.nodes) { if (t >= n.start) act = n; else break; }
      const k = 1 - Math.pow(0.06, dt);
      camX += (act.x * 0.55 + target.cx * 0.45 - camX) * k;
      camY += (act.y * 0.55 + target.cy * 0.45 - camY) * k;
      camZ += (focus * DEPTH - camZ) * (1 - Math.pow(0.12, dt));
    }

    if (!reducedMotion) drawDust(W, H, now);
    // The wave is only for real silences: the gap between the end of the sung line and the next
    // line must be longer than GAP_MIN, so short breaths between lines keep the constellation.
    let longGap = false;
    if (lyrics.length) {
      const last = idx >= 0 ? lyrics[idx] : null;
      const gapStart = last && last.words.length
        ? Math.min(last.t + 0.4 + last.words.reduce((a, w) => a + w.length + 1, 0) * 0.075 + 0.8, lyrics[idx + 1] ? lyrics[idx + 1].t : 1e9)
        : last ? last.t : 0;
      let j = idx + 1;
      while (j < lyrics.length && !lyrics[j].words.length) j++;
      const gapEnd = j < lyrics.length ? lyrics[j].t : (player && player.duration > 0 ? player.duration : gapStart);
      longGap = gapEnd - gapStart > GAP_MIN && t >= gapStart && t < gapEnd - 0.3;
    } else {
      longGap = !/Looking/.test(status); // a track with no lyrics at all
    }
    if (!reducedMotion) drawWave(W, H, now, dt, longGap && !waiting() && !(player && player.paused));
    drawRim(W, H, reducedMotion ? 0.25 : 0.5 * (0.5 + 0.5 * Math.sin(now / 1100)) + 0.5 * pulse, now);

    if (target) {
      const order = [];
      for (let i = focus - 1; i <= focus + 3; i++) if (i >= 0 && i < lyrics.length && lyrics[i].words.length) order.push(i);
      order.sort((a, b) => b - a); // far first
      ctx.globalAlpha = 1 - ambient;
      if (ambient < 0.99) for (const i of order) drawGroup(getGroup(i), t, W, H, U, i === idx, now);
      ctx.globalAlpha = 1;
      for (const k of groups.keys()) if (k < focus - 3) groups.delete(k);
    }
    if (!reducedMotion) drawBursts(now);

    if (lyrics.length && lrcDur && player && player.duration && Math.abs(lrcDur - player.duration) > 2) {
      const d = player.duration - lrcDur;
      ctx.font = '500 13px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.textAlign = 'center';
      ctx.fillText(`Lyrics are for a version ${Math.abs(d).toFixed(0)}s ${d > 0 ? 'shorter' : 'longer'} than this one - timing may be off, nudge with [ ] ( { } = 1s )`, W / 2, H - 52);
    }
    if (performance.now() < toastUntil) {
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.textAlign = 'center';
      ctx.fillText(`Lyrics offset ${offset >= 0 ? '+' : ''}${offset.toFixed(1)}s (this song)`, W / 2, H - 28);
    }
    const sourceName = player?.src === 'spotify' ? 'Spotify' : 'YouTube Music';
    const msg = waiting() ? `Waiting for ${sourceName}… play a song in the other tab` : status;
    if (msg) {
      ctx.font = '500 16px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(msg, W / 2, H / 2 + Math.min(W, H) * 0.3);
    }
    if (helpVisible) drawHelp(W, H);
  }

  function drawHelp(W, H) {
    const lines = ['LYRASTRA · KEYBOARD SHORTCUTS', '[ / ]  Nudge lyrics by 0.1 seconds', '{ / }  Nudge lyrics by 1 second', '0  Reset this song’s timing offset', 'C  Toggle album-art colour / neon green', 'F or double-click  Toggle fullscreen', 'R  Retry lyric lookup for this track', '? or H  Toggle this help · Esc closes it', 'Offsets are saved per track in this viewer.'];
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.82)'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '600 18px system-ui, sans-serif'; ctx.fillStyle = hot(1);
    ctx.fillText(lines[0], W / 2, H / 2 - 118); ctx.font = '14px system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.86)';
    lines.slice(1).forEach((line, i) => ctx.fillText(line, W / 2, H / 2 - 82 + i * 25)); ctx.restore();
  }

  function nudge(d) {
    offset = Math.round((offset + d) * 10) / 10;
    toastUntil = performance.now() + 1500;
    try { localStorage.setItem(offKey(), String(offset)); } catch { /* storage blocked */ }
  }
  const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());

  function init() {
    canvas = document.getElementById('ytmc-canvas');
    ctx = canvas.getContext('2d');
    meta = document.getElementById('ytmc-meta');
    addEventListener('keydown', (e) => {
      if (e.key === '?' || e.key.toLowerCase() === 'h') { helpVisible = !helpVisible; e.preventDefault(); return; }
      if (e.key === 'Escape') { helpVisible = false; return; }
      if (e.key === '[') nudge(-0.1);
      else if (e.key === ']') nudge(0.1);
      else if (e.key === '{') nudge(-1);
      else if (e.key === '}') nudge(1);
      else if (e.key === '0') { offset = 0; nudge(0); }
      else if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) toggleFs();
      else if (e.key === 'c' || e.key === 'C') useCover = !useCover;
      else if ((e.key === 'r' || e.key === 'R') && player) onTrackChange(player); // reload lyrics now
    });
    addEventListener('dblclick', toggleFs);
    addEventListener('mousemove', (e) => {
      mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5;
      document.body.classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (rafId) cancelAnimationFrame(rafId); rafId = 0; }
      else if (!rafId) { lastFrame = performance.now(); rafId = requestAnimationFrame(drawFrame); }
    });
    window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', (e) => { reducedMotion = e.matches; });
    requestAnimationFrame(drawFrame);
  }
  init();
})();
