// Fetches time-synced lyrics (LRC format) from the public LRCLIB API.
// Done here, not in the content script, so page CORS rules don't apply.
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.type === 'open') { openViewer(); return; }
  if (msg?.type !== 'lyrics') return;
  fetchLyrics(msg).then(send).catch(() => send(null));
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

async function fetchLyrics({ title, artist, duration }) {
  const q = new URLSearchParams({ track_name: title, artist_name: artist });
  if (duration) q.set('duration', String(Math.round(duration)));

  let r = await fetch('https://lrclib.net/api/get?' + q);
  if (r.ok) {
    const j = await r.json();
    if (j.syncedLyrics) return j.syncedLyrics;
  }

  r = await fetch('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: title, artist_name: artist }));
  if (r.ok) {
    const hit = (await r.json()).find((x) => x.syncedLyrics);
    if (hit) return hit.syncedLyrics;
  }
  return null;
}
