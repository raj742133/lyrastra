(() => {
  const DEFAULT_ACCENT = [255, 214, 10];
  let accent = DEFAULT_ACCENT;
  let trackKey = '';

  const video = () => document.querySelector('video');

  function getTrack() {
    const bar = document.querySelector('ytmusic-player-bar');
    if (!bar) return null;
    const title = bar.querySelector('.title')?.textContent.trim();
    const artist = (bar.querySelector('.byline')?.textContent || '').split('•')[0].trim();
    if (!title) return null;
    return { title, artist, thumb: bar.querySelector('img')?.src };
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
        const k = 255 / Math.max(Math.max(...col), 1); // push to full brightness so it glows
        accent = col.map((v) => Math.min(255, Math.round(v * k)));
      } catch { /* tainted canvas: keep default */ }
    };
    img.src = url.replace(/=w\d+-h\d+.*$/, '=w120-h120');
  }

  // Stream the player state to the viewer page ~8x/s; it interpolates between updates.
  setInterval(() => {
    if (!chrome.runtime?.id) return; // extension was reloaded; this script is orphaned
    const t = getTrack();
    const v = video();
    if (!t || !v) return;
    const key = t.title + '|' + t.artist;
    if (key !== trackKey) { trackKey = key; loadAccent(t.thumb); }
    chrome.runtime.sendMessage(
      { type: 'state', thumb: t.thumb, title: t.title, artist: t.artist, duration: v.duration, t: v.currentTime, paused: v.paused, accent },
      () => void chrome.runtime.lastError // no viewer open: ignore
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
