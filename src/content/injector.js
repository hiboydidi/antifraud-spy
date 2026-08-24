/**
 * Antifraud Spy - Content Script (Injector)
 * Инжектирует page-script.js в контекст страницы
 * и пересылает события в background
 */

(function() {
  'use strict';

  const CHANNEL_ID = `antifraud-spy-${crypto.randomUUID()}`;
  const MAX_QUEUED_EVENTS = 2000;
  const SEND_INTERVAL_MS = 100;
  let extensionValid = true; // Флаг валидности контекста расширения
  const pendingEvents = [];
  let sendTimer = null;

  // Безопасная отправка сообщений в background
  function safeSendMessage(message) {
    if (!extensionValid) return;

    try {
      const result = chrome.runtime.sendMessage(message);
      result?.catch?.((e) => {
        if (e.message?.includes('Extension context invalidated')) {
          extensionValid = false;
        }
      });
    } catch (e) {
      if (e.message?.includes('Extension context invalidated')) {
        extensionValid = false;
        console.warn('[Antifraud Spy] Extension reloaded, please refresh the page');
      }
    }
  }

  function flushEvents() {
    sendTimer = null;
    if (pendingEvents.length === 0 || !extensionValid) return;
    const events = pendingEvents.splice(0, pendingEvents.length);
    safeSendMessage({ action: 'log-events', events });
  }

  function queueEvents(events) {
    const available = MAX_QUEUED_EVENTS - pendingEvents.length;
    if (available > 0) {
      pendingEvents.push(...events.filter(event => event && typeof event === 'object').slice(0, available));
    }
    if (!sendTimer) sendTimer = setTimeout(flushEvents, SEND_INTERVAL_MS);
  }

  // Инжектируем page-script.js до загрузки страницы
  function injectPageScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/content/page-script.js');
    script.dataset.channelId = CHANNEL_ID;

    // Инжектируем в <html> или documentElement для раннего выполнения
    const target = document.head || document.documentElement;

    if (target) {
      target.insertBefore(script, target.firstChild);
      script.onload = () => script.remove(); // Убираем тег после выполнения (stealth)
    }
  }

  // Слушаем сообщения от page-script
  window.addEventListener('message', (event) => {
    // Проверяем что это наше сообщение
    if (event.source !== window || event.data?.type !== CHANNEL_ID) {
      return;
    }

    const payloads = Array.isArray(event.data.payloads)
      ? event.data.payloads
      : [event.data.payload];
    queueEvents(payloads);
  });

  // Инжектируем скрипт
  injectPageScript();

  const pendingDomRoots = new Set();
  let domScanTimer = null;

  function inspectFingerprintElement(node) {
    const style = window.getComputedStyle(node);

    if (node.tagName === 'IFRAME') {
      const width = String(node.width);
      const height = String(node.height);
      const isHidden = style.display === 'none' ||
                       style.visibility === 'hidden' ||
                       width === '0' || width === '1' ||
                       height === '0' || height === '1';

      if (isHidden) {
        queueEvents([{
          category: 'dom',
          method: 'hidden-iframe',
          details: { src: node.src, id: node.id, width: node.width, height: node.height },
          timestamp: Date.now(),
          url: location.href
        }]);
      }
    } else if (node.tagName === 'CANVAS') {
      const isHidden = style.display === 'none' ||
                       style.visibility === 'hidden' ||
                       style.opacity === '0';

      if (isHidden) {
        queueEvents([{
          category: 'dom',
          method: 'hidden-canvas',
          details: { id: node.id, width: node.width, height: node.height },
          timestamp: Date.now(),
          url: location.href
        }]);
      }
    }
  }

  function scanDomRoot(root) {
    const candidates = [];
    if (root.matches?.('iframe, canvas')) candidates.push(root);
    root.querySelectorAll?.('iframe, canvas').forEach(node => candidates.push(node));
    candidates.forEach(inspectFingerprintElement);
  }

  function processDomRoots() {
    domScanTimer = null;
    const roots = Array.from(pendingDomRoots).slice(0, 50);
    roots.forEach(root => pendingDomRoots.delete(root));
    roots.forEach(scanDomRoot);

    if (pendingDomRoots.size > 0) {
      domScanTimer = setTimeout(processDomRoots, 50);
    }
  }

  // DOM mutation callbacks stay cheap; style/layout work happens in bounded batches.
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) pendingDomRoots.add(node);
      }
    }
    if (pendingDomRoots.size > 0 && !domScanTimer) {
      domScanTimer = setTimeout(processDomRoots, 0);
    }
  });

  // Начинаем наблюдение после загрузки DOM
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  window.addEventListener('pagehide', flushEvents, { once: true });

})();
