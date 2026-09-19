/**
 * Kubernetes 集群概览（主进程）
 * ------------------------------------------------------------------
 * 设计选型（对比「SSH 敲命令」与「API 直连」后的混合方案）：
 *   - local 模式：spawn 本机 kubectl（平台机自带 kubeconfig 时最省事）
 *   - ssh  模式（推荐远程）：复用平台主机资产与 SSH 凭据体系，在目标跳板机上执行
 *     kubectl 并以 -o json 取回结构化结果 —— 无需向平台机暴露 API Server / 下发 kubeconfig，
 *     通道本身经过既有 SSH 认证与审计。
 *   所有资源名 / 参数经过白名单字符校验；secrets 不出现在资源清单（避免值外泄）。
 */
const { spawn } = require('child_process');
const store = require('./store');
const audit = require('./auditLogger');
const ssh = require('./ssh');
const security = require('./security');

const KUBECTL_TIMEOUT_SEC = 25;
const JSON_FLAG = '-o';

/** 允许快捷查看的资源（不含 secrets：其数据字段可能携带敏感值） */
const RESOURCES = ['pods', 'deployments', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'services', 'ingresses', 'nodes', 'namespaces', 'configmaps', 'events'];
const RESOURCES_SET = new Set(RESOURCES);

/** kubectl 参数白名单：字母数字与 . - / = : @ , 组合（覆盖 -n、--field-selector、label selector 等） */
function assertArg(arg) {
    const s = String(arg);
    if (!/^[\w.\-\/=:@,]+$/.test(s)) throw new Error(`参数含非法字符：${s.slice(0, 40)}`);
    return s;
}
const assertResource = r => {
    const s = String(r || '').toLowerCase();
    if (!RESOURCES_SET.has(s)) throw new Error(`不支持的资源类型：${r}（可用：${RESOURCES.join(' / ')}）`);
    return s;
};
const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i;

function findCluster(id) {
    const cluster = store.find('kubeClusters', id);
    if (!cluster) throw new Error('K8s 集群配置不存在，请先在容器运维页配置');
    return cluster;
}

/**
 * 执行一次 kubectl，返回 { ok, json?, text?, error }
 * local：spawn kubectl；ssh：在跳板主机上执行 kubectl（execOnHost）
 */
async function kubectl(cluster, args, opts = {}) {
    const safeArgs = args.map(assertArg);
    if (cluster.mode === 'ssh') {
        const host = store.find('hosts', String(cluster.hostId || ''));
        if (!host) return { ok: false, error: '集群关联的主机不存在（kubectl 需要在有 kubeconfig 的跳板机上执行）' };
        const cmd = 'kubectl ' + safeArgs.map(a => (/^[\w.\-\/=:@,]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
        const check = security.validate(cmd, { source: `K8s ${cluster.name}` });
        if (!check.ok) {
            audit.write({ type: '拦截', user: '-', detail: `K8s 命令被拦截（${cluster.name}）：${cmd.slice(0, 120)}`, result: 'blocked' });
            return { ok: false, error: check.reason, blocked: true };
        }
        // kubectl -o json 输出可能很大：放宽到 400KB（默认 20KB 会截断 JSON）
        const res = await ssh.execOnHost(host, cmd, KUBECTL_TIMEOUT_SEC, 400000);
        const text = String(res.output || '');
        if (res.status !== 'success') return { ok: false, error: (res.error || text || 'kubectl 执行失败').slice(0, 500) };
        return parseOut(text, opts.raw);
    }
    // local 模式
    return new Promise(resolve => {
        const child = spawn('kubectl', safeArgs, { windowsHide: true, shell: process.platform === 'win32' });
        let out = '';
        let err = '';
        const killer = setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } }, KUBECTL_TIMEOUT_SEC * 1000);
        child.stdout.on('data', d => { out += d.toString('utf8'); });
        child.stderr.on('data', d => { err += d.toString('utf8'); });
        child.on('error', e => {
            clearTimeout(killer);
            resolve({ ok: false, error: 'kubectl 不可用：' + e.message + '（本机模式需要平台机安装 kubectl 并配置 kubeconfig；远程集群请改用 SSH 模式）' });
        });
        child.on('close', code => {
            clearTimeout(killer);
            if (code !== 0 && !out) {
                const raw = err || `kubectl 退出码 ${code}`;
                const friendly = /不是内部或外部命令|not recognized|无法将/i.test(raw)
                    ? '本机未安装 kubectl（本机模式需要平台机可执行 kubectl；远程集群请改用 SSH 模式在跳板机执行）' : raw;
                return resolve({ ok: false, error: friendly.slice(0, 500) });
            }
            resolve(parseOut(out, opts.raw));
        });
    });
}

function parseOut(text, raw) {
    if (raw) return { ok: true, text };
    try {
        return { ok: true, json: JSON.parse(text) };
    } catch (e) {
        return { ok: true, text };
    }
}

/* ---------------- 概览 ---------------- */

const ageOf = ts => {
    if (!ts) return '';
    const d = (Date.now() - new Date(ts).getTime()) / 1000;
    if (d < 90) return Math.round(d) + 's';
    if (d < 5400) return Math.round(d / 60) + 'm';
    if (d < 172800) return Math.round(d / 3600) + 'h';
    return Math.round(d / 86400) + 'd';
};

const readyOf = item => {
    const s = item.status || {};
    const spec = item.spec || {};
    if (spec.replicas !== undefined) return `${s.readyReplicas || 0}/${spec.replicas}`;
    if (s.phase) return s.phase;
    if (item.kind === 'Service') return [s.clusterIP, (s.ports || [])[0] && `${(s.ports || [])[0].port}${(s.ports || [])[0].nodePort ? ':' + (s.ports || [])[0].nodePort : ''}`].filter(x => x && x !== 'None').join(' ');
    if (item.kind === 'CronJob') return `${s.active || 0} active · ${spec.schedule || ''}`;
    if (spec.schedule) return spec.schedule;
    return '';
};

function summarize(list) {
    return (list.items || []).slice(0, 200).map(item => ({
        ns: (item.metadata || {}).namespace || '',
        name: (item.metadata || {}).name || '',
        ready: readyOf(item),
        age: ageOf((item.metadata || {}).creationTimestamp),
        status: item.kind === 'Node'
            ? (((item.status || {}).conditions || []).find(c => c.type === 'Ready') || {}).status === 'True' ? 'Ready' : 'NotReady'
            : ''
    }));
}

/** 集群概览：并行取 nodes / ns 计数 / 全部 deployments / 非终态 pods / Warning events */
async function overview(cluster) {
    const [nodes, ns, deploys, pods, events] = await Promise.all([
        kubectl(cluster, ['get', 'nodes', JSON_FLAG, 'json']),
        kubectl(cluster, ['get', 'namespaces', JSON_FLAG, 'json']),
        kubectl(cluster, ['get', 'deployments', '--all-namespaces', JSON_FLAG, 'json']),
        kubectl(cluster, ['get', 'pods', '--all-namespaces', JSON_FLAG, 'json']),
        kubectl(cluster, ['get', 'events', '--all-namespaces', '--field-selector', 'type=Warning', JSON_FLAG, 'json'])
    ]);
    const firstErr = [nodes, ns, deploys, pods].find(r => !r.ok);
    if (firstErr) return { ok: false, message: firstErr.error };

    const podItems = (pods.json && pods.json.items) || [];
    const running = podItems.filter(p => ((p.status || {}).phase) === 'Running').length;
    const pending = podItems.filter(p => ((p.status || {}).phase) === 'Pending').length;
    const failed = podItems.filter(p => ((p.status || {}).phase) === 'Failed').length;

    return {
        ok: true,
        nodes: summarize(nodes.json || { items: [] }).map(n => ({ ...n, status: n.status || ((n.ready === 'True') ? 'Ready' : '') })),
        nodeReady: ((nodes.json || {}).items || []).filter(n => ((n.status || {}).conditions || []).some(c => c.type === 'Ready' && c.status === 'True')).length,
        nodeTotal: ((nodes.json || {}).items || []).length,
        namespaces: ((ns.json || {}).items || []).map(x => (x.metadata || {}).name).filter(Boolean).slice(0, 100),
        deployments: summarize((deploys.json || { items: [] })),
        podsTotal: podItems.length,
        podsRunning: running,
        podsPending: pending,
        podsFailed: failed,
        warnings: (((events.json || {}).items) || []).slice(-15).reverse().map(e => ({
            ns: (e.metadata || {}).namespace || '',
            reason: e.reason || ((e.involvedObject || {}).kind) || '',
            object: ((e.involvedObject || {}).name) || '',
            message: String(e.message || '').slice(0, 160),
            age: ageOf(e.lastTimestamp || (e.metadata || {}).creationTimestamp)
        })),
        serverVersion: ((nodes.json || {}).items || [])[0] && ((nodes.json || {}).items || [])[0].status && ((nodes.json || {}).items || [])[0].status.nodeInfo
            ? ((nodes.json || {}).items || [])[0].status.nodeInfo.kubeProxyVersion || '' : ''
    };
}

/** 资源快捷视图 */
async function getResources(cluster, resource, opts = {}) {
    assertResource(resource);
    const args = ['get', resource, JSON_FLAG, 'json'];
    if (opts.allNamespaces && resource !== 'nodes' && resource !== 'namespaces') args.splice(1, 0, '--all-namespaces');
    if (opts.namespace) { args.splice(2, 0, '-n', assertArg(opts.namespace)); }
    if (opts.fieldSelector) { args.push('--field-selector', assertArg(opts.fieldSelector)); }
    const res = await kubectl(cluster, args);
    if (!res.ok) return { ok: false, message: res.error };
    return { ok: true, resource, rows: summarize(res.json || { items: [] }) };
}

/** Pod 日志 */
async function podLogs(cluster, pod, namespace, tail = 200) {
    if (!NAME_RE.test(String(pod))) return { ok: false, message: '非法 Pod 名' };
    const args = ['logs', assertArg(pod), '--tail', String(Math.min(Number(tail) || 200, 2000))];
    if (namespace && NAME_RE.test(namespace)) args.splice(1, 0, '-n', assertArg(namespace));
    const res = await kubectl(cluster, args, { raw: true });
    return res.ok ? { ok: true, text: res.text || '（空）' } : { ok: false, message: res.error };
}

/** 管理员自定义 kubectl（速查面板执行入口）：黑白名单 + 审计 */
async function runKubectl(cluster, commandLine, user) {
    const raw = String(commandLine || '').trim();
    if (!raw) return { ok: false, message: '请输入 kubectl 命令' };
    const parts = raw.replace(/^kubectl\s+/i, '').split(/\s+/).filter(Boolean);
    if (!parts.length) return { ok: false, message: '仅支持 kubectl 子命令（无需输入 kubectl 前缀）' };
    try { parts.forEach(assertArg); } catch (e) { return { ok: false, message: e.message }; }
    const cmd = 'kubectl ' + parts.join(' ');
    const check = security.validate(cmd, { user, source: `K8s ${cluster.name}` });
    if (!check.ok) {
        audit.write({ type: '拦截', user, detail: `AI K8s 命令被拦截（${cluster.name}）：${cmd.slice(0, 120)}`, result: 'blocked' });
        return { ok: false, blocked: true, message: check.reason };
    }
    const res = await kubectl(cluster, parts, { raw: true });
    audit.write({
        type: '命令', user, source: 'K8s',
        detail: `kubectl ${cmd.slice(7, 200)}`,
        result: res.ok ? 'success' : 'failed'
    });
    if (!res.ok) return { ok: false, message: res.error };
    return { ok: true, text: (res.text || (res.json ? JSON.stringify(res.json, null, 2) : '') || '（无输出）').slice(0, 200 * 1024) };
}

/** 连通测试：优先 version -o json（失败回落到 get ns 计数） */
async function testCluster(cluster) {
    const started = Date.now();
    const ver = await kubectl(cluster, ['version', JSON_FLAG, 'json']);
    if (ver.ok && ver.json) {
        const sv = ver.json.serverVersion || ver.json.gitVersion || ver.json;
        return { ok: true, durationMs: Date.now() - started, message: `连接成功 · kube ${typeof sv === 'object' ? JSON.stringify(sv).slice(0, 40) : sv}` };
    }
    const ns = await kubectl(cluster, ['get', 'namespaces', JSON_FLAG, 'json']);
    if (ns.ok) {
        return { ok: true, durationMs: Date.now() - started, message: `连接成功 · ${((ns.json || {}).items || []).length} 个命名空间` };
    }
    return { ok: false, durationMs: Date.now() - started, message: ns.error || '连接失败' };
}

module.exports = {
    RESOURCES, kubectl, overview, getResources, podLogs, runKubectl, testCluster
};
