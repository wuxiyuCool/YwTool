const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const store = require('./store');
const audit = require('./auditLogger');
const auth = require('./auth');
const scheduler = require('./scheduler');
const menu = require('./menu');

/** IPC 业务模块：按模块拆分，统一注册 */
const IPC_MODULES = [
    './handlers/authHandler',
    './handlers/hostHandler',
    './handlers/dockerHandler',
    './handlers/kubeHandler',
    './handlers/ruleHandler',
    './handlers/taskHandler',
    './handlers/scriptHandler',
    './handlers/accountHandler',
    './handlers/ledgerHandler',
    './handlers/auditHandler',
    './handlers/alertHandler',
    './handlers/scheduleHandler',
    './handlers/dbHandler',
    './handlers/dbConfigHandler',
    './handlers/systemHandler',
    './handlers/backupHandler',
    './handlers/netsecHandler',
    './handlers/secHandler',
    './handlers/dashboardHandler',
    './handlers/aiHandler'
];
let mainWindow;

/**
 * 带鉴权的 handle 包装器
 * 所有业务 handler 都收到这个对象，因此权限校验统一在此完成，业务代码零侵入
 */
function createGuardedIpc() {
    return {
        handle: (channel, listener) => ipcMain.handle(channel, async (event, ...args) => {
            const check = auth.authorize(channel);
            if (!check.ok) {
                const err = new Error(`${check.code}: ${check.message}`);
                err.code = check.code;
                throw err;
            }
            return listener(event, ...args);
        }),
        on: (...args) => ipcMain.on(...args)
    };
}

function registerIpc() {
    ipcMain.handle('app:info', () => ({
        name: 'SgOps',
        version: app.getVersion(),
        platform: process.platform
    }));

    // 菜单栏结构（域 / 页面元数据）由主进程下发，渲染进程不重复维护
    ipcMain.handle('menu:model', () => menu.build);

    // 渲染进程同步当前域与可见范围 → 主进程重建菜单
    ipcMain.handle('menu:update', (e, payload) => menu.update(payload || {}));

    const guarded = createGuardedIpc();
    IPC_MODULES.forEach(m => {
        try {
            require(m).setup(guarded);
        } catch (err) {
            // 静默跳过会导致该模块所有通道报 No handler registered 且无从排查，必须落审计可见
            console.error(`[IPC] 模块加载失败 ${m}:`, err.message);
            try {
                audit.write({ type: '操作', user: 'system', detail: `IPC 模块加载失败 ${m}: ${err.message}`, result: 'failed' });
            } catch (e) { /* ignore */ }
        }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1320,
        height: 860,
        minWidth: 1100,
        minHeight: 700,
        title: 'SgOps · 批量运维管理平台',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            webSecurity: false  // file:// 下加载 ES 模块需要（本地内网工具）
        }
    });

    // 应用菜单栏：三个运维域放在「文件」菜单，域内页面放在「视图」菜单
    // 菜单可用性由渲染进程登录后同步的可见范围决定（见 menu.js update）
    menu.attach(mainWindow);

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
    // 初始化本地库（首次运行写入种子数据）与日志目录
    const config = store.load().config;
    store.ensureDirs();
    if (config && config.logRetentionDays) {
        try { audit.cleanup(config.logRetentionDays); } catch (e) { /* ignore */ }
    }
    audit.write({ type: '操作', user: config.currentUser, detail: '平台启动' });

    registerIpc();
    createWindow();

    // 任务调度器（30s 心跳，到点执行定时任务）
    scheduler.start();
});

app.on('before-quit', () => {
    scheduler.stop();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
