/**
 * 脚本托管 IPC
 * 通道：scripts:list / scripts:detail / scripts:save / scripts:delete / scripts:run
 */
const store = require('../store');
const audit = require('../auditLogger');
const security = require('../security');
const ssh = require('../ssh');
const { buildScriptCommand } = require('../scriptUtil');

function setup(ipcMain) {
    ipcMain.handle('scripts:list', () => store.list('scripts'));
    ipcMain.handle('scripts:detail', (e, id) => store.find('scripts', id));

    ipcMain.handle('scripts:save', (e, payload) => {
        const data = { ...payload };
        const isNew = !data.id;
        data.updatedAt = store.nowText();
        data.author = data.author || store.get('config').currentUser;
        if (isNew) {
            data.createdAt = data.updatedAt;
            data.version = data.version || 'v1';
        } else {
            const old = store.find('scripts', data.id);
            // 内容变化则版本自增
            if (old && old.content !== data.content) {
                const n = parseInt(String(old.version || 'v1').replace('v', ''), 10) || 1;
                data.version = 'v' + (n + 1);
            }
        }
        const saved = store.upsert('scripts', data);
        audit.write({
            type: '操作', user: store.get('config').currentUser,
            detail: `${isNew ? '新建' : '更新'}脚本 ${saved.name}（${saved.version}）`
        });
        return { ok: true, script: saved };
    });

    ipcMain.handle('scripts:delete', (e, id) => {
        const script = store.find('scripts', id);
        const ok = store.remove('scripts', id);
        if (ok && script) {
            audit.write({ type: '操作', user: store.get('config').currentUser, detail: `删除脚本 ${script.name}` });
        }
        return { ok };
    });

    /** 用脚本发起批量任务（复用任务执行链路） */
    ipcMain.handle('scripts:run', async (e, { id, hostIds, concurrency, timeout }) => {
        const script = store.find('scripts', id);
        if (!script) return { ok: false, message: '脚本不存在' };

        const remoteCmd = buildScriptCommand(script);
        const check = security.validate(remoteCmd, { source: `脚本 ${script.name}` });
        if (!check.ok) return { ok: false, blocked: true, message: check.reason };

        const { runTask } = require('./taskHandler');
        return runTask({ cmd: '', scriptId: id, hostIds, concurrency, timeout });
    });

    /** 脚本内容本地语法预检（Python 交给 python -m py_compile，Shell 只看 shebang/空内容） */
    ipcMain.handle('scripts:lint', (e, { type, content }) => {
        if (!String(content || '').trim()) return { ok: false, message: '脚本内容为空' };
        if (type === 'python') {
            const { spawnSync } = require('child_process');
            const res = spawnSync('python', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
                input: content, encoding: 'utf8'
            });
            if (res.error) return { ok: true, message: '未检测到本地 Python，跳过语法检查' };
            if (res.status !== 0) return { ok: false, message: 'Python 语法错误：' + (res.stderr || '').trim() };
            return { ok: true, message: 'Python 语法检查通过' };
        }
        return { ok: true, message: 'Shell 脚本将在远端 bash 中执行' };
    });

    ipcMain.handle('scripts:execOne', async (e, { id, hostId }) => {
        const script = store.find('scripts', id);
        const host = store.find('hosts', hostId);
        if (!script || !host) return { ok: false, message: '脚本或主机不存在' };
        const remoteCmd = buildScriptCommand(script);
        const res = await ssh.execOnHost(host, remoteCmd, store.get('config').cmdTimeout);
        audit.write({
            type: '命令', user: store.get('config').currentUser,
            detail: `脚本 ${script.name} 在 ${host.name} 执行`,
            result: res.status === 'success' ? 'success' : 'failed'
        });
        return { ok: res.status === 'success', result: res };
    });
}

module.exports = { setup };
