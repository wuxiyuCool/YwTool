/**
 * Kubernetes 集群 IPC（服务器运维域 · containers 模块）
 * 通道：kube:clusters:list / kube:cluster:save|delete|test
 *      kube:overview / kube:get / kube:logs（只读）
 *      kube:run（管理员：速查面板执行任意 kubectl，过黑白名单 + 审计）
 * 访问模式：local（平台机 kubectl）或 ssh（跳板机 kubectl，复用主机凭据体系）。
 */
const store = require('../store');
const audit = require('../auditLogger');
const auth = require('../auth');
const k8s = require('../k8s');

const operator = () => (auth.getSession() || {}).username || '-';

function pickCluster(id) {
    const cluster = store.find('kubeClusters', id);
    if (!cluster) throw new Error('K8s 集群配置不存在');
    return cluster;
}

function setup(ipcMain) {
    ipcMain.handle('kube:clusters:list', () => {
        const hosts = store.list('hosts').map(h => ({ id: h.id, name: h.name, ip: h.ip }));
        return { clusters: store.list('kubeClusters'), hosts };
    });

    ipcMain.handle('kube:cluster:save', (e, payload = {}) => {
        const name = String(payload.name || '').trim();
        if (!name) return { ok: false, message: '请填写集群名称' };
        const mode = payload.mode === 'ssh' ? 'ssh' : 'local';
        if (mode === 'ssh' && !payload.hostId) return { ok: false, message: 'SSH 模式需要选择在跳板上执行 kubectl 的主机' };
        const data = {
            id: payload.id || undefined,
            name,
            mode,
            hostId: mode === 'ssh' ? payload.hostId : '',
            namespace: String(payload.namespace || 'default').trim() || 'default',
            note: String(payload.note || '').trim()
        };
        const saved = store.upsert('kubeClusters', data);
        audit.write({ type: '操作', user: operator(), detail: `${payload.id ? '修改' : '新增'} K8s 集群「${saved.name}」（${mode === 'ssh' ? 'SSH 跳板' : '本机 kubectl'}）` });
        return { ok: true, cluster: saved };
    });

    ipcMain.handle('kube:cluster:delete', (e, id) => {
        const cluster = store.find('kubeClusters', id);
        const ok = store.remove('kubeClusters', id);
        if (ok && cluster) audit.write({ type: '操作', user: operator(), detail: `删除 K8s 集群「${cluster.name}」` });
        return { ok };
    });

    ipcMain.handle('kube:cluster:test', async (e, id) => {
        const cluster = pickCluster(id);
        const res = await k8s.testCluster(cluster);
        cluster.status = res.ok ? 'ok' : 'error';
        cluster.lastTestAt = store.nowText();
        store.persist();
        return res;
    });

    ipcMain.handle('kube:overview', async (e, { clusterId } = {}) => {
        try {
            return await k8s.overview(pickCluster(clusterId));
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('kube:get', async (e, { clusterId, resource, namespace, allNamespaces } = {}) => {
        try {
            return await k8s.getResources(pickCluster(clusterId), resource, { namespace, allNamespaces: !!allNamespaces });
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('kube:logs', async (e, { clusterId, pod, namespace, tail } = {}) => {
        try {
            return await k8s.podLogs(pickCluster(clusterId), pod, namespace, tail);
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('kube:run', async (e, { clusterId, command } = {}) => {
        try {
            return await k8s.runKubectl(pickCluster(clusterId), command, operator());
        } catch (err) {
            return { ok: false, message: err.message };
        }
    });

    ipcMain.handle('kube:resources', () => ({ ok: true, resources: k8s.RESOURCES }));
}

module.exports = { setup };
