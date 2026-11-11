#!/usr/bin/env bash
# E2E: запросы к запущенному n8n с тестовым воркфлоу и мок-сервером Битрикс24.
# Подготовка — см. раздел «Тесты» в README.
set -u
N8N_URL="${N8N_URL:-http://127.0.0.1:5678}"
WEBHOOK_ID="${WEBHOOK_ID:-00000000-0000-4000-8000-0000000e2e00}"
B="$N8N_URL/webhook/$WEBHOOK_ID/b24"
K1=$(printf 'a%.0s' {1..48})   # crm.lead.add, crm.lead.get; любой IP
K2=$(printf 'b%.0s' {1..48})   # crm.lead.*; 203.0.113.10 и 10.0.0.0/24
K3=$(printf 'c%.0s' {1..48})   # отключён

pass=0; fail=0
check() { # name expected_code body_regex ('!regex' = не должно совпасть) curl_args...
  local name=$1 code=$2 re=$3; shift 3
  local out http body
  out=$(curl -s -m 30 -w $'\n%{http_code}' "$@")
  http=${out##*$'\n'}; body=${out%$'\n'*}
  local matched=0
  if [[ "$re" == '!'* ]]; then [[ "$body" =~ ${re:1} ]] || matched=1
  else [[ "$body" =~ $re ]] && matched=1; fi
  if [[ "$http" == "$code" && $matched == 1 ]]; then
    pass=$((pass+1)); printf '  ok   %s\n' "$name"
  else
    fail=$((fail+1)); printf '  FAIL %s\n       HTTP %s: %s\n' "$name" "$http" "$body"
  fi
}

check "POST JSON"                 200 '"method":"crm.lead.add".*"TITLE":"JSON"' \
  -X POST "$B/$K1/crm.lead.add.json" -H 'Content-Type: application/json' -d '{"fields":{"TITLE":"JSON"}}'
check "POST form (PHP-style)"     200 '"PHONE":\{"0":\{"VALUE":"\+7111"' \
  -X POST "$B/$K1/crm.lead.add.json" --data-urlencode 'fields[TITLE]=Форма' --data-urlencode 'fields[PHONE][0][VALUE]=+7111' --data-urlencode 'auth=leak'
check "параметр auth отброшен"    200 '!"auth"' \
  -X POST "$B/$K1/crm.lead.add.json" --data-urlencode 'auth=leak'
check "GET query, без .json"      200 '"select":\["ID","TITLE"\]' \
  "$B/$K1/crm.lead.add?select%5B%5D=ID&select%5B%5D=TITLE"
check "метод не разрешён"         403 'insufficient_scope' "$B/$K1/crm.lead.delete.json?id=1"
check "неверный ключ"             401 'INVALID_CREDENTIALS' "$B/wrongwrongwrongwrongwrongwrong/crm.lead.add.json"
check "отключённый ключ"          401 'INVALID_CREDENTIALS' "$B/$K3/crm.lead.add.json"
check "ошибка Б24 как есть"       400 '"error_description":"Not found"' "$B/$K1/crm.lead.get.json?id=999"
check "batch разрешён"            200 '"method":"batch"' \
  -X POST "$B/$K1/batch.json" -H 'Content-Type: application/json' -d '{"cmd":{"a":"crm.lead.add?fields[TITLE]=1","b":"crm.lead.get?id=$result[a]"}}'
check "batch с чужим методом"     403 'crm\.deal\.list' \
  -X POST "$B/$K1/batch" --data-urlencode 'cmd[a]=crm.lead.add' --data-urlencode 'cmd[b]=crm.deal.list'
check "IP разрешён"               200 '"method":"crm.lead.list"' "$B/$K2/crm.lead.list.json" -H 'X-Forwarded-For: 203.0.113.10'
check "IP из подсети"             200 '"method":"crm.lead.update"' "$B/$K2/crm.lead.update.json" -H 'X-Forwarded-For: 1.1.1.1, 10.0.0.42'
check "подмена X-Forwarded-For"   403 'ACCESS_DENIED' "$B/$K2/crm.lead.list.json" -H 'X-Forwarded-For: 203.0.113.10, 8.8.8.8'
check "IP не определён"           403 'ACCESS_DENIED' "$B/$K2/crm.lead.list.json"
check "маска crm.lead.* ≠ deal"   403 'insufficient_scope' "$B/$K2/crm.deal.list.json" -H 'X-Forwarded-For: 203.0.113.10'

if [[ "${CHECK_DOWN:-0}" == 1 ]]; then
  check "Б24 недоступен"          502 'BITRIX24_UNAVAILABLE' "$B/$K1/crm.lead.add.json"
fi

echo "pass: $pass, fail: $fail"
[[ $fail -eq 0 ]]
