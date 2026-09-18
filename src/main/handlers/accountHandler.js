/**
 * 多系统账号 IPC
 * 通道：accounts:list / accounts:save / accounts:delete / accounts:reveal
 *      accounts:reset / accounts:loginTest / accounts:policy:save
 *
 * 说明：凭据经 AES-256-GCM 加密后入库；重置密码/登录测试由绑定的 Python 脚本在本机执行，
 *       脚本通过环境变量 SYS_URL / SYS_USER / NEW_PASSWORD 获取上下文。
 */
const crypto = require('crypto');
const { spawn } = require('child_process');
const store = require('../store');
const audit = require('../auditLogger');
const alerts = require('../alerts');
const { encrypt, decrypt, mask } = require('../crypto');

const DEFAULT_POLICY = { length: 16, charset: 'full', afterReset: 'verify' };

function policy() {
    const config = store.get('config') || {};
    return { ...DEFAULT_POLICY, ...(config.resetPolicy || {}) };
}

function sanitize(acc) {
    const { password, ...rest } = acc;
    return { ...rest, hasPassword: !!password, passwordMasked: password ? mask() : '' };
}

function genPassword(len = 16, charset = 'full') {
    const sets = {
        full: 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*',
        alnum: 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    };
    const chars = sets[charset] || sets.full;
    return Array.from({ length: len }, () => chars[crypto.randomInt(chars.length)]).join('');
}

/** 在本机执行绑定脚本（Python），返回输出 */
function runScript(name, env) {
    return new Promise(resolve => {
        const script = store.list('scripts').find(s => s.name === name);
        if (!script) {
            return resolve({ ok: false, output: '', message: `未找到绑定脚本 ${name}，请先在「脚本管理」中托管该脚本` });
        }
        const child = spawn('python', ['-c', script.content], {
            env: { ...process.env, ...env },
            windowsHide: true
        });
        let out = '';
        let err = '';
        child.stdout.on('data', d => { out += d.toString('utf8'); });
        child.stderr.on('data', d => { err += d.toString('utf8'); });
        child.on('error', e => resolve({ ok: false, output: '', message: '脚本启动失败：' + e.message }));
        child.on('close', code => resolve({
            ok: code === 0,
            output: out.trim(),
            message: code === 0 ? '脚本执行成功' : (err.trim() || `脚本退出码 ${code}`)
        }));
    });
}

function setup(ipcMain) {
    ipcMain.handle('accounts:list', () => store.list('accounts').map(sanitize));

    ipcMain.handle('accounts:save', (e, payload) => {
        const data = { ...payload };
        if (!data.password || data.password === mask()) {
            delete data.password;              // 留空 = 不修改原密码
        } else {
            data.password = encrypt(data.password);
        }
        const saved = store.upsert('accounts', data);
        audit.write({
            type: '操作', user: store.get('config').currentUser,
            detail: `${payload.id ? '修改' : '接入'}业务系统「${saved.name}」(${saved.url})`
        });
        return { ok: true, account: sanitize(saved) };
    });

    ipcMain.handle('accounts:delete', (e, id) => {
        const acc = store.find('accounts', id);
        const ok = store.remove('accounts', id);
        if (ok && acc) {
            audit.write({ type: '操作', user: store.get('config').currentUser, detail: `移除业务系统「${acc.name}」及其凭据` });
        }
        return { ok };
    });

    /** 显示明文密码：必然留痕 */
    ipcMain.handle('accounts:reveal', (e, id) => {
        const acc = store.find('accounts', id);
        if (!acc) return { ok: false, message: '账号不存在' };
        const plain = decrypt(acc.password);
        audit.write({
            type: '操作', user: store.get('config').currentUser,
            detail: `查看业务系统「${acc.name}」账号 ${acc.user} 的明文密码`
        });
        return { ok: true, password: plain };
    });

    /** 一键重置密码 */
    ipcMain.handle('accounts:reset', async (e, id) => {
        const acc = store.find('accounts', id);
        if (!acc) return { ok: false, message: '账号不存在' };

        const cfg = policy();
        const newPwd = genPassword(Number(cfg.length) || 16, cfg.charset);
        const result = await runScript(acc.scriptName, {
            SYS_URL: acc.url, SYS_USER: acc.user, NEW_PASSWORD: newPwd, MODE: 'reset'
        });

        if (!result.ok) {
            acc.status = 'error';
            store.persist();
            alerts.add({
                level: 'danger',
                title: `重置密码失败：${acc.name}`,
                detail: `${acc.user} — ${result.message}`,
                source: `account:${acc.id}`
            });
            audit.write({
                type: '告警', user: store.get('config').currentUser,
                detail: `重置「${acc.name}」密码失败：${result.message}`, result: 'failed'
            });
            return { ok: false, message: result.message, output: result.output };
        }

        acc.password = encrypt(newPwd);
        acc.status = 'ok';
        acc.lastSyncAt = store.nowText();
        store.persist();
        audit.write({
            type: '登录', user: store.get('config').currentUser,
            detail: `重置「${acc.name}」账号 ${acc.user} 密码成功（脚本 ${acc.scriptName}），新密码已加密回写`
        });
        return { ok: true, message: '密码已重置并加密回写', output: result.output, masked: mask() };
    });

    /** 模拟登录测试 */
    ipcMain.handle('accounts:loginTest', async (e, id) => {
        const acc = store.find('accounts', id);
        if (!acc) return { ok: false, message: '账号不存在' };
        const result = await runScript(acc.scriptName, {
            SYS_URL: acc.url, SYS_USER: acc.user, NEW_PASSWORD: decrypt(acc.password), MODE: 'login'
        });
        acc.status = result.ok ? 'ok' : 'error';
        acc.lastSyncAt = store.nowText();
        store.persist();
        if (!result.ok) {
            alerts.add({
                level: 'warn',
                title: `模拟登录失败：${acc.name}`,
                detail: `${acc.user} — ${result.message}`,
                source: `account:${acc.id}`
            });
        }
        audit.write({
            type: '登录', user: store.get('config').currentUser,
            detail: `模拟登录「${acc.name}」：${result.ok ? '成功' : '失败 — ' + result.message}`,
            result: result.ok ? 'success' : 'failed'
        });
        return result;
    });

    /** 重置策略保存 */
    ipcMain.handle('accounts:policy:save', (e, p) => {
        const config = store.get('config');
        config.resetPolicy = { ...policy(), ...p };
        store.persist();
        audit.write({ type: '操作', user: config.currentUser, detail: '更新重置密码策略' });
        return { ok: true, policy: config.resetPolicy };
    });
}

module.exports = { setup };
