#!/usr/bin/env node
/**
 * NetScope · 网络示波台 — 本地网络延迟/丢包测试服务
 *
 * 零依赖,Node.js >= 14。默认只绑定 127.0.0.1,仅供本机浏览器访问。
 *   node server.js            # http://127.0.0.1:8899
 *   PORT=9000 node server.js  # 自定义端口(占用时自动向后寻找)
 *   node server.js stop       # 一键停止全部实例并释放端口
 *   HOST=0.0.0.0 node server.js  # 允许局域网访问(注意:他人可借你本机发起探测)
 */
'use strict';

const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const dns = require('dns');
const https = require('https');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PORT = parseInt(process.env.PORT || '8899', 10);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* 主机名/IP 校验:只放行合法的域名与 IPv4/IPv6 形态,杜绝任何 shell 元字符 */
const HOST_RE = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function isValidHost(h) {
  return typeof h === 'string' && h.length <= 253 && HOST_RE.test(h) && !/\s/.test(h);
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/* ------------------------------------------------------------------ *
 * ICMP 探测:调用系统 ping(参数数组传参,无注入风险)
 * ------------------------------------------------------------------ */
function icmpPing(host, timeoutMs) {
  return new Promise((resolve) => {
    const plat = process.platform;
    // Windows: -w 毫秒;macOS/BSD: -W 毫秒;Linux: -W 秒
    const args =
      plat === 'win32' ? ['-n', '1', '-w', String(timeoutMs), host] :
      plat === 'darwin' ? ['-c', '1', '-W', String(timeoutMs), host] :
      ['-c', '1', '-W', String(Math.max(1, Math.round(timeoutMs / 1000))), host];

    let out = '';
    let settled = false;
    let child;
    const t0 = process.hrtime.bigint();

    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      try { child && child.kill('SIGKILL'); } catch (e) { /* noop */ }
      resolve(r);
    };

    try {
      child = spawn('ping', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: '无法调用系统 ping' });
    }

    // 兜底看门狗:即使参数解析异常也不让进程悬挂
    const killer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs + 1500);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => finish({
      ok: false,
      error: e.code === 'ENOENT' ? '系统未安装 ping 命令' : e.message,
    }));

    child.on('close', (code) => {
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      // 兼容英文/中文 locale 的输出
      const m =
        /time[=<]\s*([\d.]+)\s*ms/i.exec(out) ||
        /时间[=<]\s*([\d.]+)\s*毫秒/.exec(out);
      const ttlM = /(?:ttl|hop\s*limit)[=\s:]+(\d+)/i.exec(out);

      if (code === 0 && m) {
        return finish({ ok: true, latency: parseFloat(m[1]), ttl: ttlM ? parseInt(ttlM[1], 10) : null });
      }
      if (code === 0) {
        // 成功但解析不到 time=(极端本地化),退化为进程耗时并标记 approx
        return finish({
          ok: true, latency: Math.round(elapsedMs * 10) / 10,
          ttl: ttlM ? parseInt(ttlM[1], 10) : null, approx: true,
        });
      }
      let error = 'no reply';
      if (/unreachable|不可达/i.test(out)) error = 'unreachable';
      else if (/timeout|超时|100(\.0)?%\s*(packet\s*)?(loss|丢包)/i.test(out)) error = 'timeout';
      else if (/unknown|not\s*known|cannot\s*resolve|名称|name/i.test(out)) error = 'dns';
      finish({ ok: false, error });
    });
  });
}

/* ------------------------------------------------------------------ *
 * TCP 探测:测量 TCP 握手往返耗时(目标禁 ping 但有开放端口时适用)
 * ------------------------------------------------------------------ */
function tcpPing(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      socket.destroy();
      resolve(
        ok
          ? { ok: true, latency: Math.round(ms * 100) / 100 }
          : { ok: false, error: error || 'failed' }
      );
    };

    socket.setTimeout(timeoutMs, () => finish(false, 'timeout'));
    socket.once('error', (e) => finish(false, e.code || e.message));
    socket.once('connect', () => finish(true));
    try {
      socket.connect(port, host);
    } catch (e) {
      finish(false, 'invalid');
    }
  });
}

/* ------------------------------------------------------------------ *
 * IP 归属地(可选):经 ip-api.com 免费接口查询,带缓存与超时降级
 * ------------------------------------------------------------------ */
function dnsLookupIp(host) {
  return new Promise((resolve) => {
    dns.lookup(host, (err, addr) => resolve(err ? null : addr));
  });
}

function isPrivateIp(ip) {
  if (!ip) return true;
  let v = String(ip).toLowerCase();
  if (v.startsWith('::ffff:')) v = v.slice(7);
  if (v.includes(':')) {
    return v === '::1' || v === '::' || v.startsWith('fe8') || v.startsWith('fc') || v.startsWith('fd');
  }
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(v);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 127 || a === 10 || a === 0 ||
    (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) || v === '255.255.255.255';
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { done(JSON.parse(buf)); } catch (e) { done(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

const geoCache = new Map(); // key -> { data, ts }
const GEO_FIELDS = 'status,message,continent,continentCode,country,countryCode,regionName,city,district,zip,lat,lon,timezone,currency,isp,org,as,asname,reverse,mobile,proxy,hosting,query';
async function lookupGeo(ip) {
  const key = ip || '__self__';
  const hit = geoCache.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < (hit.data && hit.data.ok ? 600000 : 60000)) return hit.data;
  const url = `http://ip-api.com/json/${ip ? encodeURIComponent(ip) : ''}?fields=${GEO_FIELDS}&lang=zh-CN`;
  let j = await httpGetJson(url, 6500);
  if (!j) j = await httpGetJson(url, 6500); // 慢速网络重试一次
  const data = (j && j.status === 'success')
    ? {
        ok: true, ip: j.query || ip || undefined,
        country: j.country, countryCode: j.countryCode,
        continent: j.continent, region: j.regionName, city: j.city,
        district: j.district, zip: j.zip,
        lat: typeof j.lat === 'number' ? j.lat : null,
        lon: typeof j.lon === 'number' ? j.lon : null,
        timezone: j.timezone, currency: j.currency,
        isp: j.isp, org: j.org, as: j.as, asname: j.asname,
        reverse: j.reverse,
        mobile: typeof j.mobile === 'boolean' ? j.mobile : null,
        proxy: typeof j.proxy === 'boolean' ? j.proxy : null,
        hosting: typeof j.hosting === 'boolean' ? j.hosting : null,
      }
    : { ok: false, error: (j && j.message) || 'lookup failed' };
  geoCache.set(key, { data, ts: now });
  return data;
}

/* 当前默认路由实际使用的本机 IP 与网卡:解析系统路由表,完全离线、不发包。
 * 若默认路由走虚拟网卡(utun/tun 等,通常是代理或 VPN 隧道),
 * "当前网络 IP" 回退到物理网卡地址,并单独标注路由走了隧道,避免误导 */
const VIRTUAL_IF_RE = /^(utun|tun|tap|wg|ppp|virbr|docker|veth|zt|tailscale|llw|awdl|bridge|ham|nordlynx)/i;
const PHYSICAL_IF_RE = /^(en|eth|eno|ens|wlan|wlp|wl|p2p0|ge|-)/i;

function ifAddrOf(name) {
  const list = (os.networkInterfaces() || {})[name] || [];
  const a = list.find((x) => x.family === 'IPv4' && !x.internal);
  return a ? a.address : null;
}
function physicalIf() {
  const ifs = os.networkInterfaces() || {};
  const cands = Object.keys(ifs).filter((n) => !VIRTUAL_IF_RE.test(n) && ifAddrOf(n));
  cands.sort((a, b) => {
    const w = (n) => (/^(en0|eth0)$/i.test(n) ? 0 : PHYSICAL_IF_RE.test(n) ? 1 : 2);
    return w(a) - w(b);
  });
  return cands[0] ? { ip: ifAddrOf(cands[0]), if: cands[0] } : { ip: null, if: null };
}
function detectActiveIp() {
  return new Promise((resolve) => {
    const plat = process.platform;
    const finish = (routeIf) => {
      const virtual = !!routeIf && VIRTUAL_IF_RE.test(routeIf);
      const phys = physicalIf();
      if (!routeIf || virtual) {
        return resolve({ ip: phys.ip, if: phys.if, routeIf: routeIf || null, routeVirtual: virtual && !!routeIf });
      }
      resolve({ ip: ifAddrOf(routeIf), if: routeIf, routeIf, routeVirtual: false });
    };
    try {
      if (plat === 'win32') {
        const out = execSync(
          'powershell -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { $null -ne $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress"',
          { timeout: 4000 }
        ).toString().trim();
        const ifs = os.networkInterfaces() || {};
        const hit = Object.keys(ifs).find((n) =>
          (ifs[n] || []).some((a) => a.family === 'IPv4' && !a.internal && a.address === out));
        return finish(hit || null);
      }
      if (plat === 'linux') {
        const out = execSync('ip route get 8.8.8.8 2>/dev/null', { timeout: 3000 }).toString();
        const dev = /(?:^|\s)dev (\S+)/.exec(out);
        return finish(dev ? dev[1] : null);
      }
      // darwin / bsd
      const out = execSync('route -n get 8.8.8.8 2>/dev/null', { timeout: 3000 }).toString();
      const m = /interface:\s*(\S+)/.exec(out);
      return finish(m ? m[1] : null);
    } catch (e) {
      return finish(null);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 带宽测试:经 Cloudflare 公共测速端点(speed.cloudflare.com)
 * 下载 __down?bytes=N / 上传 __up;SSE 实时推送速率,支持中途取消
 * ------------------------------------------------------------------ */
const CF_HOST = 'speed.cloudflare.com';
const speedAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });
let speedTestRunning = false;

function cfRequest(opts, body, timeoutMs, onData) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = https.request({
      hostname: CF_HOST, agent: speedAgent, ...opts,
    }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; if (onData) onData(c.length); });
      res.on('end', () => resolve({
        bytes, ms: Number(process.hrtime.bigint() - t0) / 1e6, status: res.statusCode,
      }));
      res.on('error', reject);
      if (timeoutMs) {
        const killer = setTimeout(() => { try { req.destroy(); } catch (e) { } reject(new Error('timeout')); }, timeoutMs);
        res.on('end', () => clearTimeout(killer));
      }
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

/* 下载指定字节数 */
function downBytes(n) {
  return cfRequest({ path: `/__down?bytes=${n}` }, null, 15000);
}

/* 主测速:K 路并行下载,限时 windowMs;流中实时计数,1 秒滚动窗口平滑回报 */
async function downloadWindow(K, MB, windowMs, isAborted, onSample) {
  const per = MB * 1e6;
  const t0 = performance.now();
  let total = 0;
  const hist = []; // {t, total}
  const tasks = Array.from({ length: K }, () => (async () => {
    while (performance.now() - t0 < windowMs && !isAborted()) {
      const r = await cfRequest({ path: `/__down?bytes=${per}` }, null, windowMs + 4000,
        (n) => { total += n; });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
    }
  })());
  const timer = setInterval(() => {
    const now = performance.now();
    hist.push({ t: now, total });
    while (hist.length > 2 && now - hist[0].t > 1000) hist.shift();
    const ref = hist[0];
    const dt = (now - ref.t) / 1000;
    if (dt > 0.2) onSample(((total - ref.total) * 8) / 1e6 / dt);
  }, 250);
  try {
    await Promise.allSettled(tasks);
  } finally {
    clearInterval(timer);
  }
  const el = (performance.now() - t0) / 1000;
  return { mbps: (total * 8) / 1e6 / Math.max(0.001, el), bytes: total, sec: el };
}

/* 上传:多轮并行 POST 随机数据 */
async function uploadRounds(rounds, K, MB, isAborted, onSample) {
  const buf = crypto.randomBytes(MB * 1e6);
  let total = 0, t0 = performance.now();
  for (let r = 0; r < rounds && !isAborted(); r++) {
    const res = await Promise.allSettled(Array.from({ length: K }, () =>
      cfRequest({ path: '/__up', method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length } }, buf, 15000)
        .then((x) => { if (x.status !== 200 && x.status !== 204) throw new Error('HTTP ' + x.status); total += buf.length; })
    ));
    const fails = res.filter((x) => x.status === 'rejected').length;
    if (fails === K) throw new Error('upload failed');
    const el = (performance.now() - t0) / 1000;
    onSample((total * 8) / 1e6 / el, total);
  }
  const el = (performance.now() - t0) / 1000;
  return { mbps: (total * 8) / 1e6 / Math.max(0.001, el), bytes: total, sec: el };
}

async function runSpeedTest(send, isAborted) {
  /* 1) 延迟探测:8 次 0 字节请求 */
  send({ type: 'phase', phase: 'latency', label: '延迟探测' });
  const rtts = [];
  for (let i = 0; i < 8 && !isAborted(); i++) {
    const t0 = performance.now();
    try { await downBytes(0); rtts.push(performance.now() - t0); } catch (e) { break; }
  }
  if (!rtts.length) throw new Error('无法连接测速节点(检查网络)');
  const ping = {
    min: Math.min(...rtts), max: Math.max(...rtts),
    avg: rtts.reduce((a, b) => a + b, 0) / rtts.length,
    jitter: Math.abs(rtts[rtts.length - 1] - rtts[0]) || 0,
  };
  send({ type: 'ping', ping, samples: rtts.length });

  /* 2) 下载:预热 1MB → 4 路并行 10MB×循环,限时 9 秒 */
  if (isAborted()) return { ping };
  send({ type: 'phase', phase: 'download', label: '正在测下载' });
  try { await downBytes(1e6); } catch (e) { /* 预热失败继续 */ }
  const dl = await downloadWindow(4, 10, 9000, isAborted, (mbps) =>
    send({ type: 'progress', dir: 'down', mbps }));

  /* 3) 上传:2 轮 × 3 路并行 × 4MB */
  if (isAborted()) return { ping, dl };
  send({ type: 'phase', phase: 'upload', label: '正在测上传' });
  const ul = await uploadRounds(2, 3, 4, isAborted, (mbps) =>
    send({ type: 'progress', dir: 'up', mbps }));

  return { ping, dl, ul };
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */
async function handleApi(url, res) {
  if (url.pathname === '/api/info') {
    return sendJSON(res, 200, {
      ok: true,
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      node: process.version,
      hostname: os.hostname(),
      uptime: Math.round(os.uptime()),
      now: Date.now(),
    });
  }

  if (url.pathname === '/api/speedtest') {
    if (speedTestRunning) return sendJSON(res, 409, { ok: false, error: '已有测速在进行中' });
    speedTestRunning = true;
    let aborted = false;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    if (res.flushHeaders) res.flushHeaders();
    res.on('close', () => { aborted = true; });
    const send = (obj) => { if (!aborted) { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { } } };
    send({ type: 'phase', phase: 'start', label: '正在连接测速节点' });
    let result = null;
    try {
      result = await runSpeedTest(send, () => aborted);
      send({ type: 'done', ...result });
    } catch (e) {
      send({ type: 'error', error: String((e && e.message) || e) });
    } finally {
      speedTestRunning = false;
      try { res.end(); } catch (e) { /* 忽略 */ }
    }
    return;
  }

  if (url.pathname === '/api/network') {
    // 本机网络全貌:出口 IP 属性(经 ip-api.com)+ 本地环境与内网网卡
    const exit = await lookupGeo('');
    const locals = [];
    const ifaces = os.networkInterfaces() || {};
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const a of (addrs || [])) {
        if (a.family === 'IPv4' && !a.internal) locals.push({ name, address: a.address });
      }
    }
    const active = await detectActiveIp();
    const activeIp = active.ip;
    const activeIf = active.if ||
      (activeIp ? (locals.find((i) => i.address === activeIp) || {}).name || null : null);
    return sendJSON(res, 200, {
      ok: true,
      exit: exit && exit.ok ? exit : null,
      local: {
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        hostname: os.hostname(),
        node: process.version,
        uptime: Math.round(os.uptime()),
        activeIp,
        activeIf,
        routeIf: active.routeIf,
        routeVirtual: !!active.routeVirtual,
        interfaces: locals,
      },
      fetchedAt: new Date().toISOString(),
    });
  }

  if (url.pathname === '/api/geo') {
    const hostParam = (url.searchParams.get('host') || '').trim();
    if (!hostParam) {
      // 无 host:查询本机出口 IP 的归属地
      const self = await lookupGeo('');
      return sendJSON(res, 200, { ...self, self: true });
    }
    if (!isValidHost(hostParam)) {
      return sendJSON(res, 400, { ok: false, error: 'invalid host' });
    }
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostParam) || hostParam.includes(':');
    const ip = isIp ? hostParam : await dnsLookupIp(hostParam);
    if (!ip) return sendJSON(res, 200, { ok: false, error: 'dns' });
    if (isPrivateIp(ip)) {
      return sendJSON(res, 200, { ok: true, private: true, ip, country: '本机 / 局域网' });
    }
    const g = await lookupGeo(ip);
    return sendJSON(res, 200, { ...g, ip });
  }

  if (url.pathname === '/api/ping') {
    const host = (url.searchParams.get('host') || '').trim();
    const mode = url.searchParams.get('mode') === 'tcp' ? 'tcp' : 'icmp';
    const port = clampInt(url.searchParams.get('port'), 1, 65535, 443);
    const timeout = clampInt(url.searchParams.get('timeout'), 300, 10000, 2000);

    if (!isValidHost(host)) {
      return sendJSON(res, 400, { ok: false, error: '目标格式不合法:仅支持 IP 或域名' });
    }

    const started = Date.now();
    const r = mode === 'tcp' ? await tcpPing(host, port, timeout) : await icmpPing(host, timeout);

    return sendJSON(res, 200, {
      ok: r.ok,
      mode,
      host,
      ts: started,
      rtt: r.ok ? r.latency : null,
      ttl: r.ttl || null,
      approx: !!r.approx,
      error: r.error || null,
    });
  }

  return sendJSON(res, 404, { ok: false, error: 'not found' });
}

/* ------------------------------------------------------------------ *
 * 静态文件服务
 * ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(url, res).catch((e) =>
      sendJSON(res, 500, { ok: false, error: String((e && e.message) || e) })
    );
  }

  let p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/* ------------------------------------------------------------------ *
 * 实例登记与一键停止(node server.js stop / stop.command / stop.bat)
 * 目的:终端退出、Ctrl+C、关窗都能立即释放端口;残留实例可一键清理
 * ------------------------------------------------------------------ */
const REG_FILE = path.join(__dirname, '.netscope.pids');
const PORT_MIN = DEFAULT_PORT, PORT_MAX = DEFAULT_PORT + 19;

function regRead() {
  try {
    return fs.readFileSync(REG_FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) { return []; }
}
function regAdd(pid, port) {
  const lines = regRead().filter((l) => !l.startsWith(pid + ' '));
  lines.push(`${pid} ${port}`);
  try { fs.writeFileSync(REG_FILE, lines.join('\n') + '\n'); } catch (e) { /* 只读目录时忽略 */ }
}
function regRemove(pid) {
  const lines = regRead().filter((l) => !l.startsWith(pid + ' '));
  try {
    if (lines.length) fs.writeFileSync(REG_FILE, lines.join('\n') + '\n');
    else fs.unlinkSync(REG_FILE);
  } catch (e) { /* 忽略 */ }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function stopAll() {
  console.log('NetScope 端口清理');
  let n = 0;
  const seen = new Set();
  // 1) 登记表中的实例(最可靠)
  for (const line of regRead()) {
    const pid = parseInt(line, 10);
    if (!Number.isInteger(pid) || pid === process.pid || seen.has(pid) || !pidAlive(pid)) continue;
    seen.add(pid);
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`  已停止实例 PID ${pid}`);
      n++;
    } catch (e) { /* 已退出 */ }
  }
  // 2) 兜底:清理仍监听在本应用端口区间的 node 进程(处理登记丢失的残留)
  try {
    if (process.platform === 'win32') {
      execSync(`powershell -NoProfile -Command "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge ${PORT_MIN} -and $_.LocalPort -le ${PORT_MAX} } | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match 'node') { Stop-Process -Id $_.OwningProcess -Force } }"`, { stdio: 'ignore' });
    } else {
      const out = execSync(`lsof -ti :${PORT_MIN}-${PORT_MAX} -sTCP:LISTEN 2>/dev/null || true`).toString();
      for (const s of out.split('\n').map((x) => x.trim()).filter(Boolean)) {
        const pid = parseInt(s, 10);
        if (!Number.isInteger(pid) || pid === process.pid || seen.has(pid)) continue;
        let isNode = true;
        try { isNode = /node/i.test(execSync(`ps -p ${pid} -o comm=`).toString()); } catch (e) {}
        if (!isNode) continue;
        try {
          process.kill(pid, 'SIGTERM');
          console.log(`  已停止残留实例 PID ${pid}(监听端口 ${PORT_MIN}–${PORT_MAX})`);
          n++; seen.add(pid);
        } catch (e) { /* 已退出 */ }
      }
    }
  } catch (e) { /* lsof/powershell 不可用时跳过兜底 */ }
  try { fs.unlinkSync(REG_FILE); } catch (e) { /* 忽略 */ }
  console.log(n
    ? `  完成,共停止 ${n} 个实例,端口 ${PORT_MIN}–${PORT_MAX} 已释放。`
    : '  未发现正在运行的 NetScope 实例,端口本来就是空闲的。');
}

if (process.argv[2] === 'stop') {
  stopAll();
  process.exit(0);
}

/* 优雅关闭:Ctrl+C(SIGINT)、kill(SIGTERM)、关闭终端窗口(SIGHUP)都立即释放端口 */
function shutdown(sig) {
  regRemove(process.pid);
  try { server.close(); } catch (e) { /* 忽略 */ }
  console.log(`\n  已收到 ${sig},服务停止,端口已释放。`);
  process.exit(0);
}
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((s) => process.on(s, () => shutdown(s)));
process.on('exit', () => regRemove(process.pid));

/* ------------------------------------------------------------------ *
 * 启动:端口被占自动顺延;就绪后自动打开浏览器
 * ------------------------------------------------------------------ */
function listen(port, tries) {
  if (tries <= 0) {
    console.error(`端口 ${DEFAULT_PORT} 起 20 个连续端口均被占用,请用 PORT=xxxx 指定,例如:PORT=9100 node server.js`);
    process.exit(1);
  }
  const onAttemptError = (e) => {
    server.removeListener('error', onAttemptError);
    if (e.code === 'EADDRINUSE') {
      console.log(`  端口 ${port} 已被占用(可能是另一个 NetScope 实例在运行),自动改用 ${port + 1} …`);
      setImmediate(() => listen(port + 1, tries - 1));
    } else if (e.code === 'EACCES') {
      console.error(`  端口 ${port} 无权限绑定,请换一个端口,例如:PORT=9100 node server.js`);
      process.exit(1);
    } else {
      console.error('启动失败:', e.message);
      process.exit(1);
    }
  };
  server.on('error', onAttemptError);
  server.listen(port, HOST, () => {
    server.removeListener('error', onAttemptError);
    // 运行期异常只记录,不退出
    server.on('error', (e) => console.error('服务运行异常:', e.message));
    regAdd(process.pid, server.address().port);
    const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${server.address().port}`;
    console.log('');
    console.log('  NetScope · 网络示波台 已启动');
    console.log(`  ➜  ${url}`);
    console.log(`  环境 ${os.platform()}/${os.arch()} · Node ${process.version} · 仅监听 ${HOST}`);
    console.log('  停止:关闭本窗口 / Ctrl+C;清理全部实例:node server.js stop');
    console.log('');
    openBrowser(url);
  });
}

/* 启动后自动打开浏览器:NETSCOPE_OPEN=1 强制开启(启动器使用);
 * 交互式终端默认开启;后台/脚本运行(NETSCOPE_NO_OPEN=1 或非终端)不弹窗 */
function openBrowser(url) {
  if (process.env.NETSCOPE_NO_OPEN) return;
  const forced = process.env.NETSCOPE_OPEN === '1';
  if (!forced && (!process.stdout || !process.stdout.isTTY)) return;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch (e) { /* 打不开就算了,手动访问即可 */ }
}

listen(DEFAULT_PORT, 20);
