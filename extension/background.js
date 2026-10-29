// Fetches time-synced lyrics (LRC format) from the public LRCLIB API.
// Done here, not in the content script, so page CORS rules don't apply.
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.type === 'open') { openViewer(); return; }
  if (msg?.type !== 'lyrics') return;
  fetchLyrics(msg).then((hit) => send(hit ? { lrc: hit.lrc, dur: hit.dur } : { lrc: null })).catch(() => send({ error: true }));
  return true;
});

// One viewer window: focus it if it exists, else open it (drag it to any monitor).
async function openViewer() {
  const url = chrome.runtime.getURL('viewer.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.windows.create({ url, type: 'normal', width: 1280, height: 720 });
}

// Titles/artists on YouTube Music rarely match LRCLIB exactly ("Song (Official Video)", "A, B & C"),
// so try the exact pair first, then cleaned-up variants, then a scored search.
const cleanTitle = (s) => s
  .replace(/\s*[(\[][^)\]]*[)\]]/g, '')
  .replace(/\s*[-–|]\s*(official|video|lyrics?|audio|remaster).*$/i, '')
  .replace(/\s+/g, ' ')
  .trim();
const firstArtist = (s) => s.split(/\s*(?:,|&|\band\b|\bfeat\.?|\bft\.?)\s*|\s+[x×]\s+/i)[0].trim();
const norm = (s) => s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();

// LRCLIB rate-limits bursts (429/503): retry a couple of times with a short back-off
async function getJson(url, tries = 4) {
  for (let i = 0; ; i++) {
    let wait = 700 * (i + 1);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
      if (r.status === 404) return null;
      if (r.ok) return r.json();
      if (i >= tries - 1 || (r.status !== 429 && r.status < 500)) throw new Error('lrclib ' + r.status);
      wait = Math.max(wait, Math.min(+r.headers.get('retry-after') * 1000 || 0, 5000));
    } catch (e) {
      if (i >= tries - 1) throw e;
    }
    await new Promise((res) => setTimeout(res, wait));
  }
}

// some LRCLIB entries label plain text as synced: require real [mm:ss] stamps
const timed = (s) => (s || '').match(/^\s*\[\d+:\d+/gm)?.length > 3;

const scriptOf = (s) => {
  const m = (s || '').match(/[\p{L}]/gu) || [];
  const counts = { deva: 0, guru: 0, beng: 0, latin: 0 };
  for (const c of m) { const k = c.codePointAt(0); if (k >= 0x900 && k <= 0x97f) counts.deva++; else if (k >= 0xa00 && k <= 0xa7f) counts.guru++; else if (k >= 0x980 && k <= 0x9ff) counts.beng++; else if (k < 0x250) counts.latin++; }
  const [script, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count ? script : '';
};

function pick(results, title, artist, duration, script) {
  const ta = norm(title), aa = norm(artist);
  let best = null, bestScore = 0;
  for (const x of results) {
    if (!timed(x.syncedLyrics)) continue;
    const xt = norm(x.trackName || '');
    let text = 0;
    if (xt === ta) text += 4;
    else if (xt && ta && (xt.includes(ta) || ta.includes(xt))) text += 2;
    if (aa && norm(x.artistName || '').includes(aa)) text += 3;
    if (text < 4) continue; // Require a credible title match; artist/duration alone must never select lyrics
    const dd = duration && x.duration ? Math.abs(x.duration - duration) : 0;
    if (dd > 25 && text < 7) continue; // far-off length only if title AND artist both match
    const score = text + (dd <= 6 ? 6 - dd : 0) - Math.min(dd, 60) * 0.1 + (script && scriptOf(x.syncedLyrics) === script ? 2.5 : 0);
    if (dur && x.duration && dd > 20 && text < 7) continue;
    if (score > bestScore) { best = x; bestScore = score; }
  }
  return best ? { lrc: best.syncedLyrics, dur: best.duration || 0 } : null;
}

async function fetchLyrics({ title, artist, duration, script }) {
  const dur = Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0;
  const ct = cleanTitle(title) || title;
  const fa = firstArtist(artist) || artist;
  let failed = false;
  const attempt = async (fn) => { try { return await fn(); } catch { failed = true; return null; } };
  const get = (t, a) => async () => {
    const q = new URLSearchParams({ track_name: t, artist_name: a });
    if (dur) q.set('duration', String(dur));
    // /get answers 503 for tracks it can't resolve; that is a miss, not an outage, so the searches decide
    const r = await getJson('https://lrclib.net/api/get?' + q, 2).catch(() => null);
    return timed(r?.syncedLyrics) ? { lrc: r.syncedLyrics, dur: r.duration || 0 } : null;
  };
  const search = (params) => async () => {
    const list = await getJson('https://lrclib.net/api/search?' + new URLSearchParams(params));
    return list ? pick(list, ct, fa, dur, script) : null;
  };

  // cheap exact lookups first; only widen to searches when they miss (fewer simultaneous requests)
  const stages = [
    [get(title, artist), get(ct, fa)],
    [search({ q: `${ct} ${fa}` }), search({ q: title })],
    [search({ track_name: ct, artist_name: fa }), search({ track_name: ct })],
  ];
  let hit = null;
  for (const stage of stages) {
    hit = (await Promise.all(stage.map(attempt))).find(Boolean);
    if (hit) break;
  }
  // an exact-ish hit of a different length is a different recording: look for a closer one
  if (hit && dur && hit.dur && Math.abs(hit.dur - dur) > 3) {
    const alt = (await Promise.all([search({ q: `${ct} ${fa}` }), search({ track_name: ct, artist_name: fa })].map(attempt))).filter(Boolean);
    for (const a of alt) if (a.dur && Math.abs(a.dur - dur) < Math.abs(hit.dur - dur)) hit = a;
  }
  if (hit) return hit;
  if (failed) throw new Error('lyrics lookup failed'); // network/server trouble: let the viewer retry
  return null;
}
