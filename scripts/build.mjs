#!/usr/bin/env node
// Собирает воркфлоу n8n из исходников в src/.
//   node scripts/build.mjs          → b24-granular-proxy.json (шаблон для импорта)
//   node scripts/build.mjs --test   → tests/e2e/workflow.test.json (конфиг для e2e-тестов)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, 'src', f), 'utf8');
const isTest = process.argv.includes('--test');

// webhookId в шаблоне не задаётся: при импорте через интерфейс n8n генерирует свой,
// поэтому у каждой установки свой адрес. Для e2e (импорт через CLI) нужен фиксированный.
export const TEST_WEBHOOK_ID = '00000000-0000-4000-8000-0000000e2e00';

const NOTE = `## Прокси Битрикс24 с ключами

**Как подключить интеграцию:**
1. Откройте узел **⚙️ Настройки**, добавьте блок в \`KEYS\`: имя, ключ, методы (по одному на строку), при желании IP.
2. Ключ: \`openssl rand -hex 24\`
3. Выдайте интеграции адрес вместо вебхука Б24:
\`https://<n8n>/webhook/<id>/b24/<КЛЮЧ>/\`
(точный адрес — Production URL в узле **Webhook Б24**, вместо \`:key\` — ключ, вместо \`:method\` — метод)

Запросы те же, что к Б24: \`.../crm.lead.add.json\`, GET или POST (JSON / form). batch проверяется по каждой команде.

После правки Настроек нажмите **Publish** (n8n 2.x) или **Save** (n8n 1.x), иначе боевой вебхук работает со старой версией.`;

function testConfig() {
  const port = process.env.MOCK_PORT || 9999;
  const k = (c) => c.repeat(48);
  return `const B24_WEBHOOK = 'http://127.0.0.1:${port}/rest/1/secret/';
const IP_HEADER = 'x-forwarded-for';
const PROXY_HOPS = 1;
const KEYS = [
  { name: 'leads', key: '${k('a')}', methods: \`
      crm.lead.add
      crm.lead.get
    \`, ips: '' },
  { name: 'ip', key: '${k('b')}', methods: 'crm.lead.*', ips: \`
      203.0.113.10
      10.0.0.0/24
    \` },
  { name: 'disabled', key: '${k('c')}', methods: '*', enabled: false },
];
return [{ json: { req: $input.first().json, cfg: { webhook: B24_WEBHOOK, ipHeader: IP_HEADER, proxyHops: PROXY_HOPS, keys: KEYS } } }];
`;
}

const id = (n) => `0b0c1c1e-0000-4000-8000-00000000000${n}`;
const nodes = [
  {
    parameters: { content: NOTE, height: 420, width: 420, color: 4 },
    id: id(1), name: 'Как пользоваться',
    type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-560, -260],
  },
  {
    parameters: {
      multipleMethods: true,
      httpMethod: ['GET', 'POST'],
      path: 'b24/:key/:method',
      responseMode: 'responseNode',
      options: {},
    },
    id: id(2), name: 'Webhook Б24',
    type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-80, 0],
    ...(isTest ? { webhookId: TEST_WEBHOOK_ID } : {}),
  },
  {
    parameters: { jsCode: isTest ? testConfig() : read('config.js') },
    id: id(3), name: '⚙️ Настройки',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [160, 0],
  },
  {
    parameters: { jsCode: read('guard.js') },
    id: id(4), name: '🔐 Проверка доступа',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [380, 0],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{
          id: '5b7f8c2e-1d3a-4e6b-9f0a-2c4d6e8f0a1b',
          leftValue: '={{ $json.allowed }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    },
    id: id(5), name: 'Разрешено?',
    type: 'n8n-nodes-base.if', typeVersion: 2, position: [600, 0],
  },
  {
    parameters: {
      method: 'POST',
      url: '={{ $json.targetUrl }}',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.payload) }}',
      options: {
        response: { response: { fullResponse: true, neverError: true, responseFormat: 'text' } },
        timeout: 60000,
      },
    },
    id: id(6), name: 'Запрос в Битрикс24',
    type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [820, -100],
    onError: 'continueErrorOutput',
  },
  {
    parameters: { jsCode: read('response.js') },
    id: id(7), name: 'Ответ Битрикс24',
    type: 'n8n-nodes-base.code', typeVersion: 2, position: [1060, -100],
  },
  {
    parameters: {
      respondWith: 'text',
      responseBody: '={{ $json.responseBody }}',
      options: {
        responseCode: '={{ $json.statusCode }}',
        responseHeaders: { entries: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }] },
      },
    },
    id: id(8), name: 'Ответ клиенту',
    type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [1300, 0],
  },
];

const to = (...names) => names.map((node) => ({ node, type: 'main', index: 0 }));
const connections = {
  'Webhook Б24': { main: [to('⚙️ Настройки'), to('⚙️ Настройки')] },
  '⚙️ Настройки': { main: [to('🔐 Проверка доступа')] },
  '🔐 Проверка доступа': { main: [to('Разрешено?')] },
  'Разрешено?': { main: [to('Запрос в Битрикс24'), to('Ответ клиенту')] },
  'Запрос в Битрикс24': { main: [to('Ответ Битрикс24'), to('Ответ Битрикс24')] },
  'Ответ Битрикс24': { main: [to('Ответ клиенту')] },
};

const workflow = {
  name: 'Битрикс24 — прокси с ключами и правами',
  nodes,
  connections,
  active: false,
  settings: {
    executionOrder: 'v1',
    saveDataSuccessExecution: isTest ? 'all' : 'none',
    saveManualExecutions: true,
  },
  pinData: {},
  meta: { templateCredsSetupCompleted: true },
};
if (isTest) workflow.id = 'b24proxye2etest1';

const out = isTest ? join(root, 'tests/e2e/workflow.test.json') : join(root, 'b24-granular-proxy.json');
writeFileSync(out, JSON.stringify(workflow, null, 2) + '\n');
console.log('written', out.replace(root + '/', ''));
