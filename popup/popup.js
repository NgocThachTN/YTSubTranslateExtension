/**
 * YouTube Subtitle Translator - Popup Script
 * Manages configuration UI, synchronizes with chrome.storage, and updates live preview.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // UI Elements
  const toggleEnabled = document.getElementById('toggle-enabled');
  const displayModeRadios = document.querySelectorAll('input[name="displayMode"]');
  const selectSourceLang = document.getElementById('select-source-lang');
  const selectTargetLang = document.getElementById('select-target-lang');
  const sliderFontSize = document.getElementById('slider-font-size');
  const fontSizeVal = document.getElementById('font-size-val');
  const sliderBgOpacity = document.getElementById('slider-bg-opacity');
  const bgOpacityVal = document.getElementById('bg-opacity-val');
  const colorTranslated = document.getElementById('color-translated');
  const colorTranslatedHex = document.getElementById('color-translated-hex');
  const colorOriginal = document.getElementById('color-original');
  const colorOriginalHex = document.getElementById('color-original-hex');
  const origColorContainer = document.getElementById('orig-color-container');
  const checkHideNative = document.getElementById('check-hide-native');
  const btnResetPos = document.getElementById('btn-reset-pos');
  const inputApiKey = document.getElementById('input-api-key');
  const btnClearCache = document.getElementById('btn-clear-cache');
  const cacheStatus = document.getElementById('cache-status');
  const toast = document.getElementById('toast');
  const mainContent = document.getElementById('main-content');

  // Preview elements
  const previewSubBox = document.getElementById('preview-sub-box');
  const previewOrigText = document.getElementById('preview-orig-text');
  const previewTransText = document.getElementById('preview-trans-text');

  // Color preset buttons
  const presetButtons = document.querySelectorAll('.preset-btn');

  // Default state
  let currentSettings = {
    enabled: true,
    displayMode: 'bilingual',
    sourceLang: 'auto',
    targetLang: 'vi',
    fontSize: 20,
    fontColor: '#FFE600',
    originalColor: '#FFFFFF',
    bgOpacity: 65,
    subPosition: 'bottom',
    subBottomOffset: 60,
    hideOriginalNative: true,
    customApiKey: '',
  };

  let saveTimeout = null;
  let toastTimeout = null;

  /**
   * Display toast notification
   */
  function showToast(message = 'Đã lưu cài đặt!') {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 1800);
  }

  /**
   * Update live preview styling based on current state
   */
  function updatePreview() {
    if (!previewSubBox) return;

    const isBilingual = currentSettings.displayMode === 'bilingual';
    previewSubBox.style.fontSize = `${currentSettings.fontSize}px`;
    previewSubBox.style.backgroundColor = `rgba(10, 12, 18, ${(currentSettings.bgOpacity ?? 65) / 100})`;

    if (previewOrigText) {
      previewOrigText.style.display = isBilingual ? 'block' : 'none';
      previewOrigText.style.color = currentSettings.originalColor || '#FFFFFF';
    }

    if (previewTransText) {
      previewTransText.style.color = currentSettings.fontColor || '#FFE600';
    }

    if (origColorContainer) {
      origColorContainer.style.display = isBilingual ? 'flex' : 'none';
    }

    if (mainContent) {
      mainContent.style.opacity = currentSettings.enabled ? '1' : '0.45';
      mainContent.style.pointerEvents = currentSettings.enabled ? 'auto' : 'none';
    }
  }

  /**
   * Save current settings to chrome.storage.sync
   */
  function saveSettings(notify = true) {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        await chrome.storage.sync.set(currentSettings);
        updatePreview();
        if (notify) {
          showToast('Đã áp dụng thay đổi!');
        }
      } catch (err) {
        console.error('Failed to save settings:', err);
      }
    }, 150);
  }

  /**
   * Populate UI from storage
   */
  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(Object.keys(currentSettings));
      currentSettings = { ...currentSettings, ...stored };

      // Set UI values
      if (toggleEnabled) toggleEnabled.checked = currentSettings.enabled;

      displayModeRadios.forEach((radio) => {
        if (radio.value === currentSettings.displayMode) {
          radio.checked = true;
        }
      });

      if (selectSourceLang) selectSourceLang.value = currentSettings.sourceLang || 'auto';
      if (selectTargetLang) selectTargetLang.value = currentSettings.targetLang || 'vi';

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

      if (checkHideNative) checkHideNative.checked = currentSettings.hideOriginalNative;
      if (inputApiKey) inputApiKey.value = currentSettings.customApiKey || '';

      updatePreview();
      queryCacheStats();
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }

  /**
   * Fetch current translation cache statistics
   */
  function queryCacheStats() {
    chrome.runtime.sendMessage({ action: 'GET_CACHE_STATS' }, (res) => {
      if (res && res.success && cacheStatus) {
        cacheStatus.textContent = `${res.size || 0} câu đã đệm`;
      }
    });
  }

  // Event Listeners
  if (toggleEnabled) {
    toggleEnabled.addEventListener('change', () => {
      currentSettings.enabled = toggleEnabled.checked;
      saveSettings(true);
    });
  }

  displayModeRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) {
        currentSettings.displayMode = radio.value;
        saveSettings(true);
      }
    });
  });

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

  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const color = btn.getAttribute('data-color');
      if (color && colorTranslated) {
        colorTranslated.value = color;
        currentSettings.fontColor = color;
        if (colorTranslatedHex) colorTranslatedHex.textContent = color.toUpperCase();
        updatePreview();
        saveSettings(true);
      }
    });
  });

  if (checkHideNative) {
    checkHideNative.addEventListener('change', () => {
      currentSettings.hideOriginalNative = checkHideNative.checked;
      saveSettings(true);
    });
  }

  if (btnResetPos) {
    btnResetPos.addEventListener('click', () => {
      currentSettings.subBottomOffset = 60;
      currentSettings.subPosition = 'bottom';
      saveSettings(true);
      showToast('Đã đặt lại vị trí phụ đề!');
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
          if (cacheStatus) cacheStatus.textContent = '0 câu đã đệm';
          showToast('Đã xóa bộ nhớ đệm!');
        }
      });
    });
  }

  // Load configuration initially
  loadSettings();
});
