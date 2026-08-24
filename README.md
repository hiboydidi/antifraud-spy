# Antifraud Spy

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension%20MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.12-green)](manifest.json)

**Real-time browser fingerprinting monitor.** Intercepts and visualizes all API calls that websites use to identify your browser -- Canvas, WebGL, Audio, WebRTC, Navigator, Fonts, and more -- with zero detection by antifraud systems.

Built for antifraud researchers, privacy engineers, and anyone who wants to understand what data websites collect about their browser.

---

## Why This Exists

Modern antifraud systems (FingerprintJS, DataDome, Akamai, Kasada, Cloudflare) silently collect dozens of browser parameters to create a unique device fingerprint. Most users have no idea which APIs are being called, how often, or what data is being extracted.

**Antifraud Spy** makes this invisible fingerprinting visible -- in real time, without alerting the antifraud system that it's being observed.

---

## Features

### API Interception (13 categories, 50+ methods)

| Category | Intercepted Methods | Fingerprint Risk |
|----------|-------------------|-----------------|
| **Canvas** | `toDataURL`, `toBlob`, `getImageData`, `fillText`, `strokeText`, `measureText` | High -- unique rendering hash per device |
| **WebGL** | `getParameter` (VENDOR, RENDERER, UNMASKED_*), `getExtension`, `getSupportedExtensions`, `getShaderPrecisionFormat`, `readPixels` | High -- exposes GPU model |
| **Audio** | `AudioContext`, `OfflineAudioContext`, `createOscillator`, `createDynamicsCompressor`, `createAnalyser`, `createGain` | High -- hardware-dependent signal processing |
| **WebRTC** | `RTCPeerConnection`, `createDataChannel`, `createOffer`, `setLocalDescription` | Critical -- can leak real IP behind VPN |
| **Navigator** | `userAgent`, `platform`, `language`, `hardwareConcurrency`, `deviceMemory`, `maxTouchPoints`, `webdriver` + 9 more | Medium -- basic browser identity |
| **Screen** | `width`, `height`, `availWidth`, `availHeight`, `colorDepth`, `pixelDepth`, `orientation` | Low -- common resolutions |
| **Fonts** | `FontFace` constructor, `FontFaceSet.check` | High -- installed font set is highly unique |
| **Storage** | `localStorage`, `sessionStorage` (get/set), `IndexedDB.open` | Low -- tracking persistence |
| **Timezone** | `getTimezoneOffset`, `Intl.DateTimeFormat.resolvedOptions` | Medium -- must match IP geolocation |
| **Plugins** | `navigator.plugins`, `navigator.mimeTypes` | Low -- deprecated but still checked |
| **Media** | `enumerateDevices`, `getUserMedia` | High -- unique device IDs |
| **Permissions** | `Permissions.query` | Low -- permission state fingerprinting |
| **Events** | `addEventListener` for behavioral patterns (mousemove, keydown, touch) | Medium -- behavioral biometrics |

### CAPTCHA Interception

- **reCAPTCHA v3 / Enterprise** -- detects `grecaptcha.execute`, tracks token lifecycle
- **Cloudflare Turnstile** -- detects `turnstile.render`, challenge platform, `cf_clearance` cookies
- Auto-detection via MutationObserver for dynamically loaded scripts

### Network Monitoring

- Real-time XHR/Fetch/Beacon tracking
- Antifraud endpoint classification (Apple, Google, FingerprintJS, DataDome, PerimeterX, Akamai, Kasada, Cloudflare)
- Suspicious header detection (`X-Fingerprint`, `X-Device-ID`, `X-Apple-I-FD`, `Sec-CH-UA-*`)
- Fingerprint cookie identification (`Set-Cookie` analysis)

### Hidden Element Detection

- Hidden `<iframe>` elements (0x0, display:none, visibility:hidden)
- Hidden `<canvas>` elements (opacity:0, offscreen)
- Detected via DOM MutationObserver in real time

### Session Intelligence

- Cookie count and localStorage analysis
- Profile "warmth" scoring (Cold / Warm / Hot)
- Google-specific cookie detection (NID, SID, SAPISID, etc.)
- Network Information API (effectiveType, downlink, RTT)

### Risk Score

Weighted fingerprinting intensity score (0-100) based on which API categories are being probed:

| Score | Level | Meaning |
|-------|-------|---------|
| 0-25 | Low | Minimal data collection |
| 26-50 | Medium | Standard analytics fingerprinting |
| 51-70 | High | Active browser identification |
| 71-100 | Critical | Aggressive fingerprinting |

### Data Export

- **JSON** -- full event timeline with metadata, suitable for automated analysis
- **Markdown** -- human-readable report with statistics, top methods, and recommendations

---

## How It Works

### Architecture

```
Page Context                Content Script              Background                 Popup UI
(page-script.js)            (injector.js)               (service-worker.js)        (popup.js)

Hooks into native    --->   Relays via               -> Stores in session       -> Real-time
Browser APIs                chrome.runtime               storage, monitors          event log,
via prototype               .sendMessage                 network via                metrics,
patching                                                 webRequest API             risk score

Runs in page's              Runs in isolated            Manifest V3 Service        Extension
execution context           content script world        Worker with keepalive      popup window
```

### Stealth Design

The core challenge: intercept Browser APIs without being detected by the very antifraud systems we're monitoring.

**1. Page Context Injection**

The page script runs in the page's own JavaScript context, not Chrome's isolated content script world. This is critical because antifraud scripts check `instanceof` and prototype chains:

```javascript
// injector.js -- injects before any page script executes
const script = document.createElement('script');
script.src = chrome.runtime.getURL('src/content/page-script.js');
target.insertBefore(script, target.firstChild);
script.onload = () => script.remove(); // Remove <script> tag after execution
```

**2. Transparent Proxying**

All intercepted methods return original, unmodified values. We observe, never modify:

```javascript
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function(...args) {
  emit('canvas', 'toDataURL', { width: this.width, height: this.height });
  return originalToDataURL.apply(this, args); // Original result, untouched
};
```

**3. Native Function Masquerading**

Antifraud scripts call `.toString()` on native functions to detect overrides. We handle this:

```javascript
// Returns "function toDataURL() { [native code] }" -- indistinguishable from original
HTMLCanvasElement.prototype.toDataURL.toString = () => originalToDataURL.toString();
```

**4. Clean Stack Traces**

Stack traces are filtered to remove any `extension://` URLs that would reveal the extension:

```javascript
function getCleanStack() {
  try { throw new Error(); } catch (e) {
    return e.stack.split('\n')
      .filter(line => !line.includes('extension://'))
      .slice(0, 5).join('\n');
  }
}
```

**5. No Global State**

The entire page script runs inside an IIFE -- no global variables, no detectable patterns on `window`.

### Service Worker Persistence

Chrome MV3 Service Workers terminate after 30 seconds of inactivity. We use `chrome.alarms` to keep it alive:

```javascript
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
```

Events are buffered in `chrome.storage.session` with throttled writes (5s) and a 5000 event-detail limit per tab.

### Performance Safeguards

- API calls are counted exactly, while repeated calls are grouped into 250ms records using `batchCount`.
- Each method keeps representative parameter variants and one stack sample instead of capturing a stack for every call.
- In-memory detail history is bounded to recent events and requests; aggregate category/method totals remain exact.
- Session persistence keeps smaller recent-detail snapshots for the 10 most recently active tabs.
- Popup updates are delivered in batches and render at most 500 log rows.

---

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/mazamaka/antifraud-spy.git
   ```

2. Open Chrome Extensions page:
   ```
   chrome://extensions/
   ```

3. Enable **Developer mode** (toggle in top right corner)

4. Click **Load unpacked** and select the `antifraud-spy` directory

5. The extension icon appears in your toolbar -- click it on any website to start monitoring

---

## Usage

1. Navigate to a target website (e.g., `appleid.apple.com`, `accounts.google.com`, `browserleaks.com`)
2. Interact with the page -- login, signup, browse
3. Click the extension icon to open the dashboard
4. Use tabs to switch between **Log** (real-time events), **Metrics** (API coverage), and **Risk Score**
5. Filter events by category (Canvas, WebGL, Audio, Navigator, Network, Storage)
6. Export data as JSON or Markdown for further analysis

---

## Detected Antifraud Systems

| Provider | Detection Patterns |
|----------|-------------------|
| **Apple** | `idmsa.apple.com`, `appleid.cdn-apple.com`, `gsa.apple.com`, `setup.icloud.com` |
| **Google** | `accounts.google.com/_/Ident*`, `recaptcha`, `arkresolve` |
| **FingerprintJS** | `fingerprint.com`, `fpjs.io`, metrics endpoints |
| **DataDome** | `datadome` tracking endpoints |
| **PerimeterX** | `perimeterx` API calls |
| **Akamai** | Akamai bot manager sensor data |
| **Kasada** | Kasada behavioral analysis endpoints |
| **Cloudflare** | `cdn-cgi/challenge-platform`, `cf_clearance`, Turnstile |
| **hCaptcha** | hCaptcha challenge endpoints |
| **Arkose/FunCaptcha** | Arkose Labs endpoints |

---

## Project Structure

```
antifraud-spy/
├── manifest.json                   # Chrome Extension Manifest V3
├── src/
│   ├── background/
│   │   └── service-worker.js       # Network monitoring, event storage, keepalive
│   ├── content/
│   │   ├── injector.js             # Content script: injects page-script, relays messages
│   │   └── page-script.js          # Page context: API hooks (13 categories, 50+ methods)
│   └── popup/
│       ├── popup.html              # Dashboard UI (3 tabs: Log, Metrics, Risk Score)
│       ├── popup.js                # Event rendering, filtering, export, risk calculation
│       └── popup.css               # Dark theme UI (~740 lines)
├── icons/                          # Extension icons (16, 48, 128px)
├── LICENSE                         # MIT License
└── README.md
```

---

## Testing

### Recommended Test Sites

| Site | What to Observe |
|------|-----------------|
| [browserleaks.com](https://browserleaks.com) | Reference fingerprinting -- all categories active |
| [appleid.apple.com/account](https://appleid.apple.com/account) | Apple antifraud: Canvas, WebGL, Audio, reCAPTCHA |
| [accounts.google.com/signup](https://accounts.google.com/signup) | Google antifraud: Navigator, Network, reCAPTCHA Enterprise |
| [creativecloud.adobe.com](https://creativecloud.adobe.com) | DataDome integration |

### Debugging

- **Background logs**: `chrome://extensions/` -> "Service Worker" link
- **Popup logs**: Right-click extension icon -> "Inspect Popup"
- **Page script logs**: Regular browser DevTools console

---

## Limitations

- Cannot intercept compiled WebAssembly fingerprinting modules
- WebSocket traffic is monitored but payloads are not decoded
- Cross-origin iframes: content script injects via `all_frames: true`, but some CSP-restricted frames may block injection
- Very aggressive CSP policies (`script-src` without `unsafe-inline`) can prevent page-script injection on rare sites

---

## Use Cases

- **Antifraud Research** -- understand what data antifraud systems collect and how
- **Browser Fingerprint Analysis** -- audit your browser's fingerprint surface
- **Anti-detect Browser QA** -- verify that spoofed values are actually being returned to antifraud checks
- **Privacy Auditing** -- identify which websites perform aggressive device fingerprinting
- **CAPTCHA Analysis** -- monitor reCAPTCHA/Turnstile lifecycle and token flow

---

## Author

**Maksym Babenko**

- GitHub: [@mazamaka](https://github.com/mazamaka)
- Telegram: [@Mazamaka](https://t.me/Mazamaka)

---

## License

[MIT](LICENSE)
