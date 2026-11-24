// Origin Guard для Control Room (V2-3) — адаптация MIT-паттерна codbash
// (loopback Host check + CSP) на Node stdlib.
//
// Сервер слушает только 127.0.0.1, но браузерный DNS-rebinding может
// указать loopback через чужой hostname: Host/Origin проверяются на
// loopback-allowlist (127.0.0.1, localhost, [::1], <host>.localhost),
// чужие — 403.
// SECURITY_HEADERS — строгий CSP без unsafe-eval и внешних origin'ов.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'none'; " +
    "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

const hostOnly = host => {
  if (typeof host !== 'string' || !host) return '';
  // host без порта или в форме [ipv6]:port / name:port.
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  const idx = host.lastIndexOf(':');
  return idx > 0 ? host.slice(0, idx) : host;
};

const portOf = host => {
  if (typeof host !== 'string') return null;
  const idx = host.lastIndexOf(':');
  if (idx < 0 || host.endsWith(']')) return null;
  const port = Number(host.slice(idx + 1));
  return Number.isSafeInteger(port) ? port : null;
};

// Host заголовок обязан быть loopback и (если порт задан) совпадать с
// портом сервера — иначе DNS-rebinding на чужой порт тоже пройдёт.
export function isAllowedHost(host, port) {
  const name = hostOnly(host).toLowerCase();
  if (!name) return false;
  const allowed = LOOPBACK_HOSTS.has(name) || name.endsWith('.localhost');
  if (!allowed) return false;
  const p = portOf(host);
  return p === null || (Number.isSafeInteger(port) ? p === port : true);
}

// Origin заголовок (CSRF-защита для будущих мутаций и для защиты от
// drive-by форм): отсутствие Origin допустимо (curl/SSE), заданный —
// обязан быть loopback на нашем порту.
export function isAllowedOrigin(origin, port) {
  if (origin === undefined || origin === null || origin === '' || origin === 'null') {
    return true;
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isAllowedHost(parsed.host, port);
}

// Вырезание всех ANSI/CSI/OSC escape-последовательностей и опасных control
// chars из недоверенного текста (логи воркеров, вывод Board) перед
// отображением в TUI/Web: OSC 52 (clipboard), OSC 8 (hyperlinks),
// CSI репозиционирование курсора, DCS/PM/APC, control chars кроме \n\t.
export function sanitizeTerminalText(input) {
  if (typeof input !== 'string') return '';
  return input
    // OSC ... (BEL | ST) — clipboard/hyperlink инъекции.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // DCS/PM/APC блоки.
    .replace(/\x1b[P^_X][^\x1b]*(?:\x1b\\|$)/g, '')
    // CSI-последовательности.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Прочие escape-последовательности (ESC + символ).
    .replace(/\x1b[@-Z\\-_]/g, '')
    // Control chars кроме табуляции и перевода строки.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    // Unicode bidi/zero-width маркеры — спуфинг порядка отображения
    // (заголовки карточек/логов маскируют текст под другой).
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
}

export function escapeHtml(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
