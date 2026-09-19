/**
 * 网络安全工作台 IPC
 * 通道：netsec:send / netsec:proxy:start|stop|status / netsec:decision
 *      netsec:cases:list|save|delete / netsec:history:list|clear
 * 推送：netsec:packet（抓包流水）、netsec:breakpoint（断点暂停的请求）
 *
 * 定位：内网接口联调与安全自查工具（类 Postman + 类 BurpSuite 的 HTTP 部分）。
 * 抓包代理仅绑定 127.0.0.1；写类通道在 auth.js 登记为 ADMIN_ONLY。
 */
const netsec = require('../netsec');
const audit = require('../auditLogger');
const auth = require('../auth');

const operator = () => (auth.getSession() || {}).username || '-';

/** 最近一次发起 IPC 的窗口 webContents（代理事件推送目标） */
let targetWebContents = null;

function setup(ipcMain) {
    netsec.setEmitter((event, payload) => {
        if (targetWebContents && !targetWebContents.isDestroyed()) {
            targetWebContents.send('netsec:' + event, payload);
        }
    });

    ipcMain.handle('netsec:send', async (e, payload) => {
        targetWebContents = e.sender;
        return netsec.sendAndLog(payload);
    });

    ipcMain.handle('netsec:proxy:start', async (e, options = {}) => {
        targetWebContents = e.sender;
        const res = await netsec.proxyStart(options);
        audit.write({
            type: '操作', user: operator(),
            detail: `启动抓包代理（端口 ${res.port || options.port}，断点：${options.breakpoints ? '开' : '关'}）${res.ok ? '' : ' 失败：' + res.message}`
        });
        return res;
    });

    ipcMain.handle('netsec:proxy:stop', () => {
        audit.write({ type: '操作', user: operator(), detail: '停止抓包代理' });
        return netsec.proxyStop();
    });

    ipcMain.handle('netsec:proxy:status', () => netsec.proxyStatus());
    ipcMain.handle('netsec:decision', (e, payload) => netsec.resolveBreakpoint(payload));

    ipcMain.handle('netsec:cases:list', () => netsec.listCases());
    ipcMain.handle('netsec:case:save', (e, payload) => {
        audit.write({ type: '操作', user: operator(), detail: `保存请求案例「${payload && payload.name}」` });
        return netsec.saveCase(payload);
    });
    ipcMain.handle('netsec:case:delete', (e, id) => netsec.deleteCase(id));

    ipcMain.handle('netsec:history:list', (e, limit) => netsec.listHistory(limit));
    ipcMain.handle('netsec:history:clear', () => {
        audit.write({ type: '操作', user: operator(), detail: '清空网络安全工作台历史' });
        return netsec.clearHistory();
    });
}

module.exports = { setup };
