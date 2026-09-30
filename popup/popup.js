/**
 * YT ViSub - Popup Script
 * Tab navigation, live settings synchronization and cache statistics.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Tab elements
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  // General tab controls
  const toggleEnabled = document.getElementById('toggle-enabled');
  const selectTranslationService = document.getElementById('select-translation-service');
  const toggleBilingual = document.getElementById('toggle-bilingual');
  const checkHideNative = document.getElementById('check-hide-native');
  const btnClearCache = document.getElementById('btn-clear-cache');
  const statCacheCount = document.getElementById('stat-cache-count');
  const statCacheSize = document.getElementById('stat-cache-size');

  // Display tab controls
  const sliderFontSize = document.getElementById('slider-font-size');
  const fontSizeVal = document.getElementById('font-size-val');
  const sliderBgOpacity = document.getElementById('slider-bg-opacity');
  const bgOpacityVal = document.getElementById('bg-opacity-val');
  const colorTranslated = document.getElementById('color-translated');
  const colorTranslatedHex = document.getElementById('color-translated-hex');
  const colorOriginal = document.getElementById('color-original');
  const colorOriginalHex = document.getElementById('color-original-hex');
  const origColorRow = document.getElementById('orig-color-row');
  const presetPills = document.querySelectorAll('.preset-pill');
  const btnResetPos = document.getElementById('btn-reset-pos');

  // Language tab controls
  const selectSourceLang = document.getElementById('select-source-lang');
  const selectTargetLang = document.getElementById('select-target-lang');

  // Advanced tab controls
  const inputGeminiKey = document.getElementById('input-gemini-key');
  const btnTestGemini = document.getElementById('btn-test-gemini');
  const geminiStatusBadge = document.getElementById('gemini-status-badge');
  const selectGeminiModel = document.getElementById('select-gemini-model');
  const selectGeminiStyle = document.getElementById('select-gemini-style');
  const selectGeminiPronoun = document.getElementById('select-gemini-pronoun');
  const inputGithubRepo = document.getElementById('input-github-repo');

  // Quota monitor controls
  const statRequestsToday = document.getElementById('stat-requests-today');
  const statRequestsRemaining = document.getElementById('stat-requests-remaining');
  const statCuesTranslated = document.getElementById('stat-cues-translated');
  const statQuotaSaved = document.getElementById('stat-quota-saved');
  const statPacingSpeed = document.getElementById('stat-pacing-speed');
  const quotaProgressFill = document.getElementById('quota-progress-fill');
  const quotaUsagePercent = document.getElementById('quota-usage-percent');
  const quotaRemainingPercent = document.getElementById('quota-remaining-percent');
  const quotaKeyPool = document.getElementById('quota-key-pool');
  const quotaStatusBanner = document.getElementById('quota-status-banner');
  const quotaStatusText = document.getElementById('quota-status-text');
  const btnCheckQuota = document.getElementById('btn-check-quota');

  // Update tab controls
  const tabUpdateDot = document.getElementById('tab-update-dot');
  const currentVersionDisplay = document.getElementById('current-version-display');
  const latestVersionDisplay = document.getElementById('latest-version-display');
  const latestReleaseTag = document.getElementById('latest-release-tag');
  const updateStatusBanner = document.getElementById('update-status-banner');
  const updateBannerIcon = document.getElementById('update-banner-icon');
  const updateBannerText = document.getElementById('update-banner-text');
  const btnCheckUpdate = document.getElementById('btn-check-update');
  const btnDownloadUpdate = document.getElementById('btn-download-update');
  const linkGithubReleases = document.getElementById('link-github-releases');
  const releaseInfoSection = document.getElementById('release-info-section');
  const releaseNameTitle = document.getElementById('release-name-title');
  const releaseDateText = document.getElementById('release-date-text');
  const releaseNotesContent = document.getElementById('release-notes-content');

  // Preview elements
  const previewSubBox = document.getElementById('preview-sub-box');
  const previewOrigWrapper = document.getElementById('preview-orig-wrapper');
  const previewOrigText = document.getElementById('preview-orig-text');
  const previewTransText = document.getElementById('preview-trans-text');

  // Toast
  const toast = document.getElementById('toast');

  // Current settings state
  let currentSettings = {
    enabled: true,
    displayMode: 'bilingual',
    translationService: 'google',
    sourceLang: 'auto',
    targetLang: 'vi',
    fontSize: 20,
    fontColor: '#FFFFFF',
    originalColor: '#FFFFFF',
    bgOpacity: 75,
    subPosition: 'bottom',
    subBottomOffset: 0,
    hideOriginalNative: true,
    customApiKey: '',
    geminiApiKey: '',
    geminiModel: 'gemini-3.5-flash-lite',
    geminiStyle: 'auto',
    geminiPronounRole: 'auto',
    githubRepo: 'NgocThachTN/YTSubTranslateExtension',
  };

  let saveTimeout = null;
  let toastTimeout = null;

  // Tab switching logic
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTabId = btn.getAttribute('data-tab');
      tabButtons.forEach((b) => b.classList.remove('active'));
      tabPanes.forEach((p) => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPane = document.getElementById(targetTabId);
      if (targetPane) {
        targetPane.classList.add('active');
      }
    });
  });

  /**
   * Display toast notification
   */
  function showToast(message = 'Đã lưu cài đặt') {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 1600);
  }

  /**
   * Update live preview styling
   */
  function updatePreview() {
    if (!previewSubBox) return;

    const isBilingual = currentSettings.displayMode === 'bilingual';
    const bgVal = `rgba(8, 8, 8, ${(currentSettings.bgOpacity ?? 75) / 100})`;

    previewSubBox.style.backgroundColor = bgVal;
    previewSubBox.style.fontSize = `${currentSettings.fontSize}px`;

    if (previewOrigWrapper) {
      previewOrigWrapper.style.display = isBilingual ? 'block' : 'none';
    }

    if (previewOrigText) {
      previewOrigText.style.fontSize = `${Math.round(currentSettings.fontSize * 0.92)}px`;
      previewOrigText.style.color = currentSettings.originalColor || '#FFFFFF';
    }

    if (previewTransText) {
      previewTransText.style.fontSize = `${currentSettings.fontSize}px`;
      previewTransText.style.color = currentSettings.fontColor || '#FFFFFF';
    }

    if (origColorRow) {
      origColorRow.style.display = isBilingual ? 'flex' : 'none';
    }
  }

  /**
   * Save settings to storage with debounce
   */
  function saveSettings(notify = true) {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        await chrome.storage.sync.set(currentSettings);
        updatePreview();
        if (notify) {
          showToast('Đã lưu cài đặt');
        }
      } catch (err) {
        console.error('Failed to save settings:', err);
      }
    }, 120);
  }

  /**
   * Fetch cache statistics from background
   */
  function queryCacheStats() {
    chrome.runtime.sendMessage({ action: 'GET_CACHE_STATS' }, (res) => {
      if (res && res.success) {
        const count = res.size || 0;
        if (statCacheCount) {
          statCacheCount.textContent = count.toLocaleString('vi-VN');
        }
        if (statCacheSize) {
          const estimatedKb = ((count * 180) / 1024).toFixed(2);
          statCacheSize.textContent = `${estimatedKb} KB`;
        }
      }
    });
  }

  /**
   * Load stored settings
   */
  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(Object.keys(currentSettings));
      if (stored.subBottomOffset === 60) {
        stored.subBottomOffset = 0;
        chrome.storage.sync.set({ subBottomOffset: 0 }).catch(() => {});
      }
      if (stored.geminiModel && (stored.geminiModel.includes('1.5') || stored.geminiModel.includes('2.0'))) {
        stored.geminiModel = 'gemini-3.5-flash-lite';
        chrome.storage.sync.set({ geminiModel: 'gemini-3.5-flash-lite' }).catch(() => {});
      }
      currentSettings = { ...currentSettings, ...stored };

      // Set General controls
      if (toggleEnabled) toggleEnabled.checked = currentSettings.enabled;
      if (selectTranslationService) selectTranslationService.value = currentSettings.translationService || 'google';
      if (toggleBilingual) toggleBilingual.checked = currentSettings.displayMode === 'bilingual';
      if (checkHideNative) checkHideNative.checked = currentSettings.hideOriginalNative;

      // Set Display controls
      if (sliderFontSize) {
        sliderFontSize.value = currentSettings.fontSize;
        if (fontSizeVal) fontSizeVal.textContent = `${currentSettings.fontSize}px`;
      }

      if (sliderBgOpacity) {
        sliderBgOpacity.value = currentSettings.bgOpacity;
        if (bgOpacityVal) bgOpacityVal.textContent = `${currentSettings.bgOpacity}%`;
      }

      if (colorTranslated) {
        colorTranslated.value = currentSettings.fontColor;
        if (colorTranslatedHex) colorTranslatedHex.textContent = currentSettings.fontColor.toUpperCase();
      }

      if (colorOriginal) {
        colorOriginal.value = currentSettings.originalColor;
        if (colorOriginalHex) colorOriginalHex.textContent = currentSettings.originalColor.toUpperCase();
      }

      // Set Language controls
      if (selectSourceLang) selectSourceLang.value = currentSettings.sourceLang || 'auto';
      if (selectTargetLang) selectTargetLang.value = currentSettings.targetLang || 'vi';

      // Set Advanced controls
      if (inputGeminiKey) inputGeminiKey.value = currentSettings.geminiApiKey || '';
      if (selectGeminiModel) selectGeminiModel.value = currentSettings.geminiModel || 'gemini-3.5-flash-lite';
      if (selectGeminiStyle) selectGeminiStyle.value = currentSettings.geminiStyle || 'auto';
      if (selectGeminiPronoun) selectGeminiPronoun.value = currentSettings.geminiPronounRole || 'auto';

      // Set Update controls
      if (inputGithubRepo) inputGithubRepo.value = currentSettings.githubRepo || 'NgocThachTN/YTSubTranslateExtension';

      updatePreview();
      queryCacheStats();
      loadQuotaStats();
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }

  // Event Listeners
  if (toggleEnabled) {
    toggleEnabled.addEventListener('change', () => {
      currentSettings.enabled = toggleEnabled.checked;
      saveSettings(true);
    });
  }

  if (selectTranslationService) {
    selectTranslationService.addEventListener('change', () => {
      currentSettings.translationService = selectTranslationService.value;
      saveSettings(true);
      if (selectTranslationService.value === 'gemini' && !currentSettings.geminiApiKey) {
        showToast('Vui lòng nhập Gemini API Key trong tab Nâng cao');
        const advBtn = document.querySelector('.tab-btn[data-tab="tab-advanced"]');
        if (advBtn) advBtn.click();
        setTimeout(() => {
          if (inputGeminiKey) inputGeminiKey.focus();
        }, 120);
      }
    });
  }

  if (toggleBilingual) {
    toggleBilingual.addEventListener('change', () => {
      currentSettings.displayMode = toggleBilingual.checked ? 'bilingual' : 'vietnamese_only';
      saveSettings(true);
    });
  }

  if (checkHideNative) {
    checkHideNative.addEventListener('change', () => {
      currentSettings.hideOriginalNative = checkHideNative.checked;
      saveSettings(true);
    });
  }

  if (sliderFontSize) {
    sliderFontSize.addEventListener('input', () => {
      currentSettings.fontSize = parseInt(sliderFontSize.value, 10);
      if (fontSizeVal) fontSizeVal.textContent = `${currentSettings.fontSize}px`;
      updatePreview();
      saveSettings(false);
    });
  }

  if (sliderBgOpacity) {
    sliderBgOpacity.addEventListener('input', () => {
      currentSettings.bgOpacity = parseInt(sliderBgOpacity.value, 10);
      if (bgOpacityVal) bgOpacityVal.textContent = `${currentSettings.bgOpacity}%`;
      updatePreview();
      saveSettings(false);
    });
  }

  if (colorTranslated) {
    colorTranslated.addEventListener('input', () => {
      currentSettings.fontColor = colorTranslated.value;
      if (colorTranslatedHex) colorTranslatedHex.textContent = colorTranslated.value.toUpperCase();
      updatePreview();
      saveSettings(false);
    });
  }

  if (colorOriginal) {
    colorOriginal.addEventListener('input', () => {
      currentSettings.originalColor = colorOriginal.value;
      if (colorOriginalHex) colorOriginalHex.textContent = colorOriginal.value.toUpperCase();
      updatePreview();
      saveSettings(false);
    });
  }

  presetPills.forEach((pill) => {
    pill.addEventListener('click', () => {
      const color = pill.getAttribute('data-color');
      if (color && colorTranslated) {
        colorTranslated.value = color;
        currentSettings.fontColor = color;
        if (colorTranslatedHex) colorTranslatedHex.textContent = color.toUpperCase();
        updatePreview();
        saveSettings(true);
      }
    });
  });

  if (btnResetPos) {
    btnResetPos.addEventListener('click', () => {
      currentSettings.subBottomOffset = 0;
      currentSettings.subPosition = 'bottom';
      saveSettings(true);
      showToast('Đã đặt lại vị trí');
    });
  }

  if (selectSourceLang) {
    selectSourceLang.addEventListener('change', () => {
      currentSettings.sourceLang = selectSourceLang.value;
      saveSettings(true);
    });
  }

  if (selectTargetLang) {
    selectTargetLang.addEventListener('change', () => {
      currentSettings.targetLang = selectTargetLang.value;
      saveSettings(true);
    });
  }

  if (inputGeminiKey) {
    inputGeminiKey.addEventListener('input', () => {
      currentSettings.geminiApiKey = inputGeminiKey.value.trim();
      saveSettings(false);
      loadQuotaStats();
    });
    inputGeminiKey.addEventListener('change', () => {
      currentSettings.geminiApiKey = inputGeminiKey.value.trim();
      saveSettings(true);
      loadQuotaStats();
    });
  }

  if (selectGeminiModel) {
    selectGeminiModel.addEventListener('change', () => {
      currentSettings.geminiModel = selectGeminiModel.value;
      saveSettings(true);
    });
  }

  if (selectGeminiStyle) {
    selectGeminiStyle.addEventListener('change', () => {
      currentSettings.geminiStyle = selectGeminiStyle.value;
      saveSettings(true);
    });
  }

  if (selectGeminiPronoun) {
    selectGeminiPronoun.addEventListener('change', () => {
      currentSettings.geminiPronounRole = selectGeminiPronoun.value;
      saveSettings(true);
    });
  }

  if (btnTestGemini) {
    btnTestGemini.addEventListener('click', () => {
      const key = (inputGeminiKey ? inputGeminiKey.value : currentSettings.geminiApiKey || '').trim();
      const model = currentSettings.geminiModel || 'gemini-3.5-flash-lite';
      const style = currentSettings.geminiStyle || 'auto';
      const pronounRole = currentSettings.geminiPronounRole || 'auto';
      if (!key) {
        if (geminiStatusBadge) {
          geminiStatusBadge.className = 'status-badge error';
          geminiStatusBadge.textContent = 'Vui lòng dán API Key trước khi kiểm tra.';
        }
        return;
      }

      if (geminiStatusBadge) {
        geminiStatusBadge.className = 'status-badge loading';
        geminiStatusBadge.textContent = `Đang kiểm tra kết nối tới Google Gemini (${model})...`;
      }
      btnTestGemini.disabled = true;

      chrome.runtime.sendMessage({
        action: 'TEST_GEMINI_KEY',
        apiKey: key,
        model: model,
        style: style,
        pronounRole: pronounRole,
      }, (res) => {
        btnTestGemini.disabled = false;
        if (!geminiStatusBadge) return;

        if (res && res.success) {
          geminiStatusBadge.className = 'status-badge success';
          geminiStatusBadge.textContent = `Kết nối thành công (${res.model || model})! Bản dịch mẫu: "${res.translation}"`;
        } else {
          geminiStatusBadge.className = 'status-badge error';
          geminiStatusBadge.textContent = `Lỗi kết nối: ${res?.error || 'Không thể kết nối đến Gemini API'}`;
        }
      });
    });
  }

  /**
   * Load and render real-time Gemini Quota & Usage Stats
   */
  async function loadQuotaStats() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const data = await chrome.storage.local.get([
        'gemini_requests_today',
        'gemini_requests_date',
        'gemini_cues_translated',
        'gemini_quota_saved',
      ]);

      let requestsToday = data.gemini_requests_today || 0;
      if (data.gemini_requests_date !== today) {
        requestsToday = 0;
      }

      const cuesTranslated = data.gemini_cues_translated || 0;
      const quotaSaved = data.gemini_quota_saved || 0;

      // Calculate keys in pool
      const rawKeys = (currentSettings.geminiApiKey || '').trim();
      const keys = rawKeys.split(/[\n,;]+/).map((k) => k.trim()).filter((k) => k.length > 10);
      const keyCount = Math.max(1, keys.length);
      const maxRpd = keyCount * 1500;
      const maxRpm = keyCount * 15;
      const remainingRpd = Math.max(0, maxRpd - requestsToday);

      if (statRequestsToday) statRequestsToday.textContent = `${requestsToday.toLocaleString()} / ${maxRpd.toLocaleString()}`;
      if (statRequestsRemaining) statRequestsRemaining.textContent = remainingRpd.toLocaleString();
      if (statCuesTranslated) statCuesTranslated.textContent = cuesTranslated.toLocaleString();
      if (statQuotaSaved) statQuotaSaved.textContent = `${quotaSaved.toLocaleString()} câu`;
      if (statPacingSpeed) statPacingSpeed.textContent = `≤ ${maxRpm} RPM`;

      const usedPct = Math.min(100, Math.round((requestsToday / maxRpd) * 100));
      const remainingPct = Math.max(0, 100 - usedPct);

      if (quotaProgressFill) {
        quotaProgressFill.style.width = `${usedPct}%`;
        if (usedPct >= 90) {
          quotaProgressFill.style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
        } else {
          quotaProgressFill.style.background = 'linear-gradient(90deg, #3b82f6, var(--accent-green))';
        }
      }
      if (quotaUsagePercent) quotaUsagePercent.textContent = `${usedPct}%`;
      if (quotaRemainingPercent) {
        quotaRemainingPercent.textContent = `${remainingPct}%`;
        if (remainingPct <= 10) {
          quotaRemainingPercent.className = 'quota-percent-pill danger';
        } else if (remainingPct <= 25) {
          quotaRemainingPercent.className = 'quota-percent-pill warning';
        } else {
          quotaRemainingPercent.className = 'quota-percent-pill success';
        }
      }
      if (quotaKeyPool) quotaKeyPool.textContent = keyCount > 1 ? `${keyCount} Keys (${maxRpd.toLocaleString()} RPD)` : `1 Key (1.500 RPD)`;
    } catch (_) {}
  }

  if (btnCheckQuota) {
    btnCheckQuota.addEventListener('click', () => {
      const rawKey = (currentSettings.geminiApiKey || '').trim();
      if (!rawKey) {
        if (quotaStatusBanner) {
          quotaStatusBanner.className = 'status-badge warning';
          quotaStatusBanner.textContent = 'Chưa cấu hình Gemini API Key. Vui lòng nhập key phía trên.';
        }
        showToast('Chưa nhập Gemini API Key');
        return;
      }

      if (quotaStatusBanner) {
        quotaStatusBanner.className = 'status-badge loading';
        quotaStatusBanner.textContent = 'Đang ping kiểm tra kết nối & hạn ngạch tới Google AI Studio...';
      }
      btnCheckQuota.disabled = true;

      chrome.runtime.sendMessage({
        action: 'CHECK_GEMINI_QUOTA',
        apiKey: rawKey,
        model: currentSettings.geminiModel || 'gemini-3.5-flash-lite'
      }, (res) => {
        btnCheckQuota.disabled = false;
        loadQuotaStats();

        if (res && res.success) {
          if (quotaStatusBanner) {
            quotaStatusBanner.className = 'status-badge success';
            quotaStatusBanner.textContent = res.message || `Key hoạt động tốt • Ping: ${res.latencyMs}ms • Quota khả dụng`;
          }
          if (quotaStatusText) quotaStatusText.textContent = `Sẵn sàng • Ping: ${res.latencyMs}ms`;
          showToast(`Gemini API sẵn sàng! Ping: ${res.latencyMs}ms`);
        } else if (res && res.status === 'rate_limited') {
          if (quotaStatusBanner) {
            quotaStatusBanner.className = 'status-badge warning';
            quotaStatusBanner.textContent = res.message || 'Tạm chạm giới hạn 15 RPM. Tự động phục hồi sau ít phút.';
          }
          if (quotaStatusText) quotaStatusText.textContent = 'Tạm chạm giới hạn 15 RPM';
          showToast('Tạm chạm giới hạn 15 RPM');
        } else {
          if (quotaStatusBanner) {
            quotaStatusBanner.className = 'status-badge error';
            quotaStatusBanner.textContent = `Lỗi Quota / Key: ${res?.error || 'Không thể xác thực key'}`;
          }
          if (quotaStatusText) quotaStatusText.textContent = 'Lỗi kết nối / Quota';
          showToast('Kiểm tra thất bại. Vui lòng kiểm tra lại key.');
        }
      });
    });
  }

  if (btnClearCache) {
    btnClearCache.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'CLEAR_CACHE' }, (res) => {
        if (res && res.success) {
          if (statCacheCount) statCacheCount.textContent = '0';
          if (statCacheSize) statCacheSize.textContent = '0.00 KB';
          showToast('Đã xóa bộ nhớ đệm');
        }
      });
    });
  }

  // =========================================================================
  // GitHub Releases Update Checker
  // =========================================================================

  const currentAppVersion = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '1.4.0';
  const brandVersionElem = document.getElementById('brand-version');
  if (brandVersionElem) brandVersionElem.textContent = `v${currentAppVersion}`;
  if (currentVersionDisplay) currentVersionDisplay.textContent = `v${currentAppVersion}`;

  /**
   * Compare two semver version strings (e.g. "v1.4.0" vs "v1.4.1")
   * Returns: 1 if vA > vB, -1 if vA < vB, 0 if equal
   */
  function compareSemver(vA, vB) {
    const clean = (v) => (v || '').replace(/^[^\d]*/, '').trim();
    const partsA = clean(vA).split('.').map((n) => parseInt(n, 10) || 0);
    const partsB = clean(vB).split('.').map((n) => parseInt(n, 10) || 0);
    const maxLen = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < maxLen; i++) {
      const a = partsA[i] || 0;
      const b = partsB[i] || 0;
      if (a > b) return 1;
      if (a < b) return -1;
    }
    return 0;
  }

  /**
   * Check for latest release on GitHub
   */
  async function checkForUpdates(manual = false) {
    const repo = (currentSettings.githubRepo || 'NgocThachTN/YTSubTranslateExtension').trim();
    if (!repo) return;

    if (linkGithubReleases) {
      linkGithubReleases.href = `https://github.com/${repo}/releases`;
    }

    if (updateStatusBanner) {
      updateStatusBanner.className = 'update-banner loading';
      if (updateBannerIcon) updateBannerIcon.textContent = '⏳';
      if (updateBannerText) updateBannerText.textContent = `Đang kết nối GitHub (${repo})...`;
    }
    if (btnCheckUpdate) btnCheckUpdate.disabled = true;

    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github.v3+json' },
      });

      if (response.status === 404) {
        // No official release published yet
        if (updateStatusBanner) {
          updateStatusBanner.className = 'update-banner info';
          if (updateBannerIcon) updateBannerIcon.textContent = 'ℹ';
          if (updateBannerText) updateBannerText.textContent = `Chưa có bản phát hành chính thức nào trên GitHub (${repo}). Bạn đang sử dụng bản dev v${currentAppVersion}.`;
        }
        if (latestVersionDisplay) latestVersionDisplay.textContent = 'Chưa có';
        if (latestReleaseTag) latestReleaseTag.textContent = 'No release';
        if (btnDownloadUpdate) btnDownloadUpdate.style.display = 'none';
        if (tabUpdateDot) tabUpdateDot.style.display = 'none';
        if (releaseInfoSection) releaseInfoSection.style.display = 'none';
        if (manual) showToast('Chưa có bản phát hành mới trên GitHub');
        return;
      }

      if (response.status === 403) {
        if (updateStatusBanner) {
          updateStatusBanner.className = 'update-banner error';
          if (updateBannerIcon) updateBannerIcon.textContent = '⚠';
          if (updateBannerText) updateBannerText.textContent = 'GitHub API bị giới hạn tần suất truy cập tạm thời. Vui lòng bấm "Xem trên GitHub ↗".';
        }
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const latestTag = data.tag_name || '';
      const isNewer = compareSemver(latestTag, currentAppVersion) > 0;

      if (latestVersionDisplay) latestVersionDisplay.textContent = latestTag || '---';
      if (latestReleaseTag) latestReleaseTag.textContent = isNewer ? 'Có bản mới' : 'Mới nhất';

      if (isNewer) {
        if (updateStatusBanner) {
          updateStatusBanner.className = 'update-banner update-available';
          if (updateBannerIcon) updateBannerIcon.textContent = '★';
          if (updateBannerText) updateBannerText.textContent = `Đã có bản cập nhật mới (${latestTag})! Bấm "Tải bản mới" bên dưới.`;
        }
        if (tabUpdateDot) tabUpdateDot.style.display = 'inline-block';

        // Find .zip asset or fallback
        const zipAsset = (data.assets || []).find((a) => a.name && a.name.endsWith('.zip'));
        const downloadUrl = zipAsset ? zipAsset.browser_download_url : (data.zipball_url || data.html_url);

        if (btnDownloadUpdate) {
          btnDownloadUpdate.href = downloadUrl;
          btnDownloadUpdate.style.display = 'inline-flex';
        }
        if (manual) showToast(`Có bản cập nhật mới: ${latestTag}!`);
      } else {
        if (updateStatusBanner) {
          updateStatusBanner.className = 'update-banner success';
          if (updateBannerIcon) updateBannerIcon.textContent = '✓';
          if (updateBannerText) updateBannerText.textContent = `Bạn đang sử dụng phiên bản mới nhất (${latestTag || 'v' + currentAppVersion})!`;
        }
        if (tabUpdateDot) tabUpdateDot.style.display = 'none';
        if (btnDownloadUpdate) btnDownloadUpdate.style.display = 'none';
        if (manual) showToast('Bạn đang dùng bản mới nhất!');
      }

      // Display release details & changelog
      if (releaseInfoSection) {
        releaseInfoSection.style.display = 'flex';
        if (releaseNameTitle) releaseNameTitle.textContent = data.name || data.tag_name || 'Chi tiết cập nhật';
        if (releaseDateText && data.published_at) {
          const d = new Date(data.published_at);
          releaseDateText.textContent = `Phát hành: ${d.toLocaleDateString('vi-VN')}`;
        }
        if (releaseNotesContent) {
          releaseNotesContent.textContent = data.body || 'Bản phát hành không có ghi chú thay đổi kèm theo.';
        }
      }

      if (linkGithubReleases) {
        linkGithubReleases.href = data.html_url || `https://github.com/${repo}/releases`;
      }
    } catch (err) {
      console.warn('[YT ViSub Update] Check failed:', err);
      if (updateStatusBanner) {
        updateStatusBanner.className = 'update-banner error';
        if (updateBannerIcon) updateBannerIcon.textContent = '⚠';
        if (updateBannerText) updateBannerText.textContent = `Không thể kết nối đến GitHub: ${err.message || 'Lỗi mạng'}.`;
      }
    } finally {
      if (btnCheckUpdate) btnCheckUpdate.disabled = false;
    }
  }

  if (btnCheckUpdate) {
    btnCheckUpdate.addEventListener('click', () => {
      checkForUpdates(true);
    });
  }

  if (inputGithubRepo) {
    inputGithubRepo.addEventListener('change', () => {
      currentSettings.githubRepo = inputGithubRepo.value.trim() || 'NgocThachTN/YTSubTranslateExtension';
      saveSettings(true);
      checkForUpdates(false);
    });
  }

  await loadSettings();
  checkForUpdates(false);
});
