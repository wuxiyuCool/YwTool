/**
 * 容器编排与运维（主进程）
 * ------------------------------------------------------------------
 * 通过 Docker Engine HTTP API 直连守护进程，零新增依赖：
 *   - 本机：命名管道 //./pipe/docker_engine（Windows）或 /var/run/docker.sock（Linux）
 *   - 远程：TCP 端点（可选 Bearer Token；生产建议配合 TLS 反向代理，v1 不内置客户端证书）
 * Compose 编排通过 spawn 本机 docker CLI 执行（需要 docker compose 插件；
 *   纯 API 无法运行 compose，属 Docker 官方限制，已在界面说明）。
 * exec 采用 HTTP Upgrade 流复用（hijack），解析 Docker 多路复用帧后回传 stdout/stderr。
 */
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const { decrypt } = require('./crypto');

const API_VERSION = 'v1.41';
const PIPE_WINDOWS = String.raw`\\.\pipe\docker_engine`;
const PIPE_LINUX = '/var/run/docker.sock';
const EXEC_TIMEOUT_MS = 20000;
const LOG_TAIL_DEFAULT = 300;

const localPipe = () => (process.platform === 'win32' ? PIPE_WINDOWS : PIPE_LINUX);

/** host 记录 → 连接参数 */
function transportOf(host) {
    const kind = host.kind || 'pipe';
    if (kind === 'tcp') {
        if (!host.host) throw new Error('TCP 端点需要填写主机地址');
        return { host: host.host, port: Number(host.port) || 2375 };
    }
    return { socketPath: host.pipePath || localPipe() };
}

function authHeaders(host) {
    const token = host.token ? decrypt(host.token) : '';
    return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 通用 API 请求；非 2xx 时把 Docker 的 message 抛出 */
function apiRequest(host, method, apiPath, body) {
    return new Promise((resolve, reject) => {
        let transport;
        try { transport = transportOf(host); } catch (err) { return reject(err); }
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
        const req = http.request({
            ...transport,
            method,
            path: `/${API_VERSION}${apiPath}`,
            headers: {
                ...authHeaders(host),
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
            },
            timeout: 10000
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    if (!text) return resolve({});
                    try { resolve(JSON.parse(text)); } catch (e) { resolve(text); }
                } else {
                    let msg = text.slice(0, 200);
                    try { msg = JSON.parse(text).message || msg; } catch (e) { /* keep */ }
                    reject(new Error(`Docker API ${res.statusCode}：${msg}`));
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Docker 守护进程响应超时')));
        req.on('error', err => reject(new Error(
            /ENOENT|EACCES|connect/.test(err.code || err.message)
                ? `${err.message}（请确认 Docker Desktop / dockerd 已启动，或检查端点配置）`
                : err.message)));
        if (payload) req.write(payload);
        req.end();
    });
}

/** 解析 Docker 多路复用日志流（帧头 [1|2|3][0,0,0][4 字节大端长度]）；非该格式原样返回 */
function demuxStream(buf) {
    const out = [];
    let i = 0;
    let framed = true;
    while (i + 8 <= buf.length) {
        const type = buf[i];
        const len = buf.readUInt32BE(i + 4);
        if (type > 3 || i + 8 + len > buf.length) { framed = false; break; }
        out.push(buf.subarray(i + 8, i + 8 + len));
        i += 8 + len;
    }
    if (!framed || i === 0) return buf.toString('utf8');
    return Buffer.concat(out).toString('utf8');
}

/* ------------------------------------------------------------------
 * 主机连通性与资源查询
 * ------------------------------------------------------------------ */

async function testHost(host) {
    const started = Date.now();
    try {
        const info = await apiRequest(host, 'GET', '/version');
        return { ok: true, durationMs: Date.now() - started, message: `连接成功 · Docker ${info.Version}${info.Os ? ` · ${info.Os}/${info.Arch}` : ''}` };
    } catch (err) {
        return { ok: false, durationMs: Date.now() - started, message: err.message };
    }
}

async function listContainers(host, all = true) {
    const arr = await apiRequest(host, 'GET', `/containers/json?all=${all ? 1 : 0}&size=0`);
    return (Array.isArray(arr) ? arr : []).map(c => ({
        id: String(c.Id || '').slice(0, 12),
        fullId: c.Id,
        name: (c.Names || [])[0] ? String(c.Names[0]).replace(/^\//, '') : '-',
        image: c.Image,
        status: c.Status,
        state: c.State,
        project: (c.Labels || {})['com.docker.compose.project'] || '',
        service: (c.Labels || {})['com.docker.compose.service'] || '',
        ports: (c.Ports || []).filter(p => p.PublicPort).map(p => `${p.IP || '0.0.0.0'}:${p.PublicPort}→${p.PrivatePort}/${p.Type || 'tcp'}`),
        created: c.Created
    }));
}

async function listImages(host) {
    const arr = await apiRequest(host, 'GET', '/images/json');
    return (Array.isArray(arr) ? arr : []).map(im => ({
        id: String(im.Id || '').replace('sha256:', '').slice(0, 12),
        tags: (im.RepoTags || []).filter(t => t && t !== '<none>:<none>'),
        size: im.Size,
        created: im.Created * 1000
    }));
}

/** compose 项目聚合：按标签分组统计 */
function groupStacks(containers) {
    const map = {};
    containers.forEach(c => {
        if (!c.project) return;
        const s = map[c.project] || (map[c.project] = { project: c.project, total: 0, running: 0, containers: [] });
        s.total++;
        if (c.state === 'running') s.running++;
        s.containers.push(c);
    });
    return Object.values(map);
}

async function containerLogs(host, id, tail = LOG_TAIL_DEFAULT) {
    const transport = transportOf(host);
    return new Promise((resolve, reject) => {
        const req = http.request({
            ...transport,
            method: 'GET',
            path: `/${API_VERSION}/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${Math.min(Number(tail) || LOG_TAIL_DEFAULT, 2000)}`,
            headers: authHeaders(host),
            timeout: 10000
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(demuxStream(Buffer.concat(chunks))));
        });
        req.on('timeout', () => req.destroy(new Error('读取日志超时')));
        req.on('error', reject);
        req.end();
    });
}

async function containerAction(host, action, id, opts = {}) {
    const routes = {
        start: ['POST', `/containers/${id}/start`],
        stop: ['POST', `/containers/${id}/stop?t=5`],
        restart: ['POST', `/containers/${id}/restart?t=5`],
        kill: ['POST', `/containers/${id}/kill`],
        pause: ['POST', `/containers/${id}/pause`],
        unpause: ['POST', `/containers/${id}/unpause`],
        remove: ['DELETE', `/containers/${id}?force=${opts.force ? 1 : 0}`],
        'image-delete': ['DELETE', `/images/${encodeURIComponent(id)}?force=${opts.force ? 1 : 0}`]
    };
    const route = routes[action];
    if (!route) throw new Error(`不支持的操作：${action}`);
    await apiRequest(host, route[0], route[1]);
    return { ok: true };
}

/** 容器内执行命令（exec + hijack 流，返回合并输出文本） */
async function execInContainer(host, containerId, cmd) {
    const version = await apiRequest(host, 'GET', '/version').catch(() => ({}));
    const shell = String(version.Os || '').toLowerCase() === 'windows'
        ? ['cmd', '/C', String(cmd)]
        : ['/bin/sh', '-c', String(cmd)];
    const created = await apiRequest(host, 'POST', `/containers/${containerId}/exec`, {
        AttachStdout: true, AttachStderr: true, Tty: false, Cmd: shell
    });
    const execId = created && created.Id;
    if (!execId) throw new Error('exec 创建失败');

    // hijack 走裸 socket：Node http 客户端对 101 无 Connection:Upgrade 头的处理不可靠（Docker 实际就会这样回）
    const t = transportOf(host);
    const body = JSON.stringify({ Detach: false });

    return new Promise((resolve, reject) => {
        const socket = net.connect(typeof t.socketPath === 'string' ? { path: t.socketPath } : { host: t.host, port: t.port });
        const chunks = [];
        let settled = false;
        let headerSeen = false;
        let buf = Buffer.alloc(0);
        const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); fn(arg); } };
        const timer = setTimeout(() => finish(resolve, {
            ok: true, output: textOut() || '(无输出，命令可能仍在运行，已达 20 秒等待上限)'
        }), EXEC_TIMEOUT_MS);
        function textOut() {
            const all = headerSeen ? Buffer.concat(chunks) : Buffer.alloc(0);
            return all.length ? demuxStream(all) : '';
        }
        socket.on('connect', () => {
            const headers = [
                `POST /${API_VERSION}/exec/${execId}/start HTTP/1.1`,
                'Host: docker',
                'Content-Type: application/json',
                `Content-Length: ${Buffer.byteLength(body)}`,
                'Upgrade: tcp',
                'Connection: Upgrade',
                ...Object.entries(authHeaders(host)).map(([k, v]) => `${k}: ${v}`)
            ];
            socket.write(headers.join('\r\n') + '\r\n\r\n' + body);
        });
        socket.on('data', c => {
            if (!headerSeen) {
                buf = Buffer.concat([buf, c]);
                const idx = buf.indexOf('\r\n\r\n');
                if (idx < 0) return;
                const head = buf.subarray(0, idx).toString('utf8');
                if (!/ 101 /.test(head.split('\r\n')[0] + ' ')) {
                    // 非升级响应：把剩余当错误体
                    const rest = buf.subarray(idx + 4);
                    return finish(reject, new Error(`exec 启动失败：${head.split('\r\n')[0]} ${rest.toString('utf8').slice(0, 200)}`));
                }
                headerSeen = true;
                if (buf.length > idx + 4) chunks.push(buf.subarray(idx + 4));
                return;
            }
            chunks.push(c);
        });
        socket.on('end', () => finish(resolve, { ok: true, output: textOut() || '（无输出）' }));
        socket.on('close', () => finish(resolve, { ok: true, output: textOut() || '（无输出）' }));
        socket.on('error', err => finish(reject, err));
    });
}

/* ------------------------------------------------------------------
 * Compose（spawn 本机 docker CLI，写临时 yaml 后执行）
 * ------------------------------------------------------------------ */

function composeEnv() {
    const env = { ...process.env };
    env.DOCKER_HOST = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : `unix://${PIPE_LINUX}`;
    return env;
}

/** compose 固定作用于本机守护进程（spawn 本机 docker CLI） */
function runCompose(yamlText, action) {
    return new Promise(resolve => {
        if (!/^(up|down|restart|ps)$/.test(action)) return resolve({ ok: false, message: '不支持的 compose 动作' });
        if (!String(yamlText || '').trim()) return resolve({ ok: false, message: 'compose 文件内容为空' });
        const file = path.join(os.tmpdir(), `sgops-compose-${Date.now()}.yml`);
        fs.writeFileSync(file, String(yamlText), 'utf8');
        const child = spawn('docker', ['compose', '-f', file, action, ...(action === 'up' ? ['-d'] : [])], {
            env: composeEnv(), windowsHide: true
        });
        let out = '';
        child.stdout.on('data', d => { out += d.toString('utf8'); });
        child.stderr.on('data', d => { out += d.toString('utf8'); });
        child.on('error', err => {
            fs.unlink(file, () => {});
            resolve({ ok: false, message: 'docker CLI 不可用：' + err.message + '（compose 编排依赖本机 docker 命令行，Docker Desktop 默认已带）' });
        });
        child.on('close', code => {
            fs.unlink(file, () => {});
            resolve({ ok: code === 0, exitCode: code, output: out.trim(), message: code === 0 ? '执行成功' : `docker compose ${action} 退出码 ${code}` });
        });
    });
}

/** 项目级操作（纯 API）：对 compose project 内所有容器执行 start/stop/restart */
async function stackAction(host, project, action) {
    const containers = await listContainers(host, true);
    const targets = containers.filter(c => c.project === project);
    if (!targets.length) return { ok: false, message: `项目「${project}」下没有容器` };
    const results = [];
    for (const c of targets) {
        if (action === 'stop' && c.state !== 'running') continue;
        if (action === 'start' && c.state === 'running') continue;
        try {
            // eslint-disable-next-line no-await-in-loop
            await containerAction(host, action, c.fullId || c.id);
            results.push({ name: c.name, ok: true });
        } catch (err) {
            results.push({ name: c.name, ok: false, message: err.message });
        }
    }
    return { ok: true, project, action, results };
}

module.exports = {
    testHost, listContainers, listImages, groupStacks, containerLogs,
    containerAction, execInContainer, runCompose, stackAction, demuxStream, localPipe
};
