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

const LOCALHOST_SUBDOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost$/;

const validLocalhostSubdomain = name => {
  if (!LOCALHOST_SUBDOMAIN_RE.test(name) || name.length > 253) return false;
  return name.split('.').every(label => label.length <= 63 &&
    !label.startsWith('-') && !label.endsWith('-'));
};

const parseHost = host => {
  if (typeof host !== 'string' || !host) return null;
  const value = host.toLowerCase();
  let name = null;
  let portText = null;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0) return null;
    name = value.slice(0, close + 1);
    const rest = value.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      portText = rest.slice(1);
    }
  } else {
    const colons = value.match(/:/g)?.length ?? 0;
    if (colons === 0) {
      name = value;
    } else if (colons === 1) {
      const idx = value.indexOf(':');
      name = value.slice(0, idx);
      portText = value.slice(idx + 1);
    } else if (value === '::1') {
      name = value;
    } else {
      return null;
    }
  }
  if (!name) return null;
  let parsedPort = null;
  if (portText !== null) {
    if (!/^\d+$/.test(portText)) return null;
    parsedPort = Number(portText);
    if (!Number.isSafeInteger(parsedPort) || parsedPort > 65535) return null;
  }
  return { name, port: parsedPort };
};

// Host заголовок обязан быть loopback и (если порт задан) совпадать с
// портом сервера — иначе DNS-rebinding на чужой порт тоже пройдёт.
export function isAllowedHost(host, port, defaultPort = 80) {
  const parsed = parseHost(host);
  if (!parsed) return false;
  const name = parsed.name === '[::1]' ? '::1' : parsed.name;
  const allowed = LOOPBACK_HOSTS.has(name) || validLocalhostSubdomain(name);
  if (!allowed) return false;
  if (!Number.isSafeInteger(port)) return true;
  return (parsed.port ?? defaultPort) === port;
}

// Fetch Metadata: браузерные cross-site запросы к loopback отклоняются даже
// без Origin (например, адресная строка/img/script probe). CLI/curl обычно не
// шлют Sec-Fetch-Site, поэтому отсутствие заголовка остаётся допустимым.
export function isAllowedFetchSite(secFetchSite) {
  if (secFetchSite === undefined || secFetchSite === null || secFetchSite === '') return true;
  const value = String(secFetchSite).trim().toLowerCase();
  return value === 'same-origin' || value === 'none';
}

// Origin заголовок (CSRF-защита для будущих мутаций и для защиты от
// drive-by форм): отсутствие Origin допустимо (curl/SSE), заданный —
// обязан быть loopback на нашем порту.
export function isAllowedOrigin(origin, port) {
  if (origin === undefined || origin === null || origin === '') {
    return true;
  }
  if (origin === 'null') return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return false;
  }
  return isAllowedHost(parsed.host, port, parsed.protocol === 'https:' ? 443 : 80);
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
