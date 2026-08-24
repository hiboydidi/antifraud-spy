/**
 * Antifraud Spy - Popup UI
 */

(function() {
  'use strict';

  // State
  let currentTabId = null;
  let events = [];
  let requests = [];
  let totalEventCount = 0;
  let totalRequestCount = 0;
  let totalAntifraudCount = 0;
  let totalAntifraudRequestCount = 0;
  let categoryCounts = {};
  let methodCounts = {};
  let methodSamples = {};
  let startTime = Date.now();
  let isPaused = false;
  let currentFilter = 'all';
  let currentTab = 'log';

  // DOM elements
  const logEl = document.getElementById('log');
  const statEvents = document.getElementById('stat-events');
  const statRequests = document.getElementById('stat-requests');
  const statAntifraud = document.getElementById('stat-antifraud');
  const statDuration = document.getElementById('stat-duration');
  const btnClear = document.getElementById('btn-clear');
  const btnPause = document.getElementById('btn-pause');
  const btnExportJson = document.getElementById('btn-export-json');
  const btnExportMd = document.getElementById('btn-export-md');
  const filterButtons = document.querySelectorAll('.filter');
  const tabButtons = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  const currentDomainEl = document.getElementById('current-domain');
  const metricsSummaryEl = document.getElementById('metrics-summary');
  const metricsGridEl = document.getElementById('metrics-grid');
  const riskScoreEl = document.getElementById('risk-score');
  const riskCircleEl = document.getElementById('risk-circle');
  const riskLevelEl = document.getElementById('risk-level');
  const riskFactorsEl = document.getElementById('risk-factors');
  const recaptchaScoreEl = document.getElementById('recaptcha-score');
  const cloudflareStatusEl = document.getElementById('cloudflare-status');
  const cookiesCountEl = document.getElementById('cookies-count');
  const storageCountEl = document.getElementById('storage-count');
  const networkInfoEl = document.getElementById('network-info');
  const profileWarmthEl = document.getElementById('profile-warmth');

  // Category icons
  const CATEGORY_ICONS = {
    canvas: '🎨',
    webgl: '🔲',
    audio: '🔊',
    navigator: '🧭',
    screen: '🖥️',
    network: '🌐',
    storage: '💾',
    cookies: '🍪',
    fonts: '🔤',
    timezone: '🕐',
    performance: '⚡',
    webrtc: '📡',
    plugins: '🔌',
    events: '👆',
    dom: '📦',
    system: '⚙️',
    media: '📷',
    permissions: '🔐',
    recaptcha: '🤖',
    turnstile: '☁️',
    session: '📊'
  };

  // All possible metrics that can be collected
  const ALL_METRICS = {
    canvas: {
      icon: '🎨',
      name: 'Canvas',
      methods: ['toDataURL', 'toBlob', 'getImageData', 'fillText', 'strokeText', 'measureText'],
      weight: 25,
      tooltip: 'Canvas fingerprinting - уникальный "отпечаток" рендеринга графики.\ntoDataURL/toBlob: экспорт изображения\ngetImageData: чтение пикселей\nfillText/strokeText: рендеринг текста (шрифты)\nmeasureText: измерение текста\n⚠️ Высокая уникальность!'
    },
    webgl: {
      icon: '🔲',
      name: 'WebGL',
      methods: ['getParameter', 'getExtension', 'getSupportedExtensions', 'getShaderPrecisionFormat', 'readPixels'],
      weight: 20,
      tooltip: 'WebGL fingerprinting - информация о GPU.\ngetParameter: модель GPU, vendor\ngetExtension: поддерживаемые расширения\ngetShaderPrecisionFormat: точность шейдеров\nreadPixels: чтение рендера\n⚠️ Выдаёт GPU = легко связать устройства!'
    },
    audio: {
      icon: '🔊',
      name: 'Audio',
      methods: ['new AudioContext', 'new OfflineAudioContext', 'createOscillator', 'createDynamicsCompressor', 'createAnalyser', 'createGain', 'createScriptProcessor'],
      weight: 15,
      tooltip: 'Audio fingerprinting - обработка аудио уникальна для каждого устройства.\nAudioContext: создание аудио контекста\nOfflineAudioContext: оффлайн обработка\ncreateOscillator: генератор тона\ncreateDynamicsCompressor: компрессия\n⚠️ Сложно подделать!'
    },
    navigator: {
      icon: '🧭',
      name: 'Navigator',
      methods: ['userAgent', 'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'vendor', 'webdriver', 'pdfViewerEnabled'],
      weight: 10,
      tooltip: 'Navigator - базовая информация о браузере.\nuserAgent: строка браузера\nplatform: ОС\nlanguage/languages: язык\nhardwareConcurrency: кол-во CPU ядер\ndeviceMemory: RAM в GB\nmaxTouchPoints: сенсорный экран\nwebdriver: автоматизация'
    },
    screen: {
      icon: '🖥️',
      name: 'Screen',
      methods: ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth', 'orientation'],
      weight: 5,
      tooltip: 'Screen - параметры экрана.\nwidth/height: разрешение\navailWidth/availHeight: без панели задач\ncolorDepth: глубина цвета\norientation: ориентация\n📌 Низкая уникальность'
    },
    fonts: {
      icon: '🔤',
      name: 'Fonts',
      methods: ['new FontFace', 'check'],
      weight: 10,
      tooltip: 'Font fingerprinting - список установленных шрифтов.\nnew FontFace: создание шрифта\ncheck: проверка наличия шрифта\n⚠️ Уникальный набор шрифтов = уникальный отпечаток'
    },
    webrtc: {
      icon: '📡',
      name: 'WebRTC',
      methods: ['new RTCPeerConnection', 'createDataChannel', 'createOffer', 'setLocalDescription'],
      weight: 15,
      tooltip: 'WebRTC - peer-to-peer коммуникация.\nRTCPeerConnection: создание соединения\ncreateOffer/setLocalDescription: получение IP\n⚠️ Может выдать реальный IP даже через VPN!'
    },
    storage: {
      icon: '💾',
      name: 'Storage',
      methods: ['getItem', 'setItem', 'open'],
      weight: 5,
      tooltip: 'Storage - локальное хранилище.\ngetItem/setItem: localStorage\nopen: IndexedDB\n📌 Используется для tracking cookies'
    },
    timezone: {
      icon: '🕐',
      name: 'Timezone',
      methods: ['getTimezoneOffset', 'resolvedOptions'],
      weight: 5,
      tooltip: 'Timezone - часовой пояс.\ngetTimezoneOffset: смещение от UTC\nresolvedOptions: Intl форматирование\n📌 Должен совпадать с IP-локацией!'
    },
    plugins: {
      icon: '🔌',
      name: 'Plugins',
      methods: ['navigator.plugins', 'navigator.mimeTypes'],
      weight: 5,
      tooltip: 'Plugins - расширения браузера.\nnavigator.plugins: список плагинов\nnavigator.mimeTypes: поддерживаемые типы\n📌 Редко используется в современных браузерах'
    },
    events: {
      icon: '👆',
      name: 'Events',
      methods: ['addEventListener'],
      weight: 10,
      tooltip: 'Events - слушатели событий.\naddEventListener: отслеживание действий\n📌 Используется для behavioral fingerprinting\n(движения мыши, клики, прокрутка)'
    },
    media: {
      icon: '📷',
      name: 'Media',
      methods: ['enumerateDevices', 'getUserMedia'],
      weight: 10,
      tooltip: 'Media Devices - камера и микрофон.\nenumerateDevices: список устройств\ngetUserMedia: запрос доступа\n⚠️ Выдаёт уникальные ID устройств!'
    },
    permissions: {
      icon: '🔐',
      name: 'Permissions',
      methods: ['query'],
      weight: 5,
      tooltip: 'Permissions API - проверка разрешений.\nquery: статус разрешения\n📌 Геолокация, камера, уведомления и др.'
    }
  };

  /**
   * Initialize
   */
  async function init() {
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab.id;

    // Update domain display
    try {
      const url = new URL(tab.url);
      currentDomainEl.textContent = url.hostname;
    } catch {
      currentDomainEl.textContent = tab.url?.slice(0, 50) || '-';
    }

    // Load existing events
    await loadEvents();

    // Setup listeners
    setupListeners();

    // Start duration timer
    updateDuration();
    setInterval(updateDuration, 1000);

    // Initial render of metrics and risk
    renderMetrics();
    calculateRiskScore();
  }

  /**
   * Load events from background
   */
  async function loadEvents() {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'get-events',
        tabId: currentTabId
      });

      if (response) {
        events = response.events || [];
        requests = response.requests || [];
        totalEventCount = response.eventCount ?? events.reduce(
          (total, event) => total + (event.batchCount || 1), 0
        );
        totalRequestCount = response.requestCount ?? requests.length;
        totalAntifraudCount = response.antifraudCount ?? countAntifraudEvents(events);
        totalAntifraudRequestCount = response.antifraudRequestCount ??
          requests.filter(request => request.isAntifraud).length;
        categoryCounts = response.categoryCounts || {};
        methodCounts = response.methodCounts || {};
        methodSamples = response.methodSamples || {};
        startTime = response.startTime || Date.now();
        renderLog();
        updateStats();
        updateSessionStats(response.sessionStats);
        updateRecaptchaScore(response.recaptchaScore);
        updateCloudflareStatus();
      }
    } catch (e) {
      console.error('Failed to load events:', e);
    }
  }

  /**
   * Update session stats display
   */
  function updateSessionStats(stats) {
    if (!stats) {
      // Try to get from events
      const sessionEvent = events.find(e => e.category === 'session' && e.method === 'stats');
      if (sessionEvent) {
        stats = sessionEvent.details;
      }
    }

    if (!stats) return;

    cookiesCountEl.textContent = stats.cookiesCount || 0;
    cookiesCountEl.className = 'session-stat-value ' +
      (stats.cookiesCount > 10 ? 'good' : stats.cookiesCount > 0 ? 'warning' : 'bad');

    storageCountEl.textContent = stats.storageCount || 0;
    storageCountEl.className = 'session-stat-value ' +
      (stats.storageCount > 10 ? 'good' : stats.storageCount > 0 ? 'warning' : 'bad');

    // Network info
    if (stats.network) {
      const rtt = stats.network.rtt ? `${stats.network.rtt}ms` : '';
      networkInfoEl.textContent = `${stats.network.type}${rtt ? ' ' + rtt : ''}`;
      // 4g/wifi = good, 3g = warning, 2g/slow = bad
      const netType = stats.network.type?.toLowerCase() || '';
      if (netType === '4g' || netType === 'wifi' || netType === 'ethernet') {
        networkInfoEl.className = 'session-stat-value good';
      } else if (netType === '3g') {
        networkInfoEl.className = 'session-stat-value warning';
      } else {
        networkInfoEl.className = 'session-stat-value bad';
      }
    } else {
      networkInfoEl.textContent = 'N/A';
      networkInfoEl.className = 'session-stat-value';
    }

    const warmthLabels = { hot: '🔥 Hot', warm: '🌡️ Warm', cold: '❄️ Cold' };
    const warmthClasses = { hot: 'good', warm: 'warning', cold: 'bad' };
    profileWarmthEl.textContent = warmthLabels[stats.warmth] || '❄️ Cold';
    profileWarmthEl.className = 'session-stat-value ' + (warmthClasses[stats.warmth] || 'bad');
  }

  /**
   * Update reCAPTCHA status display
   * Note: Score is NOT available client-side - only server gets it from Google API
   */
  function updateRecaptchaScore(score) {
    // Check reCAPTCHA events for status
    const interceptedEvent = events.find(e => e.category === 'recaptcha' && e.method === 'intercepted');
    const executeEvent = events.find(e => e.category === 'recaptcha' && e.method === 'execute');
    const tokenEvent = events.find(e => e.category === 'recaptcha' && e.method === 'token-received');

    if (tokenEvent) {
      // Token received - reCAPTCHA was executed
      const action = tokenEvent.details?.action || executeEvent?.details?.action || '?';
      recaptchaScoreEl.textContent = `Token OK`;
      recaptchaScoreEl.title = `Action: ${action}`;
      recaptchaScoreEl.className = 'session-stat-value good';
    } else if (executeEvent) {
      // Execute called but waiting for token
      recaptchaScoreEl.textContent = 'Active';
      recaptchaScoreEl.className = 'session-stat-value warning';
    } else if (interceptedEvent) {
      // Intercepted but not executed yet
      const type = interceptedEvent.details?.type || 'v3';
      recaptchaScoreEl.textContent = type.toUpperCase();
      recaptchaScoreEl.title = 'reCAPTCHA intercepted, waiting for execute';
      recaptchaScoreEl.className = 'session-stat-value';
    } else {
      recaptchaScoreEl.textContent = '--';
      recaptchaScoreEl.className = 'session-stat-value';
    }
  }

  /**
   * Update Cloudflare status display
   */
  function updateCloudflareStatus() {
    // Check turnstile events
    const challengeEvent = events.find(e => e.category === 'turnstile' && e.method === 'challenge-detected');
    const interceptedEvent = events.find(e => e.category === 'turnstile' && e.method === 'intercepted');
    const renderEvent = events.find(e => e.category === 'turnstile' && e.method === 'render');
    const tokenEvent = events.find(e => e.category === 'turnstile' && e.method === 'token-received');

    // Also check network requests for Cloudflare Challenge Platform
    const hasCfChallenge = events.some(e =>
      e.category === 'network' &&
      e.details?.url?.includes('cdn-cgi/challenge-platform')
    );

    if (tokenEvent) {
      cloudflareStatusEl.textContent = 'Token OK';
      cloudflareStatusEl.className = 'session-stat-value good';
      cloudflareStatusEl.title = 'Cloudflare token получен';
    } else if (renderEvent || interceptedEvent) {
      cloudflareStatusEl.textContent = 'Turnstile';
      cloudflareStatusEl.className = 'session-stat-value warning';
      cloudflareStatusEl.title = 'Turnstile виджет обнаружен';
    } else if (challengeEvent || hasCfChallenge) {
      cloudflareStatusEl.textContent = 'CF';
      cloudflareStatusEl.className = 'session-stat-value warning';
      cloudflareStatusEl.title = 'Cloudflare Challenge Platform (invisible)';
    } else {
      cloudflareStatusEl.textContent = '--';
      cloudflareStatusEl.className = 'session-stat-value';
    }
  }

  /**
   * Setup event listeners
   */
  function setupListeners() {
    // Listen for new events from background
    chrome.runtime.onMessage.addListener((message) => {
      if (message.tabId !== currentTabId) return;

      if ((message.action === 'new-event' || message.action === 'new-events') && !isPaused) {
        const incomingEvents = message.action === 'new-events'
          ? (message.events || [])
          : [message.event];
        if (incomingEvents.length === 0) return;

        events.push(...incomingEvents);
        if (events.length > 5000) events = events.slice(-4000);
        totalEventCount = message.eventCount ?? (
          totalEventCount + incomingEvents.reduce(
            (total, event) => total + (event.batchCount || 1), 0
          )
        );
        totalRequestCount = message.requestCount ?? totalRequestCount;
        totalAntifraudCount = message.antifraudCount ?? (
          totalAntifraudCount + countAntifraudEvents(incomingEvents)
        );
        totalAntifraudRequestCount = message.antifraudRequestCount ?? totalAntifraudRequestCount;
        categoryCounts = message.categoryCounts || categoryCounts;
        methodCounts = message.methodCounts || methodCounts;
        methodSamples = message.methodSamples || methodSamples;

        if (logEl.querySelector('.empty-state')) logEl.innerHTML = '';
        const fragment = document.createDocumentFragment();
        incomingEvents
          .filter(event => currentFilter === 'all' || event.category === currentFilter)
          .forEach(event => renderLogEntry(event, fragment));
        logEl.appendChild(fragment);
        while (logEl.children.length > 500) logEl.firstElementChild.remove();

        updateStats();
        scrollToBottom();

        // Update session stats if it's a session event
        const sessionEvent = [...incomingEvents].reverse().find(event =>
          event.category === 'session' && event.method === 'stats'
        );
        if (sessionEvent) {
          updateSessionStats(sessionEvent.details);
        }

        // Update Cloudflare status on turnstile/network events
        if (incomingEvents.some(event => event.category === 'turnstile' ||
            (event.category === 'network' && event.details?.url?.includes('cdn-cgi/challenge-platform')))) {
          updateCloudflareStatus();
        }

        // Update metrics/risk if on those tabs
        if (currentTab === 'metrics') {
          renderMetrics();
        } else if (currentTab === 'risk') {
          calculateRiskScore();
        }
      }

      if (message.action === 'recaptcha-score') {
        updateRecaptchaScore(message.score);
      }

      if (message.action === 'session-stats') {
        updateSessionStats(message.stats);
      }
    });

    // Clear button
    btnClear.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        action: 'clear-events',
        tabId: currentTabId
      });
      events = [];
      requests = [];
      totalEventCount = 0;
      totalRequestCount = 0;
      totalAntifraudCount = 0;
      totalAntifraudRequestCount = 0;
      categoryCounts = {};
      methodCounts = {};
      methodSamples = {};
      startTime = Date.now();
      renderLog();
      updateStats();
      renderMetrics();
      calculateRiskScore();
    });

    // Pause button
    btnPause.addEventListener('click', async () => {
      isPaused = !isPaused;
      btnPause.textContent = isPaused ? '▶️' : '⏸️';
      document.querySelector('.container').classList.toggle('paused', isPaused);
      if (!isPaused) {
        await loadEvents();
        renderMetrics();
        calculateRiskScore();
      }
    });

    // Filters
    filterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        filterButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        renderLog();
      });
    });

    // Export buttons
    btnExportJson.addEventListener('click', () => exportData('json'));
    btnExportMd.addEventListener('click', () => exportData('markdown'));

    // Tab switching
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabName = btn.dataset.tab;
        switchTab(tabName);
      });
    });
  }

  /**
   * Switch between tabs
   */
  function switchTab(tabName) {
    currentTab = tabName;

    // Update tab buttons
    tabButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Update tab contents
    tabContents.forEach(content => {
      content.classList.toggle('active', content.id === `tab-${tabName}`);
    });

    // Refresh data for metrics/risk tabs
    if (tabName === 'metrics') {
      renderMetrics();
    } else if (tabName === 'risk') {
      calculateRiskScore();
    }
  }

  /**
   * Render metrics grid
   */
  function renderMetrics() {
    const collectedMethods = getCollectedMethods();
    metricsGridEl.innerHTML = '';

    // Calculate totals
    let totalMethods = 0;
    let totalCollected = 0;

    for (const [category, config] of Object.entries(ALL_METRICS)) {
      const categoryEl = document.createElement('div');
      categoryEl.className = 'metric-category';

      const collectedInCategory = config.methods.filter(m => collectedMethods.has(`${category}.${m}`));
      totalMethods += config.methods.length;
      totalCollected += collectedInCategory.length;

      categoryEl.innerHTML = `
        <div class="metric-category-header" title="${config.tooltip || ''}">
          <span class="metric-category-icon">${config.icon}</span>
          <span class="metric-category-name">${config.name}</span>
          <span class="metric-category-count">${collectedInCategory.length}/${config.methods.length}</span>
        </div>
        <div class="metric-items">
          ${config.methods.map(method => {
            const isCollected = collectedMethods.has(`${category}.${method}`);
            const value = collectedMethods.get(`${category}.${method}`);
            return `
              <div class="metric-item ${isCollected ? 'collected' : ''}">
                <span class="metric-checkbox ${isCollected ? 'checked' : ''}"></span>
                <span class="metric-name">${method}</span>
                ${value ? `<span class="metric-value" title="${value}">${value}</span>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;

      metricsGridEl.appendChild(categoryEl);
    }

    // Update summary
    const percent = totalMethods > 0 ? Math.round((totalCollected / totalMethods) * 100) : 0;
    metricsSummaryEl.innerHTML = `
      <div title="Количество обнаруженных методов fingerprinting из всех возможных">
        <span class="metrics-summary-count">${totalCollected}</span>
        <span class="metrics-summary-label">/ ${totalMethods} collected</span>
      </div>
      <div class="metrics-summary-bar" title="Прогресс сбора fingerprint данных сайтом">
        <div class="metrics-summary-fill" style="width: ${percent}%"></div>
      </div>
      <span class="metrics-summary-count" title="Процент собранных данных">${percent}%</span>
    `;
  }

  /**
   * Get collected methods with their values
   */
  function getCollectedMethods() {
    const methods = new Map();

    for (const key of Object.keys(methodCounts)) {
      const details = methodSamples[key] || {};
      let value = '';
      if (details.value !== undefined) {
        value = String(details.value).slice(0, 30);
      } else if (details.hash !== undefined) {
        value = 'collected';
      } else if (details.parameter !== undefined) {
        value = details.parameter;
      }
      methods.set(key, value || 'called');
    }

    events.forEach(event => {
      const key = `${event.category}.${event.method}`;
      if (!methods.has(key)) {
        // Store first captured value
        let value = '';
        if (event.details) {
          if (event.details.value !== undefined) {
            value = String(event.details.value).slice(0, 30);
          } else if (event.details.hash !== undefined) {
            value = 'collected';
          } else if (event.details.parameter !== undefined) {
            value = event.details.parameter;
          }
        }
        methods.set(key, value || 'called');
      }
    });

    return methods;
  }

  /**
   * Calculate and display risk score
   */
  function calculateRiskScore() {
    const collectedMethods = getCollectedMethods();
    let totalWeight = 0;
    let collectedWeight = 0;
    const factors = [];

    for (const [category, config] of Object.entries(ALL_METRICS)) {
      totalWeight += config.weight;

      const collectedInCategory = config.methods.filter(m => collectedMethods.has(`${category}.${m}`));
      if (collectedInCategory.length > 0) {
        const ratio = collectedInCategory.length / config.methods.length;
        const categoryWeight = Math.round(config.weight * ratio);
        collectedWeight += categoryWeight;

        factors.push({
          icon: config.icon,
          name: config.name,
          desc: `${collectedInCategory.length} of ${config.methods.length} methods`,
          weight: categoryWeight,
          isCollected: true
        });
      }
    }

    // Calculate score (0-100, higher = more fingerprinting detected)
    const score = Math.round((collectedWeight / totalWeight) * 100);

    // Update UI
    riskScoreEl.textContent = score;
    riskCircleEl.style.setProperty('--risk-percent', `${score}%`);
    riskCircleEl.title = `Risk Score: ${score}/100\n\nОценка интенсивности fingerprinting:\n0-25: Low - минимальный сбор данных\n26-50: Medium - умеренный fingerprinting\n51-70: High - активный сбор отпечатков\n71-100: Critical - агрессивный fingerprinting\n\nЧем выше score, тем больше сайт собирает уникальных данных о вашем браузере.`;

    // Update circle color based on score
    let color = '#4ecdc4'; // low - green
    if (score > 70) {
      color = '#ff4444'; // critical - red
    } else if (score > 50) {
      color = '#ff6b6b'; // high - orange-red
    } else if (score > 25) {
      color = '#ffe66d'; // medium - yellow
    }
    riskCircleEl.style.background = `conic-gradient(from 180deg, ${color} 0%, ${color} ${score}%, #2d2d44 ${score}%)`;

    // Determine risk level
    let level = 'Low';
    let levelClass = 'low';
    let levelTooltip = 'Минимальный сбор данных. Сайт использует базовые проверки.';
    if (score > 70) {
      level = 'Critical';
      levelClass = 'critical';
      levelTooltip = 'Агрессивный fingerprinting! Сайт собирает максимум данных для идентификации. Высокий риск обнаружения автоматизации.';
    } else if (score > 50) {
      level = 'High';
      levelClass = 'high';
      levelTooltip = 'Активный fingerprinting. Сайт использует несколько техник для идентификации браузера.';
    } else if (score > 25) {
      level = 'Medium';
      levelClass = 'medium';
      levelTooltip = 'Умеренный fingerprinting. Сайт собирает стандартный набор данных для аналитики.';
    }

    riskLevelEl.textContent = `${level} Fingerprinting`;
    riskLevelEl.className = `risk-level ${levelClass}`;
    riskLevelEl.title = levelTooltip;

    // Render factors
    riskFactorsEl.innerHTML = '';
    factors.sort((a, b) => b.weight - a.weight).forEach(factor => {
      const factorEl = document.createElement('div');
      factorEl.className = 'risk-factor';
      // Get tooltip from ALL_METRICS
      const metricConfig = Object.values(ALL_METRICS).find(m => m.name === factor.name);
      const factorTooltip = metricConfig?.tooltip || `${factor.name}: ${factor.desc}`;
      factorEl.title = factorTooltip;
      factorEl.innerHTML = `
        <span class="risk-factor-icon">${factor.icon}</span>
        <div class="risk-factor-info">
          <div class="risk-factor-name">${factor.name}</div>
          <div class="risk-factor-desc">${factor.desc}</div>
        </div>
        <span class="risk-factor-weight positive" title="Вклад в Risk Score: +${factor.weight} очков">+${factor.weight}</span>
      `;
      riskFactorsEl.appendChild(factorEl);
    });

    if (factors.length === 0) {
      riskFactorsEl.innerHTML = `
        <div class="empty-state" title="Сайт пока не использовал известные методы fingerprinting.\nВозможно они будут вызваны при взаимодействии со страницей.">
          <div class="empty-state-icon">✓</div>
          <div class="empty-state-text">No fingerprinting detected</div>
        </div>
      `;
    }
  }

  /**
   * Render log
   */
  function renderLog() {
    logEl.innerHTML = '';

    const filteredEvents = currentFilter === 'all'
      ? events
      : events.filter(e => e.category === currentFilter);

    if (filteredEvents.length === 0) {
      logEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🔍</div>
          <div class="empty-state-text">No events captured yet</div>
        </div>
      `;
      return;
    }

    // Render last 500 events for performance
    const toRender = filteredEvents.slice(-500);
    toRender.forEach(event => renderLogEntry(event));
    scrollToBottom();
  }

  /**
   * Render single log entry
   */
  function renderLogEntry(event, target = logEl) {
    const div = document.createElement('div');
    div.className = `log-entry category-${event.category}`;

    if (event.details?.isAntifraud) {
      div.classList.add('antifraud');
    }

    const time = new Date(event.timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const icon = CATEGORY_ICONS[event.category] || '📌';
    const details = formatDetails(event.details);
    const count = event.batchCount > 1 ? event.batchCount : event.callCount;
    const fields = [
      ['log-time', time],
      ['log-category', `${icon} ${event.category}`],
      ['log-method', event.method],
      ['log-details', details]
    ];
    for (const [className, text] of fields) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      div.appendChild(span);
    }
    if (count > 1) {
      const countBadge = document.createElement('span');
      countBadge.className = 'log-count';
      countBadge.textContent = `×${count}`;
      div.appendChild(countBadge);
    }

    target.appendChild(div);
  }

  /**
   * Format event details
   */
  function formatDetails(details) {
    if (!details || Object.keys(details).length === 0) return '';

    const parts = [];
    for (const [key, value] of Object.entries(details)) {
      if (key === 'isAntifraud') continue;
      if (value === undefined || value === null) continue;

      let formatted = value;
      if (typeof value === 'object') {
        formatted = JSON.stringify(value).slice(0, 60);
      } else if (typeof value === 'string' && value.length > 50) {
        formatted = value.slice(0, 50) + '...';
      }
      parts.push(`${key}=${formatted}`);
    }

    return parts.length > 0 ? `(${parts.join(', ')})` : '';
  }

  /**
   * Update stats
   */
  function updateStats() {
    statEvents.textContent = totalEventCount;
    statRequests.textContent = totalRequestCount;
    statAntifraud.textContent = totalAntifraudCount;
  }

  function countAntifraudEvents(eventList) {
    return eventList.reduce((total, event) => total + (
      event.details?.isAntifraud ||
      event.category === 'canvas' ||
      event.category === 'webgl' ||
      event.category === 'audio'
        ? (event.batchCount || 1)
        : 0
    ), 0);
  }

  /**
   * Update duration
   */
  function updateDuration() {
    const seconds = Math.floor((Date.now() - startTime) / 1000);
    if (seconds < 60) {
      statDuration.textContent = `${seconds}s`;
    } else if (seconds < 3600) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      statDuration.textContent = `${mins}m ${secs}s`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      statDuration.textContent = `${hours}h ${mins}m`;
    }
  }

  /**
   * Scroll to bottom
   */
  function scrollToBottom() {
    logEl.scrollTop = logEl.scrollHeight;
  }

  /**
   * Export data
   */
  async function exportData(format) {
    const response = await chrome.runtime.sendMessage({
      action: 'export-data',
      tabId: currentTabId
    });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Извлекаем домен для имени файла
    let domain = 'unknown';
    try {
      domain = new URL(tab.url).hostname.replace('www.', '');
    } catch {}

    let content, filename, mimeType;

    if (format === 'json') {
      content = JSON.stringify({
        url: tab.url,
        title: tab.title,
        exportTime: new Date().toISOString(),
        sessionDuration: Date.now() - response.startTime,
        summary: generateSummary(response.events, response.requests, response),
        events: response.events,
        requests: response.requests
      }, null, 2);
      filename = `antifraud-spy-${domain}-${Date.now()}.json`;
      mimeType = 'application/json';
    } else {
      content = generateMarkdown(tab, response);
      filename = `antifraud-spy-${domain}-${Date.now()}.md`;
      mimeType = 'text/markdown';
    }

    // Download
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();

    URL.revokeObjectURL(url);
  }

  /**
   * Generate summary statistics
   */
  function generateSummary(events, requests, totals = {}) {
    const hasAggregateCounts = totals.categoryCounts && totals.methodCounts;
    const categories = hasAggregateCounts ? { ...totals.categoryCounts } : {};
    const methods = hasAggregateCounts ? { ...totals.methodCounts } : {};

    if (!hasAggregateCounts) {
      events.forEach(e => {
        const count = e.batchCount || 1;
        categories[e.category] = (categories[e.category] || 0) + count;
        const key = `${e.category}.${e.method}`;
        methods[key] = (methods[key] || 0) + count;
      });
    }

    const antifraudRequests = requests.filter(r => r.isAntifraud);

    return {
      totalEvents: totals.eventCount ?? events.reduce(
        (total, event) => total + (event.batchCount || 1), 0
      ),
      totalRequests: totals.requestCount ?? requests.length,
      antifraudRequests: totals.antifraudRequestCount ?? antifraudRequests.length,
      retainedEventRecords: events.length,
      retainedRequestRecords: requests.length,
      byCategory: categories,
      topMethods: Object.entries(methods)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([method, count]) => ({ method, count }))
    };
  }

  /**
   * Generate Markdown report
   */
  function generateMarkdown(tab, data) {
    const summary = generateSummary(data.events, data.requests, data);
    const duration = Math.floor((Date.now() - data.startTime) / 1000);

    let md = `# Antifraud Analysis Report

**URL:** ${tab.url}
**Generated:** ${new Date().toISOString()}
**Session Duration:** ${Math.floor(duration / 60)}m ${duration % 60}s

---

## Summary

| Metric | Value |
|--------|-------|
| Total Events | ${summary.totalEvents} |
| Total Requests | ${summary.totalRequests} |
| Antifraud Requests | ${summary.antifraudRequests} |
| Retained Event Records | ${summary.retainedEventRecords} |
| Retained Request Records | ${summary.retainedRequestRecords} |

### Events by Category

| Category | Count |
|----------|-------|
`;

    for (const [category, count] of Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1])) {
      md += `| ${category} | ${count} |\n`;
    }

    md += `
### Top Fingerprinting Methods

| Method | Calls |
|--------|-------|
`;

    for (const { method, count } of summary.topMethods) {
      md += `| ${method} | ${count} |\n`;
    }

    // Antifraud requests
    const antifraudReqs = data.requests.filter(r => r.isAntifraud);
    if (antifraudReqs.length > 0) {
      md += `
## Detected Antifraud Endpoints

`;
      antifraudReqs.forEach(r => {
        md += `- \`${r.method}\` ${r.url}\n`;
      });
    }

    // Fingerprinting events
    const fingerprintEvents = data.events.filter(e =>
      ['canvas', 'webgl', 'audio', 'fonts'].includes(e.category)
    );

    const canvasEvents = fingerprintEvents.filter(e => e.category === 'canvas');
    const webglEvents = fingerprintEvents.filter(e => e.category === 'webgl');
    const audioEvents = fingerprintEvents.filter(e => e.category === 'audio');

    if (fingerprintEvents.length > 0) {
      md += `
## Fingerprinting Activity

### Canvas
`;
      const canvasMethods = [...new Set(canvasEvents.map(e => e.method))];
      canvasMethods.forEach(m => {
        const count = canvasEvents
          .filter(e => e.method === m)
          .reduce((total, event) => total + (event.batchCount || 1), 0);
        md += `- \`${m}\` called ${count} times\n`;
      });

      md += `
### WebGL
`;
      const webglMethods = [...new Set(webglEvents.map(e => e.method))];
      webglMethods.forEach(m => {
        const count = webglEvents
          .filter(e => e.method === m)
          .reduce((total, event) => total + (event.batchCount || 1), 0);
        const details = webglEvents.find(e => e.method === m)?.details;
        md += `- \`${m}\` called ${count} times`;
        if (details?.parameter) md += ` (${details.parameter})`;
        md += `\n`;
      });

      md += `
### Audio
`;
      const audioMethods = [...new Set(audioEvents.map(e => e.method))];
      audioMethods.forEach(m => {
        const count = audioEvents
          .filter(e => e.method === m)
          .reduce((total, event) => total + (event.batchCount || 1), 0);
        md += `- \`${m}\` called ${count} times\n`;
      });
    }

    // Navigator checks
    const navEvents = data.events.filter(e => e.category === 'navigator');
    if (navEvents.length > 0) {
      md += `
## Navigator Properties Accessed

`;
      const navMethods = [...new Set(navEvents.map(e => e.method))];
      navMethods.forEach(m => {
        const count = navEvents
          .filter(e => e.method === m)
          .reduce((total, event) => total + (event.batchCount || 1), 0);
        md += `- \`navigator.${m}\` (${count}x)\n`;
      });
    }

    // Network requests summary
    if (data.requests.length > 0) {
      md += `
## Network Activity

### XHR/Fetch Requests
`;
      const xhrRequests = data.requests.filter(r => r.type === 'xmlhttprequest');
      const uniqueUrls = [...new Set(xhrRequests.map(r => {
        try {
          return new URL(r.url).pathname;
        } catch {
          return r.url?.slice(0, 100) || 'unknown';
        }
      }))];
      uniqueUrls.slice(0, 30).forEach(url => {
        md += `- ${url}\n`;
      });
    }

    md += `
---

## Recommendations for Checker

Based on the fingerprinting activity detected:

1. **Canvas**: ${canvasEvents?.length > 0 ? 'Ensure consistent canvas hash' : 'Not detected'}
2. **WebGL**: ${webglEvents?.length > 0 ? 'Match GPU renderer with OS/browser' : 'Not detected'}
3. **Audio**: ${audioEvents?.length > 0 ? 'Implement audio fingerprint consistency' : 'Not detected'}
4. **Navigator**: Ensure all navigator properties match expected browser profile
5. **Network**: Monitor and validate antifraud endpoint responses

---

*Generated by Antifraud Spy v1.0.12*
`;

    return md;
  }

  // Initialize
  init();

})();
