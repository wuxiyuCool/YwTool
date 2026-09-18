/**
 * 认证与权限 IPC
 * 通道：auth:login / auth:logout / auth:session / auth:password / auth:resetPassword
 */
const auth = require('../auth');
const store = require('../store');
const audit = require('../auditLogger');
const menu = require('../menu');

function setup(ipcMain) {
    ipcMain.handle('auth:login', (e, { username, password }) => auth.login(username, password));

    ipcMain.handle('auth:logout', () => {
        const res = auth.logout();
        // 回收菜单可见范围，避免下一个登录的账号看到上一个账号的菜单结构
        menu.reset();
        return res;
    });

    ipcMain.handle('auth:session', () => auth.current());

    /** 修改自己的登录口令 */
    ipcMain.handle('auth:password', (e, { oldPassword, newPassword }) => {
        const session = auth.getSession();
        if (!session) return { ok: false, message: '会话已失效，请重新登录' };
        return auth.changePassword(session.username, oldPassword, newPassword);
    });

    /** 管理员重置他人口令：重置后要求其首次登录修改 */
    ipcMain.handle('auth:resetPassword', (e, { username, newPassword }) => {
        const user = store.list('users').find(u => u.username === username);
        if (!user) return { ok: false, message: '用户不存在' };
        const pwd = String(newPassword || '').trim() || 'Init@123456';
        const res = auth.setUserPassword(username, pwd, true);
        if (res.ok) {
            audit.write({
                type: '操作', user: (auth.getSession() || {}).username,
                detail: `重置用户 ${username} 的登录口令（首次登录需修改）`
            });
        }
        return { ...res, password: res.ok ? pwd : undefined };
    });
}

module.exports = { setup };
