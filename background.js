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
  geminiStyle: 'auto', // 'auto' | 'lyrics' | 'news' | 'casual'
  geminiPronounRole: 'auto', // 'auto' | 'female' | 'male' | 'neutral'
  githubRepo: 'NgocThachTN/YTSubTranslateExtension', // GitHub repository for release updates
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
 * Extract artist name if explicitly tagged in videoContext
 */
function extractArtistName(videoContext = '') {
  const match = (videoContext || '').match(/Artist:\s*([^\|]+)/i);
  if (match) return match[1].trim();
  return '';
}

/**
 * Detect artist gender from video title, channel name, or metadata
 */
function detectArtistGender(videoContext = '') {
  const text = (videoContext || '').toLowerCase();
  const femalePatterns = [
    /\b(laufey|aimer|yoasobi|zutomayo|yorushika|milet|claris|chappell roan|gracie abrams|sabrina carpenter|olivia dean|beabadoobee|billie eilish|olivia rodrigo|taylor swift|adele|ariana grande|dua lipa|katy perry|rihanna|lady gaga|beyonc[eé]|selena gomez|mariah carey|whitney houston|celine dion|avril lavigne|camila cabello|shakira|sia|lana del rey|halsey|miley cyrus|demi lovato|iu|taeyeon|ros[eé]|jennie|jisoo|lisa|blackpink|twice|aespa|ive|newjeans|le sserafim|red velvet|itzy|gidle|\(g\)i-dle|illit|carly rae jepsen|bebe rexha|ellie goulding|kesha|alessia cara|lorde|anne-marie|madonna|britney spears)\b/i,
    /\b(vũ cát tường|hoàng thùy linh|min|amee|bích phương|văn mai hương|hiền hồ|tóc tiên|bảo anh|đông nhi|mỹ tâm|hồ ngọc hà|khởi my|phương ly|lyly|tlinh|orange|suni hạ linh|vũ phụng tiên|nguyên hà)\b/i
  ];
  const malePatterns = [
    /\b(keshi|joji|fujii kaze|eve|kenshi yonezu|official hige dandism|king gnu|stephen sanchez|conan gray|jeremy zucker|alec benjamin|ed sheeran|charlie puth|bruno mars|justin bieber|the weeknd|post malone|drake|shawn mendes|sam smith|harry styles|zayn|eminem|maroon 5|coldplay|bts|jungkook|jimin|suga|exo|stray kids|seventeen|bigbang|g-dragon)\b/i,
    /\b(sơn tùng|soobin|jack|k-icm|erik|đức phúc|noo phước thịnh|hà anh tuấn|vũ\.|hoàng dũng|quân a\.p|trịnh thăng bình|phan mạnh quỳnh|trung quân|bùi anh tuấn|đan trường|tuấn hưng|justatee|rhymastic|đen vâu|đen|b ray|hieuthuhai|wren evans|mono|grey d|tăng duy tân|lê bảo bình|khắc việt)\b/i
  ];

  for (const p of femalePatterns) {
    if (p.test(text)) return 'female';
  }
  for (const p of malePatterns) {
    if (p.test(text)) return 'male';
  }
  return '';
}

// Session-level anchor map to guarantee 100% consistent pronoun perspective across all song lines
const videoRoleAnchor = new Map();
const MAX_ANCHOR_CACHE = 1000;

function getVideoAnchorKey(videoContext = '') {
  if (!videoContext) return 'default';
  const match = videoContext.match(/Title:\s*([^\|]+)/i) || videoContext.match(/Artist:\s*([^\|]+)/i);
  if (match) return match[1].trim().toLowerCase();
  return videoContext.slice(0, 80).toLowerCase().trim();
}

function resolveSongPronounRole(requestedRole, videoTitle) {
  if (requestedRole && requestedRole !== 'auto') {
    return requestedRole;
  }

  const key = getVideoAnchorKey(videoTitle);
  if (videoRoleAnchor.has(key)) {
    return videoRoleAnchor.get(key);
  }

  const detected = detectArtistGender(videoTitle);
  if (detected) {
    if (videoRoleAnchor.size >= MAX_ANCHOR_CACHE) {
      videoRoleAnchor.delete(videoRoleAnchor.keys().next().value);
    }
    videoRoleAnchor.set(key, detected);
    return detected;
  }

  return 'auto';
}

function anchorRoleFromTranslation(videoTitle, translatedText) {
  const key = getVideoAnchorKey(videoTitle);
  if (!key || videoRoleAnchor.has(key)) return;
  const text = (translatedText || '').toLowerCase();
  const femaleSignals = (text.match(/\b(em|của em|với em|cho em|chính em|bên em)\b/g) || []).length;
  const maleSignals = (text.match(/\b(anh|của anh|với anh|cho anh|chính anh|bên anh)\b/g) || []).length;
  if (femaleSignals > 0 && femaleSignals >= maleSignals) {
    videoRoleAnchor.set(key, 'female');
  } else if (maleSignals > 0 && maleSignals > femaleSignals) {
    videoRoleAnchor.set(key, 'male');
  }
}

/**
 * Sanitize and enforce lyric pronoun consistency on translated Vietnamese output
 */
function cleanLyricsPronouns(text, role) {
  if (!text || typeof text !== 'string') return text;
  let cleaned = text;

  if (role === 'female') {
    cleaned = cleaned
      .replace(/\bTôi\b/g, 'Em')
      .replace(/\btôi\b/g, 'em')
      .replace(/\bchính mình\b/gi, 'chính em')
      .replace(/\bbản thân mình\b/gi, 'bản thân em')
      .replace(/\bcủa mình\b/gi, 'của em')
      .replace(/\bvới mình\b/gi, 'với em')
      .replace(/\bcho mình\b/gi, 'cho em')
      .replace(/^(Anh|anh) (nghĩ|thấy|nhớ|muốn|biết|yêu|cần|đang|đã|sẽ|chẳng|không|bước|khóc|mơ|đợi|chờ|lạc lối|cô đơn)\b/g, (m, p1, p2) => {
        return (p1 === 'Anh' ? 'Em' : 'em') + ' ' + p2;
      });
  } else if (role === 'male') {
    cleaned = cleaned
      .replace(/\bTôi\b/g, 'Anh')
      .replace(/\btôi\b/g, 'anh')
      .replace(/\bchính mình\b/gi, 'chính anh')
      .replace(/\bbản thân mình\b/gi, 'bản thân anh')
      .replace(/\bcủa mình\b/gi, 'của anh')
      .replace(/\bvới mình\b/gi, 'với anh')
      .replace(/\bcho mình\b/gi, 'cho anh')
      .replace(/^(Em|em) (nghĩ|thấy|nhớ|muốn|biết|yêu|cần|đang|đã|sẽ|chẳng|không|bước|khóc|mơ|đợi|chờ|lạc lối|cô đơn)\b/g, (m, p1, p2) => {
        return (p1 === 'Em' ? 'Anh' : 'anh') + ' ' + p2;
      });
  }

  return cleaned;
}

/**
 * Build directive for Vietnamese pronoun roles with 100% song-wide consistency (triệt tiêu nhảy ngôi tôi/mình/em/anh)
 */
function getPronounInstruction(effectiveRole = 'auto', videoTitle = '') {
  if (effectiveRole === 'female') {
    return `\nCRITICAL PRONOUN DIRECTIVE - FEMALE SINGER (ĐỒNG NHẤT 100% NGÔI XƯNG NỮ HÁT):
- The singer is FEMALE. You MUST maintain an absolute, 100% consistent "Em - Anh" lyrical voice across EVERY SINGLE LINE of the song.
- 1st-person pronouns ("I", "me", "my", "mine", "myself") MUST ALWAYS be translated as "em" in every line.
  * STRICT PROHIBITION: NEVER use "tôi", NEVER use "mình", NEVER use "anh" for the singer anywhere in the song!
  * Even if a line has no romantic words (e.g. "I walk alone in the rain", "I think about the past"), translate "I" as "em" ("Em bước một mình dưới mưa", "Em nghĩ về quá khứ").
- 2nd-person pronouns ("you", "your", "yours") MUST ALWAYS be translated as "anh" (or "người" if poetic).
- DO NOT MIX PRONOUNS: The singer must remain "em" from the first line to the very last line!`;
  }

  if (effectiveRole === 'male') {
    return `\nCRITICAL PRONOUN DIRECTIVE - MALE SINGER (ĐỒNG NHẤT 100% NGÔI XƯNG NAM HÁT):
- The singer is MALE. You MUST maintain an absolute, 100% consistent "Anh - Em" lyrical voice across EVERY SINGLE LINE of the song.
- 1st-person pronouns ("I", "me", "my", "mine", "myself") MUST ALWAYS be translated as "anh" in every line.
  * STRICT PROHIBITION: NEVER use "tôi", NEVER use "mình", NEVER use "em" for the singer anywhere in the song!
  * Even if a line has no romantic words (e.g. "I walk alone in the rain", "I think about the past"), translate "I" as "anh" ("Anh bước một mình dưới mưa", "Anh nghĩ về quá khứ").
- 2nd-person pronouns ("you", "your", "yours") MUST ALWAYS be translated as "em" (or "người" if poetic).
- DO NOT MIX PRONOUNS: The singer must remain "anh" from the first line to the very last line!`;
  }

  if (effectiveRole === 'neutral') {
    return `\nCRITICAL PRONOUN DIRECTIVE - NEUTRAL / REFLECTIVE (ĐỒNG NHẤT 100% NGÔI XƯNG TRUNG TÍNH):
- Maintain an absolute, 100% consistent "Tôi - Bạn" or "Ta - Người" perspective across all lines.
- 1st-person pronouns ("I", "me", "my") MUST ALWAYS be translated as "tôi" (or "ta") in every line.
  * STRICT PROHIBITION: NEVER use "anh", NEVER use "em" for the singer anywhere in the song!
- 2nd-person pronouns ("you", "your") MUST ALWAYS be translated as "bạn" or "người".
- DO NOT MIX PRONOUNS across lines!`;
  }

  // Default: 'auto' with dynamic artist identification
  const parsedArtist = extractArtistName(videoTitle);
  const artistLookupHint = parsedArtist ? `
- ARTIST IDENTITY LOOKUP: The singer is identified as "${parsedArtist}". Look up your pre-trained knowledge base to identify whether "${parsedArtist}" is female, male, or a band.` : '';

  return `\nCRITICAL PRONOUN DIRECTIVE - ARTIST IDENTIFICATION & SONG CONSISTENCY (ĐỒNG NHẤT NGÔI XƯNG THEO CA SĨ):${artistLookupHint}
- Infer the singer's gender/role from the artist name or song context and stick to ONE SINGLE perspective 100% consistently across all lines:
  * If female singer/perspective: Singer is ALWAYS "em", listener is ALWAYS "anh" (or "người"). NEVER switch to "tôi" or "mình" anywhere in the song!
  * If male singer/perspective: Singer is ALWAYS "anh", listener is ALWAYS "em" (or "người"). NEVER switch to "tôi" or "mình" anywhere in the song!
  * If rap, band, or philosophical: Singer is ALWAYS "tôi" (or "ta"), listener is ALWAYS "bạn"/"người". NEVER switch to "anh" or "em" anywhere in the song!
- ABSOLUTE PROHIBITION: DO NOT MIX "tôi", "em", "mình", and "anh" for the same person. The singer's self-reference must be identical in every line!`;
}

/**
 * Construct adaptive prompt based on video genre, title, and lyrics detection
 */
function buildGeminiSubtitlePrompt(text, targetName, videoTitle = '', style = 'auto', pronounRole = 'auto') {
  const contextLine = videoTitle ? `Video Context / Title: "${videoTitle.slice(0, 180)}"\n` : '';
  let styleInstruction = '';

  if (style === 'lyrics') {
    styleInstruction = `MODE: SONG LYRICS. Translate poetically, emotionally, and rhythmically like a top Vietnamese lyricist (phổ lời Việt êm dịu, giàu chất thơ và nhạc tính, tránh dịch máy móc cứng nhắc). Preserve musical notes (♪, ♫) if present.`;
  } else if (style === 'news') {
    styleInstruction = `MODE: NEWS & ARTICLES. Use formal, professional, objective, journalistic Vietnamese with accurate terminology.`;
  } else if (style === 'casual') {
    styleInstruction = `MODE: CASUAL CONVERSATION & VLOGS. Use natural, lively, colloquial Vietnamese dialogue.`;
  } else {
    styleInstruction = `MODE: AUTO-ADAPTIVE GENRE DETECTION.
- If this is a SONG or MUSIC VIDEO (title indicates song/MV/singer, or text contains ♪/♫ or poetic verses): Translate poetically, emotionally, and rhythmically like a song lyricist (lời ca mượt mà, sâu lắng, giàu vần điệu). Preserve musical notes (♪, ♫) if present.
- If NEWS, ARTICLE, REPORT, or DOCUMENTARY: Use crisp, formal, journalistic, informative Vietnamese.
- If VLOG, PODCAST, GAMING, or CASUAL DIALOGUE: Use authentic, natural, colloquial Vietnamese.`;
  }

  const effectiveRole = resolveSongPronounRole(pronounRole, videoTitle);
  const pronounInstruction = targetName === 'Vietnamese' ? getPronounInstruction(effectiveRole, videoTitle) : '';

  return `You are a world-class bilingual subtitle translator and lyrical adapter adapting style to video content:
${contextLine}${styleInstruction}${pronounInstruction}

Translate directly into natural, concise ${targetName} suitable for video subtitles. Output ONLY the translated text, no quotes, no explanations:
${text}`;
}

function buildGeminiBatchSubtitlePrompt(lines, targetName, videoTitle = '', style = 'auto', pronounRole = 'auto') {
  const contextLine = videoTitle ? `Video Context / Title: "${videoTitle.slice(0, 180)}"\n` : '';
  const promptLines = lines.map((text, idx) => `${idx + 1}. ${text}`).join('\n');
  let styleInstruction = '';

  if (style === 'lyrics') {
    styleInstruction = `MODE: SONG LYRICS. Translate these continuous lines as song lyrics with poetic cadence, melodic flow, and deep emotion across lines (phổ lời Việt êm ái, giàu cảm xúc, uyển chuyển). Preserve musical notes (♪, ♫) if present.`;
  } else if (style === 'news') {
    styleInstruction = `MODE: NEWS & ARTICLES. Use formal, professional, objective, journalistic Vietnamese with accurate terminology.`;
  } else if (style === 'casual') {
    styleInstruction = `MODE: CASUAL & VLOGS. Use lively, natural, colloquial Vietnamese dialogue.`;
  } else {
    styleInstruction = `MODE: AUTO-ADAPTIVE GENRE DETECTION.
- If this is a SONG or MUSIC VIDEO (title indicates music/song, or lines have ♪/♫ or lyric rhymes): Translate as lyrics with poetic rhythm, musical cadence, and deep emotion across lines (lời ca giàu vần điệu, cảm xúc). Preserve musical notes (♪, ♫).
- If NEWS, ARTICLE, REPORT, or DOCUMENTARY: Use crisp, formal, journalistic, informative Vietnamese.
- If VLOG, GAMING, or CASUAL DIALOGUE: Use authentic, natural, colloquial Vietnamese.`;
  }

  const effectiveRole = resolveSongPronounRole(pronounRole, videoTitle);
  const pronounInstruction = targetName === 'Vietnamese' ? getPronounInstruction(effectiveRole, videoTitle) : '';

  return `You are a world-class bilingual subtitle translator translating continuous video subtitles:
${contextLine}${styleInstruction}${pronounInstruction}

Maintain exact line numbering (e.g. "1. <translation>"). Output ONLY the numbered translated lines in ${targetName}:
${promptLines}`;
}

/**
 * Translate single subtitle line using Google Gemini AI API (Fast, low-latency, genre-aware)
 */
async function translateWithGemini(text, sourceLang, targetLang, apiKey, model = 'gemini-3.5-flash-lite', videoTitle = '', style = 'auto', pronounRole = 'auto') {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Missing Gemini API Key');
  }
  const tl = targetLang || 'vi';
  const targetName = tl === 'vi' ? 'Vietnamese' : tl;
  const chosenModel = resolveGeminiModel(model);
  const effectiveRole = resolveSongPronounRole(pronounRole, videoTitle);

  const prompt = buildGeminiSubtitlePrompt(text, targetName, videoTitle, style, effectiveRole);

  const callModel = async (modelName) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 120
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
    let cleaned = rawText
      .trim()
      .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
      .replace(/^(Bản dịch|Translation):\s*/i, '')
      .trim();
    if (cleaned) {
      cleaned = cleanLyricsPronouns(decodeHtmlEntities(cleaned), effectiveRole);
      anchorRoleFromTranslation(videoTitle, cleaned);
      return cleaned;
    }
  }

  throw new Error(`Invalid response structure from Gemini API (${chosenModel})`);
}

/**
 * Batch translate multiple subtitle lines in a single Gemini API call (High throughput, 0ms playback, genre-aware)
 */
async function translateBatchWithGemini(lines, sourceLang, targetLang, apiKey, model = 'gemini-3.5-flash-lite', videoTitle = '', style = 'auto', pronounRole = 'auto') {
  if (!lines || lines.length === 0) return [];
  if (!apiKey || !apiKey.trim()) throw new Error('Missing Gemini API Key');

  const tl = targetLang || 'vi';
  const targetName = tl === 'vi' ? 'Vietnamese' : tl;
  const chosenModel = resolveGeminiModel(model);
  const effectiveRole = resolveSongPronounRole(pronounRole, videoTitle);

  const prompt = buildGeminiBatchSubtitlePrompt(lines, targetName, videoTitle, style, effectiveRole);

  const callModel = async (modelName) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.35,
          maxOutputTokens: 1400
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
        results[idx] = cleanLyricsPronouns(decodeHtmlEntities(match[2].trim()), effectiveRole);
      }
    }
  }

  // Fallback if numbered format failed
  if (results.filter(Boolean).length < lines.length / 2) {
    const cleanLines = outputLines
      .map(l => l.replace(/^\s*\d+[\.\:\)]\s*/, '').trim())
      .filter(Boolean);
    if (cleanLines.length === lines.length) {
      for (let i = 0; i < lines.length; i++) {
        results[i] = cleanLyricsPronouns(decodeHtmlEntities(cleanLines[i]), effectiveRole);
      }
    }
  }

  if (results.some(Boolean)) {
    anchorRoleFromTranslation(videoTitle, results.join(' '));
  }

  return results;
}

/**
 * Handle translation requests with caching and multi-engine routing
 */
async function handleTranslation({ text, sourceLang = 'auto', targetLang = 'vi', service = 'google', apiKey = '', model = 'gemini-3.5-flash-lite', videoTitle = '', style = 'auto', pronounRole = 'auto' }) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { success: true, translation: '' };
  }

  const cacheKey = `${service}:${style || 'auto'}:${pronounRole || 'auto'}:${sourceLang}->${targetLang}:${apiKey ? 'custom' : 'free'}:${trimmed}`;

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
          translated = await translateWithGemini(trimmed, sourceLang, targetLang, gKey, model, videoTitle, style, pronounRole);
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
    videoRoleAnchor.clear();
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
      request.model || 'gemini-3.5-flash-lite',
      request.videoTitle || '',
      request.style || 'auto',
      request.pronounRole || 'auto'
    )
      .then((translations) => sendResponse({ success: true, translations }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'TEST_GEMINI_KEY') {
    const chosenModel = resolveGeminiModel(request.model || 'gemini-3.5-flash-lite');
    translateWithGemini(
      '♪ Cause baby now we got bad blood, you know it used to be mad love ♪',
      'en',
      'vi',
      request.apiKey,
      chosenModel,
      'Taylor Swift - Bad Blood (Official Music Video) | Artist: Taylor Swift',
      request.style || 'auto',
      request.pronounRole || 'auto'
    )
      .then((trans) => sendResponse({ success: true, translation: trans, model: chosenModel }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'PING') {
    sendResponse({ success: true, pong: true });
    return true;
  }
});
