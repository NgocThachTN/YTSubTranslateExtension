/**
 * YouTube Subtitle Translator - Main World Interceptor (inject.js)
 * Runs in the main page world to intercept YouTube's timedtext subtitle tracks
 * and proactively fetch subtitle cues for 0ms instant pre-translation.
 */

(() => {
  'use strict';

  if (window.__ytsub_injected) return;
  window.__ytsub_injected = true;

  let lastFetchedUrl = '';

  function notifySubtitleData(url, text) {
    if (!text || text.length < 20 || url === lastFetchedUrl) return;
    lastFetchedUrl = url;
    window.postMessage({
      source: 'YTSUB_INJECT',
      type: 'TIMEDTEXT_RESPONSE',
      url: url,
      data: text,
    }, '*');
  }

  // 1. Intercept XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._ytsub_url = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    if (this._ytsub_url && typeof this._ytsub_url === 'string' && this._ytsub_url.includes('/api/timedtext')) {
      const targetUrl = this._ytsub_url;
      this.addEventListener('load', function() {
        try {
          if (this.responseText) {
            notifySubtitleData(targetUrl, this.responseText);
          }
        } catch (e) {}
      });
    }
    return origSend.apply(this, arguments);
  };

  // 2. Intercept window.fetch
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await origFetch.apply(this, args);
    try {
      const url = args[0] ? (typeof args[0] === 'string' ? args[0] : args[0].url) : '';
      if (url && typeof url === 'string' && url.includes('/api/timedtext')) {
        const clone = response.clone();
        clone.text().then((text) => {
          notifySubtitleData(url, text);
        }).catch(() => {});
      }
    } catch (e) {}
    return response;
  };

  // 3. Proactive check on YouTube player caption tracks
  function inspectPlayerCaptions() {
    try {
      const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
      if (!player || typeof player.getOption !== 'function') return;

      const track = player.getOption('captions', 'track');
      const tracklist = player.getOption('captions', 'tracklist');
      const target = track || (tracklist && tracklist[0]);

      if (target && target.baseUrl && target.baseUrl !== lastFetchedUrl) {
        origFetch(target.baseUrl)
          .then((res) => res.text())
          .then((text) => {
            notifySubtitleData(target.baseUrl, text);
          })
          .catch(() => {});
      }
    } catch (e) {}
  }

  // Periodic and event-driven inspection
  window.addEventListener('yt-navigate-finish', () => {
    lastFetchedUrl = '';
    setTimeout(inspectPlayerCaptions, 500);
    setTimeout(inspectPlayerCaptions, 1500);
  });

  window.addEventListener('load', () => {
    setTimeout(inspectPlayerCaptions, 1000);
  });

  setInterval(inspectPlayerCaptions, 3000);
})();
