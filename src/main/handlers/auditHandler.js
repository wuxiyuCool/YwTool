/**
 * 日志审计 IPC
 * 通道：audit:query / audit:stats / audit:append / audit:cleanup / audit:paths
 */
const audit = require('../auditLogger');
const store = require('../store');

function setup(ipcMain) {
    ipcMain.handle('audit:query', (e, query = {}) => ({
        ok: true,
        records: audit.query(query)
    }));

    ipcMain.handle('audit:stats', () => audit.stats());

    /** 前端手动补记（如导出、查看等交互） */
    ipcMain.handle('audit:append', (e, entry) => audit.write({
        ...entry,
        user: (entry && entry.user) || (store.get('config') || {}).currentUser
    }));

    ipcMain.handle('audit:cleanup', (e, days) => {
        const removed = audit.cleanup(days || (store.get('config') || {}).logRetentionDays);
        audit.write({ type: '操作', detail: `清理审计日志文件 ${removed} 个（保留 ${days} 天）` });
        return { ok: true, removed };
    });

    ipcMain.handle('audit:paths', () => ({
        logDir: audit.LOG_DIR,
        today: audit.logFilePath(),
        dataFile: store.DB_FILE
    }));
}

module.exports = { setup };
