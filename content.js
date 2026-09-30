/**
 * YouTube Subtitle Translator - Content Script (High Performance Engine)
 * Features:
 * - Authentic YouTube native subtitle styling (tight inline segment background)
 * - Atomic simultaneous display: original and translated lines appear at the exact same instant
 * - 0ms instant display with pre-cached TimedText tracks from inject.js
 * - High-speed Keep-Alive direct fetch with AbortController
 */

(() => {
  'use strict';

  // Current extension settings
  let settings = {
    enabled: true,
    displayMode: 'bilingual', // 'bilingual' | 'vietnamese_only' | 'off'
    sourceLang: 'auto',
    targetLang: 'vi',
    fontSize: 20,
    fontColor: '#FFFFFF',
    originalColor: '#FFFFFF',
    bgOpacity: 75,
    subPosition: 'bottom',
    subBottomOffset: 60,
    hideOriginalNative: true,
    customApiKey: '',
  };

  // Local synchronous in-memory cache for 0ms lookup
  const localCache = new Map();
  const MAX_LOCAL_CACHE = 5000;

  // Active translation controller to abort stale in-flight requests
  let activeAbortController = null;

  // State variables
  let playerElement = null;
  let captionObserver = null;
  let playerObserver = null;
  let lastCaptionText = '';
  let overlayContainer = null;
  let innerBox = null;
  let origWrapper = null;
  let transWrapper = null;
  let originalTextElement = null;
  let translatedTextElement = null;
  let isDragging = false;
  let startY = 0;
  let startBottom = 60;
  let pretranslateQueue = [];
  let isPretranslating = false;

  /**
   * Normalize string for fast cache keys
   */
  function normalizeText(str) {
    if (!str) return '';
    return str.replace(/\s+/g, ' ').trim();
  }

  /**
   * Helper to decode HTML entities
   */
  function decodeHtmlEntities(str) {
    if (!str) return '';
    return str
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));
  }

  /**
   * Load settings from storage
   */
  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(Object.keys(settings));
      settings = { ...settings, ...stored };
      applySettings();
    } catch (err) {
      console.warn('[YT ViSub] Could not load settings:', err);
    }
  }

  /**
   * Apply settings to the DOM and overlay
   */
  function applySettings() {
    if (!overlayContainer || !innerBox) return;

    if (!settings.enabled || settings.displayMode === 'off') {
      overlayContainer.style.display = 'none';
      document.body.classList.remove('ytsub-active');
      if (playerElement) {
        playerElement.classList.remove('ytsub-hide-native');
      }
      return;
    }

    overlayContainer.style.display = 'flex';
    document.body.classList.add('ytsub-active');

    if (playerElement) {
      if (settings.hideOriginalNative) {
        playerElement.classList.add('ytsub-hide-native');
      } else {
        playerElement.classList.remove('ytsub-hide-native');
      }
    }

    // Unified box background: apply directly to innerBox container
    const bgVal = `rgba(8, 8, 8, ${(settings.bgOpacity ?? 75) / 100})`;
    innerBox.style.backgroundColor = bgVal;

    if (originalTextElement) {
      originalTextElement.style.fontSize = `${Math.round(settings.fontSize * 0.92)}px`;
      originalTextElement.style.color = settings.originalColor || '#FFFFFF';
      originalTextElement.style.backgroundColor = 'transparent';
    }

    if (translatedTextElement) {
      translatedTextElement.style.fontSize = `${settings.fontSize}px`;
      translatedTextElement.style.color = settings.fontColor || '#FFFFFF';
      translatedTextElement.style.backgroundColor = 'transparent';
    }

    if (origWrapper) {
      origWrapper.style.display = settings.displayMode === 'bilingual' ? 'block' : 'none';
    }

    if (settings.subPosition === 'top') {
      overlayContainer.classList.add('ytsub-pos-top');
      overlayContainer.style.bottom = 'auto';
    } else {
      overlayContainer.classList.remove('ytsub-pos-top');
      if (!isDragging && settings.subBottomOffset !== undefined) {
        overlayContainer.style.bottom = `${settings.subBottomOffset}px`;
      }
    }
  }

  /**
   * Create or retrieve subtitle overlay container matching native YouTube caption structure
   */
  function setupOverlay(player) {
    if (!player) return;

    let container = player.querySelector('#ytsub-overlay-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'ytsub-overlay-container';

      const box = document.createElement('div');
      box.id = 'ytsub-inner-box';
      box.classList.add('ytsub-hidden');

      // Original text line wrapper
      const origWrap = document.createElement('div');
      origWrap.id = 'ytsub-orig-wrapper';
      origWrap.className = 'ytsub-line-wrapper';

      const origText = document.createElement('span');
      origText.id = 'ytsub-original-text';
      origText.className = 'ytsub-line';
      origWrap.appendChild(origText);

      // Translated text line wrapper
      const transWrap = document.createElement('div');
      transWrap.id = 'ytsub-trans-wrapper';
      transWrap.className = 'ytsub-line-wrapper';

      const transText = document.createElement('span');
      transText.id = 'ytsub-translated-text';
      transText.className = 'ytsub-line';
      transWrap.appendChild(transText);

      box.appendChild(origWrap);
      box.appendChild(transWrap);
      container.appendChild(box);

      player.appendChild(container);

      setupDraggable(box, container, player);
    }

    overlayContainer = container;
    innerBox = container.querySelector('#ytsub-inner-box');
    origWrapper = container.querySelector('#ytsub-orig-wrapper');
    transWrapper = container.querySelector('#ytsub-trans-wrapper');
    originalTextElement = container.querySelector('#ytsub-original-text');
    translatedTextElement = container.querySelector('#ytsub-translated-text');

    applySettings();
  }

  /**
   * Vertical drag handler
   */
  function setupDraggable(box, container, player) {
    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      startY = e.clientY;
      const rect = container.getBoundingClientRect();
      const playerRect = player.getBoundingClientRect();
      startBottom = playerRect.bottom - rect.bottom;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const deltaY = startY - e.clientY;
      const newBottom = Math.max(20, Math.min(player.clientHeight - 80, startBottom + deltaY));
      container.style.bottom = `${newBottom}px`;
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      const newBottom = parseInt(container.style.bottom, 10);
      if (!isNaN(newBottom)) {
        settings.subBottomOffset = newBottom;
        chrome.storage.sync.set({ subBottomOffset: newBottom }).catch(() => {});
      }
    };

    box.addEventListener('mousedown', onMouseDown);
  }

  /**
   * Fast direct translation using fetch with connection reuse
   */
  async function fetchDirectTranslation(text, sourceLang, targetLang, signal) {
    const sl = sourceLang || 'auto';
    const tl = targetLang || 'vi';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;

    const res = await fetch(url, {
      method: 'GET',
      signal: signal,
      keepalive: true,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    if (Array.isArray(data) && Array.isArray(data[0])) {
      const translated = data[0]
        .map((item) => (Array.isArray(item) && item[0] ? item[0] : ''))
        .join('');
      return decodeHtmlEntities(translated);
    }
    throw new Error('Invalid translation format');
  }

  /**
   * High-speed translation with local synchronous cache
   */
  async function translateTextFast(text) {
    const trimmed = normalizeText(text);
    if (!trimmed) return '';

    const cacheKey = `${settings.sourceLang || 'auto'}->${settings.targetLang || 'vi'}:${trimmed}`;

    // 1. Check local synchronous cache (0ms instant return!)
    if (localCache.has(cacheKey)) {
      return localCache.get(cacheKey);
    }

    // 2. Abort any previous pending on-demand translation
    if (activeAbortController) {
      activeAbortController.abort();
    }
    activeAbortController = new AbortController();
    const currentSignal = activeAbortController.signal;

    let translated = '';

    // 3. Fast direct fetch
    if (!settings.customApiKey) {
      try {
        translated = await fetchDirectTranslation(
          trimmed,
          settings.sourceLang || 'auto',
          settings.targetLang || 'vi',
          currentSignal
        );
      } catch (err) {
        if (err.name === 'AbortError') {
          return null; // Cancelled
        }
      }
    }

    // 4. Background service worker fallback
    if (!translated) {
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'TRANSLATE',
          text: trimmed,
          sourceLang: settings.sourceLang || 'auto',
          targetLang: settings.targetLang || 'vi',
          apiKey: settings.customApiKey || '',
        });
        if (response && response.success) {
          translated = response.translation;
        }
      } catch (e) {
        // Ignored or aborted
      }
    }

    // 5. Store in local cache
    if (translated) {
      if (localCache.size >= MAX_LOCAL_CACHE) {
        const firstKey = localCache.keys().next().value;
        localCache.delete(firstKey);
      }
      localCache.set(cacheKey, translated);
    }

    return translated || trimmed;
  }

  /**
   * Extract current subtitle text from YouTube DOM
   */
  function extractCaptionText() {
    if (!playerElement) return '';

    const captionContainer = playerElement.querySelector('.ytp-caption-window-container');
    if (!captionContainer) return '';

    const segments = captionContainer.querySelectorAll('.ytp-caption-segment');
    if (!segments || segments.length === 0) return '';

    const lines = [];
    segments.forEach((seg) => {
      const text = seg.textContent ? seg.textContent.trim() : '';
      if (text) {
        lines.push(text);
      }
    });

    return normalizeText(lines.join(' '));
  }

  /**
   * Render subtitle lines simultaneously in the exact same DOM frame
   */
  function renderSubtitlesSimultaneously(origText, transText) {
    if (!innerBox) return;

    if (settings.displayMode === 'bilingual') {
      if (originalTextElement) originalTextElement.textContent = origText;
      if (origWrapper) origWrapper.style.display = 'block';
    } else {
      if (origWrapper) origWrapper.style.display = 'none';
    }

    if (translatedTextElement) {
      translatedTextElement.textContent = transText;
    }
    if (transWrapper) {
      transWrapper.style.display = 'block';
    }

    innerBox.classList.remove('ytsub-hidden');
  }

  /**
   * Process subtitle updates:
   * Guarantees that original and translated subtitle appear at the exact same instant.
   */
  async function onCaptionsChanged() {
    if (!settings.enabled || settings.displayMode === 'off') {
      if (innerBox) innerBox.classList.add('ytsub-hidden');
      return;
    }

    const currentText = extractCaptionText();

    // If subtitles are currently empty or CC turned off
    if (!currentText) {
      lastCaptionText = '';
      if (innerBox) {
        innerBox.classList.add('ytsub-hidden');
        if (originalTextElement) originalTextElement.textContent = '';
        if (translatedTextElement) translatedTextElement.textContent = '';
      }
      return;
    }

    // If subtitle content has not changed, do nothing
    if (currentText === lastCaptionText) {
      return;
    }

    lastCaptionText = currentText;

    // Check if translation is already in local synchronous cache
    const cacheKey = `${settings.sourceLang || 'auto'}->${settings.targetLang || 'vi'}:${currentText}`;
    let translated = localCache.get(cacheKey);

    if (translated) {
      // 0ms INSTANT DISPLAY: render both simultaneously right now
      renderSubtitlesSimultaneously(currentText, translated);
      return;
    }

    // If not in cache yet: fetch translation FIRST, then display both together!
    // This prevents showing the original subtitle alone and having translation pop in later.
    const result = await translateTextFast(currentText);

    // Only render if this caption is still the active one
    if (result && currentText === lastCaptionText) {
      renderSubtitlesSimultaneously(currentText, result);
    }
  }

  /**
   * Parse timedtext data (JSON3 or XML) received from inject.js
   */
  function parseTimedTextData(data) {
    const texts = [];
    if (!data || typeof data !== 'string') return texts;

    // Try JSON3 format
    if (data.trim().startsWith('{')) {
      try {
        const json = JSON.parse(data);
        if (json.events && Array.isArray(json.events)) {
          json.events.forEach((e) => {
            if (e.segs) {
              const text = e.segs.map((s) => s.utf8 || '').join('').trim();
              const cleaned = normalizeText(text);
              if (cleaned && cleaned.length > 1) {
                texts.push(cleaned);
              }
            }
          });
          return Array.from(new Set(texts));
        }
      } catch (e) {}
    }

    // Try XML format
    if (data.includes('<text')) {
      const regex = /<text\s+start="[^"]*"\s+dur="[^"]*"[^>]*>([\s\S]*?)<\/text>/g;
      let match;
      while ((match = regex.exec(data)) !== null) {
        const cleaned = normalizeText(decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '')));
        if (cleaned && cleaned.length > 1) {
          texts.push(cleaned);
        }
      }
    }

    return Array.from(new Set(texts));
  }

  /**
   * Pre-translate batches of sentences in the background for 0ms playback
   */
  async function processPretranslationQueue() {
    if (isPretranslating || pretranslateQueue.length === 0) return;
    isPretranslating = true;

    while (pretranslateQueue.length > 0) {
      const batch = pretranslateQueue.splice(0, 25);
      const sl = settings.sourceLang || 'auto';
      const tl = settings.targetLang || 'vi';

      const toTranslate = batch.filter((txt) => !localCache.has(`${sl}->${tl}:${txt}`));
      if (toTranslate.length === 0) continue;

      try {
        const combinedQuery = toTranslate.join('\n');
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(combinedQuery)}`;

        const res = await fetch(url, { keepalive: true });
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json) && Array.isArray(json[0])) {
            const translatedFull = json[0].map((item) => (Array.isArray(item) && item[0] ? item[0] : '')).join('');
            const translatedLines = decodeHtmlEntities(translatedFull).split('\n');

            toTranslate.forEach((orig, idx) => {
              const trans = (translatedLines[idx] || '').trim();
              if (trans) {
                localCache.set(`${sl}->${tl}:${orig}`, trans);
              }
            });
          }
        }
      } catch (e) {
        // Best effort pre-translation
      }

      await new Promise((r) => setTimeout(r, 120));
    }

    isPretranslating = false;
  }

  /**
   * Listen for intercepted timedtext subtitles from inject.js
   */
  window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'YTSUB_INJECT' && event.data.type === 'TIMEDTEXT_RESPONSE') {
      const texts = parseTimedTextData(event.data.data);
      if (texts.length > 0) {
        pretranslateQueue.push(...texts);
        processPretranslationQueue();
      }
    }
  });

  /**
   * Attach MutationObserver to caption container
   */
  function observeCaptionContainer() {
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }

    if (!playerElement) return;

    const captionContainer = playerElement.querySelector('.ytp-caption-window-container');
    const targetNode = captionContainer || playerElement;

    captionObserver = new MutationObserver(() => {
      onCaptionsChanged();
    });

    captionObserver.observe(targetNode, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    onCaptionsChanged();
  }

  /**
   * Initialize player
   */
  function initPlayer() {
    const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    if (!player) return false;

    playerElement = player;
    setupOverlay(player);
    observeCaptionContainer();
    return true;
  }

  /**
   * Main initialization
   */
  function init() {
    loadSettings();

    if (!initPlayer()) {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (initPlayer() || attempts > 20) {
          clearInterval(interval);
        }
      }, 400);
    }

    window.addEventListener('yt-navigate-finish', () => {
      lastCaptionText = '';
      setTimeout(() => initPlayer(), 200);
    });

    window.addEventListener('spfdone', () => {
      lastCaptionText = '';
      setTimeout(() => initPlayer(), 200);
    });

    if (!playerObserver) {
      playerObserver = new MutationObserver(() => {
        const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
        if (player && player !== playerElement) {
          initPlayer();
        }
      });
      playerObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' || namespace === 'local') {
      for (const [key, change] of Object.entries(changes)) {
        settings[key] = change.newValue;
      }
      applySettings();
      if (lastCaptionText) {
        const text = lastCaptionText;
        lastCaptionText = '';
        onCaptionsChanged();
      }
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
