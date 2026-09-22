/**
 * 交互式终端会话（Xshell 式）
 * ------------------------------------------------------------------
 * 每个会话 = 一条 ssh2 Client + 一个 shell channel，渲染进程用 xterm.js 渲染。
 * 数据流：
 *   渲染 → terminal:open {hostId, cols, rows}  → 主进程建连并 shell → 返回 sessionId
 *   渲染 → terminal:input {sessionId, data}    → stream.write（用户键入）
 *   渲染 → terminal:resize {sessionId, cols, rows} → stream.setWindow
 *   渲染 → terminal:close {sessionId}          → 销毁
 *   主进程 → push 'terminal:data' {sessionId, chunk}（远端回显/输出）
 *   主进程 → push 'terminal:exit' {sessionId}（远端退出或连接断开）
 *
 * 安全：
 *   - 建连凭据走 secrets.resolve（与主机管理/批量执行同源）
 *   - 交互式 shell 不做敏感词前置校验（无法预知用户逐字输入），但会话建立/关闭写审计，
 *     且通道 terminal:open 归 tasks 模块，受模块权限与写权限约束
 *   - 空闲超时自动回收，避免连接泄漏
 */
const { BrowserWindow } = require('electron');
const store = require('../store');
const audit = require('../auditLogger');
const ssh = require('../ssh');
const scriptUtil = require('../scriptUtil');

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;   // 30 分钟无活动自动断开
const MAX_SESSIONS = 16;                   // 并发会话上限，防资源耗尽

/** sessionId → { conn, stream, hostId, hostName, lastActive, closed } */
const sessions = new Map();
let seq = 0;

const operator = () => (store.get('config') || {}).currentUser || '-';

function push(win, channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function destroySession(id, reason) {
    const s = sessions.get(id);
    if (!s || s.closed) return;
    s.closed = true;
    try { if (s.stream) s.stream.close(); } catch (e) { /* ignore */ }
    try { if (s.conn) s.conn.end(); } catch (e) { /* ignore */ }
    sessions.delete(id);
    if (reason) {
        audit.write({ type: '操作', user: operator(), detail: `终端会话结束：${s.hostName}（${reason}）` });
    }
}

function touch(s) { s.lastActive = Date.now(); }

/** 空闲回收轮询 */
const reaper = setInterval(() => {
    const now = Date.now();
    sessions.forEach((s, id) => {
        if (now - s.lastActive > IDLE_TIMEOUT_MS) destroySession(id, '空闲超时自动断开');
    });
}, 60 * 1000);
reaper.unref?.();

/** 关闭全部会话（应用退出时调用） */
function closeAll() {
    sessions.forEach((_, id) => destroySession(id, '应用退出'));
}

function setup(ipcMain) {
    /** 打开一个到主机的交互式终端会话 */
    ipcMain.handle('terminal:open', (e, { hostId, cols = 100, rows = 30 } = {}) => {
        const targetWin = BrowserWindow.fromWebContents(e.sender);
        const host = store.find('hosts', hostId);
        if (!host) return { ok: false, message: '主机不存在' };
        if (!ssh.hasDriver()) return { ok: false, message: ssh.MISSING_DEP };
        if (sessions.size >= MAX_SESSIONS) return { ok: false, message: `并发终端会话已达上限（${MAX_SESSIONS}），请先关闭部分会话` };

        const ssh2 = require('ssh2');
        const sessionId = `ts_${Date.now()}_${++seq}`;
        const conn = new ssh2.Client();
        let settled = false;

        const timer = setTimeout(() => {
            if (!settled) { settled = true; try { conn.end(); } catch (err) { /* ignore */ } }
            push(targetWin, 'terminal:exit', { sessionId, message: '连接超时' });
        }, 15000);

        conn.on('error', err => {
            clearTimeout(timer);
            if (!settled) { settled = true; push(targetWin, 'terminal:exit', { sessionId, message: 'SSH 连接失败：' + err.message }); }
            sessions.delete(sessionId);
        });

        conn.on('ready', () => {
            conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
                clearTimeout(timer);
                if (err || !stream) {
                    settled = true;
                    try { conn.end(); } catch (e2) { /* ignore */ }
                    push(targetWin, 'terminal:exit', { sessionId, message: '无法打开 Shell：' + (err && err.message || '未知') });
                    return;
                }
                settled = true;
                const sess = { conn, stream, hostId, hostName: `${host.name}（${host.ip}）`, lastActive: Date.now(), closed: false };
                sessions.set(sessionId, sess);
                stream.on('data', chunk => { if (sessions.has(sessionId)) { touch(sess); push(targetWin, 'terminal:data', { sessionId, chunk: chunk.toString('utf8') }); } });
                stream.stderr.on('data', chunk => { if (sessions.has(sessionId)) { touch(sess); push(targetWin, 'terminal:data', { sessionId, chunk: chunk.toString('utf8') }); } });
                stream.on('close', () => {
                    destroySession(sessionId, '远端退出');
                    push(targetWin, 'terminal:exit', { sessionId, message: '会话已结束' });
                });
                audit.write({ type: '操作', user: operator(), detail: `打开终端会话：${sess.hostName}` });
            });
        });

        const auth = ssh.authOptions(host);
        if (!auth) { clearTimeout(timer); return { ok: false, message: '未配置认证信息：私钥认证需指定私钥文件路径，或改用密码认证' }; }
        conn.connect({
            host: host.ip, port: host.port || 22, username: host.user,
            readyTimeout: 15000, keepaliveInterval: 15000, algorithms: ssh.FAST_ALGORITHMS, ...auth
        });

        return { ok: true, sessionId, hostName: `${host.name}（${host.ip}）` };
    });

    ipcMain.handle('terminal:input', (e, { sessionId, data } = {}) => {
        const s = sessions.get(sessionId);
        if (!s || s.closed) return { ok: false, message: '会话不存在或已结束' };
        touch(s);
        try { s.stream.write(String(data), 'utf8'); return { ok: true }; }
        catch (err) { return { ok: false, message: err.message }; }
    });

    ipcMain.handle('terminal:resize', (e, { sessionId, cols, rows } = {}) => {
        const s = sessions.get(sessionId);
        if (!s || s.closed) return { ok: false };
        touch(s);
        try { s.stream.setWindow(rows, cols, 0, 0); return { ok: true }; }
        catch (err) { return { ok: false, message: err.message }; }
    });

    /** 在活跃终端会话中执行托管脚本：包装逻辑留在主进程（scriptUtil），渲染层只传 id；交互式包装不追加 exit */
    ipcMain.handle('terminal:runScript', (e, { sessionId, scriptId } = {}) => {
        const s = sessions.get(sessionId);
        if (!s || s.closed) return { ok: false, message: '会话不存在或已结束' };
        const script = store.find('scripts', scriptId);
        if (!script) return { ok: false, message: '脚本不存在（可能已被删除）' };
        let cmd;
        try {
            cmd = scriptUtil.buildScriptCommand(script, { interactive: true });
        } catch (err) {
            return { ok: false, message: err.message };
        }
        touch(s);
        try {
            s.stream.write(cmd + '\n', 'utf8');
        } catch (err) {
            return { ok: false, message: '发送失败：' + err.message };
        }
        audit.write({
            type: '命令', user: operator(),
            detail: `终端会话执行托管脚本「${script.name}」（${script.type} ${script.version || ''}）→ ${s.hostName}`
        });
        return { ok: true, name: script.name };
    });

    ipcMain.handle('terminal:close', (e, { sessionId } = {}) => {
        destroySession(sessionId, '用户关闭');
        return { ok: true };
    });

    ipcMain.handle('terminal:list', () => ({
        ok: true,
        sessions: [...sessions.entries()].map(([id, s]) => ({ sessionId: id, hostId: s.hostId, hostName: s.hostName, idleMs: Date.now() - s.lastActive }))
    }));
}

module.exports = { setup, closeAll, sessionCount: () => sessions.size };
