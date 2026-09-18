/**
 * 定时任务调度 IPC
 * 通道：schedules:list / schedules:save / schedules:delete / schedules:toggle / schedules:runNow
 */
const store = require('../store');
const audit = require('../auditLogger');
const auth = require('../auth');
const scheduler = require('../scheduler');

function decorate(s) {
    return {
        ...s,
        nextRunText: scheduler.nextRunText(s),
        scheduleText: scheduler.describe(s)
    };
}

function setup(ipcMain) {
    ipcMain.handle('schedules:list', () => store.list('schedules').map(decorate));

    ipcMain.handle('schedules:save', (e, payload) => {
        const data = { ...payload };
        if (data.mode === 'daily' && !/^\d{1,2}:\d{2}$/.test(String(data.time || ''))) {
            return { ok: false, message: '每日定时需填写 HH:mm 格式时间' };
        }
        if (data.mode === 'interval' && !(Number(data.intervalMinutes) > 0)) {
            return { ok: false, message: '间隔执行需填写大于 0 的分钟数' };
        }
        if (!data.scriptId && !String(data.cmd || '').trim()) {
            return { ok: false, message: '请填写执行命令或选择脚本' };
        }
        if (!Array.isArray(data.hostIds) || !data.hostIds.length) {
            return { ok: false, message: '请选择目标主机' };
        }

        data.nextRunAt = data.enabled === false ? null : scheduler.computeNext(data, Date.now());
        const saved = store.upsert('schedules', data);
        audit.write({
            type: '操作', user: (auth.getSession() || {}).username,
            detail: `${payload.id ? '修改' : '新增'}定时任务「${saved.name}」（${scheduler.describe(saved)}）`
        });
        return { ok: true, schedule: decorate(saved) };
    });

    ipcMain.handle('schedules:delete', (e, id) => {
        const s = store.find('schedules', id);
        const ok = store.remove('schedules', id);
        if (ok && s) {
            audit.write({ type: '操作', user: (auth.getSession() || {}).username, detail: `删除定时任务「${s.name}」` });
        }
        return { ok };
    });

    ipcMain.handle('schedules:toggle', (e, { id, enabled }) => {
        const s = store.find('schedules', id);
        if (!s) return { ok: false, message: '定时任务不存在' };
        s.enabled = !!enabled;
        s.nextRunAt = s.enabled ? scheduler.computeNext(s, Date.now()) : null;
        store.persist();
        audit.write({
            type: '操作', user: (auth.getSession() || {}).username,
            detail: `${s.enabled ? '启用' : '停用'}定时任务「${s.name}」`
        });
        return { ok: true, schedule: decorate(s) };
    });

    /** 立即执行一次（不影响下一次计划时间） */
    ipcMain.handle('schedules:runNow', async (e, id) => {
        const s = store.find('schedules', id);
        if (!s) return { ok: false, message: '定时任务不存在' };
        const res = await scheduler.execute(s, 'manual');
        return { ...res, schedule: decorate(store.find('schedules', id)) };
    });
}

module.exports = { setup };
