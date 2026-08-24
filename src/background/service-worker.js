/**
 * Antifraud Spy - Background Service Worker
 * Обрабатывает сетевые запросы и хранит события
 */

// Хранилище событий по табам (in-memory cache)
let tabEvents = new Map();

// Флаг инициализации из storage
let initialized = false;
let initializationPromise = null;
const MAX_EVENTS_PER_TAB = 5000;
const RETAINED_EVENTS_PER_TAB = 4000;
const MAX_REQUESTS_PER_TAB = 2000;
const RETAINED_REQUESTS_PER_TAB = 1500;
const MAX_PERSISTED_TABS = 10;
const PERSISTED_EVENTS_PER_TAB = 1000;
const PERSISTED_REQUESTS_PER_TAB = 500;
const POPUP_FLUSH_INTERVAL_MS = 250;
const MAX_POPUP_BATCH_SIZE = 500;
const pendingPopupEvents = new Map();
let popupFlushTimer = null;

function mergeCounts(base = {}, additions = {}) {
  const merged = { ...base };
  for (const [key, count] of Object.entries(additions)) {
    merged[key] = (merged[key] || 0) + count;
  }
  return merged;
}

function deriveEventAggregates(events) {
  const categoryCounts = {};
  const methodCounts = {};
  const methodSamples = {};

  for (const event of events) {
    const count = event.batchCount || 1;
    const methodKey = `${event.category}.${event.method}`;
    categoryCounts[event.category] = (categoryCounts[event.category] || 0) + count;
    methodCounts[methodKey] = (methodCounts[methodKey] || 0) + count;
    if (!(methodKey in methodSamples)) methodSamples[methodKey] = event.details || {};
  }

  return { categoryCounts, methodCounts, methodSamples };
}

/**
 * Загрузка событий из storage при старте
 */
async function initFromStorage() {
  if (initialized) return;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    try {
      const result = await chrome.storage.session.get('tabEvents');
      if (result.tabEvents) {
        const restoredEvents = new Map(Object.entries(result.tabEvents));

        for (const [key, data] of restoredEvents) {
          data.events = Array.isArray(data.events)
            ? data.events.slice(-RETAINED_EVENTS_PER_TAB)
            : [];
          data.requests = Array.isArray(data.requests)
            ? data.requests.slice(-RETAINED_REQUESTS_PER_TAB)
            : [];
          data.eventCount = Number.isFinite(data.eventCount)
            ? data.eventCount
            : data.events.reduce((total, event) => total + (event.batchCount || 1), 0);
          data.requestCount = Number.isFinite(data.requestCount)
            ? data.requestCount
            : data.requests.length;
          data.antifraudCount = Number.isFinite(data.antifraudCount)
            ? data.antifraudCount
            : data.events.reduce((total, event) => total + (
              event.details?.isAntifraud || ['canvas', 'webgl', 'audio'].includes(event.category)
                ? (event.batchCount || 1)
                : 0
            ), 0);
          data.antifraudRequestCount = Number.isFinite(data.antifraudRequestCount)
            ? data.antifraudRequestCount
            : data.requests.filter(request => request.isAntifraud).length;
          const derived = deriveEventAggregates(data.events);
          data.categoryCounts = data.categoryCounts || derived.categoryCounts;
          data.methodCounts = data.methodCounts || derived.methodCounts;
          data.methodSamples = data.methodSamples || derived.methodSamples;

          const current = tabEvents.get(key);
          if (current) {
            data.events = [...data.events, ...current.events].slice(-RETAINED_EVENTS_PER_TAB);
            data.requests = [...data.requests, ...current.requests].slice(-RETAINED_REQUESTS_PER_TAB);
            data.eventCount += current.eventCount;
            data.requestCount += current.requestCount;
            data.antifraudCount += current.antifraudCount;
            data.antifraudRequestCount += current.antifraudRequestCount;
            data.categoryCounts = mergeCounts(data.categoryCounts, current.categoryCounts);
            data.methodCounts = mergeCounts(data.methodCounts, current.methodCounts);
            data.methodSamples = { ...data.methodSamples, ...current.methodSamples };
            data.sessionStats = { ...data.sessionStats, ...current.sessionStats };
            data.url = current.url || data.url;
          }
        }

        for (const [key, data] of tabEvents) {
          if (!restoredEvents.has(key)) restoredEvents.set(key, data);
        }

        tabEvents = restoredEvents;
        console.log('[Antifraud Spy] Restored events from storage:', tabEvents.size, 'tabs');
      }
    } catch (e) {
      console.warn('[Antifraud Spy] Failed to restore from storage:', e);
    } finally {
      initialized = true;
    }
  })();

  return initializationPromise;
}

/**
 * Сохранение событий в storage
 */
async function saveToStorage() {
  saveTimeout = null;
  await initFromStorage();
  try {
    const recentTabs = [...tabEvents.entries()]
      .sort((a, b) => (b[1].lastUpdated || 0) - (a[1].lastUpdated || 0))
      .slice(0, MAX_PERSISTED_TABS);
    const obj = Object.fromEntries(recentTabs.map(([key, data]) => [key, {
      ...data,
      events: data.events.slice(-PERSISTED_EVENTS_PER_TAB),
      requests: data.requests.slice(-PERSISTED_REQUESTS_PER_TAB)
    }]));
    await chrome.storage.session.set({ tabEvents: obj });
  } catch (e) {
    console.warn('[Antifraud Spy] Failed to save to storage:', e);
  }
}

// Throttle persistence so a busy page cannot postpone it forever or force
// repeated serialization of the entire session state.
let saveTimeout = null;
function debouncedSave() {
  if (!saveTimeout) {
    saveTimeout = setTimeout(saveToStorage, 5000);
  }
}

function sendPopupBatch(tabId, events) {
  const data = getTabData(tabId);
  chrome.runtime.sendMessage({
    action: 'new-events',
    tabId,
    events,
    eventCount: data.eventCount,
    requestCount: data.requestCount,
    antifraudCount: data.antifraudCount,
    antifraudRequestCount: data.antifraudRequestCount,
    categoryCounts: data.categoryCounts,
    methodCounts: data.methodCounts,
    methodSamples: data.methodSamples
  }).catch(() => {});
}

function flushPopupEvents() {
  if (popupFlushTimer) {
    clearTimeout(popupFlushTimer);
    popupFlushTimer = null;
  }

  for (const [tabKey, events] of pendingPopupEvents) {
    sendPopupBatch(Number(tabKey), events);
  }
  pendingPopupEvents.clear();
}

function queuePopupEvents(tabId, events) {
  if (!events.length) return;
  const key = String(tabId);
  const queued = pendingPopupEvents.get(key) || [];
  queued.push(...events);

  while (queued.length >= MAX_POPUP_BATCH_SIZE) {
    sendPopupBatch(tabId, queued.splice(0, MAX_POPUP_BATCH_SIZE));
  }

  if (queued.length > 0) pendingPopupEvents.set(key, queued);
  else pendingPopupEvents.delete(key);

  if (pendingPopupEvents.size > 0 && !popupFlushTimer) {
    popupFlushTimer = setTimeout(flushPopupEvents, POPUP_FLUSH_INTERVAL_MS);
  }
}

// Инициализируем при старте
initFromStorage();

// Известные antifraud/analytics эндпоинты
const ANTIFRAUD_PATTERNS = [
  // Apple
  /appleid\.cdn-apple\.com/i,
  /idmsa\.apple\.com/i,
  /setup\.icloud\.com/i,
  /gsa\.apple\.com/i,

  // Google
  /accounts\.google\.com.*\/\_\/.*Ident/i,
  /play\.google\.com.*\/log/i,
  /www\.google\.com\/recaptcha/i,
  /arkresolve/i,

  // Generic antifraud
  /fingerprint/i,
  /fp\.js/i,
  /collector/i,
  /beacon/i,
  /telemetry/i,
  /analytics/i,
  /tracking/i,
  /deviceid/i,
  /fraud/i,
  /risk/i,
  /captcha/i,
  /challenge/i,

  // Known fingerprinting services
  /fingerprintjs/i,
  /fpjs\.io/i,
  /datadome/i,
  /perimeterx/i,
  /akamai.*sensor/i,
  /kasada/i,
  /cloudflare.*challenge/i,
  /hcaptcha/i,
  /funcaptcha/i,
  /arkose/i
];

// Подозрительные заголовки
const SUSPICIOUS_HEADERS = [
  'x-fingerprint',
  'x-device-id',
  'x-client-data',
  'x-requested-with',
  'x-apple-i-fd',
  'x-apple-i-client',
  'sec-ch-ua',
  'sec-ch-ua-platform',
  'sec-ch-ua-mobile',
  'sec-ch-ua-full-version',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-model'
];

/**
 * Получение событий таба
 */
function getTabData(tabId) {
  // tabId из storage может быть строкой, нормализуем
  const key = String(tabId);

  if (!tabEvents.has(key)) {
    tabEvents.set(key, {
      events: [],
      requests: [],
      eventCount: 0,
      requestCount: 0,
      antifraudCount: 0,
      antifraudRequestCount: 0,
      categoryCounts: {},
      methodCounts: {},
      methodSamples: {},
      startTime: Date.now(),
      lastUpdated: Date.now(),
      url: '',
      recaptchaScore: null,
      sessionStats: {
        cookiesCount: 0,
        storageCount: 0,
        warmth: 'cold'
      }
    });
  }
  return tabEvents.get(key);
}

/**
 * Обновление reCAPTCHA score
 */
function updateRecaptchaScore(tabId, score) {
  const data = getTabData(tabId);
  data.recaptchaScore = score;
  data.lastUpdated = Date.now();
  debouncedSave();

  // Уведомляем popup
  chrome.runtime.sendMessage({
    action: 'recaptcha-score',
    tabId,
    score
  }).catch(() => {});
}

/**
 * Обновление session stats
 */
function updateSessionStats(tabId, stats) {
  const data = getTabData(tabId);
  data.sessionStats = { ...data.sessionStats, ...stats };
  data.lastUpdated = Date.now();
  debouncedSave();

  // Уведомляем popup
  chrome.runtime.sendMessage({
    action: 'session-stats',
    tabId,
    stats: data.sessionStats
  }).catch(() => {});
}

/**
 * Добавление события
 */
function addEvent(tabId, event, notify = true) {
  const data = getTabData(tabId);
  data.lastUpdated = Date.now();
  const eventIncrement = Number.isSafeInteger(event.batchCount) && event.batchCount > 0
    ? event.batchCount
    : 1;
  data.eventCount += eventIncrement;
  if (event.details?.isAntifraud || ['canvas', 'webgl', 'audio'].includes(event.category)) {
    data.antifraudCount += eventIncrement;
  }
  const methodKey = `${event.category}.${event.method}`;
  data.categoryCounts[event.category] = (data.categoryCounts[event.category] || 0) + eventIncrement;
  data.methodCounts[methodKey] = (data.methodCounts[methodKey] || 0) + eventIncrement;
  if (!(methodKey in data.methodSamples)) data.methodSamples[methodKey] = event.details || {};
  const storedEvent = {
    ...event,
    id: data.eventCount
  };
  data.events.push(storedEvent);

  // Ограничиваем количество событий (память)
  if (data.events.length > MAX_EVENTS_PER_TAB) {
    data.events = data.events.slice(-RETAINED_EVENTS_PER_TAB);
  }

  // Сохраняем в storage (с debounce)
  debouncedSave();

  // Уведомляем popup если открыт
  if (notify) {
    queuePopupEvents(tabId, [storedEvent]);
  }

  return storedEvent;
}

function addEvents(tabId, events) {
  if (!Array.isArray(events) || events.length === 0) return;

  const storedEvents = events.map(event => addEvent(tabId, event, false));
  queuePopupEvents(tabId, storedEvents);
}

/**
 * Проверка URL на antifraud patterns
 */
function isAntifraudUrl(url) {
  return ANTIFRAUD_PATTERNS.some(pattern => pattern.test(url));
}

/**
 * Анализ заголовков запроса
 */
function analyzeHeaders(headers) {
  const found = [];
  for (const header of headers || []) {
    const name = header.name.toLowerCase();
    if (SUSPICIOUS_HEADERS.some(h => name.includes(h.toLowerCase()))) {
      found.push({
        name: header.name,
        value: header.value?.slice(0, 200) // Обрезаем длинные значения
      });
    }
  }
  return found;
}

// ============================================
// NETWORK MONITORING
// ============================================

// Мониторинг всех запросов
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return; // Игнорируем служебные запросы

    const isAntifraud = isAntifraudUrl(details.url);

    // Логируем только интересные запросы
    if (isAntifraud || details.type === 'xmlhttprequest' || details.type === 'beacon') {
      const data = getTabData(details.tabId);
      const request = {
        id: details.requestId,
        url: details.url,
        method: details.method,
        type: details.type,
        timestamp: details.timeStamp,
        isAntifraud,
        initiator: details.initiator
      };

      // Если есть body (POST данные)
      if (details.requestBody) {
        if (details.requestBody.formData) {
          request.formData = Object.keys(details.requestBody.formData);
        }
        if (details.requestBody.raw) {
          request.bodySize = details.requestBody.raw.reduce((acc, r) => acc + (r.bytes?.byteLength || 0), 0);
        }
      }

      data.requests.push(request);
      data.lastUpdated = Date.now();
      data.requestCount += 1;
      if (isAntifraud) data.antifraudRequestCount += 1;
      if (data.requests.length > MAX_REQUESTS_PER_TAB) {
        data.requests = data.requests.slice(-RETAINED_REQUESTS_PER_TAB);
      }

      // Отправляем событие
      addEvent(details.tabId, {
        category: 'network',
        method: isAntifraud ? 'antifraud-request' : 'request',
        details: {
          url: details.url.slice(0, 150),
          method: details.method,
          type: details.type,
          isAntifraud
        },
        timestamp: details.timeStamp
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

// Мониторинг заголовков
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const suspiciousHeaders = analyzeHeaders(details.requestHeaders);
    if (suspiciousHeaders.length > 0) {
      addEvent(details.tabId, {
        category: 'network',
        method: 'suspicious-headers',
        details: {
          url: details.url.slice(0, 100),
          headers: suspiciousHeaders
        },
        timestamp: details.timeStamp
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

// Мониторинг ответов (для анализа cookies)
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const setCookies = details.responseHeaders?.filter(
      h => h.name.toLowerCase() === 'set-cookie'
    );

    if (setCookies?.length > 0) {
      // Ищем подозрительные cookies (fingerprint, tracking)
      const suspicious = setCookies.filter(c =>
        /fingerprint|fp_|_ga|_gid|tracking|device|session/i.test(c.value)
      );

      if (suspicious.length > 0) {
        addEvent(details.tabId, {
          category: 'cookies',
          method: 'set-cookie',
          details: {
            url: details.url.slice(0, 100),
            cookies: suspicious.map(c => c.value.split(';')[0].slice(0, 100))
          },
          timestamp: details.timeStamp
        });
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ============================================
// MESSAGE HANDLING
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.action) {
    case 'log-event':
      if (tabId) {
        addEvent(tabId, message.data);
        // Если это session stats событие - обновляем sessionStats
        if (message.data?.category === 'session' && message.data?.method === 'stats') {
          updateSessionStats(tabId, message.data.details);
        }
      }
      break;

    case 'log-events':
      if (tabId && Array.isArray(message.events)) {
        addEvents(tabId, message.events);

        const latestStats = message.events.findLast?.(event =>
          event?.category === 'session' && event?.method === 'stats'
        ) || [...message.events].reverse().find(event =>
          event?.category === 'session' && event?.method === 'stats'
        );
        if (latestStats) {
          updateSessionStats(tabId, latestStats.details);
        }
      }
      break;

    case 'get-events':
      // Убедимся что storage инициализирован
      initFromStorage().then(() => {
        const data = getTabData(message.tabId);
        sendResponse({
          events: data.events,
          requests: data.requests,
          eventCount: data.eventCount,
          requestCount: data.requestCount,
          antifraudCount: data.antifraudCount,
          antifraudRequestCount: data.antifraudRequestCount,
          categoryCounts: data.categoryCounts,
          methodCounts: data.methodCounts,
          methodSamples: data.methodSamples,
          startTime: data.startTime,
          recaptchaScore: data.recaptchaScore,
          sessionStats: data.sessionStats
        });
      });
      return true;

    case 'update-session-stats':
      if (tabId) {
        updateSessionStats(tabId, message.stats);
      }
      break;

    case 'recaptcha-detected':
      if (tabId && message.score !== undefined) {
        updateRecaptchaScore(tabId, message.score);
        addEvent(tabId, {
          category: 'recaptcha',
          method: 'score',
          details: {
            score: message.score,
            action: message.action || 'unknown'
          },
          timestamp: Date.now()
        });
      }
      break;

    case 'clear-events':
      if (message.tabId) {
        tabEvents.delete(String(message.tabId));
        pendingPopupEvents.delete(String(message.tabId));
        debouncedSave();
      }
      sendResponse({ success: true });
      return true;

    case 'export-data': {
      const exportTabId = message.tabId;
      const exportData = getTabData(exportTabId);
      sendResponse({
        events: exportData.events,
        requests: exportData.requests,
        eventCount: exportData.eventCount,
        requestCount: exportData.requestCount,
        antifraudCount: exportData.antifraudCount,
        antifraudRequestCount: exportData.antifraudRequestCount,
        categoryCounts: exportData.categoryCounts,
        methodCounts: exportData.methodCounts,
        methodSamples: exportData.methodSamples,
        startTime: exportData.startTime,
        exportTime: Date.now()
      });
      return true;
    }
  }
});

// ============================================
// TAB MANAGEMENT
// ============================================

// Очистка при закрытии таба
chrome.tabs.onRemoved.addListener((tabId) => {
  tabEvents.delete(String(tabId));
  pendingPopupEvents.delete(String(tabId));
  debouncedSave();
});

// Обновление URL при навигации
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const data = getTabData(tabId);
    data.url = changeInfo.url;
    data.lastUpdated = Date.now();
  }
});

// ============================================
// KEEP ALIVE (V3 Service Worker)
// ============================================

// Предотвращаем засыпание service worker
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Просто пинг чтобы worker не засыпал
  }
});

console.log('[Antifraud Spy] Background service worker started');
