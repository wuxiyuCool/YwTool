/**
 * 系统运维 · 系统设置
 * 数据流：system:env（数据文件/日志目录/驱动可用性）
 *        system:config:get|save（运行参数）
 * 用户与权限已拆至 users.js；备份与外置密钥已拆至 backup.js
 */
import { api, demoMode } from '../api.js';
import { toast, demoBanner, applyReadonly, guardAdmin } from '../ui.js';

let config = null;
let env = null;

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">运行环境</div>
                <div class="card-desc">本地存储与依赖驱动状态（依赖缺失时对应功能会给出明确提示，不影响应用启动）</div>
            </div>
        </div>
        <div class="form-row">
            <div class="form-item">
                <label>数据文件</label>
                <div class="mono muted" id="env-data" style="font-size:12.5px">-</div>
            </div>
            <div class="form-item">
                <label>日志目录</label>
                <div class="mono muted" id="env-log" style="font-size:12.5px">-</div>
            </div>
            <div class="form-item">
                <label>驱动状态</label>
                <div id="env-drivers" style="font-size:12.5px">-</div>
            </div>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">运行参数</div>
                <div class="card-desc">控制 SSH 并发上限与命令安全策略，保存后即时生效</div>
            </div>
        </div>
        <div class="form-item" style="margin-bottom:14px">
            <label>SSH 最大并发数</label>
            <input class="input" type="number" id="cfg-concurrency" min="1" max="50">
            <div class="form-hint">单任务同时连接的主机数量上限</div>
        </div>
        <div class="form-item" style="margin-bottom:14px">
            <label>单命令超时（秒）</label>
            <input class="input" type="number" id="cfg-timeout" min="5" max="600">
        </div>
        <div class="form-item" style="margin-bottom:14px">
            <label>命中高危规则默认动作</label>
            <select class="select" id="cfg-action" style="width:100%">
                <option value="block">直接拦截并告警</option>
                <option value="confirm">拦截并要求二次确认</option>
            </select>
        </div>
        <div class="form-item" style="margin-bottom:14px">
            <label>日志保留天数</label>
            <input class="input" type="number" id="cfg-retention" min="7" max="3650">
        </div>
        <div class="form-item">
            <label>白名单模式</label>
            <div style="display:flex;align-items:center;gap:10px">
                <label class="switch">
                    <input type="checkbox" id="cfg-whitelist">
                    <span class="track"></span>
                </label>
                <span class="muted" style="font-size:12.5px">白名单命令跳过敏感词校验，直接放行</span>
            </div>
        </div>
        <div class="toolbar" style="margin-top:16px;justify-content:flex-end">
            <button class="btn btn-primary" data-write id="cfg-save">保存配置</button>
        </div>
    </div>`;
}

export async function mount(root) {
    const paintDrivers = () => {
        if (!env) return;
        const d = env.drivers || {};
        const item = (ok, label) => `<div>${label}：${ok ? '<span class="text-success">已安装</span>' : '<span class="text-danger">未安装</span>'}</div>`;
        root.querySelector('#env-data').textContent = env.dataFile || '-';
        root.querySelector('#env-log').textContent = env.logDir || '-';
        root.querySelector('#env-drivers').innerHTML =
            item(d.ssh2, 'ssh2（SSH 执行）') + item(d.mysql2, 'mysql2（MySQL）') +
            item(d.oracledb, 'oracledb（Oracle）') + item(d.pg, 'pg（PostgreSQL）');
        if (!d.ssh2) {
            root.querySelector('#env-drivers').innerHTML +=
                `<div class="text-danger" style="margin-top:6px">提示：执行远端命令前需安装 ssh2，命令与脚本托管、审计等功能不受影响</div>`;
        }
    };

    try {
        env = await api.system.env();
        paintDrivers();
    } catch (err) { /* 忽略 */ }

    try {
        config = await api.system.getConfig();
        root.querySelector('#cfg-concurrency').value = config.maxConcurrency ?? 10;
        root.querySelector('#cfg-timeout').value = config.cmdTimeout ?? 30;
        root.querySelector('#cfg-action').value = config.highRiskAction || 'block';
        root.querySelector('#cfg-retention').value = config.logRetentionDays ?? 180;
        root.querySelector('#cfg-whitelist').checked = config.whitelistEnabled !== false;
    } catch (err) { /* 忽略 */ }

    root.querySelector('#cfg-save').addEventListener('click', async () => {
        if (!guardAdmin('保存运行参数')) return;
        const patch = {
            maxConcurrency: parseInt(root.querySelector('#cfg-concurrency').value, 10) || 10,
            cmdTimeout: parseInt(root.querySelector('#cfg-timeout').value, 10) || 30,
            highRiskAction: root.querySelector('#cfg-action').value,
            logRetentionDays: parseInt(root.querySelector('#cfg-retention').value, 10) || 180,
            whitelistEnabled: root.querySelector('#cfg-whitelist').checked
        };
        const res = await api.system.saveConfig(patch);
        toast(res && res.ok ? '配置已保存并即时生效' : '保存失败', res && res.ok ? 'success' : 'danger');
    });

    applyReadonly(root);
}
