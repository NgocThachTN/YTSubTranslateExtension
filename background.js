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
/**
 * Parse structured video context
 */
function parseVideoContext(videoContext = '') {
  const result = {
    genre: '',
    artist: '',
    guest: '',
    show: '',
    channel: '',
    title: videoContext
  };

  const genreMatch = videoContext.match(/Genre:\s*([^\|]+)/i);
  if (genreMatch) result.genre = genreMatch[1].trim().toLowerCase();

  const artistMatch = videoContext.match(/Artist:\s*([^\|]+)/i);
  if (artistMatch) result.artist = artistMatch[1].trim();

  const guestMatch = videoContext.match(/Guest\/Figure:\s*([^\|]+)/i);
  if (guestMatch) result.guest = guestMatch[1].trim();

  const showMatch = videoContext.match(/Show:\s*([^\|]+)/i);
  if (showMatch) result.show = showMatch[1].trim();

  const channelMatch = videoContext.match(/Channel:\s*([^\|]+)/i);
  if (channelMatch) result.channel = channelMatch[1].trim();

  const titleMatch = videoContext.match(/Title:\s*([^\|]+)/i);
  if (titleMatch) result.title = titleMatch[1].trim();

  return result;
}

/**
 * Determine effective video genre (lyrics | reality_show | news | casual)
 */
function resolveEffectiveGenre(requestedStyle = 'auto', videoContext = '') {
  if (requestedStyle && requestedStyle !== 'auto') {
    if (requestedStyle === 'lyrics') return 'lyrics';
    if (requestedStyle === 'reality') return 'reality_show';
    if (requestedStyle === 'news') return 'news';
    if (requestedStyle === 'casual') return 'casual';
  }

  const meta = parseVideoContext(videoContext);
  if (meta.genre) {
    if (meta.genre === 'music') return 'lyrics';
    if (meta.genre === 'reality_show') return 'reality_show';
    if (meta.genre === 'news') return 'news';
  }

  const lower = (videoContext || '').toLowerCase();
  if (/\b(bbc|cnn|vtv|cnbc|bloomberg|reuters|news|thời sự|bản tin|phóng sự|documentary|điều tra)\b/i.test(lower)) {
    return 'news';
  }
  if (/\b(running man|knowing bros|2 ngày 1 đêm|talkshow|podcast|phỏng vấn|interview|hot ones|the tonight show|game show|weekly idol|ep\.\s*\d+|tập\s*\d+|show thực tế)\b/i.test(lower)) {
    return 'reality_show';
  }
  if (/\b(mv|official music video|lyrics|audio|song|ca khúc|bài hát|album|♪|♫)\b/i.test(lower)) {
    return 'lyrics';
  }

  return 'casual';
}

/**
 * Extract primary artist, guest or figure name from videoContext
 */
function extractPrimaryFigure(videoContext = '') {
  const meta = parseVideoContext(videoContext);
  return meta.artist || meta.guest || meta.show || meta.channel || '';
}

/**
 * Detect figure gender from video title, channel name, or metadata
 */
function detectFigureGender(videoContext = '') {
  const text = (videoContext || '').toLowerCase();
  const femalePatterns = [
    /\b(laufey|aimer|yoasobi|zutomayo|yorushika|milet|claris|chappell roan|gracie abrams|sabrina carpenter|olivia dean|beabadoobee|billie eilish|olivia rodrigo|taylor swift|adele|ariana grande|dua lipa|katy perry|rihanna|lady gaga|beyonc[eé]|selena gomez|mariah carey|whitney houston|celine dion|avril lavigne|camila cabello|shakira|sia|lana del rey|halsey|miley cyrus|demi lovato|iu|taeyeon|ros[eé]|jennie|jisoo|lisa|blackpink|twice|aespa|ive|newjeans|le sserafim|red velvet|itzy|gidle|\(g\)i-dle|illit|carly rae jepsen|bebe rexha|ellie goulding|kesha|alessia cara|lorde|anne-marie|madonna|britney spears)\b/i,
    /\b(ellen|oprah|drew barrymore|kelly clarkson|song ji hyo|jeon so min|thúy ngân|lan ngọc|ninh dương lan ngọc|hari won|lâm vỹ dạ|sam|khả như)\b/i,
    /\b(vũ cát tường|hoàng thùy linh|min|amee|bích phương|văn mai hương|hiền hồ|tóc tiên|bảo anh|đông nhi|mỹ tâm|hồ ngọc hà|khởi my|phương ly|lyly|tlinh|orange|suni hạ linh|vũ phụng tiên|nguyên hà)\b/i
  ];
  const malePatterns = [
    /\b(keshi|joji|fujii kaze|eve|kenshi yonezu|official hige dandism|king gnu|stephen sanchez|conan gray|jeremy zucker|alec benjamin|ed sheeran|charlie puth|bruno mars|justin bieber|the weeknd|post malone|drake|shawn mendes|sam smith|harry styles|zayn|eminem|maroon 5|coldplay|bts|jungkook|jimin|suga|exo|stray kids|seventeen|bigbang|g-dragon)\b/i,
    /\b(jimmy fallon|jimmy kimmel|stephen colbert|james corden|graham norton|joe rogan|conan o'brien|seth meyers|gordon ramsay|yoo jae suk|kang ho dong|shin dong yup|kim jong kook|haha|lee kwang soo|ji suk jin|yang se chan|lee soo geun|seo jang hoon|kim hee chul|min kyung hoon)\b/i,
    /\b(trấn thành|trường giang|đại nghĩa|ngô kiến huy|jun phạm|lê dương bảo lâm|hieuthuhai|cris phan|sơn tùng|soobin|jack|k-icm|erik|đức phúc|noo phước thịnh|hà anh tuấn|vũ\.|hoàng dũng|quân a\.p|trịnh thăng bình|phan mạnh quỳnh|trung quân|bùi anh tuấn|đan trường|tuấn hưng|justatee|rhymastic|đen vâu|đen|b ray|wren evans|mono|grey d|tăng duy tân|lê bảo bình|khắc việt)\b/i
  ];

  for (const p of femalePatterns) {
    if (p.test(text)) return 'female';
  }
  for (const p of malePatterns) {
    if (p.test(text)) return 'male';
  }
  return '';
}

// Session-level anchor map to guarantee 100% consistent perspective across all video lines
const videoRoleAnchor = new Map();
const MAX_ANCHOR_CACHE = 1000;

function getVideoAnchorKey(videoContext = '') {
  if (!videoContext) return 'default';
  const match = videoContext.match(/Title:\s*([^\|]+)/i) || videoContext.match(/Artist:\s*([^\|]+)/i) || videoContext.match(/Show:\s*([^\|]+)/i);
  if (match) return match[1].trim().toLowerCase();
  return videoContext.slice(0, 80).toLowerCase().trim();
}

function resolveSongPronounRole(requestedRole, videoTitle, effectiveGenre = 'lyrics') {
  if (requestedRole && requestedRole !== 'auto') {
    return requestedRole;
  }

  const key = getVideoAnchorKey(videoTitle);
  if (videoRoleAnchor.has(key)) {
    return videoRoleAnchor.get(key);
  }

  const detected = detectFigureGender(videoTitle);
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
 * Sanitize and enforce genre-specific pronoun consistency on translated Vietnamese output
 */
function cleanOutputByGenre(text, effectiveGenre, role) {
  if (!text || typeof text !== 'string') return text;
  let cleaned = text;

  if (effectiveGenre === 'lyrics') {
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
  } else if (effectiveGenre === 'reality_show') {
    // In reality shows, avoid inappropriate romantic couple address (anh yêu / em yêu)
    cleaned = cleaned
      .replace(/\banh yêu\b/gi, 'anh')
      .replace(/\bem yêu\b/gi, 'em')
      .replace(/\bcục cưng\b/gi, 'bạn');
  } else if (effectiveGenre === 'news') {
    // In news & reports, eliminate romantic & casual pronouns
    cleaned = cleaned
      .replace(/\banh yêu\b/gi, 'nam ca sĩ')
      .replace(/\bem yêu\b/gi, 'nữ ca sĩ')
      .replace(/\bmình ơi\b/gi, '');
  }

  return cleaned;
}

/**
 * Build directive for Vietnamese pronoun roles adaptive to Genre (Music, Reality Shows, News)
 */
function getPronounInstruction(effectiveRole = 'auto', videoTitle = '', effectiveGenre = 'lyrics') {
  const primaryFigure = extractPrimaryFigure(videoTitle);
  const figureHint = primaryFigure ? ` Identified figure/artist: "${primaryFigure}".` : '';

  // 1. REALITY SHOW / TALKSHOW / PODCAST / INTERVIEW DIRECTIVE
  if (effectiveGenre === 'reality_show') {
    let roleSpecific = '';
    if (effectiveRole === 'show_host') {
      roleSpecific = `\n- SPEAKER IS MC/HOST: When addressing the audience, use "chúng tôi", "quý vị và các bạn", "mọi người". When talking with guests, address them as "bạn", "anh", "chị", "em".`;
    } else if (effectiveRole === 'female') {
      roleSpecific = `\n- SPEAKER IS FEMALE: Address herself naturally as "em" (when talking to seniors/hosts) or "mình/tôi" (sharing views). Address others as "anh", "chị", "bạn".`;
    } else if (effectiveRole === 'male') {
      roleSpecific = `\n- SPEAKER IS MALE: Address himself naturally as "anh" (to juniors) or "em" (to seniors) or "tôi/mình". Address others respectfully.`;
    }

    return `\nCRITICAL PRONOUN DIRECTIVE - REALITY SHOW / TALKSHOW / INTERVIEW (SHOW THỰC TẾ & PHỎNG VẤN):${figureHint}
- CONTEXT: This is a reality show, variety show, podcast, or interview. People are talking and interacting dynamically in real life.
- PRONOUN USAGE (XƯNG HÔ ĐÚNG CHUẨN ĐỜI SỐNG THỰC TẾ):
  * Host with audience: "chúng tôi", "quý vị và các bạn", "mọi người".
  * Participants with each other: Use natural Vietnamese conversational address ("anh / em", "chị / em", "tôi / bạn", "mình / cậu", "mọi người").
  * STRICT PROHIBITION: NEVER use romantic couple pronouns ("anh yêu / em yêu") unless this is explicitly a romantic dating show! This is an entertainment show/interview, NOT a love song.
  * DO NOT use stiff robotic pronouns ("tôi nghĩ bạn nên..."). Translate naturally ("mình nghĩ cậu nên...", "anh thấy em nên...").
  * Translate natural exclamations lively: "Trời ơi!", "Thật không?", "Cười xỉu", "Tuyệt vời!".${roleSpecific}`;
  }

  // 2. NEWS & JOURNALISM DIRECTIVE
  if (effectiveGenre === 'news') {
    return `\nCRITICAL PRONOUN DIRECTIVE - NEWS & JOURNALISM (BÁO CHÍ, THỜI SỰ & PHÓNG SỰ):${figureHint}
- CONTEXT: Formal news report, documentary, or journalistic article.
- PRONOUN USAGE (DANH XƯNG BÁO CHÍ CHUẨN MỰC):
  * News Anchor / Reporter: Use editorial "chúng tôi", "phóng viên", or neutral 3rd-person narration.
  * Public figures & Artists mentioned: MUST be addressed with proper respectful titles:
    - Female artist/singer: "nữ ca sĩ [Tên]", "nữ nghệ sĩ [Tên]", "cô [Tên]"
    - Male artist/singer: "nam ca sĩ [Tên]", "nam diễn viên [Tên]", "anh [Tên]"
    - Experts/Leaders: "ông/bà [Tên]", "vị chuyên gia", "nhà khoa học"
  * STRICT PROHIBITION: NEVER use casual or romantic pronouns ("anh yêu", "em yêu", "cậu ấy", "mình"). Maintain journalistic objectivity and professional distance.
  * Terminology: Use standard, concise journalistic Vietnamese.`;
  }

  // 3. SONG LYRICS DIRECTIVE
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
  const parsedArtist = primaryFigure;
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
 * Construct adaptive prompt based on video genre, title, entities and lyrics detection
 */
function buildGeminiSubtitlePrompt(text, targetName, videoTitle = '', style = 'auto', pronounRole = 'auto') {
  const contextLine = videoTitle ? `Video Context / Metadata: "${videoTitle.slice(0, 240)}"\n` : '';
  const effectiveGenre = resolveEffectiveGenre(style, videoTitle);
  let styleInstruction = '';

  if (effectiveGenre === 'lyrics') {
    styleInstruction = `MODE: SONG LYRICS. Translate poetically, emotionally, and rhythmically like a top Vietnamese lyricist (phổ lời Việt êm dịu, giàu chất thơ và nhạc tính, tránh dịch máy móc cứng nhắc). Preserve musical notes (♪, ♫) if present.`;
  } else if (effectiveGenre === 'reality_show') {
    styleInstruction = `MODE: REALITY SHOW & TALK SHOW. Translate lively, authentic, witty, and conversational Vietnamese for reality/game show dialogue.`;
  } else if (effectiveGenre === 'news') {
    styleInstruction = `MODE: NEWS & ARTICLES. Use formal, professional, objective, journalistic Vietnamese with accurate terminology and proper respectful titles.`;
  } else {
    styleInstruction = `MODE: CASUAL CONVERSATION & VLOGS. Use natural, lively, colloquial Vietnamese dialogue.`;
  }

  const effectiveRole = resolveSongPronounRole(pronounRole, videoTitle, effectiveGenre);
  const pronounInstruction = targetName === 'Vietnamese' ? getPronounInstruction(effectiveRole, videoTitle, effectiveGenre) : '';

  return `You are a world-class bilingual subtitle translator and localization expert adapting style to video genre:
${contextLine}${styleInstruction}${pronounInstruction}

Translate directly into natural, concise ${targetName} suitable for video subtitles. Output ONLY the translated text, no quotes, no explanations:
${text}`;
}

function buildGeminiBatchSubtitlePrompt(lines, targetName, videoTitle = '', style = 'auto', pronounRole = 'auto') {
  const contextLine = videoTitle ? `Video Context / Metadata: "${videoTitle.slice(0, 240)}"\n` : '';
  const effectiveGenre = resolveEffectiveGenre(style, videoTitle);
  const promptLines = lines.map((text, idx) => `${idx + 1}. ${text}`).join('\n');
  let styleInstruction = '';

  if (effectiveGenre === 'lyrics') {
    styleInstruction = `MODE: SONG LYRICS. Translate these continuous lines as song lyrics with poetic cadence, melodic flow, and deep emotion across lines (phổ lời Việt êm ái, giàu cảm xúc, uyển chuyển). Preserve musical notes (♪, ♫) if present.`;
  } else if (effectiveGenre === 'reality_show') {
    styleInstruction = `MODE: REALITY SHOW & TALK SHOW. Translate these continuous dialogue lines as authentic, witty, lively conversation for variety/reality show.`;
  } else if (effectiveGenre === 'news') {
    styleInstruction = `MODE: NEWS & ARTICLES. Use formal, professional, objective, journalistic Vietnamese with accurate terminology and proper public figure titles.`;
  } else {
    styleInstruction = `MODE: CASUAL & VLOGS. Use lively, natural, colloquial Vietnamese dialogue.`;
  }

  const effectiveRole = resolveSongPronounRole(pronounRole, videoTitle, effectiveGenre);
  const pronounInstruction = targetName === 'Vietnamese' ? getPronounInstruction(effectiveRole, videoTitle, effectiveGenre) : '';

  return `You are a world-class bilingual subtitle translator translating continuous video subtitles:
${contextLine}${styleInstruction}${pronounInstruction}

Maintain exact line numbering (e.g. "1. <translation>"). Output ONLY the numbered translated lines in ${targetName}:
${promptLines}`;
}

let geminiKeyIndex = 0;

/**
 * Parse and clean multi-key pool (comma, semicolon, or newline separated)
 */
function getGeminiApiKeys(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return [];
  return rawKey
    .split(/[\n,;]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 10);
}

/**
 * Get next rotating Gemini API key
 */
function getNextGeminiApiKey(rawKey) {
  const keys = getGeminiApiKeys(rawKey);
  if (keys.length === 0) return rawKey ? rawKey.trim() : '';
  const key = keys[geminiKeyIndex % keys.length];
  geminiKeyIndex = (geminiKeyIndex + 1) % keys.length;
  return key;
}

/**
 * Record quota usage in chrome.storage.local
 */
async function recordGeminiQuotaUsage(linesCount = 1) {
  try {
    const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const data = await chrome.storage.local.get([
      'gemini_requests_today',
      'gemini_requests_date',
      'gemini_cues_translated',
      'gemini_quota_saved',
    ]);

    let requestsToday = data.gemini_requests_today || 0;
    if (data.gemini_requests_date !== today) {
      requestsToday = 0; // Reset for new day
    }
    requestsToday += 1;

    const cuesTranslated = (data.gemini_cues_translated || 0) + linesCount;

    await chrome.storage.local.set({
      gemini_requests_today: requestsToday,
      gemini_requests_date: today,
      gemini_cues_translated: cuesTranslated,
    });
  } catch (_) {}
}

/**
 * Record quota saved by offline noise filters & caching
 */
async function recordQuotaSaved(count = 1) {
  try {
    const data = await chrome.storage.local.get(['gemini_quota_saved']);
    await chrome.storage.local.set({
      gemini_quota_saved: (data.gemini_quota_saved || 0) + count,
    });
  } catch (_) {}
}

/**
 * Translate single subtitle line using Google Gemini AI API (Fast, low-latency, genre-aware)
 */
async function translateWithGemini(text, sourceLang, targetLang, apiKey, model = 'gemini-3.5-flash-lite', videoTitle = '', style = 'auto', pronounRole = 'auto') {
  const effectiveKey = getNextGeminiApiKey(apiKey);
  if (!effectiveKey) {
    throw new Error('Missing Gemini API Key');
  }
  recordGeminiQuotaUsage(1);

  const tl = targetLang || 'vi';
  const targetName = tl === 'vi' ? 'Vietnamese' : tl;
  const chosenModel = resolveGeminiModel(model);
  const effectiveGenre = resolveEffectiveGenre(style, videoTitle);
  const effectiveRole = resolveSongPronounRole(pronounRole, videoTitle, effectiveGenre);

  const prompt = buildGeminiSubtitlePrompt(text, targetName, videoTitle, style, effectiveRole);

  const callModel = async (modelName) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(effectiveKey)}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: effectiveGenre === 'news' ? 0.15 : 0.35,
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
      cleaned = cleanOutputByGenre(decodeHtmlEntities(cleaned), effectiveGenre, effectiveRole);
      if (effectiveGenre === 'lyrics') {
        anchorRoleFromTranslation(videoTitle, cleaned);
      }
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
  const effectiveKey = getNextGeminiApiKey(apiKey);
  if (!effectiveKey) throw new Error('Missing Gemini API Key');
  recordGeminiQuotaUsage(lines.length);

  const tl = targetLang || 'vi';
  const targetName = tl === 'vi' ? 'Vietnamese' : tl;
  const chosenModel = resolveGeminiModel(model);
  const effectiveGenre = resolveEffectiveGenre(style, videoTitle);
  const effectiveRole = resolveSongPronounRole(pronounRole, videoTitle, effectiveGenre);

  const prompt = buildGeminiBatchSubtitlePrompt(lines, targetName, videoTitle, style, effectiveRole);

  const callModel = async (modelName) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(effectiveKey)}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: effectiveGenre === 'news' ? 0.15 : 0.35,
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
        results[idx] = cleanOutputByGenre(decodeHtmlEntities(match[2].trim()), effectiveGenre, effectiveRole);
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
        results[i] = cleanOutputByGenre(decodeHtmlEntities(cleanLines[i]), effectiveGenre, effectiveRole);
      }
    }
  }

  if (effectiveGenre === 'lyrics' && results.some(Boolean)) {
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

  const anchorKey = service === 'gemini' ? `:${getVideoAnchorKey(videoTitle)}` : '';
  const cacheKey = `${service}:${style || 'auto'}:${pronounRole || 'auto'}${anchorKey}:${sourceLang}->${targetLang}:${apiKey ? 'custom' : 'free'}:${trimmed}`;

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

  if (request.action === 'RECORD_QUOTA_SAVED') {
    recordQuotaSaved(request.count || 1);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'CHECK_GEMINI_QUOTA') {
    (async () => {
      const startTime = Date.now();
      const rawKey = request.apiKey || '';
      const keys = getGeminiApiKeys(rawKey);
      const testKey = keys.length > 0 ? keys[0] : rawKey.trim();

      if (!testKey) {
        sendResponse({ success: false, error: 'Chưa cấu hình Gemini API Key' });
        return;
      }

      const today = new Date().toISOString().slice(0, 10);
      const stats = await chrome.storage.local.get([
        'gemini_requests_today',
        'gemini_requests_date',
        'gemini_cues_translated',
        'gemini_quota_saved'
      ]);

      let requestsToday = stats.gemini_requests_today || 0;
      if (stats.gemini_requests_date !== today) {
        requestsToday = 0;
      }

      try {
        const chosenModel = resolveGeminiModel(request.model || 'gemini-3.5-flash-lite');
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chosenModel)}:generateContent?key=${encodeURIComponent(testKey)}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Hello' }] }],
            generationConfig: { maxOutputTokens: 5 }
          })
        });

        const latency = Date.now() - startTime;

        if (res.ok) {
          sendResponse({
            success: true,
            status: 'active',
            latencyMs: latency,
            requestsToday,
            cuesTranslated: stats.gemini_cues_translated || 0,
            quotaSaved: stats.gemini_quota_saved || 0,
            keyCount: keys.length || 1,
            maxRpd: (keys.length || 1) * 1500,
            maxRpm: (keys.length || 1) * 15,
            message: `Key hoạt động tốt • Ping: ${latency}ms • Quota sẵn sàng`
          });
        } else if (res.status === 429) {
          sendResponse({
            success: true,
            status: 'rate_limited',
            latencyMs: latency,
            requestsToday,
            cuesTranslated: stats.gemini_cues_translated || 0,
            quotaSaved: stats.gemini_quota_saved || 0,
            keyCount: keys.length || 1,
            maxRpd: (keys.length || 1) * 1500,
            maxRpm: (keys.length || 1) * 15,
            message: 'Tạm thời chạm giới hạn 15 RPM • Vui lòng đợi 30s hoặc thêm key phụ'
          });
        } else {
          let errText = `HTTP ${res.status}`;
          try {
            const errJson = await res.json();
            if (errJson?.error?.message) errText = errJson.error.message;
          } catch (_) {}
          sendResponse({
            success: false,
            status: 'error',
            error: errText,
            requestsToday,
            cuesTranslated: stats.gemini_cues_translated || 0,
            quotaSaved: stats.gemini_quota_saved || 0,
            keyCount: keys.length || 1
          });
        }
      } catch (err) {
        sendResponse({
          success: false,
          status: 'network_error',
          error: err.message,
          requestsToday,
          cuesTranslated: stats.gemini_cues_translated || 0,
          quotaSaved: stats.gemini_quota_saved || 0,
          keyCount: keys.length || 1
        });
      }
    })();
    return true;
  }

  if (request.action === 'PING') {
    sendResponse({ success: true, pong: true });
    return true;
  }
});
