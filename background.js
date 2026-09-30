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
  geminiRpdLimit: 500, // 500 RPD (Google AI Studio Free) | 1500 RPD (Google Cloud Tier 1)
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
  if (/\b(running man|knowing bros|2 ngày 1 đêm|talkshow|podcast|phỏng vấn|interview|hot ones|the tonight show|game show|weekly idol|amazing saturday|ep\.\s*\d+|tập\s*\d+|show thực tế)\b|乃木坂工事中|nogizaka under construction|そこ曲がったら|日向坂で会いましょう|乃木坂どこへ|スター誕生|akbingo|サヨナラ毛利さん|モニタリング|水曜日のダウンタウン|ロンドンハーツ|アメトーーク|しゃべくり007|それsnow man|vs嵐|嵐にしやがれ|バラエティ|月曜から夜ふかし/i.test(videoContext || '')) {
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
    // Global & US-UK Female Artists
    /\b(laufey|aimer|yoasobi|zutomayo|yorushika|milet|claris|chappell roan|gracie abrams|sabrina carpenter|olivia dean|beabadoobee|billie eilish|olivia rodrigo|taylor swift|adele|ariana grande|dua lipa|katy perry|rihanna|lady gaga|beyonc[eé]|selena gomez|mariah carey|whitney houston|celine dion|avril lavigne|camila cabello|shakira|sia|lana del rey|halsey|miley cyrus|demi lovato|carly rae jepsen|bebe rexha|ellie goulding|kesha|alessia cara|lorde|anne-marie|madonna|britney spears|tate mcrae|sza|doja cat|cardi b|megan thee stallion|renee rapp|madison beer|dove cameron|raye|tinashe|kali uchis|rosal[ií]a|karol g|anitta|clairo|phoebe bridgers|lucy dacus|alicia keys|norah jones|amy winehouse|bjork|florence welch|katseye)\b/i,
    // Japanese Female Artists & Groups
    /\b(ado|lisa|reona|ikura|suis|acaね|daoko|chanmina|awich|yama|minami|sayuri|majiko|tuyu|eir aoi|kano|hanatan|nano|utada hikaru|utada|ayumi hamasaki|namie amuro|yui|kana nishino|aimyon|aoi teshima|chihiro onitsuka|mika nakashima|chico with honeyworks|honeyworks|supercell|atashi|clariS|akb48|nogizaka46|sakurazaka46|hinatazaka46|babymetal)\b/i,
    // Korean Female Artists & Girl Groups
    /\b(iu|taeyeon|ros[eé]|jennie|jisoo|lisa|blackpink|twice|aespa|ive|newjeans|le sserafim|red velvet|itzy|gidle|\(g\)i-dle|illit|babymonster|nmixx|stayc|kiss of life|meovv|chungha|sunmi|hwasa|lee hi|heize|bol4|davichi|mamamoo|sistar|girls' generation|snsd|kara|2ne1|apink|exid|oh my girl|fromis_9|loona|triples|boa|hyuna|somi|kwon eun bi|yena|chuu)\b/i,
    // Vietnamese Female Artists & Celebrities
    /\b(hòa minzy|hoa minzy|trang pháp|mỹ tâm|hồ ngọc hà|đông nhi|bích phương|hoàng thùy linh|min|amee|bảo anh|tóc tiên|hiền hồ|phương ly|lyly|tlinh|orange|suni hạ linh|văn mai hương|phương mỹ chi|vũ cát tường|hà nhi|lâm bảo ngọc|thùy chi|myra trần|uyên linh|lệ quyên|mỹ linh|hồng nhung|trần thu hà|hà trần|hương tràm|khổng tú quỳnh|thanh hà|như quỳnh|phi nhung|cẩm ly|minh tuyết|phương thanh|siu black|đoan trang|bảo thy|thùy lâm|giang hồng ngọc|pháo|marzuz|muộii|hồng thanh|hoàng yến chibi|mie|suboi|vũ phụng tiên|nguyên hà|phùng khánh linh|emily|liz kim cương|han sara|thu phương|lưu hương giang|minh hằng|diệp lâm anh|thúy ngân|lan ngọc|ninh dương lan ngọc|hari won|lâm vỹ dạ|sam|khả như)\b/i,
    // Chinese / Mandopop Female Artists
    /\b(đặng tử kỳ|g\.e\.m\.|gem|teresa teng|faye wong|vương phi|jolin tsai|thái y lâm|cyndi wang|vương tâm lăng|angela zhang|trương thiều hàm|fish leong|lương tĩnh như|a-lin|karen mok|mạc văn úy|hebe tien|điền phó chân|s\.h\.e|rainie yang|dương thừa lâm|liu yuxin|lexie liu|curley g)\b/i,
    // Variety Hosts Female
    /\b(ellen|oprah|drew barrymore|kelly clarkson|song ji hyo|jeon so min)\b/i
  ];
  const malePatterns = [
    // Global & US-UK Male Artists
    /\b(keshi|joji|stephen sanchez|conan gray|jeremy zucker|alec benjamin|ed sheeran|charlie puth|bruno mars|justin bieber|the weeknd|post malone|drake|shawn mendes|sam smith|harry styles|zayn|eminem|maroon 5|coldplay|benson boone|teddy swims|noah kahan|hozier|luke combs|morgan wallen|zach bryan|jack harlow|kendrick lamar|j\. cole|travis scott|kanye west|tyler, the creator|mac miller|juice wrld|xxxtentacion|lil nas x|bad bunny|peso pluma|david kushner|dean lewis|lewis capaldi|calum scott|james arthur|john legend)\b/i,
    // Japanese Male Artists & Bands
    /\b(fujii kaze|kenshi yonezu|vaundy|yuuri|eve|official hige dandism|king gnu|radwimps|back number|mrs\. green apple|asian kung-fu generation|bump of chicken|spyair|one ok rock|tani yuuki|imase|gen hoshino|tk from ling tosite sigure|hitorie|sukima switch|wacci|novelbright)\b/i,
    // Korean Male Artists & Boy Groups
    /\b(bts|jungkook|jimin|suga|exo|baekhyun|kai|stray kids|seventeen|bigbang|g-dragon|txt|tomorrow x together|enhypen|riize|zerobaseone|zb1|boynextdoor|tws|ateez|the boyz|treasure|monsta x|nct|nct 127|nct dream|wayv|shinee|taemin|wonho|woodz|crush|dpr ian|dpr live|zion\.t|loco|gray|sik-k|beenzino|epik high)\b/i,
    // Vietnamese Male Artists
    /\b(sơn tùng m-tp|sơn tùng|soobin hoàng sơn|soobin|jack|k-icm|erik|đức phúc|noo phước thịnh|hà anh tuấn|vũ\.|vũ|hoàng dũng|quân a\.p|trịnh thăng bình|phan mạnh quỳnh|trung quân|trung quân idol|bùi anh tuấn|quốc thiên|lân nhã|đan trường|tuấn hưng|justatee|rhymastic|đen vâu|đen|b ray|wren evans|mono|grey d|tăng duy tân|lê bảo bình|khắc việt|anh tú|lou hoàng|onlyc|kai đinh|hứa kim tuyền|bùi công nam|phạm hồng phước|nguyễn trần trung quân|bằng kiều|quang dũng|quang lê|trọng tấn|hieuthuhai|hieu thu hai|rhyder|quang hùng masterd|captain boy|wean|hurrykng|pháp kiều|negav|ali hoàng dương|isaac|song luân|gin tuấn kiệt|kay trần|cường seven|s\.t sơn thạch|st sơn thạch|bb trần|duy khánh|cris phan|trấn thành|trường giang|đại nghĩa|ngô kiến huy|jun phạm|lê dương bảo lâm|karik|wowy)\b/i,
    // Chinese / Mandopop Male Artists
    /\b(châu kiệt luân|jay chou|jj lin|lâm tuấn kiệt|eason chan|trần dịch tấn|wang leehom|vương lực hoành|joker xue|tiết chi khiêm|eric chou|châu hưng triết|hua chenyu|hoa hoa|hoa thần vũ|lay zhang|trương nghệ hưng|jackson wang|vương gia nhĩ|zhou shen|châu thâm|mayday|ngũ nguyệt thiên)\b/i,
    // Variety Hosts Male
    /\b(jimmy fallon|jimmy kimmel|stephen colbert|james corden|graham norton|joe rogan|conan o'brien|seth meyers|gordon ramsay|yoo jae suk|kang ho dong|shin dong yup|kim jong kook|haha|lee kwang soo|ji suk jin|yang se chan|lee soo geun|seo jang hoon|kim hee chul|min kyung hoon)\b/i
  ];

  for (const p of femalePatterns) {
    if (p.test(text)) return 'female';
  }
  for (const p of malePatterns) {
    if (p.test(text)) return 'male';
  }

  // Perspective clues in song title if artist not directly matched
  if (/\b(trái tim anh|anh đau|cho anh|với anh|bên anh|anh nhớ em|anh yêu em|anh xin lỗi|vì anh|anh muốn|chàng trai|chú rể)\b/i.test(text)) {
    return 'male';
  }
  if (/\b(trái tim em|em đau|cho em|với em|bên em|em nhớ anh|em yêu anh|em xin lỗi|vì em|em muốn|cô gái|cô dâu|nàng thơ)\b/i.test(text)) {
    return 'female';
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
  const femaleSignals = (text.match(/\b(em|của em|với em|cho em|chính em|bên em|em nhớ anh|em yêu anh|anh ơi)\b/g) || []).length;
  const maleSignals = (text.match(/\b(anh|của anh|với anh|cho anh|chính anh|bên anh|anh nhớ em|anh yêu em|em ơi)\b/g) || []).length;
  if (femaleSignals > 0 && femaleSignals >= maleSignals) {
    videoRoleAnchor.set(key, 'female');
  } else if (maleSignals > 0 && maleSignals > femaleSignals) {
    videoRoleAnchor.set(key, 'male');
  }
}

// Session-level pronoun & relationship summary for Reality Shows, Variety Shows, and Vlogs
const videoPronounSummary = new Map();

function updatePronounSummaryFromTranslation(videoTitle, translatedBatchText, effectiveGenre) {
  if (!videoTitle || !translatedBatchText) return;
  const key = getVideoAnchorKey(videoTitle);
  if (!key) return;

  const textLower = translatedBatchText.toLowerCase();

  if (effectiveGenre === 'reality_show') {
    const isJpIdol = /(乃木坂|櫻坂|日向坂|akb48|ske48|nmb48|hkt48|工事中|そこ曲がったら|日向坂で会いましょう|スター誕生|モニタリング|水曜日のダウンタウン|ロンドンハーツ)/i.test(videoTitle);
    if (isJpIdol) {
      videoPronounSummary.set(key, 'Idol members address themselves as "em", address MCs as "anh [Tên]". MCs address members as "em / mấy đứa", address viewers as "quý vị / mọi người". Keep lively cute reactions ("Hả?!", "Toang rồi!").');
      return;
    }

    const hasAudience = /\b(quý vị|quý khán giả|mọi người|các bạn)\b/.test(textLower);
    const hasAnhEm = /\b(anh|em|chị)\b/.test(textLower);
    const hasCauTo = /\b(cậu|tớ|mình)\b/.test(textLower);

    const parts = [];
    if (hasAudience) {
      parts.push('Host/Cast addressing audience: "chúng tôi / mình" with "quý vị / mọi người / các bạn"');
    }
    if (hasAnhEm) {
      parts.push('Cast members interacting naturally: "anh / em" and "chị / em"');
    } else if (hasCauTo) {
      parts.push('Cast members interacting as peers: "cậu - tớ" and "mình"');
    }
    if (parts.length === 0) {
      parts.push('Natural reality show dialogue: "anh / em", "chị / em", "mọi người", lively witty banter');
    }
    parts.push('STRICT BAN on romantic couple pronouns ("anh yêu / em yêu") and robotic "tôi / bạn"');

    videoPronounSummary.set(key, parts.join('; '));
  } else if (effectiveGenre === 'casual') {
    const hasMinh = /\b(mình|chúng mình)\b/.test(textLower);
    const hasCacBan = /\b(các bạn|mọi người)\b/.test(textLower);
    const hasTo = /\b(tớ|cậu)\b/.test(textLower);
    const hasAnhEm = /\b(anh|em)\b/.test(textLower);

    let summary = 'Vlogger friendly address: ';
    if (hasMinh && hasCacBan) {
      summary += 'Self is "mình", audience is "các bạn / mọi người". Natural, friendly, conversational tone (NEVER use stiff robotic "tôi / bạn").';
    } else if (hasTo) {
      summary += 'Self is "tớ", audience is "cậu / mọi người". Friendly peer tone.';
    } else if (hasAnhEm) {
      summary += 'Vlogger addresses audience as "các em / mọi người", self is "anh" (or "chị").';
    } else {
      summary += 'Self is "mình", audience is "các bạn / mọi người". Keep warm conversational bond.';
    }
    videoPronounSummary.set(key, summary);
  }
}

/**
 * Sanitize and enforce genre-specific pronoun consistency on translated Vietnamese output
 */
function cleanOutputByGenre(text, effectiveGenre, role, videoTitle = '') {
  if (!text || typeof text !== 'string') return text;
  let cleaned = text;

  // Resolve role from session anchor or artist detection if not explicit
  let effectiveRole = role;
  const key = getVideoAnchorKey(videoTitle);
  if ((!effectiveRole || effectiveRole === 'auto') && videoTitle) {
    if (videoRoleAnchor.has(key)) {
      effectiveRole = videoRoleAnchor.get(key);
    } else {
      const detected = detectFigureGender(videoTitle);
      if (detected) {
        effectiveRole = detected;
        videoRoleAnchor.set(key, detected);
      }
    }
  }

  // If still auto for lyrics, dynamically deduce and anchor from line content
  if (effectiveGenre === 'lyrics' && (!effectiveRole || effectiveRole === 'auto')) {
    const textLower = cleaned.toLowerCase();
    if (/\b(em yêu anh|em nhớ anh|bên anh|anh ơi|cho em|với em)\b/.test(textLower)) {
      effectiveRole = 'female';
      if (key) videoRoleAnchor.set(key, 'female');
    } else if (/\b(anh yêu em|anh nhớ em|bên em|em ơi|cho anh|với anh)\b/.test(textLower)) {
      effectiveRole = 'male';
      if (key) videoRoleAnchor.set(key, 'male');
    }
  }

  if (effectiveGenre === 'lyrics') {
    if (effectiveRole === 'female') {
      cleaned = cleaned
        .replace(/\bTôi\b/g, 'Em')
        .replace(/\btôi\b/g, 'em')
        .replace(/\bchính mình\b/gi, 'chính em')
        .replace(/\bbản thân mình\b/gi, 'bản thân em')
        .replace(/\bcủa mình\b/gi, 'của em')
        .replace(/\bvới mình\b/gi, 'với em')
        .replace(/\bcho mình\b/gi, 'cho em')
        .replace(/\bMình\b/g, 'Em')
        .replace(/\bmình\b/g, 'em')
        .replace(/^(Anh|anh) (nghĩ|thấy|nhớ|muốn|biết|yêu|cần|đang|đã|sẽ|chẳng|không|bước|khóc|mơ|đợi|chờ|lạc lối|cô đơn)\b/g, (m, p1, p2) => {
          return (p1 === 'Anh' ? 'Em' : 'em') + ' ' + p2;
        });
    } else if (effectiveRole === 'male') {
      cleaned = cleaned
        .replace(/\bTôi\b/g, 'Anh')
        .replace(/\btôi\b/g, 'anh')
        .replace(/\bchính mình\b/gi, 'chính anh')
        .replace(/\bbản thân mình\b/gi, 'bản thân anh')
        .replace(/\bcủa mình\b/gi, 'của anh')
        .replace(/\bvới mình\b/gi, 'với anh')
        .replace(/\bcho mình\b/gi, 'cho anh')
        .replace(/\bMình\b/g, 'Anh')
        .replace(/\bmình\b/g, 'anh')
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

    // For Japanese idol variety shows (乃木坂工事中, Sakamichi, 48G), eliminate robotic "Tôi"
    if (/(乃木坂|櫻坂|日向坂|akb48|工事中|そこ曲がったら|日向坂で会いましょう|スター誕生|モニタリング|水曜日のダウンタウン|ロンドンハーツ)/i.test(videoTitle)) {
      cleaned = cleaned
        .replace(/\bTôi nghĩ\b/g, 'Em nghĩ')
        .replace(/\btôi nghĩ\b/g, 'em nghĩ')
        .replace(/\bTôi thấy\b/g, 'Em thấy')
        .replace(/\btôi thấy\b/g, 'em thấy')
        .replace(/\bTôi muốn\b/g, 'Em muốn')
        .replace(/\btôi muốn\b/g, 'em muốn')
        .replace(/\bTôi không\b/g, 'Em không')
        .replace(/\btôi không\b/g, 'em không')
        .replace(/\bTôi đã\b/g, 'Em đã')
        .replace(/\btôi đã\b/g, 'em đã');
    }
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
    const isJpIdolShow = /(乃木坂|櫻坂|日向坂|akb48|ske48|nmb48|hkt48|ngu48|stu48|akbingo|工事中|そこ曲がったら|日向坂で会いましょう|スター誕生|超・乃木坂スター誕生|モニタリング|水曜日のダウンタウン|ロンドンハーツ|アメトーーク|しゃべくり|ジャニーズ|snow man|vs嵐|嵐にしやがれ|バラエティ|月曜から夜ふかし|バナナマン|オードリー)/i.test(videoTitle);

    if (isJpIdolShow) {
      return `\nCRITICAL PRONOUN DIRECTIVE - JAPANESE IDOL VARIETY SHOW (SHOW IDOL NHẬT - 乃木坂工事中, SAKAMICHI, 48G, VARIETY):${figureHint}
- CONTEXT: Japanese idol variety show (such as 乃木坂工事中 / Nogizaka Under Construction, そこ曲がったら、櫻坂?, 日向坂で会いましょう, AKBINGO!, etc.) featuring comedian MCs (Bananaman, Audrey, Sawabe, Tsuchida) interacting with young female idol members.
- IDOL MEMBERS PRONOUNS (XƯNG HÔ CỦA THÀNH VIÊN IDOL):
  * Female idols addressing MCs (Shitara-san, Himura-san, Wakabayashi-san, etc.) or staff: MUST refer to themselves as "em" (e.g. "Em nghĩ là...", "Hôm qua em..."). STRICT PROHIBITION: NEVER use "tôi" for idol members! Address MCs as "anh [Tên]" (e.g. "anh Shitara", "anh Himura", "anh Wakabayashi") or "thầy/chú".
  * Junior idols addressing senior members (Senpai): Junior idols address seniors as "chị [Tên]" (or "tiền bối"), and refer to themselves as "em".
  * Peer members (Dōki - cùng thế hệ): Address each other naturally as "cậu - tớ", "mình - bạn", "mấy đứa mình".
- MCs PRONOUNS (XƯNG HÔ CỦA MC):
  * When addressing idols: MCs address idols as "em", "[Tên]", "mấy đứa", "các em". MCs refer to themselves as "anh", "tôi", or "chúng tôi".
  * When addressing viewers: "quý vị khán giả", "mọi người", "các bạn".
- IDOL ENTERTAINMENT REACTIONS (DỊCH PHẢN ỨNG DỄ THƯƠNG & HÀI HƯỚC):
  * Translate characteristic variety reactions lively and cutely:
    - "えぇー!?" / "嘘!?" -> "Hả?!", "Thật á?!", "Trời ơi!"
    - "ヤバい" -> "Toang rồi!", "Nguy hiểm ghê!", "Ghê thật á!"
    - "可愛い" -> "Dễ thương quá à!", "Đáng yêu xỉu!"
    - "無理無理" -> "Không được đâu!", "Chịu luôn á!"
    - "なんで!?" -> "Sao lại thế chứ?!", "Ủa tại sao?!"
- STRICT PROHIBITION: NEVER use romantic couple pronouns ("anh yêu / em yêu")! This is an idol variety show.`;
    }

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

  // Default: 'auto' with mandatory artist & performer identification
  const parsedArtist = primaryFigure;
  const artistLookupHint = parsedArtist
    ? `\n- ARTIST IDENTIFICATION: The performer is identified as "${parsedArtist}". Look up your knowledge base to determine whether "${parsedArtist}" is female, male, or a band.`
    : `\n- ARTIST / CONTEXT IDENTIFICATION: Inspect the Video Metadata / Title to identify the performing artist and their gender/persona.`;

  return `\nCRITICAL PRONOUN DIRECTIVE - MANDATORY ARTIST CHECK (BẮT BUỘC KIỂM TRA NGHỆ SĨ TRƯỚC KHI DỊCH):${artistLookupHint}
- Determine the singer's gender/perspective from the artist name or song title BEFORE translating:
  * Female singer/perspective: Singer is ALWAYS "em" (self), listener is ALWAYS "anh" (or "người"). ABSOLUTE BAN: NEVER use "tôi" or "anh" for a female singer!
  * Male singer/perspective: Singer is ALWAYS "anh" (self), listener is ALWAYS "em" (or "người"). ABSOLUTE BAN: NEVER use "tôi" or "em" for a male singer!
  * Band, rap, or philosophical/neutral song: Singer is ALWAYS "tôi" (or "ta"), listener is ALWAYS "bạn" or "người".
- ABSOLUTE PROHIBITION ON MIXING PRONOUNS: Stick to ONE SINGLE lyrical perspective 100% consistently across EVERY SINGLE LINE of the song. Do not flip between "tôi", "em", and "anh"!`;
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

function buildGeminiBatchSubtitlePrompt(lines, targetName, videoTitle = '', style = 'auto', pronounRole = 'auto', contextTail = []) {
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

  let summarySection = '';
  if (effectiveGenre === 'reality_show' || effectiveGenre === 'casual') {
    const key = getVideoAnchorKey(videoTitle);
    const establishedSummary = videoPronounSummary.get(key);
    if (establishedSummary) {
      summarySection = `\nESTABLISHED PRONOUN & RELATIONSHIP SUMMARY (TÓM TẮT XƯNG HÔ ĐÃ THIẾT LẬP TỪ BATCH TRƯỚC):
- Relationship Mapping: ${establishedSummary}
- CRITICAL REQUIREMENT: Maintain this EXACT conversational relationship and pronoun mapping consistently across all lines below!\n`;
    }
  }

  let previousContextSection = '';
  if (Array.isArray(contextTail) && contextTail.length > 0) {
    const validTails = contextTail.filter((t) => t && t.original && t.translation);
    if (validTails.length > 0) {
      const tailFormatted = validTails
        .map((t) => `- Earlier Line: "${t.original}" -> Translated: "${t.translation}"`)
        .join('\n');
      previousContextSection = `\nPREVIOUS TRANSLATED CONTEXT (NGỮ CẢNH ĐÃ DỊCH TRƯỚC ĐÓ - DÙNG ĐỂ NỐI MẠCH VĂN):
The following line(s) were translated immediately prior to this batch. Use them to maintain seamless narrative flow, poetic rhyme, lyrical continuity, and consistent pronouns:
${tailFormatted}
MANDATORY DIRECTIVE: DO NOT re-translate the previous lines above! Output translations ONLY for the numbered lines below (1 to ${lines.length}). Connect pronouns and emotional tone seamlessly with the previous context!\n`;
    }
  }

  return `You are a world-class bilingual subtitle translator translating continuous video subtitles:
${contextLine}${styleInstruction}${pronounInstruction}${summarySection}${previousContextSection}
Maintain exact line numbering (e.g. "1. <translation>"). Output ONLY the numbered translated lines in ${targetName}. Do NOT include explanations, previous lines, or metadata:
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
 * Return current date in Pacific Time (America/Los_Angeles) matching Google AI Studio reset
 */
function getQuotaDateKey() {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Return stable identifier for API key(s) to track quota per key
 */
function getApiKeyHash(rawKey) {
  if (!rawKey) return 'default';
  const keys = getGeminiApiKeys(rawKey);
  if (keys.length === 0) return 'default';
  return keys.map((k) => k.slice(-8)).sort().join('_');
}

/**
 * Record quota usage in chrome.storage.local (Both per-key and global)
 */
async function recordGeminiQuotaUsage(linesCount = 1, rawKey = '') {
  try {
    const today = getQuotaDateKey(); // Pacific Time 'YYYY-MM-DD'
    const keyHash = getApiKeyHash(rawKey);
    const keyUsageKey = `gemini_req_${keyHash}_${today}`;

    const data = await chrome.storage.local.get([
      keyUsageKey,
      'gemini_requests_today',
      'gemini_requests_date',
      'gemini_cues_translated',
      'gemini_quota_saved',
    ]);

    let keyRequestsToday = data[keyUsageKey] || 0;
    keyRequestsToday += 1;

    let requestsToday = data.gemini_requests_today || 0;
    if (data.gemini_requests_date !== today) {
      requestsToday = 0; // Reset for new day
    }
    requestsToday += 1;

    const cuesTranslated = (data.gemini_cues_translated || 0) + linesCount;

    await chrome.storage.local.set({
      [keyUsageKey]: keyRequestsToday,
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
  recordGeminiQuotaUsage(1, effectiveKey);

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
      if (effectiveGenre === 'lyrics') {
        anchorRoleFromTranslation(videoTitle, cleaned);
      }
      cleaned = cleanOutputByGenre(decodeHtmlEntities(cleaned), effectiveGenre, effectiveRole, videoTitle);
      return cleaned;
    }
  }

  throw new Error(`Invalid response structure from Gemini API (${chosenModel})`);
}

/**
 * Batch translate multiple subtitle lines in a single Gemini API call (High throughput, 0ms playback, genre-aware)
 */
async function translateBatchWithGemini(lines, sourceLang, targetLang, apiKey, model = 'gemini-3.5-flash-lite', videoTitle = '', style = 'auto', pronounRole = 'auto', contextTail = []) {
  if (!lines || lines.length === 0) return [];
  const effectiveKey = getNextGeminiApiKey(apiKey);
  if (!effectiveKey) throw new Error('Missing Gemini API Key');
  recordGeminiQuotaUsage(lines.length, effectiveKey);

  const tl = targetLang || 'vi';
  const targetName = tl === 'vi' ? 'Vietnamese' : tl;
  const chosenModel = resolveGeminiModel(model);
  const effectiveGenre = resolveEffectiveGenre(style, videoTitle);
  const effectiveRole = resolveSongPronounRole(pronounRole, videoTitle, effectiveGenre);

  const prompt = buildGeminiBatchSubtitlePrompt(lines, targetName, videoTitle, style, effectiveRole, contextTail);

  const callModel = async (modelName) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(effectiveKey)}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: effectiveGenre === 'news' ? 0.15 : 0.35,
          maxOutputTokens: 2200
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

  const rawResults = new Array(lines.length).fill('');
  const outputLines = rawText.split('\n');
  for (const line of outputLines) {
    const match = line.match(/^\s*(\d+)[\.\:\)]\s*(.*)$/);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      if (idx >= 0 && idx < lines.length) {
        rawResults[idx] = decodeHtmlEntities(match[2].trim());
      }
    }
  }

  // Fallback if numbered format failed
  if (rawResults.filter(Boolean).length < lines.length / 2) {
    const cleanLines = outputLines
      .map(l => l.replace(/^\s*\d+[\.\:\)]\s*/, '').trim())
      .filter(Boolean);
    if (cleanLines.length === lines.length) {
      for (let i = 0; i < lines.length; i++) {
        rawResults[i] = decodeHtmlEntities(cleanLines[i]);
      }
    }
  }

  // Anchor role from full batch first so all lines are unified
  if (effectiveGenre === 'lyrics' && rawResults.some(Boolean)) {
    anchorRoleFromTranslation(videoTitle, rawResults.join(' '));
  }

  // Update pronoun & relationship summary for reality shows and vlogs
  if ((effectiveGenre === 'reality_show' || effectiveGenre === 'casual') && rawResults.some(Boolean)) {
    updatePronounSummaryFromTranslation(videoTitle, rawResults.join(' '), effectiveGenre);
  }

  // Sanitize every line with videoTitle and the anchored role
  const results = rawResults.map((line) => {
    return line ? cleanOutputByGenre(line, effectiveGenre, effectiveRole, videoTitle) : '';
  });

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
      request.pronounRole || 'auto',
      request.contextTail || []
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

      const today = getQuotaDateKey();
      const keyHash = getApiKeyHash(rawKey);
      const keyUsageKey = `gemini_req_${keyHash}_${today}`;
      const stats = await chrome.storage.local.get([
        keyUsageKey,
        'gemini_requests_today',
        'gemini_requests_date',
        'gemini_cues_translated',
        'gemini_quota_saved'
      ]);

      let requestsToday = stats[keyUsageKey];
      if (typeof requestsToday !== 'number') {
        requestsToday = (stats.gemini_requests_date === today) ? (stats.gemini_requests_today || 0) : 0;
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

        const syncSettings = await chrome.storage.sync.get(['geminiRpdLimit']);
        const baseRpd = syncSettings.geminiRpdLimit || 500;
        const keyCount = keys.length || 1;
        const maxRpd = keyCount * baseRpd;
        const maxRpm = keyCount * 15;

        if (res.ok) {
          sendResponse({
            success: true,
            status: 'active',
            latencyMs: latency,
            requestsToday,
            cuesTranslated: stats.gemini_cues_translated || 0,
            quotaSaved: stats.gemini_quota_saved || 0,
            keyCount,
            maxRpd,
            maxRpm,
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
            keyCount,
            maxRpd,
            maxRpm,
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
