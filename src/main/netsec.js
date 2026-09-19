/**
 * 网络安全工作台（主进程）
 * ------------------------------------------------------------------
 * 两类能力，全部仅监听/发起于本机，用于运维自查与内网接口联调：
 *   1. 请求构造与重放（类 Postman）：任意 method/headers/body 发送，超时与体积上限保护
 *   2. 本地抓包代理（类 BurpSuite 的 HTTP 部分）：
 *        - 仅绑定 127.0.0.1；应用侧把浏览器/工具代理指到本端口即可捕获
 *        - 明文 HTTP：可开「断点」暂存请求 → 界面修改后重放 / 丢弃；不开断点则透明转发
 *        - HTTPS：CONNECT 隧道直通（不解密内容，仅记录域名、字节数、时长）
 *          如需 MITM 解密 HTTPS，需额外引入 node-forge 生成站点证书（见依赖清单说明）
 *
 * 数据落库：apiCases（收藏的请求）、apiHistory（发送与抓包记录，滚动上限）
 */
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');
const store = require('./store');

const HISTORY_CAP = 200;
const MAX_BODY_BYTES = 5 * 1024 * 1024;      // 单请求/响应体上限 5MB
const DEFAULT_TIMEOUT_MS = 30000;
const BREAKPOINT_HOLD_MS = 120000;           // 断点最长暂存 2 分钟，超时自动放行

/* ------------------------------------------------------------------
 * 历史与案例
 * ------------------------------------------------------------------ */

function addHistory(entry) {
    const arr = store.list('apiHistory');
    arr.unshift({ id: store.uid('nh_'), at: store.nowText(), ...entry });
    if (arr.length > HISTORY_CAP) arr.length = HISTORY_CAP;
    store.persist();
}

function listHistory(limit = HISTORY_CAP) {
    return store.list('apiHistory').slice(0, limit);
}

function clearHistory() {
    store.set('apiHistory', []);
    return { ok: true };
}

const listCases = () => store.list('apiCases');

function saveCase(payload = {}) {
    return { ok: true, case: store.upsert('apiCases', { ...payload, updatedAt: store.nowText() }) };
}

function deleteCase(id) {
    return { ok: store.remove('apiCases', id) };
}

/* ------------------------------------------------------------------
 * 请求发送（Postman 类）
 * payload: { method, url, headers:{}, body:'', timeoutMs, followRedirect }
 * ------------------------------------------------------------------ */

function sendRequest(payload = {}) {
    return new Promise(resolve => {
        let target;
        try {
            target = new URL(String(payload.url || ''));
        } catch (e) {
            return resolve({ ok: false, message: 'URL 不合法：' + e.message });
        }
        if (!/^https?:$/.test(target.protocol)) {
            return resolve({ ok: false, message: '仅支持 http/https 协议' });
        }
        const isHttps = target.protocol === 'https:';
        const lib = isHttps ? https : http;
        const method = String(payload.method || 'GET').toUpperCase();
        const headers = { ...(payload.headers || {}) };
        const body = payload.body != null && !['GET', 'HEAD'].includes(method) ? String(payload.body) : null;
        if (body != null && !Object.keys(headers).some(k => k.toLowerCase() === 'content-length')) {
            headers['Content-Length'] = Buffer.byteLength(body);
        }
        const startedAt = Date.now();
        const req = lib.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (isHttps ? 443 : 80),
            path: (target.pathname || '/') + (target.search || ''),
            method,
            headers,
            timeout: Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS
        }, res => {
            const chunks = [];
            let size = 0;
            let truncated = false;
            res.on('data', c => {
                size += c.length;
                if (size <= MAX_BODY_BYTES) chunks.push(c);
                else if (!truncated) truncated = true;
            });
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({
                    ok: true,
                    status: res.statusCode,
                    statusText: res.statusMessage,
                    headers: res.headers,
                    body: text,
                    truncated,
                    durationMs: Date.now() - startedAt,
                    sizeBytes: size
                });
            });
            res.on('error', err => resolve({ ok: false, message: '读取响应失败：' + err.message }));
        });
        req.on('timeout', () => { req.destroy(new Error('请求超时')); });
        req.on('error', err => resolve({
            ok: false,
            message: err.message,
            durationMs: Date.now() - startedAt
        }));
        if (body != null) req.write(body);
        req.end();
    });
}

/** 发送并记入历史（IPC 入口用） */
async function sendAndLog(payload = {}) {
    const res = await sendRequest(payload);
    addHistory({
        source: 'manual',
        method: String(payload.method || 'GET').toUpperCase(),
        url: String(payload.url || ''),
        status: res.ok ? res.status : 'error',
        durationMs: res.durationMs || 0,
        sizeBytes: res.sizeBytes || 0,
        message: res.ok ? '' : res.message
    });
    return res;
}

/* ------------------------------------------------------------------
 * 抓包代理
 * ------------------------------------------------------------------ */

const proxy = {
    server: null,
    port: 0,
    breakpoints: false,
    httpsTunnel: true,
    stats: { requests: 0, tunnels: 0, bytes: 0 },
    emitter: null,          // (event, payload) => void，由 handler 注入 webContents.send
    pending: new Map()      // id → { record, resolve }
};

const pushEvent = (name, payload) => {
    try { if (proxy.emitter) proxy.emitter(name, payload); } catch (e) { /* 窗口已关闭 */ }
};

function headerPairs(raw) {
    const out = {};
    Object.entries(raw || {}).forEach(([k, v]) => { out[k] = Array.isArray(v) ? v.join('\n') : String(v); });
    return out;
}

/** 抓包记录 → 推送到界面 */
function logPacket(record) {
    proxy.stats.requests++;
    proxy.stats.bytes += (record.body ? record.body.length : 0);
    addHistory({
        source: 'proxy',
        method: record.method,
        url: record.url,
        status: record.result === 'breakpoint-drop' ? 'dropped' : (record.status || record.result),
        durationMs: record.durationMs || 0,
        sizeBytes: record.sizeBytes || 0
    });
    pushEvent('packet', record);
}

/** 把一个 Record（{method, url, headers, body}）真正发出去并回写浏览器 socket */
function forwardToClient(socket, record) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        let target;
        try { target = new URL(record.url); } catch (e) {
            socket.write('HTTP/1.1 400 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
            return resolve({ result: 'bad-url' });
        }
        const isHttps = target.protocol === 'https:';
        const lib = isHttps ? https : http;
        const headers = headerPairs(record.headers);
        delete headers['proxy-connection'];
        const body = record.body ? Buffer.from(record.body, 'base64') : null;
        const req = lib.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (isHttps ? 443 : 80),
            path: (target.pathname || '/') + (target.search || ''),
            method: record.method,
            headers,
            timeout: DEFAULT_TIMEOUT_MS
        }, upstream => {
            const head = [`HTTP/1.1 ${upstream.statusCode} ${upstream.statusMessage || ''}`.trimEnd()];
            Object.entries(upstream.headers).forEach(([k, v]) => {
                (Array.isArray(v) ? v : [v]).forEach(item => head.push(`${k}: ${item}`));
            });
            head.push('Connection: close');
            socket.write(head.join('\r\n') + '\r\n\r\n');
            let size = 0;
            upstream.on('data', c => { size += c.length; if (!socket.destroyed) socket.write(c); });
            upstream.on('end', () => {
                if (!socket.destroyed) socket.end();
                resolve({ status: upstream.statusCode, durationMs: Date.now() - startedAt, sizeBytes: size });
            });
            upstream.on('error', () => { if (!socket.destroyed) socket.destroy(); resolve({ result: 'upstream-error' }); });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', err => {
            if (!socket.destroyed) {
                socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
                socket.end();
            }
            resolve({ result: 'error', message: err.message });
        });
        if (body) req.write(body);
        req.end();
    });
}

/**
 * 断点流程：推给界面等待决策
 * 决策 action：forward（可携带修改后的 request/response）· drop · replay
 */
function holdForBreakpoint(socket, record) {
    return new Promise(resolve => {
        const id = store.uid('bp_');
        const timer = setTimeout(() => {
            proxy.pending.delete(id);
            resolve(null);       // null → 调用方超时自动放行
        }, BREAKPOINT_HOLD_MS);
        proxy.pending.set(id, {
            timer,
            finish: decision => {
                clearTimeout(timer);
                proxy.pending.delete(id);
                resolve(decision);
            }
        });
        pushEvent('breakpoint', { id, record });
    });
}

/** 渲染进程提交断点决策 */
function resolveBreakpoint(payload = {}) {
    const entry = proxy.pending.get(payload.id);
    if (!entry) return { ok: false, message: '该断点已超时或已处理' };
    entry.finish({ action: payload.action || 'forward', modified: payload.modified || null });
    return { ok: true };
}

function handleHttpOnSocket(socket, firstReq) {
    const processRequest = req => {
        const chunks = [];
        req.on('data', c => {
            if (Buffer.concat(chunks).length < MAX_BODY_BYTES) chunks.push(c);
        });
        req.on('end', async () => {
            let decision = null;
            const base = {
                method: req.method,
                url: req.url,
                headers: req.headers,
                body: Buffer.concat(chunks).toString('base64'),
                remote: (socket.remoteAddress || '') + ':' + (socket.remotePort || '')
            };
            const record = { id: store.uid('pk_'), kind: 'http', at: store.nowText(), ...base };

            if (proxy.breakpoints) {
                decision = await holdForBreakpoint(socket, record);
                if (decision && decision.action === 'drop') {
                    if (!socket.destroyed) socket.end();
                    logPacket({ ...record, result: 'breakpoint-drop' });
                    return;
                }
            }
            const outgoing = (decision && decision.modified) ? { ...base, ...decision.modified } : base;
            const result = await forwardToClient(socket, outgoing);
            logPacket({ ...record, ...result, result: result.result || 'forwarded' });
        });
    };
    processRequest(firstReq);
    socket.on('error', () => socket.destroy());
}

function handleConnect(req, clientSocket, head) {
    const [host, portText] = String(req.url).split(':');
    const port = Number(portText) || 443;
    const startedAt = Date.now();
    const logTunnel = (ok, message) => {
        proxy.stats.tunnels++;
        addHistory({
            source: 'proxy', kind: 'connect',
            method: 'CONNECT', url: `https://${host}:${port}`,
            status: ok ? 'tunnel' : 'error', message: message || '',
            durationMs: Date.now() - startedAt
        });
        pushEvent('packet', {
            id: store.uid('pk_'), kind: 'connect', at: store.nowText(),
            method: 'CONNECT', url: `${host}:${port}`,
            result: ok ? 'tunnel' : 'error', message: message || ''
        });
    };
    if (!proxy.httpsTunnel) {
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return clientSocket.end();
    }
    const upstream = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        let bytes = 0;
        const counter = c => { bytes += c.length; proxy.stats.bytes += c.length; };
        upstream.on('data', counter);
        clientSocket.on('data', counter);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        const done = () => { upstream.destroy(); clientSocket.destroy(); void bytes; };
        upstream.on('error', done);
        clientSocket.on('error', done);
        upstream.on('close', () => clientSocket.end());
        clientSocket.on('close', () => upstream.destroy());
        logTunnel(true);
    });
    upstream.on('error', err => logTunnel(false, err.message));
}

function proxyStart(options = {}) {
    return new Promise(resolve => {
        if (proxy.server) {
            return resolve({ ok: true, already: true, port: proxy.port });
        }
        const port = Number(options.port) || 8899;
        proxy.breakpoints = !!options.breakpoints;
        proxy.httpsTunnel = options.httpsTunnel !== false;
        proxy.stats = { requests: 0, tunnels: 0, bytes: 0 };
        const server = http.createServer();
        server.on('connect', handleConnect);
        server.on('request', req => handleHttpOnSocket(req.socket, req));
        server.on('error', err => {
            proxy.server = null;
            resolve({ ok: false, message: '代理启动失败：' + err.message });
        });
        server.listen(port, '127.0.0.1', () => {
            proxy.server = server;
            proxy.port = port;
            resolve({ ok: true, port, breakpoints: proxy.breakpoints });
        });
    });
}

function proxyStop() {
    proxy.pending.forEach(entry => {
        clearTimeout(entry.timer);
        entry.finish({ action: 'forward' });
    });
    proxy.pending.clear();
    if (proxy.server) {
        try { proxy.server.close(); } catch (e) { /* ignore */ }
        proxy.server = null;
        proxy.port = 0;
    }
    return { ok: true };
}

const proxyStatus = () => ({
    running: !!proxy.server,
    port: proxy.port,
    breakpoints: proxy.breakpoints,
    httpsTunnel: proxy.httpsTunnel,
    pendingBreakpoints: proxy.pending.size,
    stats: { ...proxy.stats }
});

module.exports = {
    sendAndLog,
    proxyStart, proxyStop, proxyStatus, resolveBreakpoint,
    setEmitter: fn => { proxy.emitter = fn; },
    listHistory, clearHistory,
    listCases, saveCase, deleteCase
};
