/**
 * 告警中心 IPC
 * 通道：alerts:list / alerts:unread / alerts:ack / alerts:ackAll / alerts:clear
 */
const alerts = require('../alerts');
const audit = require('../auditLogger');
const auth = require('../auth');

function setup(ipcMain) {
    ipcMain.handle('alerts:list', (e, query = {}) => alerts.list(query));

    ipcMain.handle('alerts:unread', () => ({
        count: alerts.unreadCount(),
        latest: alerts.list({ onlyUnread: true, limit: 10 })
    }));

    ipcMain.handle('alerts:ack', (e, id) => alerts.ack(id));

    ipcMain.handle('alerts:ackAll', () => {
        const res = alerts.ackAll();
        audit.write({
            type: '操作', user: (auth.getSession() || {}).username,
            detail: `确认全部告警（${res.count} 条）`
        });
        return res;
    });

    ipcMain.handle('alerts:clear', () => {
        const res = alerts.clearAcknowledged();
        audit.write({
            type: '操作', user: (auth.getSession() || {}).username,
            detail: `清理已确认告警 ${res.removed} 条`
        });
        return res;
    });
}

module.exports = { setup };
