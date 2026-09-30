/**
 * YouTube Subtitle Translator - Content Script (High Performance Multi-Engine)
 * Features:
 * - Authentic YouTube native subtitle styling (unified caption-window)
 * - Atomic simultaneous display: original and translated lines appear at the exact same instant
 * - Multi-engine support: YouTube Native Subtitles (&tlang=), Google Translate, MyMemory Translated
 * - High-speed Keep-Alive direct fetch with AbortController
 */

(() => {
  'use strict';

  // Current extension settings
  let settings = {
    enabled: true,
    displayMode: 'bilingual', // 'bilingual' | 'vietnamese_only' | 'off'
    translationService: 'google', // 'google' | 'youtube' | 'mymemory' | 'google_cloud'
    sourceLang: 'auto',
    targetLang: 'vi',
    fontSize: 20,
    fontColor: '#FFFFFF',
    originalColor: '#FFFFFF',
    bgOpacity: 75,
    subPosition: 'bottom',
    subBottomOffset: 0, // 0 = automatic responsive elevation above player controls
    hideOriginalNative: true,
    customApiKey: '',
    geminiApiKey: '',
    geminiModel: 'gemini-3.5-flash-lite',
  };

  // Local synchronous in-memory cache for 0ms lookup
  const localCache = new Map();
  const MAX_LOCAL_CACHE = 5000;

  // Active translation controller and in-flight request deduplication
  let activeAbortController = null;
  const inFlightTranslations = new Map();

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
  let pretranslateQueue = [];
  let isPretranslating = false;
  let detectedCaptionLang = '';

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
   * Fast script detection for CJK, Cyrillic, Arabic, Thai, etc.
   */
  function detectScriptLanguage(text) {
    if (!text) return '';
    // Japanese: Hiragana or Katakana
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja';
    // Korean: Hangul
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(text)) return 'ko';
    // Chinese: Han characters without Kana
    if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text)) return 'zh';
    // Russian / Cyrillic
    if (/[\u0400-\u04FF]/.test(text)) return 'ru';
    // Arabic
    if (/[\u0600-\u06FF]/.test(text)) return 'ar';
    // Thai
    if (/[\u0E00-\u0E7F]/.test(text)) return 'th';
    // Greek
    if (/[\u0370-\u03FF]/.test(text)) return 'el';
    // Hebrew
    if (/[\u0590-\u05FF]/.test(text)) return 'he';
    return '';
  }

  /**
   * Determine exact source language code (e.g. ja, ko, en) when auto-detection is active
   */
  function resolveSourceLang(text, configuredSourceLang) {
    if (configuredSourceLang && configuredSourceLang !== 'auto') {
      return configuredSourceLang;
    }
    const detected = detectScriptLanguage(text);
    if (detected) {
      return detected;
    }
    if (detectedCaptionLang) {
      return detectedCaptionLang;
    }
    return 'en';
  }

  /**
   * Send config to inject.js in main world
   */
  function syncConfigToMainWorld() {
    window.postMessage({
      source: 'YTSUB_CONTENT_CONFIG',
      targetLang: settings.targetLang || 'vi',
      service: settings.translationService || 'google',
    }, '*');
  }

  /**
   * Load settings from storage
   */
  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(Object.keys(settings));
      // Auto-migrate legacy default 60 to 0 (0 = automatic responsive elevation above player controls)
      if (stored.subBottomOffset === 60) {
        stored.subBottomOffset = 0;
        chrome.storage.sync.set({ subBottomOffset: 0 }).catch(() => {});
      }
      // Auto-migrate legacy 1.5/2.0 models to gemini-3.5-flash-lite
      if (stored.geminiModel && (stored.geminiModel.includes('1.5') || stored.geminiModel.includes('2.0'))) {
        stored.geminiModel = 'gemini-3.5-flash-lite';
        chrome.storage.sync.set({ geminiModel: 'gemini-3.5-flash-lite' }).catch(() => {});
      }
      settings = { ...settings, ...stored };
      applySettings();
      syncConfigToMainWorld();
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
    } else {
      overlayContainer.classList.remove('ytsub-pos-top');
      if (!isDragging) {
        if (settings.subBottomOffset && settings.subBottomOffset !== 0) {
          overlayContainer.style.setProperty('--ytsub-user-offset', `${settings.subBottomOffset}px`);
        } else {
          overlayContainer.style.removeProperty('--ytsub-user-offset');
        }
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

      const origWrap = document.createElement('div');
      origWrap.id = 'ytsub-orig-wrapper';
      origWrap.className = 'ytsub-line-wrapper';

      const origText = document.createElement('span');
      origText.id = 'ytsub-original-text';
      origText.className = 'ytsub-line';
      origWrap.appendChild(origText);

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
    let startUserOffset = 0;

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      startY = e.clientY;
      const currentProp = container.style.getPropertyValue('--ytsub-user-offset');
      startUserOffset = currentProp ? parseInt(currentProp, 10) || 0 : (settings.subBottomOffset || 0);
      container.style.transition = 'none';

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;
      const deltaY = startY - e.clientY;
      const newOffset = Math.max(-60, Math.min(player.clientHeight - 150, startUserOffset + deltaY));
      container.style.setProperty('--ytsub-user-offset', `${newOffset}px`);
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      container.style.removeProperty('transition');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      const prop = container.style.getPropertyValue('--ytsub-user-offset');
      const savedOffset = prop ? parseInt(prop, 10) || 0 : 0;
      settings.subBottomOffset = savedOffset;
      chrome.storage.sync.set({ subBottomOffset: savedOffset }).catch(() => {});
    };

    box.addEventListener('mousedown', onMouseDown);
  }

  /**
   * Fast Google Gemini AI translation (Routed through Background Worker to bypass YouTube CSP)
   */
  async function fetchGeminiTranslation(text, sourceLang, targetLang, apiKey, signal, model) {
    if (!apiKey || !apiKey.trim()) throw new Error('Missing Gemini API Key');
    const tl = targetLang || 'vi';
    let chosenModel = model || settings.geminiModel || 'gemini-3.5-flash-lite';
    if (chosenModel.includes('lite')) {
      chosenModel = 'gemini-3.5-flash-lite';
    } else if (chosenModel.includes('3.5')) {
      chosenModel = 'gemini-3.5-flash';
    } else if (chosenModel.includes('2.0') || chosenModel.includes('1.5')) {
      chosenModel = 'gemini-3.5-flash-lite';
    }

    // 1. Primary: Route via Background Service Worker (100% immune to YouTube page CSP)
    try {
      const bgResult = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'TRANSLATE',
          text: text,
          sourceLang: sourceLang || 'auto',
          targetLang: tl,
          service: 'gemini',
          apiKey: apiKey.trim(),
          model: chosenModel,
        }, (res) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          if (res && res.success && res.translation) {
            return resolve(res.translation);
          }
          reject(new Error(res?.error || 'Gemini returned empty'));
        });
      });

      if (bgResult) {
        return bgResult;
      }
    } catch (bgErr) {
      console.warn('[YT ViSub] [Gemini AI] Background worker error, trying direct fetch...', bgErr.message);
    }

    // 2. Direct fetch fallback
    const targetName = tl === 'vi' ? 'Vietnamese' : tl;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chosenModel)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
    const prompt = `Translate this subtitle line directly to natural, conversational ${targetName}. Keep it concise for video subtitles. Output ONLY the translated text, no quotes, no extra explanations:\n${text}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 60
        }
      }),
      signal: signal,
      keepalive: true
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (rawText && typeof rawText === 'string') {
      const cleaned = rawText
        .trim()
        .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
        .replace(/^(Bản dịch|Translation):\s*/i, '')
        .trim();
      if (cleaned) {
        return decodeHtmlEntities(cleaned);
      }
    }

    throw new Error('Invalid response structure from Gemini API');
  }

  /**
   * Fast direct translation (Google Translate, MyMemory or Gemini with auto failover)
   */
  async function fetchDirectTranslation(text, sourceLang, targetLang, service, signal) {
    const sl = sourceLang || 'auto';
    const tl = targetLang || 'vi';

    // If Gemini AI engine selected
    if (service === 'gemini') {
      if (settings.geminiApiKey) {
        try {
          const geminiTrans = await fetchGeminiTranslation(
            text,
            sl,
            tl,
            settings.geminiApiKey,
            signal,
            settings.geminiModel || 'gemini-3.5-flash-lite'
          );
          if (geminiTrans) {
            return geminiTrans;
          }
        } catch (err) {
          if (err.name === 'AbortError' && signal && signal.aborted) {
            throw err;
          }
          console.warn('[YT ViSub] Gemini translation failed, auto-failover to Google Translate...', err);
        }
      }
      // If Gemini key missing or failed, seamlessly fall back to Google Translate!
    }

    // If MyMemory engine selected
    if (service === 'mymemory') {
      const resolvedSl = resolveSourceLang(text, sl);
      const pair = `${resolvedSl}|${tl}`;
      try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;
        const timeoutController = new AbortController();
        const timeoutTimer = setTimeout(() => timeoutController.abort(), 2000);
        const onAbort = () => timeoutController.abort();
        if (signal) signal.addEventListener('abort', onAbort);

        const res = await fetch(url, { signal: timeoutController.signal, keepalive: true });
        clearTimeout(timeoutTimer);
        if (signal) signal.removeEventListener('abort', onAbort);

        if (res.ok) {
          const json = await res.json();
          const rawTrans = json.responseData?.translatedText;
          if (rawTrans && typeof rawTrans === 'string') {
            const decoded = decodeHtmlEntities(rawTrans).trim();
            const upper = decoded.toUpperCase();
            const isWarning = upper.includes('MYMEMORY WARNING') || 
                              upper.includes('INVALID LANGUAGE PAIR') || 
                              upper.includes('NO QUERY SPECIFIED') ||
                              upper.includes('DAILY LIMIT') ||
                              upper.includes('QUERY LENGTH LIMIT');
            const isUntranslated = decoded.toLowerCase() === text.trim().toLowerCase();
            
            if (!isWarning && !isUntranslated && decoded.length > 0) {
              return decoded;
            }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError' && signal && signal.aborted) {
          throw err;
        }
      }
      // If MyMemory failed, timed out, or returned invalid/untranslated text:
      // Silently fall back to Google Translate!
    }

    // Google Translate Primary: gtx
    try {
      const gtxUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
      const res = await fetch(gtxUrl, { method: 'GET', signal, keepalive: true });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && Array.isArray(data[0])) {
          const translated = data[0]
            .map((item) => (Array.isArray(item) && item[0] ? item[0] : ''))
            .join('');
          if (translated) {
            return decodeHtmlEntities(translated);
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }

    // Google Translate Backup: clients5
    try {
      const backupUrl = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;
      const backupRes = await fetch(backupUrl, { method: 'GET', signal, keepalive: true });
      if (backupRes.ok) {
        const backupData = await backupRes.json();
        const result = Array.isArray(backupData) ? backupData[0] : backupData;
        if (result && typeof result === 'string' && result.trim()) {
          return decodeHtmlEntities(result.trim());
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }

    throw new Error('All direct translation endpoints failed');
  }

  /**
   * High-speed translation with local synchronous cache & request deduplication
   */
  async function translateTextFast(text) {
    const trimmed = normalizeText(text);
    if (!trimmed) return '';

    const service = settings.translationService || 'google';
    const cacheKey = `${service}:${settings.sourceLang || 'auto'}->${settings.targetLang || 'vi'}:${trimmed}`;

    // 1. Check local synchronous cache (0ms instant return!)
    if (localCache.has(cacheKey)) {
      return localCache.get(cacheKey);
    }

    // 2. Deduplicate in-flight requests for identical text
    if (inFlightTranslations.has(cacheKey)) {
      return inFlightTranslations.get(cacheKey);
    }

    const promise = (async () => {
      let translated = '';

      // Direct fetch / background service worker
      try {
        const effectiveApiKey = service === 'gemini'
          ? (settings.geminiApiKey || '')
          : (settings.customApiKey || '');

        const response = await chrome.runtime.sendMessage({
          action: 'TRANSLATE',
          text: trimmed,
          sourceLang: settings.sourceLang || 'auto',
          targetLang: settings.targetLang || 'vi',
          service: service,
          apiKey: effectiveApiKey,
          model: settings.geminiModel || 'gemini-3.5-flash-lite',
        });

        if (response && response.success && response.translation) {
          translated = response.translation;
        }
      } catch (err) {
        console.warn('[YT ViSub] Translation message failed:', err);
      }

      // If Gemini translation failed or was empty, auto-fallback to Google Translate fast endpoint
      if (!translated && service === 'gemini') {
        try {
          translated = await fetchDirectTranslation(
            trimmed,
            settings.sourceLang || 'auto',
            settings.targetLang || 'vi',
            'google',
            null
          );
        } catch (_) {}
      }

      // Store in local cache (only genuine non-empty translations)
      if (translated && translated.trim().toLowerCase() !== trimmed.toLowerCase()) {
        if (localCache.size >= MAX_LOCAL_CACHE) {
          const firstKey = localCache.keys().next().value;
          localCache.delete(firstKey);
        }
        localCache.set(cacheKey, translated);
      }

      return translated || '';
    })();

    inFlightTranslations.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      inFlightTranslations.delete(cacheKey);
    }
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
   * Render subtitle lines simultaneously (Guarantees atomic parallel display - song song cùng lúc)
   */
  function renderSubtitlesSimultaneously(origText, transText) {
    if (!innerBox) return;

    if (!transText) {
      // Never display a half-rendered subtitle without translation
      innerBox.classList.add('ytsub-hidden');
      return;
    }

    if (settings.displayMode === 'bilingual') {
      if (originalTextElement) originalTextElement.textContent = origText || '';
      if (origWrapper) origWrapper.style.display = origText ? 'block' : 'none';
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
   * Guarantees that original and translated subtitle ALWAYS appear at the exact same instant (song song).
   */
  async function onCaptionsChanged() {
    if (!settings.enabled || settings.displayMode === 'off') {
      if (innerBox) innerBox.classList.add('ytsub-hidden');
      return;
    }

    const currentText = extractCaptionText();

    if (!currentText) {
      lastCaptionText = '';
      if (innerBox) {
        innerBox.classList.add('ytsub-hidden');
        if (originalTextElement) originalTextElement.textContent = '';
        if (translatedTextElement) translatedTextElement.textContent = '';
      }
      return;
    }

    if (currentText === lastCaptionText) {
      return;
    }

    lastCaptionText = currentText;

    // 1. Check local synchronous cache (0ms instant return - atomic simultaneous display)
    const service = settings.translationService || 'google';
    const cacheKey = `${service}:${settings.sourceLang || 'auto'}->${settings.targetLang || 'vi'}:${currentText}`;
    const cached = localCache.get(cacheKey);

    if (cached) {
      renderSubtitlesSimultaneously(currentText, cached);
      return;
    }

    // 2. If not cached yet: Fetch translation first, then display BOTH lines together at the exact same moment!
    const result = await translateTextFast(currentText);

    if (result) {
      const activeText = extractCaptionText();
      // Render if still on this caption or if active caption is continuing this phrase
      if (activeText === currentText || (activeText && activeText.startsWith(currentText)) || currentText === lastCaptionText) {
        const isDuplicate = result.trim().toLowerCase() === currentText.trim().toLowerCase() && detectScriptLanguage(currentText);
        const safeTrans = isDuplicate ? '' : result;
        if (safeTrans) {
          renderSubtitlesSimultaneously(activeText || currentText, safeTrans);
        }
      }
    }
  }

  /**
   * Parse timedtext data (JSON3 or XML) received from inject.js
   */
  function parseTimedTextData(data) {
    const texts = [];
    if (!data || typeof data !== 'string') return texts;

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
   * Parse pre-translated JSON3 from YouTube Native Translation (&tlang=)
   */
  function parseYouTubeNativeTranslatedData(data) {
    if (!data || typeof data !== 'string' || !data.trim().startsWith('{')) return;
    try {
      const json = JSON.parse(data);
      if (json.events && Array.isArray(json.events)) {
        const service = settings.translationService || 'google';
        const sl = settings.sourceLang || 'auto';
        const tl = settings.targetLang || 'vi';

        json.events.forEach((e) => {
          if (e.segs) {
            const translatedText = normalizeText(e.segs.map((s) => s.utf8 || '').join(''));
            if (translatedText && translatedText.length > 1) {
              localCache.set(`${service}:${sl}->${tl}:${translatedText}`, translatedText);
            }
          }
        });
        console.log(`[YT ViSub] YouTube Native pre-translated cues loaded. Cache: ${localCache.size}`);
      }
    } catch (e) {}
  }

  /**
   * Pre-translate batches of sentences in the background for 0ms playback
   */
  async function processPretranslationQueue() {
    if (isPretranslating || pretranslateQueue.length === 0) return;
    isPretranslating = true;

    const service = settings.translationService || 'google';
    const sl = settings.sourceLang || 'auto';
    const tl = settings.targetLang || 'vi';

    try {
      if (service === 'gemini' && settings.geminiApiKey) {
        // Batch pre-translation with Gemini AI (15 lines per batch)
        while (pretranslateQueue.length > 0 && settings.translationService === 'gemini') {
          const batch = pretranslateQueue.splice(0, 15);
          const toTranslate = batch.filter((txt) => !localCache.has(`${service}:${sl}->${tl}:${txt}`));
          if (toTranslate.length === 0) continue;

          try {
            const response = await chrome.runtime.sendMessage({
              action: 'TRANSLATE_BATCH_GEMINI',
              lines: toTranslate,
              sourceLang: sl,
              targetLang: tl,
              apiKey: settings.geminiApiKey,
              model: settings.geminiModel || 'gemini-3.5-flash-lite',
            });

            if (response && response.success && Array.isArray(response.translations)) {
              toTranslate.forEach((orig, idx) => {
                const trans = (response.translations[idx] || '').trim();
                if (trans) {
                  localCache.set(`${service}:${sl}->${tl}:${orig}`, trans);
                }
              });
              console.log(`[YT ViSub] [Gemini Batch] Pre-translated ${toTranslate.length} subtitle lines into cache.`);
            }
          } catch (e) {
            console.warn('[YT ViSub] Gemini batch pre-translation failed:', e);
          }

          // Delay 2 seconds between batches to strictly respect Gemini 15 RPM free tier!
          await new Promise((r) => setTimeout(r, 2000));
        }
      } else if (service === 'google') {
        // Batch pre-translation with Google Translate (25 lines per batch)
        while (pretranslateQueue.length > 0 && settings.translationService === 'google') {
          const batch = pretranslateQueue.splice(0, 25);
          const toTranslate = batch.filter((txt) => !localCache.has(`${service}:${sl}->${tl}:${txt}`));
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
                    localCache.set(`${service}:${sl}->${tl}:${orig}`, trans);
                  }
                });
              }
            }
          } catch (e) {}

          await new Promise((r) => setTimeout(r, 120));
        }
      }
    } finally {
      isPretranslating = false;
    }
  }

  /**
   * Listen for intercepted timedtext subtitles from inject.js
   */
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== 'YTSUB_INJECT') return;

    if (event.data.captionLang) {
      detectedCaptionLang = event.data.captionLang;
    }

    if (event.data.type === 'TIMEDTEXT_TRANSLATED_RESPONSE') {
      parseYouTubeNativeTranslatedData(event.data.data);
    } else if (event.data.type === 'TIMEDTEXT_RESPONSE') {
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
    syncConfigToMainWorld();
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
      detectedCaptionLang = '';
      setTimeout(() => initPlayer(), 200);
    });

    window.addEventListener('spfdone', () => {
      lastCaptionText = '';
      detectedCaptionLang = '';
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
      let serviceOrKeyChanged = false;
      for (const [key, change] of Object.entries(changes)) {
        settings[key] = change.newValue;
        if (key === 'translationService' || key === 'geminiApiKey' || key === 'geminiModel') {
          serviceOrKeyChanged = true;
        }
      }
      if (serviceOrKeyChanged) {
        localCache.clear();
        console.log('[YT ViSub] Service or key updated. Local cache cleared. Active service:', settings.translationService);
      }
      applySettings();
      syncConfigToMainWorld();
      if (lastCaptionText) {
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
