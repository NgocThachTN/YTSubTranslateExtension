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
  const inputApiKey = document.getElementById('input-api-key');

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
      if (inputApiKey) inputApiKey.value = currentSettings.customApiKey || '';

      updatePreview();
      queryCacheStats();
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
    });
    inputGeminiKey.addEventListener('change', () => {
      currentSettings.geminiApiKey = inputGeminiKey.value.trim();
      saveSettings(true);
    });
  }

  if (selectGeminiModel) {
    selectGeminiModel.addEventListener('change', () => {
      currentSettings.geminiModel = selectGeminiModel.value;
      saveSettings(true);
    });
  }

  if (btnTestGemini) {
    btnTestGemini.addEventListener('click', () => {
      const key = (inputGeminiKey ? inputGeminiKey.value : currentSettings.geminiApiKey || '').trim();
      const model = currentSettings.geminiModel || 'gemini-3.5-flash-lite';
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

      chrome.runtime.sendMessage({ action: 'TEST_GEMINI_KEY', apiKey: key, model: model }, (res) => {
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

  if (inputApiKey) {
    inputApiKey.addEventListener('change', () => {
      currentSettings.customApiKey = inputApiKey.value.trim();
      saveSettings(true);
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

  loadSettings();
});
