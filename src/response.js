// Ответ Битрикс24 отдаётся клиенту как есть: тот же HTTP-код и то же тело.
const r = $input.first().json;

if (r.error && r.statusCode === undefined) {
  // Битрикс24 недоступен (сеть, DNS, таймаут)
  const msg = typeof r.error === 'string' ? r.error : (r.error.message || 'Bitrix24 is unavailable');
  return [{
    json: {
      statusCode: 502,
      responseBody: JSON.stringify({ error: 'BITRIX24_UNAVAILABLE', error_description: msg }),
    },
  }];
}

let body = r.body ?? r.data ?? '';
if (typeof body !== 'string') body = JSON.stringify(body);

return [{ json: { statusCode: Number(r.statusCode) || 200, responseBody: body } }];
