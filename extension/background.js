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

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('lrclib ' + r.status);
  return r.json();
}

const scriptOf = (s) => {
  const m = (s || '').match(/[\p{L}]/gu) || [];
  let deva = 0, guru = 0, latin = 0;
  for (const c of m) { const k = c.codePointAt(0); if (k >= 0x900 && k <= 0x97f) deva++; else if (k >= 0xa00 && k <= 0xa7f) guru++; else if (k < 0x250) latin++; }
  const top = Math.max(deva, guru, latin);
  return !top ? '' : top === deva ? 'deva' : top === guru ? 'guru' : 'latin';
};

function pick(results, title, artist, duration, script) {
  const ta = norm(title), aa = norm(artist);
  let best = null, bestScore = 0;
  for (const x of results) {
    if (!x.syncedLyrics) continue;
    const xt = norm(x.trackName || '');
    let text = 0;
    if (xt === ta) text += 4;
    else if (xt && ta && (xt.includes(ta) || ta.includes(xt))) text += 2;
    if (aa && norm(x.artistName || '').includes(aa)) text += 3;
    if (!text) continue; // same length alone is not enough: never show another song's lyrics
    const dd = duration && x.duration ? Math.abs(x.duration - duration) : 0;
    if (dd > 25 && text < 7) continue; // far-off length only if title AND artist both match
    const score = text + (dd <= 6 ? 6 - dd : 0) + (script && scriptOf(x.syncedLyrics) === script ? 2.5 : 0);
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
    const r = await getJson('https://lrclib.net/api/get?' + q);
    return r?.syncedLyrics ? { lrc: r.syncedLyrics, dur: r.duration || 0 } : null;
  };
  const search = (params) => async () => {
    const list = await getJson('https://lrclib.net/api/search?' + new URLSearchParams(params));
    return list ? pick(list, ct, fa, dur, script) : null;
  };

  const tries = [
    get(title, artist),
    get(ct, fa),
    search({ q: title }),
    search({ q: `${ct} ${fa}` }),
    search({ track_name: ct, artist_name: fa }),
    search({ track_name: ct }),
  ];
  // run every lookup at once (a slow LRCLIB miss must not block the rest), prefer them in order
  const found = await Promise.all(tries.map(attempt));
  const hit = found.find(Boolean);
  if (hit) return hit;
  if (failed) throw new Error('lyrics lookup failed'); // network/server trouble: let the viewer retry
  return null;
}
