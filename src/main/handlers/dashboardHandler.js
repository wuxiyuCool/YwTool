/**
 * 总览看板 IPC
 * 通道：dashboard:overview
 */
const store = require('../store');
const audit = require('../auditLogger');

function setup(ipcMain) {
    ipcMain.handle('dashboard:overview', () => {
        const hosts = store.list('hosts');
        const tasks = store.list('tasks');
        const scripts = store.list('scripts');
        const rules = store.list('rules');

        const weekAgo = Date.now() - 7 * 86400000;
        const weekTasks = tasks.filter(t => {
            const ts = new Date(String(t.createdAt).replace(' ', 'T')).getTime();
            return !Number.isNaN(ts) && ts >= weekAgo;
        });
        const intervened = audit.query({ type: '拦截', limit: 100 });

        return {
            stats: {
                hostTotal: hosts.length,
                hostOnline: hosts.filter(h => h.status === 'online').length,
                hostOffline: hosts.filter(h => h.status === 'offline' || h.status === 'unknown').length,
                taskWeek: weekTasks.length,
                taskSuccess: weekTasks.filter(t => t.status === 'success').length,
                taskFailed: weekTasks.filter(t => t.status === 'failed').length,
                blocked: intervened.length,
                ruleEnabled: rules.filter(r => r.enabled).length,
                scriptTotal: scripts.length,
                scriptShell: scripts.filter(s => s.type === 'shell').length,
                scriptPython: scripts.filter(s => s.type === 'python').length,
                auditToday: audit.stats()
            },
            recentTasks: tasks.slice(0, 6).map(t => ({
                id: t.id, cmd: t.cmd, hostCount: t.hostCount, status: t.status,
                createdAt: t.createdAt, operator: t.operator
            })),
            alerts: audit.query({ limit: 60 })
                .filter(r => r.type === '拦截' || r.type === '告警')
                .slice(0, 5)
                .map(r => ({ level: r.level, text: r.detail, time: String(r.time).slice(11, 16) }))
        };
    });
}

module.exports = { setup };
