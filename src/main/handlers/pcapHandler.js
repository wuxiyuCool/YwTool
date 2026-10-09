/**
 * 流量分析（pcap/pcapng + tshark 实时抓包）IPC
 * 通道：pcap:open / pcap:list / pcap:detail / pcap:stream / pcap:close
 *       pcap:tool / pcap:ifaces / pcap:live:start / pcap:live:stop
 * 推送：pcap:live（实时抓包新增报文批次）
 * 归属 netsec 模块；打开文件与实时抓包为管理员通道（auth.ADMIN_ONLY）。
 */
const { dialog } = require('electron');
const pcap = require('../pcap');
const auth = require('../auth');
const audit = require('../auditLogger');

const operator = () => (auth.getSession() || {}).username || '-';

let targetWin = null;

function setup(ipcMain) {
    pcap.setEmitter((event, payload) => {
        if (targetWin && !targetWin.isDestroyed()) targetWin.send('pcap:' + event, payload);
    });

    ipcMain.handle('pcap:open', async (e) => {
        targetWin = e.sender;
        const win = require('electron').BrowserWindow.fromWebContents(e.sender);
        const res = await dialog.showOpenDialog(win, {
            title: '打开流量包',
            filters: [
                { name: '抓包文件 (*.pcap;*.pcapng)', extensions: ['pcap', 'pcapng'] },
                { name: '所有文件', extensions: ['*'] }
            ],
            properties: ['openFile']
        });
        if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
        const out = pcap.openFile(res.filePaths[0]);
        if (out.ok) audit.write({ type: '操作', user: operator(), detail: `打开流量包 ${out.file}（${out.count} 报文）` });
        return out;
    });

    ipcMain.handle('pcap:list', () => pcap.listPackets());
    ipcMain.handle('pcap:detail', (e, no) => pcap.getDetail(no));
    ipcMain.handle('pcap:stream', (e, no) => pcap.followStream(no));
    ipcMain.handle('pcap:close', () => pcap.closeFile());

    ipcMain.handle('pcap:tool', () => pcap.toolInfo());
    ipcMain.handle('pcap:ifaces', () => pcap.listInterfaces());

    ipcMain.handle('pcap:live:start', async (e, options) => {
        targetWin = e.sender;
        const res = pcap.liveStart(options || {});
        audit.write({
            type: '操作', user: operator(),
            detail: res.ok ? `启动实时抓包（接口 ${options && options.iface || '默认'}，工具 ${res.tool}）` : `实时抓包启动失败：${res.message}`
        });
        return res;
    });
    ipcMain.handle('pcap:live:stop', () => {
        const res = pcap.liveStop();
        audit.write({ type: '操作', user: operator(), detail: `停止实时抓包（共 ${res.count || 0} 报文）` });
        return res;
    });
}

module.exports = { setup };
