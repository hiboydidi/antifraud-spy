/**
 * Antifraud Spy - Page Script
 * Инжектится в контекст страницы для перехвата fingerprint API
 *
 * STEALTH: Не модифицируем значения, только логируем
 */

(function() {
  'use strict';

  // Уникальный ID для коммуникации (генерируется при инжекции)
  const CHANNEL_ID = document.currentScript?.dataset?.channelId || 'antifraud-spy';

  // Хранилище оригинальных функций
  const originals = new Map();

  // Счётчик вызовов для статистики
  const callCounts = {};

  const EVENT_FLUSH_INTERVAL_MS = 250;
  const MAX_DETAIL_VARIANTS_PER_METHOD = 10;
  const pendingEvents = new Map();
  const pendingDetailVariants = new Map();
  const capturedStacks = new Set();
  let flushTimer = null;

  function flushEvents() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingEvents.size === 0) return;

    const payloads = Array.from(pendingEvents.values());
    pendingEvents.clear();
    pendingDetailVariants.clear();
    window.postMessage({ type: CHANNEL_ID, payloads }, '*');
  }

  function scheduleFlush() {
    if (!flushTimer) {
      flushTimer = setTimeout(flushEvents, EVENT_FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Отправка события в content script
   */
  function emit(category, method, details = {}) {
    const key = `${category}.${method}`;
    callCounts[key] = (callCounts[key] || 0) + 1;

    let detailKey = '';
    try {
      detailKey = JSON.stringify(details);
    } catch (e) {
      detailKey = '[unserializable]';
    }
    let eventKey = `${key}:${detailKey.slice(0, 500)}`;
    let existing = pendingEvents.get(eventKey);

    if (!existing) {
      const variantCount = pendingDetailVariants.get(key) || 0;
      if (variantCount >= MAX_DETAIL_VARIANTS_PER_METHOD) {
        eventKey = `${key}:__overflow`;
        existing = pendingEvents.get(eventKey);
      } else {
        pendingDetailVariants.set(key, variantCount + 1);
      }
    }

    if (existing) {
      existing.callCount = callCounts[key];
      existing.batchCount += 1;
      existing.timestamp = Date.now();
    } else {
      const isOverflow = eventKey.endsWith(':__overflow');
      const shouldCaptureStack = !isOverflow && !capturedStacks.has(key);
      if (shouldCaptureStack) capturedStacks.add(key);

      pendingEvents.set(eventKey, {
        category,
        method,
        details: isOverflow ? { aggregated: true, sample: details } : details,
        timestamp: Date.now(),
        url: location.href,
        stack: shouldCaptureStack ? getCleanStack() : '',
        callCount: callCounts[key],
        batchCount: 1
      });
    }

    scheduleFlush();
  }

  /**
   * Очистка stack trace от extension URLs (stealth)
   */
  function getCleanStack() {
    try {
      throw new Error();
    } catch (e) {
      return (e.stack || '')
        .split('\n')
        .slice(3) // Убираем наши вызовы
        .filter(line => !line.includes('extension://'))
        .slice(0, 5)
        .join('\n');
    }
  }

  window.addEventListener('pagehide', flushEvents, { once: true });

  /**
   * Безопасное сохранение оригинала
   */
  function saveOriginal(obj, prop) {
    const key = `${obj.constructor?.name || 'Object'}.${prop}`;
    if (!originals.has(key)) {
      originals.set(key, obj[prop]);
    }
    return originals.get(key);
  }

  /**
   * Создание proxy для метода
   */
  function hookMethod(obj, prop, category, customHandler = null) {
    const original = saveOriginal(obj, prop);
    if (typeof original !== 'function') return;

    obj[prop] = function(...args) {
      const details = customHandler ? customHandler(args, this) : { args: args.map(summarizeArg) };
      emit(category, prop, details);
      return original.apply(this, args);
    };

    // Сохраняем toString чтобы выглядело как native
    obj[prop].toString = () => original.toString();
  }

  /**
   * Создание proxy для getter
   */
  function hookGetter(obj, prop, category, customHandler = null) {
    const descriptor = Object.getOwnPropertyDescriptor(obj, prop);
    if (!descriptor || !descriptor.get) return;

    const originalGet = descriptor.get;
    saveOriginal({ get: originalGet }, prop);

    Object.defineProperty(obj, prop, {
      ...descriptor,
      get: function() {
        const value = originalGet.call(this);
        const details = customHandler ? customHandler(value) : { value: summarizeValue(value) };
        emit(category, prop, details);
        return value;
      }
    });
  }

  /**
   * Summarize argument for logging (avoid huge data)
   */
  function summarizeArg(arg) {
    if (arg === null) return null;
    if (arg === undefined) return undefined;
    if (typeof arg === 'function') return '[Function]';
    if (typeof arg === 'string') return arg.length > 100 ? arg.slice(0, 100) + '...' : arg;
    if (Array.isArray(arg)) return `[Array(${arg.length})]`;
    if (arg instanceof ArrayBuffer) return `[ArrayBuffer(${arg.byteLength})]`;
    if (arg instanceof ImageData) return `[ImageData(${arg.width}x${arg.height})]`;
    if (typeof arg === 'object') return '[Object]';
    return arg;
  }

  function summarizeValue(val) {
    if (typeof val === 'string' && val.length > 200) {
      return val.slice(0, 200) + '...';
    }
    return val;
  }

  // ============================================
  // CANVAS FINGERPRINTING
  // ============================================

  // Canvas toDataURL - capture hash of result
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    const result = originalToDataURL.apply(this, args);
    // Create short hash of the data URL for fingerprint comparison
    const hash = result.length > 100 ?
      `len:${result.length},start:${result.slice(0, 50)}...` : result;
    emit('canvas', 'toDataURL', {
      type: args[0] || 'image/png',
      width: this.width,
      height: this.height,
      hash: hash.slice(0, 200)
    });
    return result;
  };
  HTMLCanvasElement.prototype.toDataURL.toString = () => originalToDataURL.toString();

  hookMethod(HTMLCanvasElement.prototype, 'toBlob', 'canvas', (args) => ({
    type: args[1] || 'image/png',
    quality: args[2]
  }));

  // Canvas 2D context
  const ctx2dProto = CanvasRenderingContext2D.prototype;

  hookMethod(ctx2dProto, 'getImageData', 'canvas', (args) => ({
    x: args[0], y: args[1], width: args[2], height: args[3]
  }));

  hookMethod(ctx2dProto, 'fillText', 'canvas', (args) => ({
    text: args[0]?.slice(0, 50),
    x: args[1], y: args[2]
  }));

  hookMethod(ctx2dProto, 'strokeText', 'canvas', (args) => ({
    text: args[0]?.slice(0, 50),
    x: args[1], y: args[2]
  }));

  hookMethod(ctx2dProto, 'measureText', 'canvas', (args) => ({
    text: args[0]?.slice(0, 50)
  }));

  // ============================================
  // WEBGL FINGERPRINTING
  // ============================================

  function hookWebGL(proto, name) {
    // getParameter - основной метод fingerprinting - capture actual values
    const originalGetParam = proto.getParameter;
    proto.getParameter = function(param) {
      const result = originalGetParam.call(this, param);
      const paramNames = {
        7936: 'VENDOR',
        7937: 'RENDERER',
        37445: 'UNMASKED_VENDOR_WEBGL',
        37446: 'UNMASKED_RENDERER_WEBGL',
        7938: 'VERSION',
        35724: 'SHADING_LANGUAGE_VERSION',
        3379: 'MAX_TEXTURE_SIZE',
        34076: 'MAX_CUBE_MAP_TEXTURE_SIZE',
        34024: 'MAX_RENDERBUFFER_SIZE',
        36347: 'MAX_VERTEX_ATTRIBS'
      };
      emit('webgl', 'getParameter', {
        parameter: paramNames[param] || param,
        paramCode: param,
        value: typeof result === 'string' ? result : (result?.toString?.() || result)
      });
      return result;
    };
    proto.getParameter.toString = () => originalGetParam.toString();

    hookMethod(proto, 'getExtension', 'webgl', (args) => ({
      extension: args[0]
    }));

    hookMethod(proto, 'getSupportedExtensions', 'webgl');

    hookMethod(proto, 'getShaderPrecisionFormat', 'webgl', (args) => ({
      shaderType: args[0],
      precisionType: args[1]
    }));

    // readPixels - иногда используется для fingerprinting
    hookMethod(proto, 'readPixels', 'webgl', (args) => ({
      x: args[0], y: args[1], width: args[2], height: args[3]
    }));
  }

  if (typeof WebGLRenderingContext !== 'undefined') {
    hookWebGL(WebGLRenderingContext.prototype, 'WebGL');
  }
  if (typeof WebGL2RenderingContext !== 'undefined') {
    hookWebGL(WebGL2RenderingContext.prototype, 'WebGL2');
  }

  // ============================================
  // NAVIGATOR FINGERPRINTING
  // ============================================

  const navigatorProps = [
    'userAgent', 'platform', 'language', 'languages',
    'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints',
    'vendor', 'appVersion', 'appName', 'appCodeName',
    'product', 'productSub', 'cookieEnabled', 'doNotTrack',
    'webdriver', 'pdfViewerEnabled'
  ];

  navigatorProps.forEach(prop => {
    try {
      hookGetter(Navigator.prototype, prop, 'navigator');
    } catch (e) { /* некоторые свойства могут быть недоступны */ }
  });

  // Navigator methods
  hookMethod(Navigator.prototype, 'getBattery', 'navigator');

  if (navigator.connection) {
    ['type', 'effectiveType', 'downlink', 'rtt', 'saveData'].forEach(prop => {
      try {
        hookGetter(NetworkInformation.prototype, prop, 'network');
      } catch (e) {}
    });
  }

  // Permissions API
  if (navigator.permissions) {
    hookMethod(Permissions.prototype, 'query', 'permissions', (args) => ({
      name: args[0]?.name
    }));
  }

  // MediaDevices
  if (navigator.mediaDevices) {
    hookMethod(MediaDevices.prototype, 'enumerateDevices', 'media');
    hookMethod(MediaDevices.prototype, 'getUserMedia', 'media', (args) => ({
      constraints: JSON.stringify(args[0])
    }));
  }

  // ============================================
  // SCREEN FINGERPRINTING
  // ============================================

  const screenProps = [
    'width', 'height', 'availWidth', 'availHeight',
    'colorDepth', 'pixelDepth', 'orientation'
  ];

  screenProps.forEach(prop => {
    try {
      hookGetter(Screen.prototype, prop, 'screen');
    } catch (e) {}
  });

  // ============================================
  // AUDIO FINGERPRINTING
  // ============================================

  if (typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined') {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;

    if (AudioCtx) {
      const originalAudioContext = AudioCtx;
      window.AudioContext = function(...args) {
        emit('audio', 'new AudioContext', { sampleRate: args[0]?.sampleRate });
        return new originalAudioContext(...args);
      };
      window.AudioContext.prototype = originalAudioContext.prototype;

      // Основные методы для audio fingerprint
      hookMethod(AudioCtx.prototype, 'createOscillator', 'audio');
      hookMethod(AudioCtx.prototype, 'createDynamicsCompressor', 'audio');
      hookMethod(AudioCtx.prototype, 'createAnalyser', 'audio');
      hookMethod(AudioCtx.prototype, 'createGain', 'audio');
      hookMethod(AudioCtx.prototype, 'createScriptProcessor', 'audio', (args) => ({
        bufferSize: args[0]
      }));

      // OfflineAudioContext - ключевой для fingerprinting
      if (typeof OfflineAudioContext !== 'undefined') {
        const OriginalOffline = OfflineAudioContext;
        window.OfflineAudioContext = function(...args) {
          emit('audio', 'new OfflineAudioContext', {
            channels: args[0],
            length: args[1],
            sampleRate: args[2]
          });
          return new OriginalOffline(...args);
        };
        window.OfflineAudioContext.prototype = OriginalOffline.prototype;
      }
    }
  }

  // ============================================
  // FONTS FINGERPRINTING
  // ============================================

  // FontFace API
  if (typeof FontFace !== 'undefined') {
    const OriginalFontFace = FontFace;
    window.FontFace = function(family, source, descriptors) {
      emit('fonts', 'new FontFace', { family });
      return new OriginalFontFace(family, source, descriptors);
    };
    window.FontFace.prototype = OriginalFontFace.prototype;
  }

  // document.fonts
  try {
    if (document.fonts && window.FontFaceSet && window.FontFaceSet.prototype) {
      hookMethod(window.FontFaceSet.prototype, 'check', 'fonts', (args) => ({
        font: args[0],
        text: args[1]
      }));
    }
  } catch (e) { /* FontFaceSet may not be available */ }

  // ============================================
  // STORAGE FINGERPRINTING
  // ============================================

  // localStorage
  hookMethod(Storage.prototype, 'getItem', 'storage', (args, ctx) => ({
    storage: ctx === localStorage ? 'localStorage' : 'sessionStorage',
    key: args[0]
  }));

  hookMethod(Storage.prototype, 'setItem', 'storage', (args, ctx) => ({
    storage: ctx === localStorage ? 'localStorage' : 'sessionStorage',
    key: args[0],
    valueLength: args[1]?.length
  }));

  // IndexedDB
  if (typeof indexedDB !== 'undefined') {
    hookMethod(IDBFactory.prototype, 'open', 'storage', (args) => ({
      type: 'indexedDB',
      name: args[0],
      version: args[1]
    }));
  }

  // ============================================
  // DATE/TIME FINGERPRINTING
  // ============================================

  hookMethod(Date.prototype, 'getTimezoneOffset', 'timezone');

  if (typeof Intl !== 'undefined') {
    hookMethod(Intl.DateTimeFormat.prototype, 'resolvedOptions', 'timezone');
  }

  // ============================================
  // PERFORMANCE FINGERPRINTING
  // ============================================

  // NOTE: performance.now() disabled - called thousands of times per second (animations)
  // performance.memory also disabled - too noisy, not useful for antifraud analysis

  // ============================================
  // WEBRTC FINGERPRINTING
  // ============================================

  if (typeof RTCPeerConnection !== 'undefined') {
    const OriginalRTC = RTCPeerConnection;
    window.RTCPeerConnection = function(config) {
      emit('webrtc', 'new RTCPeerConnection', {
        iceServers: config?.iceServers?.length
      });
      return new OriginalRTC(config);
    };
    window.RTCPeerConnection.prototype = OriginalRTC.prototype;

    hookMethod(RTCPeerConnection.prototype, 'createDataChannel', 'webrtc', (args) => ({
      label: args[0]
    }));

    hookMethod(RTCPeerConnection.prototype, 'createOffer', 'webrtc');
    hookMethod(RTCPeerConnection.prototype, 'setLocalDescription', 'webrtc');
  }

  // ============================================
  // PLUGINS & MIMETYPES
  // ============================================

  // Plugin enumeration
  try {
    const pluginsDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins');
    if (pluginsDescriptor?.get) {
      Object.defineProperty(Navigator.prototype, 'plugins', {
        get: function() {
          const plugins = pluginsDescriptor.get.call(this);
          emit('plugins', 'navigator.plugins', { count: plugins.length });
          return plugins;
        }
      });
    }
  } catch (e) {}

  try {
    const mimeTypesDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'mimeTypes');
    if (mimeTypesDescriptor?.get) {
      Object.defineProperty(Navigator.prototype, 'mimeTypes', {
        get: function() {
          const mimeTypes = mimeTypesDescriptor.get.call(this);
          emit('plugins', 'navigator.mimeTypes', { count: mimeTypes.length });
          return mimeTypes;
        }
      });
    }
  } catch (e) {}

  // ============================================
  // EVENTS (mouse, keyboard patterns)
  // ============================================

  // Отслеживаем добавление suspicious event listeners
  const suspiciousEvents = ['mousemove', 'mousedown', 'mouseup', 'keydown', 'keyup', 'touchstart', 'touchend', 'touchmove'];
  const originalAddEventListener = EventTarget.prototype.addEventListener;

  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (suspiciousEvents.includes(type) && this) {
      try {
        emit('events', 'addEventListener', {
          type,
          target: this?.constructor?.name || this?.tagName || 'unknown'
        });
      } catch (e) { /* ignore */ }
    }
    return originalAddEventListener.call(this, type, listener, options);
  };
  EventTarget.prototype.addEventListener.toString = () => originalAddEventListener.toString();

  // ============================================
  // GLOBAL ERROR для отладки
  // ============================================

  window.addEventListener('error', (e) => {
    if (e.filename?.includes('extension://')) return; // Игнорируем свои ошибки
  });

  // ============================================
  // RECAPTCHA V3 SCORE INTERCEPTION
  // ============================================

  // Перехватываем grecaptcha.execute для получения токена
  let recaptchaIntercepted = false;

  function interceptRecaptcha() {
    if (recaptchaIntercepted) return;

    // Проверяем наличие grecaptcha
    if (typeof grecaptcha !== 'undefined' && grecaptcha.enterprise) {
      const originalExecute = grecaptcha.enterprise.execute;

      grecaptcha.enterprise.execute = function(siteKey, options) {
        emit('recaptcha', 'execute', {
          siteKey: siteKey?.slice(0, 20) + '...',
          action: options?.action
        });

        return originalExecute.apply(this, arguments).then(token => {
          // Токен содержит закодированный score, но мы не можем его декодировать
          // Отправляем событие что execute был вызван
          emit('recaptcha', 'token-received', {
            action: options?.action,
            tokenLength: token?.length
          });
          return token;
        });
      };

      recaptchaIntercepted = true;
      emit('recaptcha', 'intercepted', { type: 'enterprise' });
    } else if (typeof grecaptcha !== 'undefined' && grecaptcha.execute) {
      const originalExecute = grecaptcha.execute;

      grecaptcha.execute = function(siteKey, options) {
        emit('recaptcha', 'execute', {
          siteKey: siteKey?.slice(0, 20) + '...',
          action: options?.action
        });

        const result = originalExecute.apply(this, arguments);
        if (result && result.then) {
          return result.then(token => {
            emit('recaptcha', 'token-received', {
              action: options?.action,
              tokenLength: token?.length
            });
            return token;
          });
        }
        return result;
      };

      recaptchaIntercepted = true;
      emit('recaptcha', 'intercepted', { type: 'v3' });
    }
  }

  // Пробуем перехватить сразу и с задержкой (grecaptcha может загрузиться позже)
  interceptRecaptcha();
  setTimeout(interceptRecaptcha, 1000);
  setTimeout(interceptRecaptcha, 3000);
  setTimeout(interceptRecaptcha, 5000);

  // ============================================
  // CLOUDFLARE TURNSTILE INTERCEPTION
  // ============================================

  let turnstileIntercepted = false;

  function interceptTurnstile() {
    if (turnstileIntercepted) return;

    // Проверяем наличие turnstile
    if (typeof turnstile !== 'undefined' && turnstile.render) {
      const originalRender = turnstile.render;

      turnstile.render = function(container, options) {
        emit('turnstile', 'render', {
          siteKey: options?.sitekey?.slice(0, 20) + '...',
          action: options?.action,
          theme: options?.theme
        });

        // Перехватываем callback для получения токена
        const originalCallback = options?.callback;
        if (originalCallback) {
          options.callback = function(token) {
            emit('turnstile', 'token-received', {
              tokenLength: token?.length,
              action: options?.action
            });
            return originalCallback.apply(this, arguments);
          };
        }

        return originalRender.apply(this, arguments);
      };

      // Перехватываем execute если есть
      if (turnstile.execute) {
        const originalExecute = turnstile.execute;
        turnstile.execute = function(container, options) {
          emit('turnstile', 'execute', {
            action: options?.action
          });
          return originalExecute.apply(this, arguments);
        };
      }

      turnstileIntercepted = true;
      emit('turnstile', 'intercepted', { type: 'turnstile' });
    }
  }

  // Пробуем перехватить с задержками
  interceptTurnstile();
  setTimeout(interceptTurnstile, 1000);
  setTimeout(interceptTurnstile, 3000);
  setTimeout(interceptTurnstile, 5000);

  // A shared, throttled observer avoids running two full-page callbacks for
  // every DOM mutation while CAPTCHA libraries are loading.
  let captchaCheckTimer = null;
  const captchaObserver = new MutationObserver(() => {
    if (recaptchaIntercepted && turnstileIntercepted) {
      captchaObserver.disconnect();
      return;
    }
    if (!captchaCheckTimer) {
      captchaCheckTimer = setTimeout(() => {
        captchaCheckTimer = null;
        interceptRecaptcha();
        interceptTurnstile();
      }, 250);
    }
  });
  captchaObserver.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => captchaObserver.disconnect(), 30000);

  // Детекция Cloudflare Challenge Platform (invisible challenge)
  // Проверяем наличие cf-chl-widget или __cf_chl_tk
  function detectCloudflareChallenge() {
    const hasCfWidget = document.querySelector('[id^="cf-chl"], [class*="cf-challenge"]');
    const hasCfScript = document.querySelector('script[src*="cdn-cgi/challenge-platform"]');
    const hasCfToken = document.cookie.includes('cf_clearance') || document.cookie.includes('__cf_bm');

    if (hasCfWidget || hasCfScript) {
      emit('turnstile', 'challenge-detected', {
        type: 'cloudflare-challenge',
        hasWidget: !!hasCfWidget,
        hasScript: !!hasCfScript,
        hasClearance: hasCfToken
      });
    }
  }

  setTimeout(detectCloudflareChallenge, 1000);
  setTimeout(detectCloudflareChallenge, 5000);

  // ============================================
  // SESSION STATS (cookies, storage, network)
  // ============================================

  function collectSessionStats() {
    const stats = {
      cookiesCount: 0,
      storageCount: 0,
      warmth: 'cold',
      network: null
    };

    // document.cookie может быть недоступен в sandboxed iframes
    try {
      stats.cookiesCount = document.cookie.split(';').filter(c => c.trim()).length;
    } catch (e) {}

    try {
      stats.storageCount = localStorage.length;
    } catch (e) {}

    // Network Information API (используется Google/Apple для fingerprinting)
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      stats.network = {
        type: conn.effectiveType || conn.type || 'unknown', // 4g, 3g, wifi
        downlink: conn.downlink, // Mbps
        rtt: conn.rtt, // ms
        saveData: conn.saveData || false
      };
    }

    // Определяем "теплоту" профиля
    const totalItems = stats.cookiesCount + stats.storageCount;
    if (totalItems > 20) {
      stats.warmth = 'hot';
    } else if (totalItems > 5) {
      stats.warmth = 'warm';
    } else {
      stats.warmth = 'cold';
    }

    // Проверяем Google-специфичные cookies
    try {
      const googleCookies = ['NID', 'SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '1P_JAR', 'CONSENT'];
      const hasGoogleCookies = googleCookies.some(name =>
        document.cookie.includes(name + '=')
      );

      if (hasGoogleCookies) {
        stats.warmth = 'hot';
        stats.hasGoogleCookies = true;
      }
    } catch (e) {}

    emit('session', 'stats', stats);
  }

  // Собираем статистику только из главного фрейма (не из iframes)
  // Иначе каждый iframe будет отправлять свои stats и они будут скакать
  if (window === window.top) {
    collectSessionStats();
    // Обновляем stats периодически (cookies/storage могут меняться)
    setInterval(collectSessionStats, 5000);
  }

  // Сигнализируем что скрипт загружен
  emit('system', 'initialized', {
    version: '1.0.12',
    hooks: Object.keys(callCounts).length === 0 ? 'ready' : callCounts
  });

  // Silent init -- no console output to avoid detection by antifraud systems

})();
