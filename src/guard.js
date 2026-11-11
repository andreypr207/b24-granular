// =====================================================================
//  ПРОВЕРКА ДОСТУПА: ключ → IP → методы (включая команды внутри batch)
//  Настройки — в узле «⚙️ Настройки». Этот узел менять не нужно.
// =====================================================================
const { req, cfg } = $input.first().json;

const METHOD_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deny(statusCode, error, description, extra = {}) {
  return [{
    json: {
      allowed: false,
      statusCode,
      responseBody: JSON.stringify({ error, error_description: description }),
      ...extra,
    },
  }];
}

// --- утилиты -----------------------------------------------------------
const lines = (text) => String(text ?? '')
  .split(/[\r\n,]+/)
  .map((s) => s.replace(/#.*$/, '').trim())
  .filter(Boolean);

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function normalizeMethod(raw) {
  return String(raw ?? '').trim().toLowerCase().replace(/\.(json|xml)$/, '');
}

function methodAllowed(method, patterns) {
  return patterns.some((p) => {
    if (p === '*') return true;
    if (p.endsWith('*')) return method.startsWith(p.slice(0, -1));
    return method === p;
  });
}

// "fields[PHONE][0][VALUE]" → ["fields","PHONE","0","VALUE"]
function splitKey(key) {
  const m = /^([^[\]]+)((?:\[[^[\]]*\])+)$/.exec(key);
  if (!m) return [key];
  const parts = [m[1]];
  const re = /\[([^[\]]*)\]/g;
  let x;
  while ((x = re.exec(m[2]))) parts.push(x[1]);
  return parts;
}

const isObj = (v) => v !== null && typeof v === 'object';

// Приводит параметры к вложенному виду, как их понимает PHP/Битрикс:
// плоские ключи вида a[b][c] (из form-urlencoded / query) раскладываются в объекты.
function nest(src, dst = {}) {
  if (!isObj(src)) return dst;
  for (const [rawKey, value] of Object.entries(src)) {
    const parts = splitKey(rawKey);
    if (parts.some((p) => BAD_KEYS.has(p))) continue;
    let cur = dst;
    for (let i = 0; i < parts.length; i++) {
      let p = parts[i];
      const last = i === parts.length - 1;
      if (p === '' && last && Array.isArray(value)) { // a[]=1&a[]=2, собранные парсером в массив
        for (const v of value) cur[String(Object.keys(cur).length)] = isObj(v) ? nest(v) : v;
        break;
      }
      if (p === '') p = String(Object.keys(cur).length); // a[]=1
      if (last) {
        if (isObj(value) && !Array.isArray(value)) {
          cur[p] = nest(value, isObj(cur[p]) ? cur[p] : {});
        } else if (Array.isArray(value)) {
          const arr = value.map((v) => (isObj(v) && !Array.isArray(v) ? nest(v) : v));
          cur[p] = arr;
        } else {
          cur[p] = value;
        }
      } else {
        if (!isObj(cur[p])) cur[p] = {};
        cur = cur[p];
      }
    }
  }
  return dst;
}

// --- IP ------------------------------------------------------------------
function getClientIp(headers) {
  const h = headers || {};
  const name = String(cfg.ipHeader || 'x-forwarded-for').toLowerCase();
  let ip = '';
  if (name === 'x-forwarded-for') {
    const chain = String(h['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const hops = Math.max(1, Number(cfg.proxyHops) || 1);
    ip = chain.length >= hops ? chain[chain.length - hops] : '';
  } else {
    ip = String(h[name] || '').split(',')[0].trim();
  }
  ip = ip.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

function ipv4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    if (!/^\d{1,3}$/.test(o) || Number(o) > 255) return null;
    n = n * 256 + Number(o);
  }
  return n;
}

function ipv6ToBigInt(ip) {
  if (!ip.includes(':')) return null;
  let [head, tail] = ip.split('::');
  if (ip.split('::').length > 2) return null;
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  // IPv4 в хвосте (::ffff:1.2.3.4)
  const lastArr = t ?? h;
  if (lastArr.length && lastArr[lastArr.length - 1].includes('.')) {
    const v4 = ipv4ToInt(lastArr.pop());
    if (v4 === null) return null;
    lastArr.push((v4 >>> 16).toString(16), (v4 & 0xffff).toString(16));
  }
  let groups;
  if (t === null) {
    if (h.length !== 8) return null;
    groups = h;
  } else {
    const fill = 8 - h.length - t.length;
    if (fill < 0) return null;
    groups = [...h, ...Array(fill).fill('0'), ...t];
  }
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) + BigInt(parseInt(g, 16));
  }
  return n;
}

function ipMatches(ip, rule) {
  const [base, bitsRaw] = rule.split('/');
  const v4 = ipv4ToInt(ip);
  const b4 = ipv4ToInt(base);
  if (v4 !== null && b4 !== null) {
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!(bits >= 0 && bits <= 32)) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return ((v4 & mask) >>> 0) === ((b4 & mask) >>> 0);
  }
  const v6 = ipv6ToBigInt(ip);
  const b6 = ipv6ToBigInt(base);
  if (v6 !== null && b6 !== null) {
    const bits = bitsRaw === undefined ? 128 : Number(bitsRaw);
    if (!(bits >= 0 && bits <= 128)) return false;
    const shift = BigInt(128 - bits);
    return (v6 >> shift) === (b6 >> shift);
  }
  return false;
}

// --- 1. Ключ ---------------------------------------------------------------
const key = String(req.params?.key ?? '');
let client = null;
for (const k of cfg.keys || []) {
  const kk = String(k.key ?? '');
  if (kk.length < 24 || /CHANGE_ME/i.test(kk) || k.enabled === false) continue;
  if (safeEqual(kk, key)) client = k;
}
if (!client) return deny(401, 'INVALID_CREDENTIALS', 'Invalid request credentials');

// --- 2. IP -----------------------------------------------------------------
const clientIp = getClientIp(req.headers);
const ipRules = lines(client.ips);
if (ipRules.length && !(clientIp && ipRules.some((r) => ipMatches(clientIp, r)))) {
  return deny(403, 'ACCESS_DENIED', `IP ${clientIp || 'unknown'} is not allowed for this key`,
    { keyName: client.name, clientIp });
}

// --- 3. Метод и параметры ----------------------------------------------------
const method = normalizeMethod(req.params?.method);
if (!METHOD_RE.test(method)) return deny(404, 'ERROR_METHOD_NOT_FOUND', 'Method not found!');

const params = nest(req.body, nest(req.query));
delete params.auth; // авторизация — только через вебхук прокси

const patterns = lines(client.methods).map((s) => s.toLowerCase());
let checked = [method];

if (method === 'batch') {
  const cmd = params.cmd;
  const cmds = isObj(cmd) ? Object.values(cmd) : [];
  if (!cmds.length) return deny(400, 'INVALID_REQUEST', 'Batch: cmd is empty');
  checked = cmds.map((c) => normalizeMethod(String(c).split('?')[0]));
  const bad = checked.find((m) => !METHOD_RE.test(m) || m === 'batch');
  if (bad !== undefined) return deny(400, 'INVALID_REQUEST', `Batch: invalid command "${bad}"`);
}

const forbidden = checked.filter((m) => !methodAllowed(m, patterns));
if (forbidden.length) {
  return deny(403, 'insufficient_scope',
    `Method ${forbidden.join(', ')} is not allowed for this key`,
    { keyName: client.name, clientIp, method });
}

// --- Разрешено -----------------------------------------------------------------
return [{
  json: {
    allowed: true,
    keyName: client.name,
    clientIp,
    method,
    targetUrl: String(cfg.webhook).replace(/\/+$/, '') + '/' + method + '.json',
    payload: params,
  },
}];
