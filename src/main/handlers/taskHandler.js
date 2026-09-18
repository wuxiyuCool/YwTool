/**
 * 任务调度与执行 IPC
 * 通道：tasks:list / tasks:detail / tasks:validate / tasks:run
 *
 * 执行链路：命令校验 → 落库(执行中) → SSH 并发执行(带进度推送) → 回写结果 → 审计留痕
 */
const { BrowserWindow } = require('electron');
const store = require('../store');
const audit = require('../auditLogger');
const security = require('../security');
const alerts = require('../alerts');
const ssh = require('../ssh');
const { buildScriptCommand } = require('../scriptUtil');

function broadcast(channel, payload) {
    BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
    });
}

function summary(task) {
    const results = task.results || [];
    return {
        id: task.id, cmd: task.cmd, hostCount: task.hostCount, status: task.status,
        operator: task.operator, createdAt: task.createdAt,
        successCount: results.filter(r => r.status === 'success').length,
        failedCount: results.filter(r => r.status === 'failed').length
    };
}

/** 任务失败时写入告警中心（按任务去重，5 分钟内不重复打扰） */
function alertWrite(task, results) {
    const failed = results.filter(r => r.status === 'failed');
    alerts.add({
        level: 'warn',
        title: `任务执行失败：${task.id}`,
        detail: `命令 ${task.cmd} · 失败 ${failed.length} 台：` +
            failed.slice(0, 5).map(r => `${r.hostName}(${(r.error || '未知错误').slice(0, 60)})`).join('、'),
        source: `task:${task.id}`
    });
}

async function runTask(payload) {
    const config = store.get('config');
    const { cmd, hostIds = [], scriptId = null, concurrency, timeout } = payload;

    // 目标主机解析
    const allHosts = store.list('hosts');
    const targets = hostIds.includes('all') ? allHosts : allHosts.filter(h => hostIds.includes(h.id));
    if (!targets.length) return { ok: false, message: '未选择任何目标主机' };

    // 生成实际执行内容
    const script = scriptId ? store.find('scripts', scriptId) : null;
    const remoteCmd = script ? buildScriptCommand(script) : String(cmd || '').trim();
    const label = script ? `[脚本] ${script.name}` : remoteCmd;

    // 1) 执行前安全校验
    const check = security.validate(remoteCmd, { source: '平台' });
    const taskId = store.nextTaskId();

    if (!check.ok) {
        const blockedTask = store.upsert('tasks', {
            id: taskId, cmd: label, hostIds: targets.map(h => h.id), hostCount: targets.length,
            status: 'blocked', operator: config.currentUser, createdAt: store.nowText(),
            results: [], blockReason: check.reason
        });
        return { ok: false, blocked: true, message: check.reason, task: summary(blockedTask) };
    }

    // 2) 落库：执行中
    const task = store.upsert('tasks', {
        id: taskId, cmd: label, hostIds: targets.map(h => h.id), hostCount: targets.length,
        status: 'running', operator: config.currentUser, createdAt: store.nowText(),
        concurrency: Number(concurrency) || config.maxConcurrency,
        timeout: Number(timeout) || config.cmdTimeout,
        whitelisted: check.whitelisted, results: []
    });

    broadcast('task:progress', { taskId, phase: 'start', total: targets.length, done: 0, label });

    // 3) 并发执行
    const results = await ssh.execBatch(targets, remoteCmd, {
        concurrency: task.concurrency,
        timeout: task.timeout,
        onProgress: (done, total, res) => {
            broadcast('task:progress', { taskId, phase: 'running', total, done, host: res.hostName, status: res.status });
        }
    });

    // 4) 回写结果与主机状态
    task.results = results;
    task.finishedAt = store.nowText();
    task.status = results.some(r => r.status === 'failed') ? 'failed' : 'success';
    results.forEach(r => {
        const host = store.find('hosts', r.hostId);
        if (host) {
            host.status = r.status === 'success' ? 'online' : 'offline';
            host.lastConnectedAt = store.nowText();
        }
    });
    store.persist();

    // 5) 审计留痕
    audit.write({
        type: '命令', user: config.currentUser,
        detail: `${taskId} 在 ${targets.length} 台主机执行 ${label}（成功 ${summary(task).successCount} / 失败 ${summary(task).failedCount}）`,
        result: task.status === 'success' ? 'success' : 'failed'
    });
    if (task.status === 'failed') {
        alertWrite(task, results);
        audit.write({
            type: '告警', user: 'system',
            detail: `${taskId} 存在执行失败主机：${results.filter(r => r.status === 'failed').map(r => r.hostName).join('、')}`,
            result: 'failed'
        });
    }

    broadcast('task:progress', { taskId, phase: 'done', total: targets.length, done: targets.length, status: task.status });
    return { ok: true, task: summary(task), results };
}

function setup(ipcMain) {
    ipcMain.handle('tasks:list', (e, { limit = 100 } = {}) =>
        store.list('tasks').slice(0, limit).map(summary));

    ipcMain.handle('tasks:detail', (e, id) => store.find('tasks', id));

    ipcMain.handle('tasks:validate', (e, { cmd, scriptId }) => {
        const script = scriptId ? store.find('scripts', scriptId) : null;
        const target = script ? buildScriptCommand(script) : String(cmd || '');
        return security.validate(target);
    });

    ipcMain.handle('tasks:run', async (e, payload) => {
        try {
            return await runTask(payload);
        } catch (err) {
            return { ok: false, message: '任务执行异常：' + err.message };
        }
    });

    /** 结果导出（CSV 文本，交由前端下载） */
    ipcMain.handle('tasks:export', (e, id) => {
        const task = store.find('tasks', id);
        if (!task) return { ok: false, message: '任务不存在' };
        const header = '主机名,IP,状态,退出码,耗时(ms),输出摘要,错误信息\n';
        const body = (task.results || []).map(r => [
            r.hostName, r.ip, r.status, r.exitCode, r.durationMs,
            JSON.stringify((r.output || '').slice(0, 200)), JSON.stringify(r.error || '')
        ].join(',')).join('\n');
        return { ok: true, filename: `${task.id}.csv`, content: header + body };
    });
}

module.exports = { setup, runTask };
