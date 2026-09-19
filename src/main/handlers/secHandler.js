/**
 * 信息安全工具箱 IPC
 * 通道：sec:hash / sec:cipher + sec:ciphers / sec:jwt / sec:qr:generate|decode / sec:drivers
 * 全部为本机纯计算（二维码识别也是本地解码），不访问网络、不落库。
 */
const sectools = require('../sectools');

function setup(ipcMain) {
    ipcMain.handle('sec:hash', (e, payload) => sectools.hash(payload));
    ipcMain.handle('sec:cipher', (e, payload) => sectools.cipher(payload));
    ipcMain.handle('sec:ciphers', () => sectools.cipherList());
    ipcMain.handle('sec:jwt', (e, payload) => sectools.jwt(payload));
    ipcMain.handle('sec:qr:generate', async (e, payload) => sectools.qrGenerate(payload));
    ipcMain.handle('sec:qr:decode', async (e, payload) => sectools.qrDecode(payload));
    ipcMain.handle('sec:drivers', () => sectools.driverStatus());
}

module.exports = { setup };
