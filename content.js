/**
 * YouTube Subtitle Translator - Content Script
 * Captures YouTube subtitles, sends translation requests, and renders customizable Vietnamese overlay.
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
    fontColor: '#FFE600',
    originalColor: '#FFFFFF',
    bgOpacity: 65,
    subPosition: 'bottom',
    subBottomOffset: 60,
    hideOriginalNative: true,
    customApiKey: '',
  };

  // State variables
  let playerElement = null;
  let captionObserver = null;
  let playerObserver = null;
  let lastCaptionText = '';
  let debounceTimer = null;
  let overlayContainer = null;
  let innerBox = null;
  let originalTextElement = null;
  let translatedTextElement = null;
  let isDragging = false;
  let startY = 0;
  let startBottom = 60;

  /**
   * Load settings from chrome.storage.sync
   */
  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(Object.keys(settings));
      settings = { ...settings, ...stored };
      applySettings();
    } catch (err) {
      console.warn('[YT Sub Translate] Could not load settings:', err);
    }
  }

  /**
   * Apply settings to the DOM and overlay
   */
  function applySettings() {
    if (!overlayContainer || !innerBox) return;

    // Toggle overlay visibility based on enabled state and display mode
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

    // Handle native subtitle hiding
    if (playerElement) {
      if (settings.hideOriginalNative) {
        playerElement.classList.add('ytsub-hide-native');
      } else {
        playerElement.classList.remove('ytsub-hide-native');
      }
    }

    // Apply typography and styles
    innerBox.style.fontSize = `${settings.fontSize}px`;
    innerBox.style.backgroundColor = `rgba(10, 12, 18, ${(settings.bgOpacity ?? 65) / 100})`;

    if (originalTextElement) {
      originalTextElement.style.color = settings.originalColor || '#FFFFFF';
      originalTextElement.style.display = settings.displayMode === 'bilingual' ? 'block' : 'none';
    }

    if (translatedTextElement) {
      translatedTextElement.style.color = settings.fontColor || '#FFE600';
    }

    // Position class
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
   * Create or retrieve the custom subtitle overlay elements
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

      const origText = document.createElement('div');
      origText.id = 'ytsub-original-text';
      origText.className = 'ytsub-line';

      const transText = document.createElement('div');
      transText.id = 'ytsub-translated-text';
      transText.className = 'ytsub-line';

      box.appendChild(origText);
      box.appendChild(transText);
      container.appendChild(box);

      player.appendChild(container);

      // Drag to adjust vertical position
      setupDraggable(box, container, player);
    }

    overlayContainer = container;
    innerBox = container.querySelector('#ytsub-inner-box');
    originalTextElement = container.querySelector('#ytsub-original-text');
    translatedTextElement = container.querySelector('#ytsub-translated-text');

    applySettings();
  }

  /**
   * Enable dragging of subtitle box vertically
   */
  function setupDraggable(box, container, player) {
    let currentY = 0;

    const onMouseDown = (e) => {
      // Only primary mouse button
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
      const deltaY = startY - e.clientY; // moving up increases bottom distance
      const newBottom = Math.max(20, Math.min(player.clientHeight - 80, startBottom + deltaY));
      container.style.bottom = `${newBottom}px`;
    };

    const onMouseUp = (e) => {
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
   * Extract current subtitle text from YouTube DOM
   */
  function extractCaptionText() {
    if (!playerElement) return '';

    const captionContainer = playerElement.querySelector('.ytp-caption-window-container');
    if (!captionContainer) return '';

    // Check all caption windows and segments
    const segments = captionContainer.querySelectorAll('.ytp-caption-segment');
    if (!segments || segments.length === 0) return '';

    const lines = [];
    segments.forEach((seg) => {
      const text = seg.textContent ? seg.textContent.trim() : '';
      if (text) {
        lines.push(text);
      }
    });

    return lines.join(' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Process subtitle updates
   */
  function onCaptionsChanged() {
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

    // Show box and display original subtitle immediately
    if (innerBox) {
      innerBox.classList.remove('ytsub-hidden');
    }

    if (originalTextElement && settings.displayMode === 'bilingual') {
      originalTextElement.textContent = currentText;
      originalTextElement.style.display = 'block';
    } else if (originalTextElement) {
      originalTextElement.style.display = 'none';
    }

    // Debounce translation request to avoid rapid API calls on streaming captions
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      translateSubtitle(currentText);
    }, 80);
  }

  /**
   * Request translation from background service worker
   */
  async function translateSubtitle(text) {
    if (!text || text !== lastCaptionText) return;

    if (translatedTextElement) {
      translatedTextElement.classList.add('ytsub-translating');
    }

    try {
      const response = await chrome.runtime.sendMessage({
        action: 'TRANSLATE',
        text: text,
        sourceLang: settings.sourceLang || 'auto',
        targetLang: settings.targetLang || 'vi',
        apiKey: settings.customApiKey || '',
      });

      // Ensure text is still current when response arrives
      if (text === lastCaptionText && response && response.success) {
        if (translatedTextElement) {
          translatedTextElement.textContent = response.translation || text;
          translatedTextElement.classList.remove('ytsub-translating');
        }
      } else if (response && !response.success) {
        console.warn('[YT Sub Translate] Translation error:', response.error);
        if (translatedTextElement && text === lastCaptionText) {
          translatedTextElement.textContent = text; // Fallback to original
          translatedTextElement.classList.remove('ytsub-translating');
        }
      }
    } catch (err) {
      console.warn('[YT Sub Translate] Error communicating with background:', err);
    }
  }

  /**
   * Attach MutationObserver to the YouTube caption container
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

    // Check current state immediately
    onCaptionsChanged();
  }

  /**
   * Initialize translator for the YouTube player
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
   * Monitor page for video player initialization and SPA transitions
   */
  function init() {
    loadSettings();

    // Try immediately
    if (!initPlayer()) {
      // Poll until player is ready
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (initPlayer() || attempts > 20) {
          clearInterval(interval);
        }
      }, 500);
    }

    // Listen for YouTube SPA navigation events
    window.addEventListener('yt-navigate-finish', () => {
      setTimeout(() => {
        initPlayer();
      }, 300);
    });

    window.addEventListener('spfdone', () => {
      setTimeout(() => {
        initPlayer();
      }, 300);
    });

    // Observe player re-creations
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

  // Listen for real-time configuration changes from popup
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' || namespace === 'local') {
      for (const [key, change] of Object.entries(changes)) {
        settings[key] = change.newValue;
      }
      applySettings();
      // Re-trigger caption rendering if settings changed
      if (lastCaptionText) {
        const text = lastCaptionText;
        lastCaptionText = '';
        setTimeout(() => {
          onCaptionsChanged();
        }, 50);
      }
    }
  });

  // Start initialization when script is loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
