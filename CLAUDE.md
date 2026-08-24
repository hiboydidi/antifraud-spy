# Antifraud Spy - Project Notes

## Архитектура

### Chrome Extension Manifest V3
- Service Worker вместо background page (засыпает через 30 сек)
- Keep-alive через chrome.alarms
- webRequest только для наблюдения (блокировка через declarativeNetRequest)

### Stealth подход
- Page script инжектится в контекст страницы, не в isolated world
- Оригинальные функции сохраняются и вызываются без модификации
- Stack traces очищаются от extension:// URLs
- Нет глобальных переменных

### Коммуникация
```
Page Context (page-script.js)
    ↓ window.postMessage
Content Script (injector.js)
    ↓ chrome.runtime.sendMessage
Background (service-worker.js)
    ↓ chrome.runtime.sendMessage
Popup (popup.js)
```

## Важные паттерны

### Перехват методов
```javascript
// Правильно - сохраняем оригинал, возвращаем реальный результат
const original = HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL = function(...args) {
  emit('canvas', 'toDataURL', {});
  return original.apply(this, args); // Вызываем оригинал
};
```

### Перехват getters
```javascript
const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
Object.defineProperty(Navigator.prototype, 'userAgent', {
  ...descriptor,
  get: function() {
    const value = descriptor.get.call(this);
    emit('navigator', 'userAgent', { value });
    return value; // Возвращаем реальное значение
  }
});
```

## Antifraud эндпоинты

### Apple
- `appleid.cdn-apple.com` - статика
- `idmsa.apple.com` - аутентификация
- `setup.icloud.com` - setup wizard
- `gsa.apple.com` - GSA (Grand Slam Auth)
- Заголовки: `X-Apple-I-FD-Client-Info`, `X-Apple-I-MD`

### Google
- `accounts.google.com/_/Ident*` - идентификация
- `arkresolve` - Arkose/FunCaptcha
- Заголовки: `X-Client-Data`, `Sec-CH-UA-*`

## Ограничения

1. **Service Worker засыпание** - решено через alarms
2. **Popup закрытие** - события буферизируются в background
3. **Cross-origin iframes** - content script инжектится через all_frames: true
4. **CSP блокировка** - page-script.js должен быть в web_accessible_resources

## Тестирование

```bash
# Установка в Chrome
1. chrome://extensions/
2. Developer mode ON
3. Load unpacked → выбрать папку antifraud-spy
```

### Тестовые сайты
- https://appleid.apple.com/account (регистрация Apple ID)
- https://accounts.google.com/signup (регистрация Google)
- https://browserleaks.com (reference fingerprints)
