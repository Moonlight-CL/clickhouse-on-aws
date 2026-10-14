-- Synthetic data generators (parameterized views), created on both replicas.
-- Rows are a pure function of the row number n, so any range [start, start+cnt) can be (re)generated in parallel.
-- Data window: 90 days, 2026-07-14 00:00:00 .. 2026-10-12 00:00:00 UTC (4 monthly partitions).
-- Distribution: 100k users (heavily skewed: a few hot users produce most traffic), 30% of users in 5k orgs,
-- 24 models (skewed), 20 providers, 97% success, 80% streaming, token counts / latencies with realistic ranges.

CREATE DATABASE IF NOT EXISTS bench ON CLUSTER '{cluster}';

CREATE OR REPLACE VIEW bench.gen_billing_rows ON CLUSTER '{cluster}' AS
WITH
    number AS n,
    toDateTime64('2026-07-14 00:00:00', 3, 'UTC') + toIntervalMillisecond(cityHash64(n, 1) % 7776000000) AS ts,
    1 + toUInt64(100000 * pow((cityHash64(n, 2) % 1000000) / 1000000., 3)) AS uid,
    cityHash64(n, 3) AS h3,
    concat(hex(cityHash64(n, 12)), hex(cityHash64(n, 13))) AS hx,
    cityHash64(n, 4) AS h4,
    (h4 % 100) < 97 AS ok,
    50 + h3 % 16000 AS in_tok,
    if(h3 % 10 = 0, h3 % 2000, 0) AS img_tok,
    if(h3 % 3 = 0, intDiv(in_tok, 2), 0) AS cache_tok,
    if(ok, 10 + h4 % 4000, 0) AS out_tok,
    100 + cityHash64(n, 5) % 900 AS tfe,
    tfe + cityHash64(n, 6) % 500 AS tfc,
    tfc + out_tok * 20 AS tot
SELECT
    if(n % 50 = 0, 'billing_refund', 'billing_record') AS kafka_meta_event_type,
    ['relay-api', 'relay-stream', 'batch-worker'][1 + n % 3] AS kafka_meta_event_source,
    ts + toIntervalMillisecond(h4 % 2000) AS kafka_meta_timestamp,
    n + 1 AS id,
    uid AS user_id,
    if(uid % 10 < 7, 0, 1 + uid % 5000) AS org_id,
    ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3', 'o4-mini', 'claude-sonnet-4', 'claude-opus-4', 'claude-3-5-haiku',
     'gemini-2.5-pro', 'gemini-2.5-flash', 'deepseek-v3', 'deepseek-r1', 'qwen3-max', 'qwen3-coder', 'qwen-plus', 'glm-4.5',
     'kimi-k2', 'doubao-pro', 'mistral-large', 'llama-4-maverick', 'grok-4', 'text-embedding-3-large', 'whisper-1']
        [1 + toUInt64(24 * pow((h3 % 1000) / 1000., 2))] AS model_code,
    uid * 10 + n % 3 AS api_key_id,
    1 + cityHash64(n, 7) % 20 AS provider_id,
    lower(concat(substring(hx, 1, 8), '-', substring(hx, 9, 4), '-4', substring(hx, 14, 3), '-a', substring(hx, 18, 3), '-', substring(hx, 21, 12))) AS trace_id,
    concat('req_', hex(cityHash64(n, 8))) AS user_header_req_id,
    concat('preq_', hex(cityHash64(n, 9))) AS provider_req_header_req_id,
    concat('msg_', hex(cityHash64(n, 10))) AS provider_res_body_id,
    concat('pres_', hex(cityHash64(n, 11))) AS provider_res_header_req_id,
    if(ok, 'success', 'failed') AS status,
    if(ok, '', ['rate_limit', 'timeout', 'upstream_500', 'invalid_request', 'context_length'][1 + h4 % 5]) AS error_code,
    if(ok, '', concat('upstream request failed: ', toString(h4 % 1000))) AS error_message,
    if(ok OR h4 % 2 = 0, '', '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}') AS supplier_error,
    ['chat', 'completion', 'agent', 'embedding', 'coding'][1 + h3 % 5] AS scene,
    toUInt8(h4 % 100 < 2) AS is_fallback,
    toUInt32(in_tok) AS input_tokens,
    toUInt32(in_tok - img_tok) AS input_text_tokens,
    toUInt32(img_tok) AS input_image_tokens,
    toUInt32(cache_tok) AS input_cache_tokens,
    if(cache_tok > 0 AND h3 % 2 = 0, 'ephemeral', '') AS cache_type,
    toUInt32(if(h3 % 7 = 0, intDiv(in_tok, 4), 0)) AS cache_creation_input_tokens,
    toUInt32(if(h3 % 14 = 0, intDiv(in_tok, 8), 0)) AS cache_creation_1h_input_tokens,
    toUInt32(if(h3 % 7 = 0, intDiv(in_tok, 8), 0)) AS cache_creation_5m_input_tokens,
    toUInt32(0) AS audio_input_tokens,
    toUInt32(out_tok) AS output_tokens,
    toUInt32(0) AS audio_output_tokens,
    toUInt64((in_tok * 3 + out_tok * 15) * 1000) AS cost,
    toDecimal32(0.8 + (h4 % 21) / 100, 4) AS discount_rate,
    toUInt8(h3 % 10 < 8) AS is_stream,
    concat('sess_', toString(uid), '_', toString(intDiv(n, 50) % 1000)) AS session_id,
    ts - toIntervalMillisecond(tot) AS request_at,
    toInt32(tfe) AS t_first_event,
    toInt32(tfc) AS t_first_content,
    toInt32(tot) AS total,
    toUInt8(h3 % 5 = 0) AS thinking_enabled,
    if(uid % 4 = 0, 'nCNY', 'nUSD') AS currency,
    toUInt8(n % 50 = 0) AS billing_mode,
    if(n % 200 = 0, '{"billing_seconds":5.2}', '') AS ext_info,
    ts AS created_at
FROM numbers({start:UInt64}, {cnt:UInt64});

-- Kafka-shaped events ({event_type, event_source, timestamp, data:JSON string}) for the MV pipeline test.
CREATE OR REPLACE VIEW bench.gen_billing_events ON CLUSTER '{cluster}' AS
SELECT
    kafka_meta_event_type AS event_type,
    kafka_meta_event_source AS event_source,
    toUInt64(toUnixTimestamp64Milli(kafka_meta_timestamp)) AS timestamp,
    formatRowNoNewline('JSONEachRow', id, user_id, org_id, model_code, api_key_id, provider_id, trace_id, user_header_req_id,
        provider_req_header_req_id, provider_res_body_id, provider_res_header_req_id, status, error_code, error_message,
        supplier_error, scene, is_fallback, input_tokens, input_text_tokens, input_image_tokens, input_cache_tokens, cache_type,
        cache_creation_input_tokens, cache_creation_1h_input_tokens, cache_creation_5m_input_tokens, audio_input_tokens,
        output_tokens, audio_output_tokens, cost, toFloat64(discount_rate) AS discount_rate, is_stream, session_id,
        toUnixTimestamp64Milli(request_at) AS request_at, t_first_event, t_first_content, total, thinking_enabled, currency,
        billing_mode, ext_info, IPv4NumToString(toUInt32(cityHash64(id))) AS client_ip, '' AS forwarded_for,
        toUnixTimestamp64Milli(created_at) AS created_at) AS data
FROM bench.gen_billing_rows(start = {start:UInt64}, cnt = {cnt:UInt64});
