/**
 * 主机管理 IPC
 * 通道：hosts:list / hosts:save / hosts:delete / hosts:test
 */
const store = require('../store');
const audit = require('../auditLogger');
const alerts = require('../alerts');
const ssh = require('../ssh');
const { encrypt, mask } = require('../crypto');

/** 对外输出时脱敏，绝不返回明文口令 */
function sanitize(host) {
    const { password, ...rest } = host;
    return { ...rest, hasPassword: !!password, passwordMasked: password ? mask() : '' };
}

function setup(ipcMain) {
    ipcMain.handle('hosts:list', () => store.list('hosts').map(sanitize));

    ipcMain.handle('hosts:save', (e, payload) => {
        const data = { ...payload };
        // 密码：留空表示不修改；有值则加密存储
        if (data.password === undefined || data.password === '' || data.password === mask()) {
            delete data.password;
        } else {
            data.password = encrypt(data.password);
        }
        if (Array.isArray(data.tags) === false && typeof data.tags === 'string') {
            data.tags = data.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        }
        const saved = store.upsert('hosts', data);
        audit.write({
            type: '操作', user: store.get('config').currentUser,
            detail: `${payload.id ? '修改' : '添加'}主机 ${saved.name}（${saved.ip}:${saved.port}）`
        });
        return sanitize(saved);
    });

    ipcMain.handle('hosts:delete', (e, id) => {
        const host = store.find('hosts', id);
        const ok = store.remove('hosts', id);
        if (ok && host) {
            audit.write({ type: '操作', user: store.get('config').currentUser, detail: `删除主机 ${host.name}（${host.ip}）` });
        }
        return { ok };
    });

    ipcMain.handle('hosts:test', async (e, id) => {
        const host = store.find('hosts', id);
        if (!host) return { ok: false, message: '主机不存在' };
        const result = await ssh.testConnection(host);
        host.status = result.ok ? 'online' : 'offline';
        host.lastConnectedAt = store.nowText();
        store.persist();
        if (!result.ok) {
            alerts.add({
                level: 'warn',
                title: `主机连接失败：${host.name}`,
                detail: `${host.ip}:${host.port} — ${result.message}`,
                source: `host:${host.id}`
            });
        }
        audit.write({
            type: '操作', user: store.get('config').currentUser,
            detail: `连接测试 ${host.name}（${host.ip}）：${result.message}`,
            result: result.ok ? 'success' : 'failed'
        });
        return { ...result, host: sanitize(host) };
    });

    /** 单机执行（调试用，同样走命令校验） */
    ipcMain.handle('hosts:exec', async (e, { id, cmd }) => {
        const host = store.find('hosts', id);
        if (!host) return { ok: false, message: '主机不存在' };
        const security = require('../security');
        const check = security.validate(cmd, { source: host.name });
        if (!check.ok) return { ok: false, message: check.reason, blocked: true };
        const res = await ssh.execOnHost(host, cmd, store.get('config').cmdTimeout);
        audit.write({
            type: '命令', user: store.get('config').currentUser,
            detail: `${host.name}（${host.ip}）执行 "${cmd}"`,
            result: res.status === 'success' ? 'success' : 'failed'
        });
        return { ok: res.status === 'success', result: res };
    });
}

module.exports = { setup, sanitize };
