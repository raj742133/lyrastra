(() => {
  // Spotify Web Player: same state stream as content.js, read from the player bar DOM.
  const DEFAULT_ACCENT = [255, 214, 10];
  let accent = DEFAULT_ACCENT;
  let trackKey = '';

  const $ = (sel) => document.querySelector(sel);
  const secs = (s) => {
    const p = (s || '').trim().split(':').map(Number);
    return p.length >= 2 && p.every(Number.isFinite) ? p.reduce((a, n) => a * 60 + n, 0) : 0;
  };

  function getTrack() {
    let title = $('[data-testid="context-item-link"]')?.textContent.trim();
    let artist = [...document.querySelectorAll('[data-testid="context-item-info-artist"], [data-testid="context-item-info-subtitles"] a')]
      .map((a) => a.textContent.trim()).filter(Boolean).join(', ');
    const bar = $('[data-testid="now-playing-bar"]') || $('footer') || document;
    if (!title) title = bar.querySelector('a[href*="/track/"], a[href*="/album/"]')?.textContent.trim();
    if (!artist) artist = [...bar.querySelectorAll('a[href*="/artist/"]')].map((a) => a.textContent.trim()).filter(Boolean).join(', ');
    const md = navigator.mediaSession?.metadata;
    if (!title && md?.title) { title = md.title; artist = artist || md.artist; }
    if (!title) { // page title while playing is "Song • Artist"
      const m = document.title.match(/^(.+?)\s*[•·]\s*(.+)$/);
      if (m && !/spotify/i.test(m[1])) { title = m[1].trim(); artist = artist || m[2].replace(/\s*[•·|-]\s*Spotify.*$/i, '').trim(); }
    }
    if (!title || /^advertisement$/i.test(title)) return null;
    const thumb = $('[data-testid="cover-art-image"]')?.src || bar.querySelector('img[src*="scdn.co"], img[src*="spotifycdn"]')?.src || md?.artwork?.slice(-1)[0]?.src || '';
    return { title, artist, thumb };
  }

  function loadAccent(url) {
    accent = DEFAULT_ACCENT;
    if (!url) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, 24, 24);
        const d = g.getImageData(0, 0, 24, 24).data;
        let r = 0, gr = 0, b = 0, wsum = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]);
          const mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const w = (mx - mn) * (mx / 255) + 1;
          r += d[i] * w; gr += d[i + 1] * w; b += d[i + 2] * w; wsum += w;
        }
        const col = [r / wsum, gr / wsum, b / wsum];
        const k = 255 / Math.max(Math.max(...col), 1);
        accent = col.map((v) => Math.min(255, Math.round(v * k)));
      } catch { /* tainted canvas: keep default */ }
    };
    img.src = url;
  }

  // The player bar only shows whole seconds, so keep our own sub-second clock that restarts
  // each time the displayed second ticks over.
  let lastSec = -1, tickAt = 0;
  function position(paused) {
    const s = secs($('[data-testid="playback-position"]')?.textContent);
    const now = performance.now();
    if (s !== lastSec) { lastSec = s; tickAt = now; }
    return paused ? s : s + Math.min((now - tickAt) / 1000, 0.99);
  }

  setInterval(() => {
    if (!chrome.runtime?.id) return;
    const t = getTrack();
    if (!t) return;
    const key = t.title + '|' + t.artist;
    if (key !== trackKey) { trackKey = key; lastSec = -1; loadAccent(t.thumb); }
    const label = $('[data-testid="control-button-playpause"]')?.getAttribute('aria-label') || '';
    const paused = /^play/i.test(label);
    chrome.runtime.sendMessage(
      { type: 'state', src: 'spotify', lyr: { text: '', source: '' }, thumb: t.thumb, title: t.title, artist: t.artist, duration: secs($('[data-testid="playback-duration"]')?.textContent), t: position(paused), paused, accent },
      () => void chrome.runtime.lastError
    );
  }, 125);

  const toggle = document.createElement('button');
  toggle.id = 'ytmc-toggle';
  toggle.title = 'Open constellation lyrics in a new window';
  toggle.textContent = '✦';
  toggle.onclick = () => chrome.runtime.sendMessage({ type: 'open' });
  document.body.append(toggle);

  addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyC') chrome.runtime.sendMessage({ type: 'open' });
  });
})();
