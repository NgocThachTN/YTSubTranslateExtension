/**
 * YouTube Subtitle Translator - Main World Interceptor (inject.js)
 * Intercepts YouTube's timedtext subtitle tracks and supports YouTube's Native Subtitle Translation engine (&tlang=).
 */

(() => {
  'use strict';

  if (window.__ytsub_injected) return;
  window.__ytsub_injected = true;

  let currentTargetLang = 'vi';
  let currentService = 'google';
  let lastFetchedUrl = '';

  // Receive active configuration from content.js
  window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'YTSUB_CONTENT_CONFIG') {
      if (event.data.targetLang) currentTargetLang = event.data.targetLang;
      if (event.data.service) currentService = event.data.service;
    }
  });

  function notifySubtitleData(url, text, isTranslated = false, explicitLang = '') {
    if (!text || text.length < 20) return;
    let captionLang = explicitLang;
    if (!captionLang && url) {
      try {
        const match = url.match(/[?&]lang=([a-zA-Z-]+)/);
        if (match && match[1]) {
          captionLang = match[1];
        }
      } catch (e) {}
    }

    window.postMessage({
      source: 'YTSUB_INJECT',
      type: isTranslated ? 'TIMEDTEXT_TRANSLATED_RESPONSE' : 'TIMEDTEXT_RESPONSE',
      url: url,
      data: text,
      targetLang: currentTargetLang,
      captionLang: captionLang,
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
            const hasTlang = targetUrl.includes('tlang=');
            notifySubtitleData(targetUrl, this.responseText, hasTlang);
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
          const hasTlang = url.includes('tlang=');
          notifySubtitleData(url, text, hasTlang);
        }).catch(() => {});
      }
    } catch (e) {}
    return response;
  };

  // 3. Proactively fetch caption track (including YouTube Native Subtitle Translation)
  function inspectPlayerCaptions() {
    try {
      const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
      if (!player || typeof player.getOption !== 'function') return;

      const track = player.getOption('captions', 'track');
      const tracklist = player.getOption('captions', 'tracklist');
      const target = track || (tracklist && tracklist[0]);

      if (target && target.baseUrl) {
        const trackLang = target.languageCode || '';
        const fetchKey = `${target.baseUrl}:${currentTargetLang}:${currentService}`;
        if (fetchKey === lastFetchedUrl) return;
        lastFetchedUrl = fetchKey;

        // If service is YouTube Native or as secondary fast translation, fetch with &tlang
        const nativeUrl = target.baseUrl.includes('tlang=')
          ? target.baseUrl
          : `${target.baseUrl}&tlang=${encodeURIComponent(currentTargetLang)}&fmt=json3`;

        origFetch(nativeUrl)
          .then((res) => res.text())
          .then((text) => {
            if (text && text.includes('events')) {
              notifySubtitleData(nativeUrl, text, true, trackLang);
            } else {
              // Fallback to original track
              origFetch(`${target.baseUrl}&fmt=json3`)
                .then((r) => r.text())
                .then((origText) => notifySubtitleData(target.baseUrl, origText, false, trackLang))
                .catch(() => {});
            }
          })
          .catch(() => {
            origFetch(`${target.baseUrl}&fmt=json3`)
              .then((r) => r.text())
              .then((origText) => notifySubtitleData(target.baseUrl, origText, false, trackLang))
              .catch(() => {});
          });
      }
    } catch (e) {}
  }

  window.addEventListener('yt-navigate-finish', () => {
    lastFetchedUrl = '';
    setTimeout(inspectPlayerCaptions, 400);
    setTimeout(inspectPlayerCaptions, 1200);
  });

  window.addEventListener('load', () => {
    setTimeout(inspectPlayerCaptions, 800);
  });

  setInterval(inspectPlayerCaptions, 2500);
})();
