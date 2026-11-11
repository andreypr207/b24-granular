#!/usr/bin/env bash
# Проверка прокси: добавить лид и убедиться, что чужой метод закрыт.
# Ключу в «⚙️ Настройки» должен быть разрешён crm.lead.add.

N8N='https://your-n8n.example.com'
WEBHOOK_ID='id_из_Production_URL'   # узел «Webhook Б24» → Production URL
KEY='ключ_из_настроек'
BASE="$N8N/webhook/$WEBHOOK_ID/b24/$KEY"

echo '--- crm.lead.add (JSON)'
curl -sS -X POST "$BASE/crm.lead.add.json" \
  -H 'Content-Type: application/json' \
  -d '{
    "fields": {
      "TITLE": "Тест прокси n8n",
      "NAME": "Иван",
      "PHONE": [{"VALUE": "+79990000000", "VALUE_TYPE": "WORK"}],
      "SOURCE_ID": "WEB"
    },
    "params": {"REGISTER_SONET_EVENT": "Y"}
  }' \
  -w '\nHTTP %{http_code}\n'

echo '--- crm.lead.add (form-urlencoded)'
curl -sS -X POST "$BASE/crm.lead.add.json" \
  --data-urlencode 'fields[TITLE]=Тест прокси n8n (форма)' \
  --data-urlencode 'fields[PHONE][0][VALUE]=+79990000000' \
  --data-urlencode 'fields[PHONE][0][VALUE_TYPE]=WORK' \
  -w '\nHTTP %{http_code}\n'

echo '--- crm.lead.list (ожидается 403 insufficient_scope)'
curl -sS "$BASE/crm.lead.list.json" -w '\nHTTP %{http_code}\n'
