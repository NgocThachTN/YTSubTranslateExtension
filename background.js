/**
 * YouTube Subtitle Translator - Background Service Worker
 * Handles Google Translate API requests, caching, and default extension settings.
 */

// In-memory cache for translations to reduce API calls and improve performance
const translationCache = new Map();
const MAX_CACHE_SIZE = 3000;

// Default configuration settings
const DEFAULT_SETTINGS = {
  enabled: true,
  displayMode: 'bilingual', // 'bilingual' | 'vietnamese_only' | 'off'
  sourceLang: 'auto',
  targetLang: 'vi',
  fontSize: 20,
  fontColor: '#FFE600', // Yellow for Vietnamese translated subtitle
  originalColor: '#FFFFFF', // White for original subtitle
  bgOpacity: 65, // % opacity of background box
  subPosition: 'bottom', // 'bottom' | 'top'
  subBottomOffset: 60, // px from bottom of video player
  hideOriginalNative: true, // Hide YouTube's native subtitle render to avoid overlap
  customApiKey: '', // Optional Google Cloud Translation API key
};

// Initialize default settings upon installation
chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const existing = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
    const toSet = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (existing[key] === undefined) {
        toSet[key] = value;
      }
    }
    if (Object.keys(toSet).length > 0) {
      await chrome.storage.sync.set(toSet);
    }
    console.log('[YT Sub Translate] Extension initialized with settings:', { ...DEFAULT_SETTINGS, ...existing });
  } catch (err) {
    console.error('[YT Sub Translate] Failed to initialize settings:', err);
  }
});

/**
 * Decode HTML entities like &quot;, &#39;, &amp;, &lt;, &gt;
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
 * Translate text using Google Cloud Translation API (if API Key provided)
 */
async function translateWithGoogleCloudApi(text, sourceLang, targetLang, apiKey) {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`;
  const body = {
    q: text,
    target: targetLang,
    format: 'text',
  };
  if (sourceLang && sourceLang !== 'auto') {
    body.source = sourceLang;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google Cloud API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  if (data?.data?.translations?.[0]?.translatedText) {
    return decodeHtmlEntities(data.data.translations[0].translatedText);
  }
  throw new Error('Invalid response structure from Google Cloud API');
}

/**
 * Translate text using Google Translate free endpoint (client=gtx)
 */
async function translateWithFreeGoogleEndpoint(text, sourceLang, targetLang) {
  const sl = sourceLang || 'auto';
  const tl = targetLang || 'vi';
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Google Translate Web API returned status ${response.status}`);
  }

  const data = await response.json();
  if (Array.isArray(data) && Array.isArray(data[0])) {
    const translatedText = data[0]
      .map((item) => (Array.isArray(item) && item[0] ? item[0] : ''))
      .join('');
    return decodeHtmlEntities(translatedText);
  }
  throw new Error('Unexpected translation response format');
}

/**
 * Handle translation requests with caching
 */
async function handleTranslation({ text, sourceLang = 'auto', targetLang = 'vi', apiKey = '' }) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { success: true, translation: '' };
  }

  const cacheKey = `${sourceLang}->${targetLang}:${apiKey ? 'custom' : 'free'}:${trimmed}`;

  // Check in-memory cache
  if (translationCache.has(cacheKey)) {
    return {
      success: true,
      translation: translationCache.get(cacheKey),
      fromCache: true,
    };
  }

  try {
    let translated = '';
    if (apiKey && apiKey.trim().length > 0) {
      translated = await translateWithGoogleCloudApi(trimmed, sourceLang, targetLang, apiKey.trim());
    } else {
      translated = await translateWithFreeGoogleEndpoint(trimmed, sourceLang, targetLang);
    }

    // Add to cache with size limit check
    if (translationCache.size >= MAX_CACHE_SIZE) {
      const firstKey = translationCache.keys().next().value;
      translationCache.delete(firstKey);
    }
    translationCache.set(cacheKey, translated);

    return {
      success: true,
      translation: translated,
      fromCache: false,
    };
  } catch (error) {
    console.error('[YT Sub Translate] Translation error:', error);
    return {
      success: false,
      error: error.message || 'Translation failed',
    };
  }
}

// Handle message communication from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'TRANSLATE') {
    handleTranslation(request)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Indicates asynchronous response
  }

  if (request.action === 'CLEAR_CACHE') {
    translationCache.clear();
    console.log('[YT Sub Translate] Cache cleared.');
    sendResponse({ success: true, count: 0 });
    return true;
  }

  if (request.action === 'GET_CACHE_STATS') {
    sendResponse({ success: true, size: translationCache.size });
    return true;
  }

  if (request.action === 'PING') {
    sendResponse({ success: true, pong: true });
    return true;
  }
});
