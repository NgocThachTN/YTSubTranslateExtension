/**
 * YouTube Subtitle Translator - Background Service Worker
 * Handles Multi-Engine Translation (Google Translate, YouTube Native, MyMemory, Google Cloud API),
 * with dual-layer caching, automatic failover, and settings synchronization.
 */

// In-memory cache for translations to reduce API calls and improve performance
const translationCache = new Map();
const MAX_CACHE_SIZE = 4000;

// Default configuration settings
const DEFAULT_SETTINGS = {
  enabled: true,
  displayMode: 'bilingual', // 'bilingual' | 'vietnamese_only' | 'off'
  translationService: 'google', // 'google' | 'youtube' | 'mymemory' | 'google_cloud'
  sourceLang: 'auto',
  targetLang: 'vi',
  fontSize: 20,
  fontColor: '#FFFFFF', // Clean white matching native YouTube subtitle color
  originalColor: '#FFFFFF', // Soft light gray/white for original subtitle in bilingual mode
  bgOpacity: 75, // 75% dark backdrop (YouTube native standard)
  subPosition: 'bottom', // 'bottom' | 'top'
  subBottomOffset: 0, // 0 = automatic responsive elevation above player controls
  hideOriginalNative: true, // Hide YouTube's native subtitle render to avoid overlap
  customApiKey: '', // Optional Google Cloud Translation API key
  geminiApiKey: '', // Optional Google Gemini AI API key (free tier)
  geminiModel: 'gemini-3.5-flash-lite', // 'gemini-3.5-flash-lite' | 'gemini-3.5-flash'
};

// Initialize default settings upon installation
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const existing = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
    const toSet = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (existing[key] === undefined) {
        toSet[key] = value;
      }
    }
    // Auto-migrate legacy 1.5, 2.0 or undefined models to gemini-3.5-flash-lite
    if (existing.geminiModel && (existing.geminiModel.includes('1.5') || existing.geminiModel.includes('2.0'))) {
      toSet.geminiModel = 'gemini-3.5-flash-lite';
    }
    // Migrate legacy default 60 to 0
    if (existing.subBottomOffset === 60) {
      toSet.subBottomOffset = 0;
    }
    if (Object.keys(toSet).length > 0) {
      await chrome.storage.sync.set(toSet);
    }
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
 * Translate text using Google Translate free endpoint (with automatic fast failover)
 */
async function translateWithFreeGoogleEndpoint(text, sourceLang, targetLang) {
  const sl = sourceLang || 'auto';
  const tl = targetLang || 'vi';

  // Primary endpoint: gtx
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url, { keepalive: true });
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        const translatedText = data[0]
          .map((item) => (Array.isArray(item) && item[0] ? item[0] : ''))
          .join('');
        return decodeHtmlEntities(translatedText);
      }
    }
  } catch (err) {
    console.warn('[YT Sub Translate] Primary gtx endpoint failed, trying backup...', err);
  }

  // Backup fast endpoint: dict-chrome-ex
  const backupUrl = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;
  const backupRes = await fetch(backupUrl, { keepalive: true });
  if (backupRes.ok) {
    const backupData = await backupRes.json();
    const result = Array.isArray(backupData) ? backupData[0] : backupData;
    if (result && typeof result === 'string') {
      return decodeHtmlEntities(result);
    }
  }

  throw new Error('All Google translation endpoints failed');
}

/**
 * Fast script detection for CJK, Cyrillic, Arabic, etc.
 */
function detectScriptLanguage(text) {
  if (!text) return '';
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja';
  if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(text)) return 'ko';
  if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text)) return 'zh';
  if (/[\u0400-\u04FF]/.test(text)) return 'ru';
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  if (/[\u0E00-\u0E7F]/.test(text)) return 'th';
  if (/[\u0370-\u03FF]/.test(text)) return 'el';
  if (/[\u0590-\u05FF]/.test(text)) return 'he';
  return '';
}

/**
 * Translate text using MyMemory Translation API (Free Translation Memory engine)
 */
async function translateWithMyMemory(text, sourceLang, targetLang) {
  let sl = sourceLang === 'auto' ? '' : sourceLang;
  if (!sl) {
    sl = detectScriptLanguage(text) || 'en';
  }
  const tl = targetLang || 'vi';
  const pair = `${sl}|${tl}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;

  const res = await fetch(url, { keepalive: true });
  if (!res.ok) {
    throw new Error(`MyMemory HTTP ${res.status}`);
  }

  const data = await res.json();
  const rawTrans = data?.responseData?.translatedText;
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
  throw new Error('MyMemory translation invalid, untranslated or quota exceeded');
}

/**
 * Safely resolve model name to supported Gemini API models
 */
function resolveGeminiModel(model) {
  if (!model) return 'gemini-3.5-flash-lite';
  if (model.includes('lite')) return 'gemini-3.5-flash-lite';
  if (model.includes('3.5-flash') || model.includes('3.5')) return 'gemini-3.5-flash';
  // Map any legacy 2.0 or 1.5 to 3.5-flash-lite
  if (model.includes('2.0') || model.includes('1.5')) return 'gemini-3.5-flash-lite';
  return 'gemini-3.5-flash-lite';
}

/**
 * Translate single subtitle line using Google Gemini AI API (Fast, low-latency, deterministic)
 */
async function translateWithGemini(text, sourceLang, targetLang, apiKey, model = 'gemini-3.5-flash-lite') {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Missing Gemini API Key');
  }
  const tl = targetLang || 'vi';
  const targetName = tl === 'vi' ? 'Vietnamese' : tl;
  const chosenModel = resolveGeminiModel(model);

  const prompt = `Translate this subtitle line directly to natural, conversational ${targetName}. Keep it concise for video subtitles. Output ONLY the translated text, no quotes, no extra explanations:\n${text}`;

  const callModel = async (modelName) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 60
        }
      }),
      keepalive: true
    });
  };

  let res = await callModel(chosenModel);

  // If the chosen model returns 404, fallback gracefully to gemini-3.5-flash
  if (res.status === 404 && chosenModel !== 'gemini-3.5-flash') {
    console.warn(`[YT Sub Translate] ${chosenModel} not found on this API key, falling back to gemini-3.5-flash...`);
    res = await callModel('gemini-3.5-flash');
  }

  if (!res.ok) {
    let errMessage = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson?.error?.message) {
        errMessage = errJson.error.message;
      }
    } catch (_) {
      try {
        const errText = await res.text();
        if (errText) errMessage = errText;
      } catch (__) {}
    }
    throw new Error(`Gemini API (${chosenModel}): ${errMessage}`);
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

  throw new Error(`Invalid response structure from Gemini API (${chosenModel})`);
}

/**
 * Batch translate multiple subtitle lines in a single Gemini API call (High throughput, 0ms playback)
 */
async function translateBatchWithGemini(lines, sourceLang, targetLang, apiKey, model = 'gemini-3.5-flash-lite') {
  if (!lines || lines.length === 0) return [];
  if (!apiKey || !apiKey.trim()) throw new Error('Missing Gemini API Key');

  const tl = targetLang || 'vi';
  const targetName = tl === 'vi' ? 'Vietnamese' : tl;
  const chosenModel = resolveGeminiModel(model);

  const promptLines = lines.map((text, idx) => `${idx + 1}. ${text}`).join('\n');
  const prompt = `Translate these numbered video subtitle lines to natural, conversational ${targetName}. Keep each translation concise and preserve tone and meaning.
Return ONLY the translated lines with their respective line numbers (e.g. "1. <translation>"). No extra text:
${promptLines}`;

  const callModel = async (modelName) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024
        }
      }),
      keepalive: true
    });
  };

  let res = await callModel(chosenModel);
  if (res.status === 404 && chosenModel !== 'gemini-3.5-flash') {
    res = await callModel('gemini-3.5-flash');
  }

  if (!res.ok) {
    let errMessage = `HTTP ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson?.error?.message) errMessage = errJson.error.message;
    } catch (_) {}
    throw new Error(`Gemini Batch API (${chosenModel}): ${errMessage}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  const results = new Array(lines.length).fill('');
  const outputLines = rawText.split('\n');
  for (const line of outputLines) {
    const match = line.match(/^\s*(\d+)[\.\:\)]\s*(.*)$/);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      if (idx >= 0 && idx < lines.length) {
        results[idx] = decodeHtmlEntities(match[2].trim());
      }
    }
  }

  return results;
}

/**
 * Handle translation requests with caching and multi-engine routing
 */
async function handleTranslation({ text, sourceLang = 'auto', targetLang = 'vi', service = 'google', apiKey = '', model = 'gemini-2.0-flash' }) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { success: true, translation: '' };
  }

  const cacheKey = `${service}:${sourceLang}->${targetLang}:${apiKey ? 'custom' : 'free'}:${trimmed}`;

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

    if (service === 'gemini') {
      const gKey = (apiKey || '').trim();
      if (gKey) {
        try {
          translated = await translateWithGemini(trimmed, sourceLang, targetLang, gKey, model);
        } catch (err) {
          console.warn('[YT Sub Translate] Gemini API failed, falling back to Google Translate...', err);
          translated = await translateWithFreeGoogleEndpoint(trimmed, sourceLang, targetLang);
        }
      } else {
        translated = await translateWithFreeGoogleEndpoint(trimmed, sourceLang, targetLang);
      }
    } else if (apiKey && apiKey.trim().length > 0) {
      translated = await translateWithGoogleCloudApi(trimmed, sourceLang, targetLang, apiKey.trim());
    } else if (service === 'mymemory') {
      try {
        translated = await translateWithMyMemory(trimmed, sourceLang, targetLang);
      } catch (err) {
        console.warn('[YT Sub Translate] MyMemory failed, falling back to Google Translate...', err);
        translated = await translateWithFreeGoogleEndpoint(trimmed, sourceLang, targetLang);
      }
    } else {
      // Default: Google Translate fast endpoints
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
    return true;
  }

  if (request.action === 'CLEAR_CACHE') {
    translationCache.clear();
    sendResponse({ success: true, count: 0 });
    return true;
  }

  if (request.action === 'GET_CACHE_STATS') {
    sendResponse({ success: true, size: translationCache.size });
    return true;
  }

  if (request.action === 'TRANSLATE_BATCH_GEMINI') {
    translateBatchWithGemini(
      request.lines,
      request.sourceLang || 'auto',
      request.targetLang || 'vi',
      request.apiKey,
      request.model || 'gemini-3.5-flash-lite'
    )
      .then((translations) => sendResponse({ success: true, translations }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'TEST_GEMINI_KEY') {
    const chosenModel = resolveGeminiModel(request.model || 'gemini-3.5-flash-lite');
    translateWithGemini('Hello, this is a test subtitle from YouTube.', 'en', 'vi', request.apiKey, chosenModel)
      .then((trans) => sendResponse({ success: true, translation: trans, model: chosenModel }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'PING') {
    sendResponse({ success: true, pong: true });
    return true;
  }
});
