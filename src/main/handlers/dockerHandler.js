/**
 * 容器编排与运维 IPC（服务器运维域 · containers 模块）
 * 通道：docker:host:list|save|delete|test     Docker 端点管理（token 加密存储；支持本机/TCP/SSH 桥接）
 *      docker:containers                      容器列表 + compose 项目分组（一次往返）
 *      docker:images / docker:image:detail    镜像列表 / 镜像详情（inspect + 分层历史）
 *      docker:info                            引擎详情（连接状态卡）
 *      docker:logs                            容器日志（demux 后文本）
 *      docker:run                             容器操作：start/stop/restart/kill/pause/unpause/remove/image-delete
 *      docker:stack:run                       compose 项目级 启/停/重启
 *      docker:exec                            容器内执行命令（ADMIN_ONLY）
 *      docker:compose:run                     本机 docker compose 编排（ADMIN_ONLY，依赖 docker CLI）
 * 审计：所有变更类操作与 exec/compose 均留痕。
 */
const store = require('../store');
const audit = require('../auditLogger');
const auth = require('../auth');
const containers = require('../containers');
const { encrypt, mask } = require('../crypto');

const operator = () => (auth.getSession() || {}).username || '-';

function sanitize(host) {
    const { token, ...rest } = host;
    return { ...rest, hasToken: !!token, tokenMasked: token ? mask() : '' };
}

function pickHost(id) {
    const host = store.find('dockerHosts', id);
    if (!host) throw new Error('Docker 端点不存在，请先在容器运维页配置');
    return host;
}

function setup(ipcMain) {
    /* ---------------- 端点管理 ---------------- */

    /** 端点清单 + 可关联主机（SSH 端点表单下拉用） */
    ipcMain.handle('docker:host:list', () => ({
        ok: true,
        endpoints: store.list('dockerHosts').map(sanitize),
        hosts: store.list('hosts').map(h => ({ id: h.id, name: h.name, ip: h.ip, authType: h.authType, hasPassword: !!h.password }))
    }));

    ipcMain.handle('docker:host:save', (e, payload = {}) => {
        const data = { ...payload };
        const kind = data.kind === 'ssh' ? 'ssh' : data.kind === 'tcp' ? 'tcp' : 'pipe';
        data.kind = kind;
        if (!data.token || data.token === mask()) {
            delete data.token;                       // 留空 = 不修改原 token
        } else {
            data.token = encrypt(data.token);
        }
        if (kind === 'tcp') { /* host/port 保留 */ } else if (kind === 'ssh') {
            if (!data.hostId) return { ok: false, message: 'SSH 端点需要关联一台平台主机（其凭据由主机管理统一维护）' };
            data.host = ''; data.port = '';
        } else {
            data.host = data.host || ''; data.port = ''; data.hostId = '';
        }
        const saved = store.upsert('dockerHosts', data);
        containers.dropBridge(saved.id);             // 端点变更后重建 SSH 桥接
        audit.write({
            type: '操作', user: operator(),
            detail: `${payload.id ? '修改' : '新增'} Docker 端点「${saved.name}」（${kind === 'tcp' ? saved.host + ':' + saved.port : kind === 'ssh' ? 'SSH 桥接' : '本机 socket'}）`
        });
        return { ok: true, host: sanitize(saved) };
    });

    ipcMain.handle('docker:host:delete', (e, id) => {
        const host = store.find('dockerHosts', id);
        const ok = store.remove('dockerHosts', id);
        containers.dropBridge(id);
        if (ok && host) audit.write({ type: '操作', user: operator(), detail: `删除 Docker 端点「${host.name}」` });
        return { ok };
    });

    ipcMain.handle('docker:host:test', async (e, id) => {
        const host = pickHost(id);
        const res = await containers.testHost(host);
        host.status = res.ok ? 'ok' : 'error';
        host.lastTestAt = store.nowText();
        store.persist();
        return res;
    });

    /* ---------------- 资源查询与操作 ---------------- */

    ipcMain.handle('docker:containers', async (e, { hostId, all = true } = {}) => {
        try {
            const list = await containers.listContainers(pickHost(hostId), !!all);
            return { ok: true, containers: list, stacks: containers.groupStacks(list) };
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('docker:images', async (e, { hostId } = {}) => {
        try {
            return { ok: true, images: await containers.listImages(pickHost(hostId)) };
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    /** 引擎详情（连接状态卡）：docker info + version 摘要 */
    ipcMain.handle('docker:info', async (e, { hostId } = {}) => {
        try {
            return await containers.dockerInfo(pickHost(hostId));
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    /** 镜像详情：inspect + 分层历史 */
    ipcMain.handle('docker:image:detail', async (e, { hostId, ref } = {}) => {
        try {
            return await containers.imageDetail(pickHost(hostId), ref);
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('docker:logs', async (e, { hostId, id, tail } = {}) => {
        try {
            return { ok: true, text: await containers.containerLogs(pickHost(hostId), String(id), tail) };
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('docker:run', async (e, { hostId, action, id, force } = {}) => {
        const host = pickHost(hostId);
        try {
            const res = await containers.containerAction(host, String(action || ''), String(id || ''), { force: !!force });
            audit.write({
                type: '命令', user: operator(),
                detail: `容器操作「${action}」：${host.name} / ${id}${force ? '（强制）' : ''}`
            });
            return res;
        } catch (err) {
            audit.write({
                type: '命令', user: operator(), result: 'failed',
                detail: `容器操作「${action}」失败：${host.name} / ${id} — ${err.message}`
            });
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('docker:stack:run', async (e, { hostId, project, action } = {}) => {
        const host = pickHost(hostId);
        try {
            const res = await containers.stackAction(host, String(project || ''), String(action || ''));
            audit.write({
                type: '命令', user: operator(),
                detail: `compose 项目「${action}」：${host.name} / ${project}（${(res.results || []).length} 个容器）`
            });
            return res;
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('docker:exec', async (e, { hostId, id, cmd } = {}) => {
        const host = pickHost(hostId);
        const command = String(cmd || '').trim();
        if (!command) return { ok: false, message: '请输入要执行的命令' };
        try {
            const res = await containers.execInContainer(host, String(id), command);
            audit.write({
                type: '命令', user: operator(),
                detail: `容器内执行：${host.name} / ${id} — ${command.slice(0, 200)}`
            });
            return { ok: true, output: String(res.output || '').slice(0, 200 * 1024) };
        } catch (err) {
            audit.write({
                type: '命令', user: operator(), result: 'failed',
                detail: `容器内执行失败：${host.name} / ${id} — ${command.slice(0, 120)}（${err.message}）`
            });
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('docker:compose:run', async (e, { yaml, action } = {}) => {
        const res = await containers.runCompose(String(yaml || ''), String(action || ''));
        audit.write({
            type: '命令', user: operator(), result: res.ok ? 'success' : 'failed',
            detail: `docker compose ${action}（本机 CLI）：${res.message || ''}`
        });
        return res;
    });
}

module.exports = { setup };
