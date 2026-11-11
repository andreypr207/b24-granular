// Unit-тесты логики узла «🔐 Проверка доступа» без n8n: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/guard.js', import.meta.url), 'utf8');
const guard = new Function('$input', src);

const K1 = 'a'.repeat(48);
const K2 = 'b'.repeat(48);
const K3 = 'c'.repeat(48);
const cfg = {
  webhook: 'https://portal.bitrix24.ru/rest/1/secret/',
  ipHeader: 'x-forwarded-for',
  proxyHops: 1,
  keys: [
    { name: 'leads', key: K1, methods: '\n  crm.lead.add\n  # comment\n', ips: '\n' },
    { name: 'ip', key: K2, methods: 'crm.lead.*, crm.activity.add', ips: '203.0.113.10\n10.0.0.0/24 # office\n2a01:4f8::/32' },
    { name: 'off', key: K3, methods: '*', enabled: false },
    { name: 'placeholder', key: 'CHANGE_ME', methods: '*' },
    { name: 'short', key: 'short-key', methods: '*' },
  ],
};

const run = (key, method, { query = {}, body = {}, headers = {} } = {}, c = cfg) =>
  guard({ first: () => ({ json: { req: { params: { key, method }, query, body, headers }, cfg: c } }) })[0].json;

const err = (r) => JSON.parse(r.responseBody).error;

test('разрешённый метод проходит, URL собирается из вебхука', () => {
  const r = run(K1, 'crm.lead.add.json', { body: { fields: { TITLE: 'x' } } });
  assert.equal(r.allowed, true);
  assert.equal(r.targetUrl, 'https://portal.bitrix24.ru/rest/1/secret/crm.lead.add.json');
  assert.deepEqual(r.payload, { fields: { TITLE: 'x' } });
});

test('регистр и окончание .json/.xml не важны', () => {
  assert.equal(run(K1, 'CRM.LEAD.ADD').method, 'crm.lead.add');
  assert.equal(run(K1, 'crm.lead.add.xml').method, 'crm.lead.add');
});

test('неразрешённый метод → 403 insufficient_scope', () => {
  const r = run(K1, 'crm.lead.delete.json');
  assert.equal(r.allowed, false);
  assert.equal(r.statusCode, 403);
  assert.equal(err(r), 'insufficient_scope');
});

test('неверный, отключённый, шаблонный и короткий ключ → 401', () => {
  for (const k of ['nope', K3, 'CHANGE_ME', 'short-key', '']) {
    const r = run(k, 'crm.lead.add');
    assert.equal(r.statusCode, 401, k);
    assert.equal(err(r), 'INVALID_CREDENTIALS');
  }
});

test('мусор в имени метода → 404', () => {
  for (const m of ['../../profile', 'crm.lead.add/../x', 'crm lead', '']) {
    assert.equal(run(K1, m).statusCode, 404, m);
  }
});

test('form-urlencoded в стиле PHP раскладывается во вложенные объекты, auth удаляется', () => {
  const r = run(K1, 'crm.lead.add', {
    body: {
      'fields[TITLE]': 'T',
      'fields[PHONE][0][VALUE]': '+7',
      'fields[PHONE][0][VALUE_TYPE]': 'WORK',
      auth: 'foreign-token',
    },
  });
  assert.deepEqual(r.payload, { fields: { TITLE: 'T', PHONE: { 0: { VALUE: '+7', VALUE_TYPE: 'WORK' } } } });
});

test('повторяющиеся a[]=… и query + body сливаются', () => {
  const r = run(K1, 'crm.lead.add', {
    query: { 'select[]': ['ID', 'TITLE'], 'filter[>ID]': '5' },
    body: { 'filter[<ID]': '10' },
  });
  assert.deepEqual(r.payload, { select: { 0: 'ID', 1: 'TITLE' }, filter: { '>ID': '5', '<ID': '10' } });
});

test('ключи __proto__/constructor игнорируются', () => {
  const r = run(K1, 'crm.lead.add', { body: { '__proto__[x]': 1, 'a[constructor][y]': 2, ok: 1 } });
  assert.deepEqual(r.payload, { ok: 1 });
  assert.equal(({}).x, undefined);
});

test('batch: пропускается, только если разрешены все команды', () => {
  const ok = run(K1, 'batch', { body: { halt: 0, cmd: { a: 'crm.lead.add?fields[TITLE]=1', b: 'CRM.LEAD.ADD.json?x=1' } } });
  assert.equal(ok.allowed, true);

  const bad = run(K1, 'batch', { body: { cmd: ['crm.lead.add?x', 'crm.contact.list'] } });
  assert.equal(bad.statusCode, 403);
  assert.match(bad.responseBody, /crm\.contact\.list/);

  assert.equal(run(K1, 'batch', { body: { cmd: { a: 'batch?cmd[x]=y' } } }).statusCode, 400);
  assert.equal(run(K1, 'batch', { body: {} }).statusCode, 400);
});

test('маски методов: crm.lead.* и *', () => {
  const h = { headers: { 'x-forwarded-for': '203.0.113.10' } };
  assert.equal(run(K2, 'crm.lead.list', h).allowed, true);
  assert.equal(run(K2, 'crm.deal.list', h).statusCode, 403);
  const all = { ...cfg, keys: [{ name: 'all', key: K1, methods: '*' }] };
  assert.equal(run(K1, 'user.get', {}, all).allowed, true);
});

test('IP: точный адрес, подсеть, IPv6, ::ffff:', () => {
  const ip = (v) => run(K2, 'crm.lead.list', { headers: { 'x-forwarded-for': v } });
  assert.equal(ip('203.0.113.10').allowed, true);
  assert.equal(ip('10.0.0.42').allowed, true);
  assert.equal(ip('10.0.1.5').statusCode, 403);
  assert.equal(ip('2a01:4f8:c0c:1234::1').allowed, true);
  assert.equal(ip('2a02:4f8::1').statusCode, 403);
  assert.equal(ip('::ffff:203.0.113.10').allowed, true);
});

test('IP: берётся адрес, дописанный доверенным прокси, а не присланный клиентом', () => {
  const ip = (v) => run(K2, 'crm.lead.list', { headers: { 'x-forwarded-for': v } });
  assert.equal(ip('203.0.113.10, 8.8.8.8').statusCode, 403); // клиент подставил разрешённый IP
  assert.equal(ip('1.1.1.1, 10.0.0.77').allowed, true);       // настоящий адрес — последний
  const cf = { ...cfg, proxyHops: 2 };
  assert.equal(run(K2, 'crm.lead.list', { headers: { 'x-forwarded-for': '203.0.113.10, 172.68.1.1' } }, cf).allowed, true);
});

test('IP не определён → отказ для ключа с ограничением', () => {
  const r = run(K2, 'crm.lead.list');
  assert.equal(r.statusCode, 403);
  assert.equal(err(r), 'ACCESS_DENIED');
});

test('IP проверяется раньше метода', () => {
  const r = run(K2, 'crm.deal.list', { headers: { 'x-forwarded-for': '8.8.8.8' } });
  assert.equal(err(r), 'ACCESS_DENIED');
});

test('x-real-ip как источник адреса', () => {
  const c = { ...cfg, ipHeader: 'x-real-ip' };
  assert.equal(run(K2, 'crm.lead.list', { headers: { 'x-real-ip': '203.0.113.10' } }, c).allowed, true);
});
