-- Read workload against token_hub.t_billing_records_mv (a TO-materialized view: SELECTs read t_billing_records).
-- Placeholders ({uid}, {org}, {trace}) are substituted by bench.sh with sampled real values, one query per line.
-- Data window ends 2026-10-12 00:00:00 UTC, so "last 7 days" = since 2026-10-05, "last 24h" = since 2026-10-11.

-- Q1_user_daily_bill: a user's bill per day and model over 30 days (user console)
SELECT toDate(created_at) AS d, model_code, count() AS requests, sum(input_tokens) AS in_tok, sum(output_tokens) AS out_tok, sum(cost) AS total_cost FROM token_hub.t_billing_records_mv WHERE kafka_meta_event_type = 'billing_record' AND created_at >= '2026-09-12 00:00:00' AND user_id = {uid} GROUP BY d, model_code ORDER BY d, model_code

-- Q2_user_recent_records: newest 50 records of a user in the last 7 days (records list page)
SELECT id, created_at, model_code, input_tokens, output_tokens, cost, status, t_first_content, total FROM token_hub.t_billing_records_mv WHERE kafka_meta_event_type = 'billing_record' AND created_at >= '2026-10-05 00:00:00' AND user_id = {uid} ORDER BY created_at DESC LIMIT 50

-- Q3_org_monthly_summary: an organization's September usage by model (org billing)
SELECT model_code, currency, count() AS requests, sum(input_tokens + output_tokens) AS tokens, sum(cost) AS total_cost FROM token_hub.t_billing_records_mv WHERE kafka_meta_event_type = 'billing_record' AND created_at >= '2026-09-01 00:00:00' AND created_at < '2026-10-01 00:00:00' AND org_id = {org} GROUP BY model_code, currency ORDER BY total_cost DESC

-- Q4_hourly_dashboard_24h: platform dashboard, last 24h per hour and model, with TTFT p95 and error rate
SELECT toStartOfHour(created_at) AS h, model_code, count() AS requests, sum(cost) AS total_cost, quantile(0.95)(t_first_content) AS ttft_p95, countIf(status != 'success') / count() AS error_rate FROM token_hub.t_billing_records_mv WHERE kafka_meta_event_type = 'billing_record' AND created_at >= '2026-10-11 00:00:00' GROUP BY h, model_code ORDER BY h, model_code

-- Q5_top_users_7d: top 100 users by spend over the last 7 days
SELECT user_id, count() AS requests, sum(cost) AS total_cost, sum(input_tokens + output_tokens) AS tokens FROM token_hub.t_billing_records_mv WHERE kafka_meta_event_type = 'billing_record' AND created_at >= '2026-10-05 00:00:00' GROUP BY user_id ORDER BY total_cost DESC LIMIT 100

-- Q6_provider_errors_24h: error rate and latency per provider over the last 24h (supplier monitoring)
SELECT provider_id, count() AS requests, countIf(status != 'success') AS errors, round(errors / requests, 4) AS error_rate, quantiles(0.5, 0.99)(total) AS total_ms FROM token_hub.t_billing_records_mv WHERE created_at >= '2026-10-11 00:00:00' GROUP BY provider_id ORDER BY error_rate DESC

-- Q7_trace_lookup: find one request by trace_id (not in the sorting key: worst case, full scan)
SELECT * FROM token_hub.t_billing_records_mv WHERE trace_id = '{trace}' LIMIT 1

-- Q8_monthly_model_revenue: whole-September revenue by model and currency (finance report, full month scan)
SELECT model_code, currency, count() AS requests, sum(cost) AS total_cost, sum(toDecimal128(cost, 0) * discount_rate) AS discounted FROM token_hub.t_billing_records_mv WHERE kafka_meta_event_type = 'billing_record' AND created_at >= '2026-09-01 00:00:00' AND created_at < '2026-10-01 00:00:00' GROUP BY model_code, currency ORDER BY total_cost DESC
