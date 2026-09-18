/**
 * 异常告警模块
 * - 触发点：高危命令拦截、任务失败、主机连接失败、模拟登录/重置失败
 * - 5 分钟内同源同标题去重，仅累加次数；未确认告警计入未读
 * - 新增告警即时推送到渲染进程（alert:new），顶栏铃铛实时更新
 */
const { BrowserWindow } = require('electron');
const store = require('./store');

const DEDUPE_MS = 5 * 60 * 1000;

function broadcast(payload) {
    BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('alert:new', payload);
    });
}

/**
 * 写入告警
 * @param {{level?:'danger'|'warn'|'info', title:string, detail?:string, source?:string}} input
 */
function add(input) {
    const alerts = store.list('alerts');
    const now = Date.now();
    const title = String(input.title || '').slice(0, 120);
    const source = input.source || 'system';

    const dup = alerts.find(a => !a.acknowledged && a.source === source && a.title === title &&
        now - new Date(String(a.createdAt).replace(' ', 'T')).getTime() < DEDUPE_MS);

    if (dup) {
        dup.count = (dup.count || 1) + 1;
        dup.lastAt = store.nowText();
        dup.detail = input.detail || dup.detail;
        store.persist();
        broadcast({ type: 'update', alert: dup });
        return dup;
    }

    const alert = store.upsert('alerts', {
        level: input.level || 'warn',
        title,
        detail: input.detail || '',
        source,
        acknowledged: false,
        count: 1,
        createdAt: store.nowText(),
        lastAt: store.nowText()
    });

    broadcast({ type: 'new', alert });
    return alert;
}

function list({ onlyUnread = false, limit = 50 } = {}) {
    const alerts = store.list('alerts');
    const rows = onlyUnread ? alerts.filter(a => !a.acknowledged) : alerts;
    // 未确认优先，其次按时间倒序
    return [...rows].sort((a, b) => {
        if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
        return String(b.lastAt || b.createdAt).localeCompare(String(a.lastAt || a.createdAt));
    }).slice(0, limit);
}

const unreadCount = () => store.list('alerts').filter(a => !a.acknowledged).length;

function ack(id) {
    const alert = store.find('alerts', id);
    if (!alert) return { ok: false, message: '告警不存在' };
    alert.acknowledged = true;
    alert.acknowledgedAt = store.nowText();
    store.persist();
    return { ok: true };
}

function ackAll() {
    const alerts = store.list('alerts').filter(a => !a.acknowledged);
    alerts.forEach(a => {
        a.acknowledged = true;
        a.acknowledgedAt = store.nowText();
    });
    store.persist();
    return { ok: true, count: alerts.length };
}

function clearAcknowledged() {
    const locked = store.load();
    const before = locked.alerts.length;
    locked.alerts = locked.alerts.filter(a => !a.acknowledged);
    store.persist();
    return { ok: true, removed: before - locked.alerts.length };
}

module.exports = { add, list, unreadCount, ack, ackAll, clearAcknowledged };
