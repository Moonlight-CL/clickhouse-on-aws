#!/usr/bin/env node
// Build the HTML performance report from the files collected in a results directory.
// Usage: node perf/report.js [results-dir] [output.html] [baseline-results-dir]
// With a baseline directory, a comparison section (this run vs. baseline run) is added.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = process.argv[2] || path.join(__dirname, 'results');
const OUT = process.argv[3] || path.join(__dirname, 'report.html');
const BASE = process.argv[4];

// ------------------------------------------------------------------ loading
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(DIR, f));
const jsonl = (f) => (exists(f) ? read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const json = (f, d = null) => (exists(f) ? JSON.parse(read(f)) : d);
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

const results = jsonl('results.jsonl');
const env = jsonl('env.jsonl');
const parts = jsonl('parts.jsonl');
const columns = jsonl('columns.jsonl');
const disks = jsonl('disks.jsonl');
const readLog = jsonl('read_query_log.jsonl');
const instances = json('instances.json', []);
const volumes = json('volumes.json', []);
const params = Object.fromEntries((json('stack-parameters.json', []) || []).map((p) => [p.ParameterKey, p.ParameterValue]));
const cw = json('cloudwatch.json', { MetricDataResults: [] });
const findings = exists('findings.html') ? read('findings.html') : '';
const schemaNotes = exists('schema-notes.html') ? read('schema-notes.html') : '';
// optional per-run files: platform.txt ("EC2" | "EKS"), label.txt (name in comparisons), deployment.html
const platform = exists('platform.txt') ? read('platform.txt').trim() : 'EC2';
const deployment = exists('deployment.html') ? read('deployment.html') : '';
const queriesSql = fs.readFileSync(path.join(__dirname, 'sql', '03_read_queries.sql'), 'utf8');

const benchLog = exists('bench.log') ? read('bench.log') : '';
const endTs = ((benchLog.match(/^\[(\S+)\] === ALL DONE/m) || [])[1]) || (results[results.length - 1] || {}).ts || '';
const by = (test) => results.filter((r) => r.test === test);
const one = (test) => by(test)[0];


// clickhouse-benchmark text output -> { hosts: [{host, queries, qps, rps, mibps}], pct: {"50": [s, s]}, errors }
function parseBenchText(txt) {
  const hosts = [];
  const pct = {};
  for (const line of txt.split('\n')) {
    let m = line.match(/^(\S+):\d+, queries: (\d+), QPS: ([\d.]+), RPS: ([\d.]+), MiB\/s: ([\d.]+)/);
    if (m) hosts.push({ host: m[1].split('.')[0], queries: +m[2], qps: +m[3], rps: +m[4], mibps: +m[5] });
    m = line.match(/^([\d.]+)%\s+(.*)$/);
    if (m) pct[m[1]] = [...m[2].matchAll(/([\d.]+) sec\./g)].map((x) => +x[1]);
  }
  const errors = (txt.match(/Code: \d+/g) || []).length;
  return { hosts, pct, errors };
}
const parseBench = (file) => (exists(file) ? parseBenchText(read(file)) : null);
const benchQps = (b) => (b ? b.hosts.reduce((s, h) => s + h.qps, 0) : NaN);
const benchPct = (b, p, i = 0) => (b && b.pct[p] ? b.pct[p][i] : NaN);

// ------------------------------------------------------------------ formatting
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }) : '–');
const human = (v) => {
  if (!Number.isFinite(v)) return '–';
  const u = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']].find(([n]) => Math.abs(v) >= n);
  return u ? `${fmt(v / u[0], 2)}${u[1]}` : fmt(v, 0);
};
const bytes = (v) => {
  if (!Number.isFinite(v)) return '–';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${fmt(v, i ? 2 : 0)} ${u[i]}`;
};
const ms = (sec) => (Number.isFinite(sec) ? `${fmt(sec * 1000, sec < 0.1 ? 1 : 0)} ms` : '–');
const table = (head, rows, cls = '') => `<table class="${cls}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n')}</tbody></table>`;

// ------------------------------------------------------------------ SVG charts
const PALETTE = ['#2563eb', '#f97316', '#16a34a', '#dc2626', '#9333ea', '#0891b2', '#ca8a04', '#db2777'];
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}
// grouped bar chart: labels on x, series = [{name, values}]
function barChart({ labels, series, title, yLabel, width = 760, height = 300, yFmt = human }) {
  const m = { l: 70, r: 20, t: 34, b: 52 };
  const w = width - m.l - m.r, h = height - m.t - m.b;
  const max = niceMax(Math.max(...series.flatMap((s) => s.values.filter(Number.isFinite))));
  const gw = w / labels.length, bw = Math.min(46, (gw * 0.8) / series.length);
  let s = `<svg viewBox="0 0 ${width} ${height}" class="chart"><text x="${width / 2}" y="18" class="ct">${esc(title)}</text>`;
  for (let i = 0; i <= 4; i++) {
    const y = m.t + h - (h * i) / 4;
    s += `<line x1="${m.l}" x2="${m.l + w}" y1="${y}" y2="${y}" class="grid"/><text x="${m.l - 6}" y="${y + 4}" class="ya">${yFmt((max * i) / 4)}</text>`;
  }
  s += `<text transform="translate(14 ${m.t + h / 2}) rotate(-90)" class="yl">${esc(yLabel)}</text>`;
  labels.forEach((lab, i) => {
    const x0 = m.l + gw * i + (gw - bw * series.length) / 2;
    series.forEach((se, j) => {
      const v = se.values[i];
      if (!Number.isFinite(v)) return;
      const bh = (h * v) / max, x = x0 + j * bw, y = m.t + h - bh;
      s += `<rect x="${x}" y="${y}" width="${bw - 3}" height="${bh}" fill="${PALETTE[j % PALETTE.length]}"><title>${esc(se.name)} ${esc(lab)}: ${yFmt(v)}</title></rect>`;
      if (series.length <= 3) s += `<text x="${x + (bw - 3) / 2}" y="${y - 4}" class="bv">${yFmt(v)}</text>`;
    });
    s += `<text x="${m.l + gw * i + gw / 2}" y="${m.t + h + 16}" class="xa">${esc(lab)}</text>`;
  });
  if (series.length > 1) {
    series.forEach((se, j) => {
      s += `<rect x="${m.l + j * 150}" y="${height - 18}" width="10" height="10" fill="${PALETTE[j % PALETTE.length]}"/><text x="${m.l + j * 150 + 14}" y="${height - 9}" class="lg">${esc(se.name)}</text>`;
    });
  }
  return `${s}</svg>`;
}
// time-series line chart: series = [{name, points:[[Date, v]]}], marks = [{t:Date, label}]
function lineChart({ series, title, yLabel, marks = [], width = 960, height = 280, yFmt = human }) {
  const m = { l: 70, r: 20, t: 34, b: 56 };
  const w = width - m.l - m.r, h = height - m.t - m.b;
  const all = series.flatMap((s) => s.points);
  if (!all.length) return '<p class="muted">（无指标数据）</p>';
  const t0 = Math.min(...all.map((p) => +p[0])), t1 = Math.max(...all.map((p) => +p[0]));
  const max = niceMax(Math.max(...all.map((p) => p[1])));
  const X = (t) => m.l + (w * (+t - t0)) / Math.max(1, t1 - t0), Y = (v) => m.t + h - (h * v) / max;
  let s = `<svg viewBox="0 0 ${width} ${height}" class="chart"><text x="${width / 2}" y="18" class="ct">${esc(title)}</text>`;
  for (let i = 0; i <= 4; i++) {
    const y = m.t + h - (h * i) / 4;
    s += `<line x1="${m.l}" x2="${m.l + w}" y1="${y}" y2="${y}" class="grid"/><text x="${m.l - 6}" y="${y + 4}" class="ya">${yFmt((max * i) / 4)}</text>`;
  }
  s += `<text transform="translate(14 ${m.t + h / 2}) rotate(-90)" class="yl">${esc(yLabel)}</text>`;
  for (let i = 0; i <= 6; i++) {
    const t = new Date(t0 + ((t1 - t0) * i) / 6);
    s += `<text x="${X(t)}" y="${m.t + h + 16}" class="xa">${t.toISOString().slice(11, 16)}</text>`;
  }
  marks.forEach((mk, i) => {
    if (+mk.t < t0 || +mk.t > t1) return;
    s += `<line x1="${X(mk.t)}" x2="${X(mk.t)}" y1="${m.t}" y2="${m.t + h}" class="mark"/><text x="${X(mk.t) + 3}" y="${m.t + 10 + (i % 3) * 11}" class="mk">${esc(mk.label)}</text>`;
  });
  series.forEach((se, j) => {
    const d = se.points.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    s += `<path d="${d}" fill="none" stroke="${PALETTE[j % PALETTE.length]}" stroke-width="1.8"/>`;
    s += `<rect x="${m.l + j * 190}" y="${height - 18}" width="10" height="10" fill="${PALETTE[j % PALETTE.length]}"/><text x="${m.l + j * 190 + 14}" y="${height - 9}" class="lg">${esc(se.name)}</text>`;
  });
  return `${s}</svg>`;
}

// ------------------------------------------------------------------ data assembly
const roleName = (role) => (role || '').replace(/^ChS(\d+)R(\d+)$/, 'ch-s$1-r$2').replace(/^Keeper(\d+)$/, 'keeper-$1');
// ClickHouse hostName() is the EC2 private DNS (ip-a-b-c-d...); map it to the node name via the private IP.
// On EKS it is the pod name chi-<chi>-<cluster>-<shard>-<replica>-0 (0-based indexes).
const host = (h) => {
  const pod = /^chi-.+-(\d+)-(\d+)-\d+$/.exec(h || '');
  if (pod) return `ch-s${+pod[1] + 1}-r${+pod[2] + 1}`;
  const i = instances.find((x) => x.ip && (h || '').startsWith(`ip-${x.ip.replace(/\./g, '-')}`));
  return i ? roleName(i.role) : (h || '').replace(/\..*/, '');
};
const nodeCpu = jsonl('node_cpu.jsonl');
const chNodes = instances.filter((i) => /^ChS/.test(i.role)).sort((a, b) => a.role.localeCompare(b.role));
const keeperNodes = instances.filter((i) => /^Keeper/.test(i.role)).sort((a, b) => a.role.localeCompare(b.role));
const volOf = (inst, dev) => volumes.find((v) => v.instance === inst.id && v.device === dev) || {};
const version = (env.find((e) => e.version) || {}).version || '–';

const w1 = by('W1');
const w1t = one('W1_total') || {};
const w2 = by('W2');
const w2q = one('W2Q');
const w3s = one('W3sync');
const w3a = one('W3async');
const w4 = by('W4');
const w4c = one('W4_check') || {};
const files = one('files') || {};
const rps = (r) => (r ? r.rows / r.seconds : NaN);
const mbps = (r, bytesPerRow) => (r ? (r.rows * bytesPerRow) / r.seconds / 1048576 : NaN);
const rowBytes = num(files.rows_file_bytes) / num(files.rows_file_rows);
const eventBytes = num(files.events_file_bytes) / num(files.rows_file_rows);

const queryNames = [...queriesSql.matchAll(/^-- (Q\d+_[a-z0-9_]+): (.*)$/gm)].map((m) => ({ name: m[1], desc: m[2] }));
const querySql = Object.fromEntries([...queriesSql.matchAll(/^-- (Q\d+_[a-z0-9_]+):.*\n(SELECT[^\n]*)/gm)].map((m) => [m[1], m[2]]));
const CONCS = [1, 8, 32];
const reads = queryNames.map((q) => ({
  ...q, runs: Object.fromEntries(CONCS.map((c) => [c, parseBench(`read_${q.name}_c${c}.txt`)])),
}));
const mixed1 = parseBench('read_mixed_1replica_c16.txt');
const mixed2 = parseBench('read_mixed_2replicas_c16.txt');

const totalRows = parts.length ? Math.max(...parts.map((p) => num(p.rows))) : NaN;
const comp = parts.length ? num(parts[0].compressed) : NaN;
const uncomp = parts.length ? num(parts[0].uncompressed) : NaN;

// CloudWatch series
const cwSeries = (prefix, scale = 1) => cw.MetricDataResults.filter((r) => r.Id.startsWith(prefix)).map((r) => ({
  name: r.Label.replace(/^\S+ /, '').replace(/^ChS(\d)R(\d)$/, 'ch-s$1-r$2'),
  points: r.Timestamps.map((t, i) => [new Date(t), r.Values[i] * scale]).sort((a, b) => a[0] - b[0]),
}));
const phaseMarks = [];
const firstOf = (t) => results.find((r) => r.test === t);
for (const [t, label] of [['W1', 'W1 bulk'], ['W2', 'W2 batch'], ['W2Q', 'W2Q quorum'], ['W3sync', 'W3 small'], ['W4', 'W4 MV'], ['final_replication_catchup', 'reads']]) {
  const r = firstOf(t);
  if (r && r.ts) phaseMarks.push({ t: new Date(r.ts), label });
}

// ------------------------------------------------------------------ sections
// ------------------------------------------------------------------ comparison with a baseline run
// Key metrics of one results directory, as [group, label, value, unit, betterWhen]
function runMetrics(dir) {
  const p = (f) => path.join(dir, f);
  const ex = (f) => fs.existsSync(p(f));
  const lines = (f) => (ex(f) ? fs.readFileSync(p(f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const res = lines('results.jsonl');
  const get = (t, c) => res.find((r) => r.test === t && (c === undefined || r.concurrency === c));
  const rate = (r) => (r ? r.rows / r.seconds : NaN);
  const bench = (f) => (ex(f) ? parseBenchText(fs.readFileSync(p(f), 'utf8')) : null);
  const ver = (lines('env.jsonl').find((e) => e.version) || {}).version || '?';
  const label = ex('label.txt') ? fs.readFileSync(p('label.txt'), 'utf8').trim() : ver;
  const pts = lines('parts.jsonl');
  const m = [
    ['写入', 'W1 服务端批量导入（行/秒）', (() => { const t = get('W1_total'); return t ? t.rows / t.seconds : NaN; })(), 'rows', 'higher'],
    ...[1, 4, 8, 16].map((c) => ['写入', `W2 批量写入 c=${c}（行/秒）`, rate(get('W2', c)), 'rows', 'higher']),
    ['写入', 'W2 c=16 单个 INSERT p99（ms）', num((get('W2', 16) || { stats: {} }).stats.p99_ms), 'ms', 'lower'],
    ['写入', 'W2Q insert_quorum=2 c=8（行/秒）', rate(get('W2Q', 8)), 'rows', 'higher'],
    ['写入', 'W3 小批量同步 c=8（行/秒）', rate(get('W3sync')), 'rows', 'higher'],
    ['写入', 'W3 async_insert c=16（行/秒）', rate(get('W3async')), 'rows', 'higher'],
    ...[1, 4, 8].map((c) => ['写入', `W4 MV 管道 c=${c}（行/秒）`, rate(get('W4', c)), 'rows', 'higher']),
    ['写入', 'W4 单个 10 万事件 INSERT p50（ms）', num((get('W4', 1) || { stats: {} }).stats.p50_ms), 'ms', 'lower'],
  ];
  for (const q of queryNames) {
    const b1 = bench(`read_${q.name}_c1.txt`), b32 = bench(`read_${q.name}_c32.txt`);
    m.push(['读取', `${q.name.split('_')[0]} c=1 p50（ms）`, benchPct(b1, '50') * 1000, 'ms', 'lower']);
    m.push(['读取', `${q.name.split('_')[0]} c=32 QPS`, benchQps(b32), 'qps', 'higher']);
  }
  m.push(['读取', '混合负载单副本 QPS', benchQps(bench('read_mixed_1replica_c16.txt')), 'qps', 'higher']);
  m.push(['读取', '混合负载两副本 QPS', benchQps(bench('read_mixed_2replicas_c16.txt')), 'qps', 'higher']);
  m.push(['存储', '每副本压缩后大小', pts.length ? num(pts[0].compressed) : NaN, 'bytes', 'lower']);
  m.push(['存储', '压缩比', pts.length ? num(pts[0].uncompressed) / num(pts[0].compressed) : NaN, 'x', 'higher']);
  return { version: label, metrics: m };
}
function comparisonSection() {
  if (!BASE) return '';
  const cur = runMetrics(DIR), base = runMetrics(BASE);
  const show = (v, unit) => (unit === 'bytes' ? bytes(v) : unit === 'ms' ? fmt(v, v < 100 ? 1 : 0) : unit === 'x' ? `${fmt(v, 2)}×` : unit === 'qps' ? fmt(v, 1) : human(v));
  const rows = cur.metrics.map(([g, label, v, unit, better], i) => {
    const b = base.metrics[i][2];
    const d = (v - b) / b;
    const good = better === 'higher' ? d > 0 : d < 0;
    const cls = !Number.isFinite(d) || Math.abs(d) < 0.05 ? '' : good ? 'good' : 'bad';
    return [g, label, show(v, unit), show(b, unit), `<span class="${cls}">${Number.isFinite(d) ? `${d > 0 ? '+' : ''}${fmt(d * 100, 1)}%` : '–'}</span>`];
  });
  return `<h3>与 ${esc(base.version)} 的对比（相同实例规格、相同脚本和数据）</h3>
<p class="muted">差异 = (${esc(cur.version)} − ${esc(base.version)}) / ${esc(base.version)}。绿色表示 ${esc(cur.version)} 更好，红色表示更差；|差异| &lt; 5% 不着色，可视为测量噪声。</p>
${table(['类别', '指标', esc(cur.version), esc(base.version), '差异'], rows)}`;
}

const cards = [
  ['服务端批量导入（INSERT SELECT）', `${human(w1t.rows / w1t.seconds)} 行/秒`, `${human(w1t.rows)} 行，用时 ${fmt(w1t.seconds, 0)} s（持续写入）`],
  ['客户端批量写入（峰值）', `${human(Math.max(...w2.map(rps)))} 行/秒`, `每个 INSERT 10 万行，Native 格式，客户端发送 ${fmt(Math.max(...w2.map((r) => mbps(r, rowBytes))), 0)} MiB/s`],
  ['物化视图管道（JSON → MV → 表）', `${human(Math.max(...w4.map(rps)))} 行/秒`, `8 并发；逐行校验一致：${w4c.check && w4c.check.identical == 1 ? '是' : '否'}`],
  ['混合读 QPS（16 并发）', `${fmt(benchQps(mixed2), 1)} QPS`, `两个副本分担；单副本 ${fmt(benchQps(mixed1), 1)} QPS`],
  ['存储行数', `${human(totalRows)} 行`, `每副本压缩后 ${bytes(comp)}，压缩比 ${fmt(uncomp / comp, 2)}×`],
];

const envRows = [
  ...chNodes.map((i) => {
    const r = volOf(i, '/dev/xvda'), d = volOf(i, '/dev/sdb');
    return [`ClickHouse server <b>${roleName(i.role)}</b>`, i.type, i.arch, i.az,
      `${r.size} GiB ${r.type}`, `${d.size} GiB ${d.type}, ${d.iops} IOPS, ${d.throughput} MiB/s`];
  }),
  ...keeperNodes.map((i) => {
    const r = volOf(i, '/dev/xvda'), d = volOf(i, '/dev/sdb');
    return [`ClickHouse Keeper <b>${roleName(i.role)}</b>`, i.type, i.arch, i.az,
      `${r.size} GiB ${r.type}`, `${d.size} GiB ${d.type}, ${d.iops} IOPS, ${d.throughput} MiB/s`];
  }),
];

const w1Chart = barChart({
  labels: w1.map((r) => `#${r.batch}`),
  series: [{ name: '行/秒', values: w1.map(rps) }],
  title: 'W1：每批 1000 万行 INSERT … SELECT（顺序执行）的吞吐', yLabel: '行 / 秒',
});
const w2Chart = barChart({
  labels: w2.map((r) => `c=${r.concurrency}`),
  series: [{ name: 'rows/s', values: w2.map(rps) }],
  title: 'W2：客户端批量写入吞吐随并发的变化（每个 INSERT 10 万行）', yLabel: '行 / 秒',
});
const w2LatChart = barChart({
  labels: w2.map((r) => `c=${r.concurrency}`),
  series: ['p50_ms', 'p95_ms', 'p99_ms'].map((k) => ({ name: k.replace('_ms', ''), values: w2.map((r) => num(r.stats[k])) })),
  title: 'W2：单个 10 万行 INSERT 的延迟', yLabel: 'ms', yFmt: (v) => fmt(v, 0),
});
const w4Chart = barChart({
  labels: w4.map((r) => `c=${r.concurrency}`),
  series: [{ name: 'rows/s', values: w4.map(rps) }],
  title: 'W4：Kafka 形态 JSON 事件 → 源表 → t_billing_records_mv → t_billing_records 的吞吐', yLabel: '行 / 秒',
});

const insertRow = (label, r, bpr) => [label, r.concurrency, fmt(r.inserts), human(r.rows), fmt(r.seconds, 1),
  `<b>${human(rps(r))}</b>`, fmt(mbps(r, bpr), 0), fmt(num(r.stats.p50_ms)), fmt(num(r.stats.p95_ms)), fmt(num(r.stats.p99_ms)),
  bytes(num(r.stats.max_memory))];
const insertHead = ['测试', '并发', 'INSERT 次数', '行数', '耗时 (s)', '行/秒', '客户端 MiB/s', 'p50 ms', 'p95 ms', 'p99 ms', '单个 INSERT 最大内存'];

const readTable = table(
  ['查询', '用途', 'c=1 p50', 'c=1 p95', 'c=1 p99', 'c=1 QPS', 'c=8 QPS', 'c=8 p95', 'c=32 QPS', 'c=32 p95', '单次扫描行数', '错误'],
  reads.map((q) => {
    const r1 = q.runs[1], r8 = q.runs[8], r32 = q.runs[32];
    const log = readLog.find((l) => querySql[q.name] && l.q && querySql[q.name].startsWith(l.q.slice(0, 40)));
    const errs = [r1, r8, r32].reduce((s, r) => s + (r ? r.errors : 0), 0);
    return [`<b>${q.name.split('_')[0]}</b> <code>${q.name.replace(/^Q\d+_/, '')}</code>`, esc(q.desc),
      ms(benchPct(r1, '50')), ms(benchPct(r1, '95')), ms(benchPct(r1, '99')), fmt(benchQps(r1), 1),
      fmt(benchQps(r8), 1), ms(benchPct(r8, '95')), `<b>${fmt(benchQps(r32), 1)}</b>`, ms(benchPct(r32, '95')),
      log ? human(num(log.read_rows)) : '–', errs ? `<span class="bad">${errs}</span>` : '0'];
  }),
);
const readQpsChart = barChart({
  labels: reads.map((q) => q.name.split('_')[0]),
  series: CONCS.map((c) => ({ name: `并发 ${c}`, values: reads.map((q) => benchQps(q.runs[c])) })),
  title: '各查询读取 QPS 随客户端并发的变化（单副本 ch-s1-r1）', yLabel: 'QPS',
  yFmt: (v) => fmt(v, 0),
});
const readLatChart = barChart({
  labels: reads.map((q) => q.name.split('_')[0]),
  series: CONCS.map((c) => ({ name: `p95 @ c=${c}`, values: reads.map((q) => benchPct(q.runs[c], '95') * 1000) })),
  title: '各查询 p95 延迟随并发的变化', yLabel: 'ms', yFmt: (v) => fmt(v, 0),
});
const mixedRows = [[mixed1, '单副本（ch-s1-r1）'], [mixed2, '两个副本（r1 + r2，随机路由）']].filter(([b]) => b).map(([b, label]) => [
  label, b.hosts.map((h) => `${h.host}: ${fmt(h.queries)} 次, ${fmt(h.qps, 1)} QPS`).join('<br>'), `<b>${fmt(benchQps(b), 1)}</b>`,
  ms(benchPct(b, '50')), ms(benchPct(b, '95')), ms(benchPct(b, '99')), ms(benchPct(b, '99.9'))]);

const cpuSeries = nodeCpu.length
  ? [...new Set(nodeCpu.map((r) => r.host))].sort((a, b) => host(a).localeCompare(host(b))).map((h) => ({
    name: host(h),
    points: nodeCpu.filter((r) => r.host === h).map((r) => [new Date(`${r.t.replace(' ', 'T')}Z`), num(r.cpu_pct)]),
  }))
  : cwSeries('cpu');
const cpuChart = lineChart({
  series: cpuSeries,
  title: nodeCpu.length ? 'ClickHouse 进程 CPU 使用率（system.metric_log, 1 分钟, 8 vCPU = 100%）' : 'CPU utilization of ClickHouse nodes (CloudWatch)',
  yLabel: '%', marks: phaseMarks, yFmt: (v) => fmt(v, 0),
});
const dataVol = volumes.find((v) => v.device === '/dev/sdb' && v.size > 50) || {};
const ebsWChart = lineChart({ series: cwSeries('wb', 1 / 60 / 1048576), title: `数据盘写入吞吐（MiB/s，CloudWatch 1 分钟）— gp3 配置上限 ${dataVol.throughput} MiB/s`, yLabel: 'MiB/s', marks: phaseMarks, yFmt: (v) => fmt(v, 0) });
const ebsRChart = lineChart({ series: cwSeries('rb', 1 / 60 / 1048576), title: '数据盘读取吞吐（MiB/s，CloudWatch 1 分钟）', yLabel: 'MiB/s', marks: phaseMarks, yFmt: (v) => fmt(v, 0) });
const ebsIopsChart = lineChart({
  series: [...cwSeries('wo', 1 / 60).map((s) => ({ ...s, name: `写 IOPS ${s.name}` })), ...cwSeries('ro', 1 / 60).map((s) => ({ ...s, name: `读 IOPS ${s.name}` }))],
  title: `数据盘 IOPS（CloudWatch 1 分钟）— gp3 配置 ${dataVol.iops} IOPS`, yLabel: 'IOPS', marks: phaseMarks, yFmt: (v) => fmt(v, 0),
});

const colTable = table(['列', '类型', '压缩后', '压缩前', '压缩比'], columns.slice(0, 12).map((c) => [
  `<code>${esc(c.name)}</code>`, `<code>${esc(c.type)}</code>`, bytes(num(c.compressed)), bytes(num(c.uncompressed)), `${fmt(num(c.uncompressed) / num(c.compressed), 1)}×`]));

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClickHouse on AWS — token_hub 性能测试报告</title>
<style>
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937;margin:0;background:#f8fafc}
main{max-width:1180px;margin:0 auto;padding:28px 28px 60px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:20px;margin:36px 0 10px;padding-bottom:6px;border-bottom:2px solid #e5e7eb}h3{font-size:16px;margin:22px 0 8px}
.sub{color:#6b7280;margin-bottom:20px}.muted{color:#6b7280}.bad{color:#dc2626;font-weight:600}.good{color:#16a34a;font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:18px 0}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px}.card .k{color:#6b7280;font-size:12px}.card .v{font-size:22px;font-weight:700;color:#1d4ed8;margin:4px 0}.card .d{font-size:12px;color:#4b5563}
table{border-collapse:collapse;width:100%;background:#fff;margin:8px 0 14px;font-size:13px}th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f1f5f9;font-weight:600}
td:not(:first-child):not(:nth-child(2)){font-variant-numeric:tabular-nums}
code{background:#f1f5f9;padding:1px 4px;border-radius:4px;font-size:12px}pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow:auto;font-size:12px}
.chart{width:100%;height:auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;margin:8px 0}
.ct{font-weight:600;font-size:13px;text-anchor:middle}.ya{font-size:11px;text-anchor:end;fill:#6b7280}.xa{font-size:11px;text-anchor:middle;fill:#374151}.yl{font-size:11px;text-anchor:middle;fill:#6b7280}
.bv{font-size:10px;text-anchor:middle;fill:#111827}.lg{font-size:11px;fill:#374151}.grid{stroke:#eef2f7}.mark{stroke:#9ca3af;stroke-dasharray:3 3}.mk{font-size:10px;fill:#6b7280}
.note{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin:10px 0}
.finding{background:#fff;border-left:4px solid #2563eb;padding:8px 14px;margin:8px 0;border-radius:0 8px 8px 0}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:900px){.two{grid-template-columns:1fr}}
</style></head><body><main>
<h1>ClickHouse on AWS ${esc(platform)} — token_hub 计费表性能测试报告</h1>
<div class="sub">集群 <b>${esc(params.ClusterName || '')}</b> · ClickHouse ${esc(version)} · ${esc(params.ShardCount || '1')} 分片 × ${esc(params.ReplicaCount || '2')} 副本 · ClickHouse Keeper × ${esc(params.KeeperCount || '3')} · 区域 us-west-2 · 测试时间 ${esc((results[0] || {}).ts || '')} – ${esc(endTs)} (UTC)</div>

<div class="cards">${cards.map(([k, v, d]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('')}</div>

<h2>1. 结论摘要</h2>
${findings || '<p class="muted">（未提供 findings.html）</p>'}
${comparisonSection()}

<h2>2. 测试环境</h2>
${table(['节点', '实例类型', '架构', '可用区', '系统盘 (/dev/xvda)', '数据盘 (/dev/sdb → /var/lib/clickhouse)'], envRows)}
${deployment || `<p>部署方式：本仓库的 CloudFormation 模版 <code>templates/clickhouse-cluster.template.json</code>（参数见 <code>${esc(exists('params-file.txt') ? read('params-file.txt').trim() : 'examples/perf-params.json')}</code>，ClickHouseVersion = ${esc(params.ClickHouseVersion || '')}）。系统盘与数据盘是两块独立的加密 gp3 EBS 卷，
数据盘采用 gp3 默认性能（3000 IOPS / 125 MiB/s）。副本跨 AZ（${chNodes.map((i) => i.az).join(' / ')}），Keeper 跨 3 个 AZ。
压测客户端是同 VPC 内一台独立的 m7g.2xlarge（us-west-2a），通过原生协议 9000 端口访问；写入在两个副本之间交替分发，读取默认只打 ch-s1-r1（"2 replicas" 场景除外）。</p>`}
<h3>表结构</h3>
<p>按业务方提供的 token_hub 建表 DDL 创建 <code>token_hub.t_billing_records</code>（ReplicatedMergeTree，<code>PARTITION BY toYYYYMM(created_at) ORDER BY (kafka_meta_event_type, created_at, user_id)</code>）
和 <code>token_hub.t_billing_records_mv</code>（TO 物化视图，从 Kafka 源表解析 JSON）。与原 DDL 的差异（详见 <code>perf/sql/01_schema.sql</code>）：</p>
<ul>
<li>所有语句加了 <code>ON CLUSTER '{cluster}'</code>，两个副本同时建表。</li>
<li>Kafka 源表 <code>t_billing_events_kafka_source</code> 改为同结构的 <code>ENGINE = Null</code>：生产 Kafka（aliyuncs.com）从 AWS 不可达；向 Null 表 INSERT 会像 Kafka 消费一样触发物化视图，因此可以压测 MV 管道本身。</li>
${schemaNotes}
</ul>
<h3>测试数据</h3>
<p>合成数据由参数化视图 <code>bench.gen_billing_rows</code> 生成（<code>perf/sql/02_generators.sql</code>），每行是行号的确定性函数：90 天时间窗口（2026-07-14 → 2026-10-12，4 个月分区）、
10 万用户（强倾斜，少量头部用户贡献大部分请求）、30% 用户属于 5,000 个组织、24 个模型、20 个供应商、97% 成功率、80% 流式；trace_id / 各类 req_id 为随机十六进制字符串（与生产一样不可压缩）。
单行 Native 格式约 ${fmt(rowBytes, 0)} 字节，Kafka JSON 事件约 ${fmt(eventBytes, 0)} 字节。</p>

<h2>3. 写入压力测试（t_billing_records）</h2>
<h3>W1 — 服务端批量导入（INSERT … SELECT，生成 + 写入 + 复制）</h3>
<p>${fmt(w1.length)} 个批次 × 10M 行顺序执行，<code>max_insert_threads = 8</code>。总计 <b>${human(w1t.rows)}</b> 行，用时 <b>${fmt(w1t.seconds, 0)} s</b>，平均 <b>${human(w1t.rows / w1t.seconds)} rows/s</b>；
导入结束后副本 r2 追平 r1 用时 ${fmt(num(w1t.replication_catchup_s), 1)} s。</p>
${w1Chart}
<h3>W2 — 客户端批量写入（原生协议，每个 INSERT 10 万行）</h3>
${table(insertHead, [...w2.map((r) => insertRow('W2', r, rowBytes)), ...(w2q ? [insertRow('W2Q <code>insert_quorum=2</code>', w2q, rowBytes)] : [])])}
<div class="two">${w2Chart}${w2LatChart}</div>
<h3>W3 — 小批量写入（每个 INSERT 1,000 行）：同步 vs <code>async_insert</code></h3>
${table(insertHead, [w3s && insertRow('W3 同步写入', w3s, rowBytes), w3a && insertRow('W3 async_insert=1, wait=1', w3a, rowBytes)].filter(Boolean))}
<h3>W4 — 物化视图管道（Kafka 形态 JSON 事件 → 源表 → <code>t_billing_records_mv</code> → <code>t_billing_records</code>）</h3>
${table(insertHead, w4.map((r) => insertRow('W4', r, eventBytes)))}
${w4Chart}
<p>正确性校验：经 MV 解析写入的 ${human(num(w4c.check && w4c.check.mv_rows))} 行，与生成器直接产出的数据逐行哈希比对
（<code>sum(cityHash64(*))</code>）${w4c.check && w4c.check.identical == 1 ? '<b>完全一致</b>' : '<span class="bad">不一致</span>'}，说明 JSON → 列的类型转换（UInt64、DateTime64(3)、Decimal(5,4) 等）没有精度损失。</p>

<h2>4. 读取压力测试（t_billing_records_mv）</h2>
<p>所有查询都 <code>FROM token_hub.t_billing_records_mv</code>（TO 型物化视图，SELECT 实际读的是 <code>t_billing_records</code>）。工具是 <code>clickhouse-benchmark</code>，每个“查询 × 并发”组合压测 20 s；
带参数的查询（Q1–Q3、Q7）每次随机替换为 200 个真实 user_id / org_id / trace_id 之一，避免只命中单一缓存。查询前先做一轮预热。数据量 ${human(totalRows)} 行。</p>
${readTable}
<div class="two">${readQpsChart}${readLatChart}</div>
<h3>混合负载（16 并发，60 s）</h3>
<p>查询池由 Q1–Q6、Q8 的全部变体拼成：Q1/Q2/Q3 各 200 条（不同 user_id / org_id），其余各 1 条，所以负载约 99% 是“按租户”的 Q1–Q3（用户账单、用户明细、组织月报）。
“2 replicas” 场景由 clickhouse-benchmark 把每个查询随机发往 r1 或 r2，相当于客户端在两个副本之间做负载均衡。</p>
${table(['场景', '各副本执行量', '总 QPS', 'p50', 'p95', 'p99', 'p99.9'], mixedRows)}
<details><summary>查询 SQL</summary><pre>${esc(queriesSql)}</pre></details>

<h2>5. 存储</h2>
${table(['副本', '行数', 'Active parts', '分区数', '压缩后', '压缩前', '压缩比'], parts.map((p) => [host(p.host), human(num(p.rows)), fmt(num(p.active_parts)), fmt(num(p.partitions)),
  bytes(num(p.compressed)), bytes(num(p.uncompressed)), `${fmt(num(p.uncompressed) / num(p.compressed), 2)}×`]))}
${table(['副本', '磁盘', '已用', '总容量'], disks.map((d) => [host(d.host), d.name, bytes(num(d.total_space) - num(d.free_space)), bytes(num(d.total_space))]))}
<h3>占用空间最大的列</h3>
${colTable}

<h2>6. 资源使用（system.metric_log / CloudWatch）</h2>
<p class="muted">虚线标出各测试阶段（位置取该阶段第一条结果的时间，近似阶段开始）。写入阶段 CPU 只有 10–30%，数据盘写入却长时间顶在 125 MiB/s；读取阶段正好相反，CPU 接近 100%，磁盘几乎空闲。</p>
${cpuChart}${ebsWChart}${ebsRChart}${ebsIopsChart}

<h2>7. 测试方法与复现</h2>
<ul>
<li><code>perf/sql/01_schema.sql</code> — 建表 DDL（来自业务方提供的 token_hub DDL，差异见第 2 节）</li>
<li><code>perf/sql/02_generators.sql</code> — 合成数据生成器（参数化视图）</li>
<li><code>perf/sql/03_read_queries.sql</code> — 读取负载 Q1–Q8</li>
<li><code>perf/bench.sh</code> — 在压测机上执行全部写入 / 读取测试，结果写入 <code>/opt/bench/results</code></li>
<li><code>perf/fetch-metrics.sh</code> — 拉取实例 / 卷信息和 CloudWatch 指标；<code>perf/report.js</code> — 生成本报告</li>
</ul>
<p class="muted">说明：W2 / W3 / W4 中同一批数据文件在不同并发档位下重复写入，并关闭了 <code>insert_deduplicate</code>，因此表中这部分数据存在重复的 id，不影响吞吐测量。
写入延迟和内存取自两个副本的 <code>system.query_log</code>；读延迟来自 clickhouse-benchmark 的客户端统计（包含网络往返），精度 1 ms。</p>
</main></body></html>
`;
fs.writeFileSync(OUT, html);
console.log(`report written to ${OUT} (${html.length} bytes)`);
