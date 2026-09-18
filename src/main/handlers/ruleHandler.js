/**
 * 敏感词规则 IPC
 * 通道：rules:list / rules:save / rules:delete / rules:toggle / rules:validate
 */
const store = require('../store');
const audit = require('../auditLogger');
const security = require('../security');

function setup(ipcMain) {
    ipcMain.handle('rules:list', () => store.list('rules'));

    ipcMain.handle('rules:save', (e, payload) => {
        // 正则合法性校验
        try {
            new RegExp(payload.pattern);
        } catch (err) {
            return { ok: false, message: '正则表达式语法错误：' + err.message };
        }
        const saved = store.upsert('rules', payload);
        audit.write({
            type: '操作', user: store.get('config').currentUser,
            detail: `${payload.id ? '修改' : '新增'}敏感词规则「${saved.desc}」(${saved.pattern})`
        });
        return { ok: true, rule: saved };
    });

    ipcMain.handle('rules:delete', (e, id) => {
        const rule = store.find('rules', id);
        const ok = store.remove('rules', id);
        if (ok && rule) {
            audit.write({ type: '操作', user: store.get('config').currentUser, detail: `删除敏感词规则「${rule.desc}」` });
        }
        return { ok };
    });

    ipcMain.handle('rules:toggle', (e, { id, enabled }) => {
        const rule = store.find('rules', id);
        if (!rule) return { ok: false, message: '规则不存在' };
        rule.enabled = !!enabled;
        store.persist();
        audit.write({
            type: '操作', user: store.get('config').currentUser,
            detail: `${enabled ? '启用' : '停用'}敏感词规则「${rule.desc}」`
        });
        return { ok: true, rule };
    });

    ipcMain.handle('rules:validate', (e, { cmd }) => security.validate(cmd));
}

module.exports = { setup };
