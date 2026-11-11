// Мок REST API Битрикс24 для e2e-тестов: возвращает то, что получил.
// node tests/e2e/mock-bitrix.cjs   (порт: MOCK_PORT, по умолчанию 9999)
const http = require('http');
const port = Number(process.env.MOCK_PORT || 9999);

http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const m = req.url.match(/^\/rest\/1\/secret\/([^?]+)\.json/);
    if (!m) return send(404, { error: 'NOT_FOUND', url: req.url });
    let body;
    try { body = JSON.parse(data || '{}'); } catch { body = data; }
    // имитация ошибки Битрикс24 для проверки проброса кода и тела
    if (m[1] === 'crm.lead.get') return send(400, { error: '', error_description: 'Not found' });
    send(200, {
      result: { method: m[1], httpMethod: req.method, contentType: req.headers['content-type'], body },
      time: { start: Date.now() / 1000 },
    });
  });
}).listen(port, '127.0.0.1', () => console.log(`mock Bitrix24 on http://127.0.0.1:${port}`));
