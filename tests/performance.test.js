const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  const listeners = {};
  const sentMessages = [];
  let savedState = null;
  const timers = new Map();
  let nextTimerId = 1;

  const eventApi = (name) => ({
    addListener(listener) {
      listeners[name] = listener;
    }
  });

  const chrome = {
    storage: {
      session: {
        async get() { return {}; },
        async set(value) { savedState = value; }
      }
    },
    runtime: {
      onMessage: eventApi('message'),
      async sendMessage(message) {
        sentMessages.push(message);
      }
    },
    webRequest: {
      onBeforeRequest: eventApi('beforeRequest'),
      onSendHeaders: eventApi('sendHeaders'),
      onResponseStarted: eventApi('responseStarted')
    },
    tabs: {
      onRemoved: eventApi('tabRemoved'),
      onUpdated: eventApi('tabUpdated')
    },
    alarms: {
      create() {},
      onAlarm: eventApi('alarm')
    }
  };

  const context = {
    chrome,
    console: { log() {}, warn() {} },
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  };

  const workerPath = path.join(__dirname, '..', 'src', 'background', 'service-worker.js');
  vm.runInNewContext(fs.readFileSync(workerPath, 'utf8'), context, { filename: workerPath });
  await Promise.resolve();
  await Promise.resolve();

  for (let batch = 0; batch < 10; batch += 1) {
    const events = Array.from({ length: 100 }, (_, index) => ({
      category: 'canvas',
      method: 'measureText',
      details: { text: `sample-${index % 10}` },
      timestamp: batch * 100 + index,
      batchCount: 10
    }));
    listeners.message({ action: 'log-events', events }, { tab: { id: 1 } }, () => {});
  }

  for (let index = 0; index < 3000; index += 1) {
    listeners.beforeRequest({
      tabId: 1,
      requestId: String(index),
      url: `https://example.com/api/${index}`,
      method: 'GET',
      type: 'xmlhttprequest',
      timeStamp: index,
      initiator: 'https://example.com'
    });
  }

  let exported;
  listeners.message(
    { action: 'export-data', tabId: 1 },
    {},
    (response) => { exported = response; }
  );

  assert.equal(exported.eventCount, 13000, 'aggregated and network event counts remain exact');
  assert.equal(exported.requestCount, 3000, 'request total remains exact after retention');
  assert.equal(exported.antifraudCount, 10000, 'fingerprinting total remains exact');
  assert.equal(exported.methodCounts['canvas.measureText'], 10000);
  assert.ok(exported.events.length <= 5000, 'event detail history is bounded');
  assert.ok(exported.requests.length <= 2000, 'request detail history is bounded');

  const popupBatches = sentMessages.filter(message => message.action === 'new-events');
  assert.ok(popupBatches.length > 1, 'busy traffic is delivered in batches');
  assert.ok(
    popupBatches.every(message => message.events.length <= 500),
    'popup batch size has a hard upper bound'
  );

  for (const [id, callback] of [...timers]) {
    timers.delete(id);
    await callback();
  }
  const persistedTab = savedState.tabEvents['1'];
  assert.ok(persistedTab.events.length <= 1000, 'persisted event details are bounded');
  assert.ok(persistedTab.requests.length <= 500, 'persisted request details are bounded');
  assert.equal(persistedTab.eventCount, 13000, 'persisted event aggregate remains exact');
  assert.equal(persistedTab.requestCount, 3000, 'persisted request aggregate remains exact');

  console.log('performance regression test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
