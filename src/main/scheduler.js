/**
 * 任务调度器
 * - 支持两种周期：间隔执行（intervalMinutes）与每日定时（daily + time "HH:mm"）
 * - 主进程常驻 30s 心跳，到点复用 taskHandler.runTask 链路（含命令校验与审计）
 * - 调度异常/任务失败会生成告警
 */
const { BrowserWindow } = require('electron');
const store = require('./store');
const audit = require('./auditLogger');
const alerts = require('./alerts');

const TICK_MS = 30 * 1000;
let timer = null;
let running = false;

function broadcast(channel, payload) {
    BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
    });
}

/** 计算下一次执行时间戳 */
function computeNext(schedule, from = Date.now()) {
    if (schedule.mode === 'daily') {
        const [h, m] = String(schedule.time || '00:00').split(':').map(n => parseInt(n, 10) || 0);
        const d = new Date(from);
        d.setHours(h, m, 0, 0);
        if (d.getTime() <= from) d.setDate(d.getDate() + 1);
        return d.getTime();
    }
    const minutes = Math.max(1, Number(schedule.intervalMinutes) || 60);
    return from + minutes * 60000;
}

function nextRunText(schedule) {
    const ts = schedule.nextRunAt;
    if (!ts) return '-';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function describe(schedule) {
    return schedule.mode === 'daily'
        ? `每日 ${schedule.time}`
        : `每 ${schedule.intervalMinutes || 60} 分钟`;
}

/** 单次心跳：检查到期调度并执行 */
async function tick() {
    if (running) return;
    running = true;
    try {
        const now = Date.now();
        for (const schedule of store.list('schedules')) {
            if (!schedule.enabled) continue;
            if (!schedule.nextRunAt) {
                schedule.nextRunAt = computeNext(schedule, now);
                store.persist();
                continue;
            }
            if (schedule.nextRunAt > now) continue;
            await execute(schedule, 'schedule');
        }
    } catch (err) {
        audit.write({ type: '告警', user: 'system', detail: '调度器异常：' + err.message, result: 'failed' });
    } finally {
        running = false;
    }
}

/** 执行一次调度任务（供心跳与「立即执行」共用） */
async function execute(schedule, trigger = 'manual') {
    const { runTask } = require('./handlers/taskHandler');
    schedule.lastRunAt = store.nowText();
    schedule.lastStatus = 'running';
    store.persist();

    broadcast('schedule:progress', { id: schedule.id, phase: 'start', trigger, name: schedule.name });

    let status = 'failed';
    let taskId = null;
    try {
        const res = await runTask({
            cmd: schedule.cmd,
            scriptId: schedule.scriptId || null,
            hostIds: schedule.hostIds || [],
            concurrency: schedule.concurrency,
            timeout: schedule.timeout
        });

        if (res.blocked) {
            status = 'blocked';
            alerts.add({
                level: 'danger',
                title: `定时任务被拦截：${schedule.name}`,
                detail: res.message,
                source: `schedule:${schedule.id}`
            });
        } else if (res.ok && res.task) {
            status = res.task.status;
            taskId = res.task.id;
            if (status === 'failed') {
                alerts.add({
                    level: 'warn',
                    title: `定时任务执行失败：${schedule.name}`,
                    detail: `任务 ${taskId}：成功 ${res.task.successCount} 台 / 失败 ${res.task.failedCount} 台`,
                    source: `schedule:${schedule.id}`
                });
            }
        } else {
            alerts.add({
                level: 'danger',
                title: `定时任务无法执行：${schedule.name}`,
                detail: (res && res.message) || '未知错误',
                source: `schedule:${schedule.id}`
            });
        }
    } catch (err) {
        alerts.add({
            level: 'danger',
            title: `定时任务异常：${schedule.name}`,
            detail: err.message,
            source: `schedule:${schedule.id}`
        });
    }

    schedule.lastStatus = status;
    schedule.lastTaskId = taskId;
    schedule.lastTrigger = trigger;
    schedule.nextRunAt = computeNext(schedule, Date.now());
    store.persist();

    audit.write({
        type: '操作', user: (store.get('config') || {}).currentUser,
        detail: `调度任务「${schedule.name}」${trigger === 'manual' ? '手动' : '定时'}触发，结果：${status}`,
        result: status === 'success' ? 'success' : (status === 'blocked' ? 'blocked' : 'failed')
    });

    broadcast('schedule:progress', { id: schedule.id, phase: 'done', status, taskId });
    return { ok: true, status, taskId };
}

function start() {
    if (timer) return;
    // 启动时补齐 nextRunAt
    store.list('schedules').forEach(s => {
        if (!s.enabled) { s.nextRunAt = null; return; }
        if (!s.nextRunAt || s.nextRunAt < Date.now() - 60000) s.nextRunAt = computeNext(s, Date.now());
    });
    store.persist();
    timer = setInterval(tick, TICK_MS);
    tick();
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { start, stop, tick, execute, computeNext, nextRunText, describe, broadcast };
