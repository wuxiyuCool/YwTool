/**
 * 系统运维 · 系统设置页
 * 数据流：system:env（数据文件/日志目录/驱动可用性）
 *        system:config:get|save（运行参数）
 *        system:users:list|save|delete（用户账号）
 *        system:modules:list|system:perms:get|save|reset（界面与功能权限矩阵）
 * 数据库配置已拆分至 dbconfig.js（数据库运维域）
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow, applyReadonly, guardAdmin } from '../ui.js';

let config = null;
let env = null;
let users = [];
let moduleMeta = null;
let perms = null;
let editingUser = null;
/** 用户弹窗中正在编辑的模块权限矩阵（null 表示跟随角色） */
let draftMatrix = null;

const ROLE_BADGE = { '系统管理员': 'purple', '运维员': 'blue', '审计员': 'gray' };
const LEVEL_LABEL = { viewer: '只读', operator: '可操作', admin: '可管理' };
const LEVEL_CLASS = { viewer: 'gray', operator: 'blue', admin: 'purple' };

function userRow(u) {
    const override = u.modulePermOverride
        ? '<span class="badge amber" title="该用户拥有独立于角色的模块权限">自定义</span>'
        : '<span class="muted" style="font-size:11.5px">跟随角色</span>';
    const visible = (u.visibleModules || []).length;
    return `
    <tr data-id="${esc(u.id)}">
        <td><strong>${esc(u.username)}</strong></td>
        <td><span class="badge ${ROLE_BADGE[u.role] || 'gray'}">${esc(u.role)}</span></td>
        <td>${u.enabled ? '<span class="badge green">正常</span>' : '<span class="badge gray">已停用</span>'}</td>
        <td>${override} <span class="muted" style="font-size:11.5px">${visible} 个模块</span></td>
        <td class="muted">${esc(u.lastLoginAt || '-')}</td>
        <td>
            <button class="btn-link" data-act="perms" data-write>权限</button>
            <button class="btn-link" data-act="toggle" data-write>${u.enabled ? '停用' : '启用'}</button>
            <button class="btn-link danger" data-act="delete" data-write>删除</button>
        </td>
    </tr>`;
}

/**
 * 权限矩阵编辑器（按域分组 × 模块行）
 * @param {string} role 当前编辑的角色
 * @param {Object} matrix 模块 id → 等级
 * @param {boolean} readonly 只读展示（系统管理员行）
 */
function matrixEditor(role, matrix, readonly) {
    if (!moduleMeta) return '<div class="empty">模块清单加载中...</div>';
    const levels = moduleMeta.levels;

    const domains = moduleMeta.domains.map(d => {
        const mods = moduleMeta.modules.filter(m => m.domain === d.id);
        if (!mods.length) return '';
        const rows = mods.map(m => {
            const current = matrix[m.id] || null;
            const options = [{ v: '', label: '不可见' }]
                .concat(levels.filter(lv => m.caps.includes(lv)).map(lv => ({ v: lv, label: LEVEL_LABEL[lv] })));
            return `
            <tr data-module="${esc(m.id)}">
                <td>
                    <div class="perm-mod-name">${esc(m.label)}</div>
                    <div class="muted" style="font-size:11.5px">${esc(m.desc)}</div>
                </td>
                <td>
                    <div class="perm-options">
                        ${options.map(o => `<label class="perm-opt ${current === (o.v || null) ? 'active' : ''}" data-value="${esc(o.v)}">
                            <input type="radio" name="perm_${esc(role)}_${esc(m.id)}" value="${esc(o.v)}" ${current === (o.v || null) ? 'checked' : ''} ${readonly ? 'disabled' : ''}>
                            <span>${esc(o.label)}</span>
                        </label>`).join('')}
                    </div>
                </td>
            </tr>`;
        }).join('');
        return `<tr class="perm-domain"><td colspan="2">${esc(d.label)}<span class="muted"> · ${esc(d.desc)}</span></td></tr>${rows}`;
    }).join('');

    return `
    <table class="table perm-table">
        <thead><tr><th style="width:42%">功能模块</th><th>权限等级</th></tr></thead>
        <tbody>${domains}</tbody>
    </table>`;
}

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
                <div class="card-title">用户与角色</div>
                <div class="card-desc">账号、角色与模块权限；「权限」按钮可单独覆写某账号的可见模块</div>
            </div>
            <button class="btn btn-primary btn-sm" data-write id="btn-add-user">+ 添加用户</button>
        </div>
        <div class="table-wrap">
            <table class="table">
                <thead><tr><th>用户</th><th>角色</th><th>状态</th><th>模块权限</th><th>最近登录</th><th>操作</th></tr></thead>
                <tbody id="user-tbody">${loadingRow(6)}</tbody>
            </table>
        </div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">界面与功能权限</div>
                <div class="card-desc">按角色配置各模块的可见与可操作范围；系统管理员恒为全部权限</div>
            </div>
            <div class="toolbar" style="margin:0">
                <label class="switch" title="关闭后所有账号按内置默认权限执行">
                    <input type="checkbox" id="perm-enabled">
                    <span class="track"></span>
                </label>
                <span class="muted" style="font-size:12.5px">权限总开关</span>
                <button class="btn btn-ghost btn-sm" id="btn-perm-reset-users" data-write>清空用户覆写</button>
                <button class="btn btn-ghost btn-sm" id="btn-perm-reset" data-write>恢复默认</button>
            </div>
        </div>
        <div class="tabs" id="perm-tabs"></div>
        <div id="perm-editor"><div class="empty">权限矩阵加载中...</div></div>
        <div class="toolbar" style="margin-top:16px;justify-content:flex-end">
            <span class="muted" id="perm-summary" style="font-size:12.5px;margin-right:auto"></span>
            <button class="btn btn-primary" data-write id="perm-save">保存权限</button>
        </div>
    </div>

    <div class="grid-2">
        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">运行参数</div>
                    <div class="card-desc">控制 SSH 并发上限，防止压垮内网</div>
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
        </div>

        <div class="card">
            <div class="card-header">
                <div>
                    <div class="card-title">权限说明</div>
                    <div class="card-desc">三层校验：角色能力 → 模块可见性 → 模块内等级</div>
                </div>
            </div>
            <div class="perm-legend">
                <div class="perm-legend-item"><span class="badge gray">不可见</span><span>左侧菜单不展示，对应接口直接拒绝</span></div>
                <div class="perm-legend-item"><span class="badge blue">只读</span><span>可查看数据与列表，写操作被拦截</span></div>
                <div class="perm-legend-item"><span class="badge blue">可操作</span><span>可执行日常运维动作（执行命令、跑脚本等）</span></div>
                <div class="perm-legend-item"><span class="badge purple">可管理</span><span>额外开放删除、启停、密钥查看等管理动作</span></div>
            </div>
            <div class="alert info" style="margin-top:14px;margin-bottom:0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <span>权限变更保存后，其它已登录会话立即失效，需要重新登录才会应用新权限。</span>
            </div>
        </div>
    </div>

    <div class="modal-mask" id="user-modal">
        <div class="modal" style="width:560px">
            <div class="modal-header">
                <h3 id="user-modal-title">添加用户</h3>
                <button class="modal-close" data-close>×</button>
            </div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-item">
                        <label>用户名</label>
                        <input class="input" id="u-name" placeholder="ops03">
                    </div>
                    <div class="form-item">
                        <label>角色</label>
                        <select class="select" id="u-role" style="width:100%">
                            <option>运维员</option>
                            <option>系统管理员</option>
                            <option>审计员</option>
                        </select>
                    </div>
                </div>
                <div class="form-item">
                    <label>初始密码</label>
                    <input class="input" id="u-password" type="text" placeholder="留空则使用 Init@123456">
                    <div class="form-hint">新增用户默认要求首次登录修改口令</div>
                </div>
                <div class="form-item">
                    <label>模块权限来源</label>
                    <div style="display:flex;align-items:center;gap:10px">
                        <label class="switch">
                            <input type="checkbox" id="u-override">
                            <span class="track"></span>
                        </label>
                        <span class="muted" style="font-size:12.5px">为该账号单独配置模块权限（否则继承角色）</span>
                    </div>
                </div>
                <div id="u-matrix-wrap" style="display:none">
                    <div class="perm-scroll" id="u-matrix"></div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="user-save">保存</button>
            </div>
        </div>
    </div>`;
}

export async function mount(root) {
    const userTbody = root.querySelector('#user-tbody');
    const userModal = root.querySelector('#user-modal');
    const permEditor = root.querySelector('#perm-editor');
    const permTabs = root.querySelector('#perm-tabs');
    /** 当前编辑的角色 */
    let activeRole = '运维员';
    /** 角色矩阵的可编辑副本 */
    let draftRoles = {};

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

    const loadUsers = async () => {
        try {
            users = await api.system.users.list();
            userTbody.innerHTML = users.length ? users.map(userRow).join('') : emptyRow(6, '暂无用户');
        } catch (err) {
            userTbody.innerHTML = emptyRow(6, '用户加载失败：' + err.message);
        }
    };

    /* ---------------- 权限矩阵 ---------------- */

    const paintTabs = () => {
        const roles = Object.keys(draftRoles).filter(r => r !== '系统管理员');
        permTabs.innerHTML = Object.keys(draftRoles).map(r =>
            `<div class="tab ${r === activeRole ? 'active' : ''}" data-role="${esc(r)}">
                ${esc(r)}${r === '系统管理员' ? '<span class="tab-note">全权限</span>' : ''}
            </div>`).join('');
        void roles;
    };

    const paintMatrix = () => {
        const matrix = draftRoles[activeRole] || {};
        const readonly = activeRole === '系统管理员';
        permEditor.innerHTML = matrixEditor(activeRole, matrix, readonly);

        const granted = Object.entries(matrix).filter(([, v]) => v).length;
        const total = (moduleMeta && moduleMeta.modules.length) || 0;
        root.querySelector('#perm-summary').textContent =
            `「${activeRole}」已授权 ${granted} / ${total} 个模块`;

        if (readonly) {
            permEditor.querySelectorAll('input').forEach(i => { i.disabled = true; });
        }

        // 单选按钮的高亮状态与草稿矩阵双向同步
        permEditor.querySelectorAll('.perm-opt').forEach(opt => {
            opt.addEventListener('click', () => {
                if (readonly) return;
                const tr = opt.closest('tr[data-module]');
                if (!tr) return;
                const value = opt.dataset.value || null;
                draftRoles[activeRole][tr.dataset.module] = value;
                tr.querySelectorAll('.perm-opt').forEach(o =>
                    o.classList.toggle('active', o === opt));
                const input = opt.querySelector('input');
                if (input) input.checked = true;
                paintSummaryOnly();
            });
        });
    };

    const paintSummaryOnly = () => {
        const matrix = draftRoles[activeRole] || {};
        const granted = Object.entries(matrix).filter(([, v]) => v).length;
        const total = (moduleMeta && moduleMeta.modules.length) || 0;
        root.querySelector('#perm-summary').textContent =
            `「${activeRole}」已授权 ${granted} / ${total} 个模块`;
    };

    const loadPerms = async () => {
        try {
            perms = await api.system.perms.get();
        } catch (err) {
            perms = null;
        }
        if (!moduleMeta) {
            try { moduleMeta = await api.system.modules(); } catch (err) { moduleMeta = null; }
        }
        if (!moduleMeta) {
            permEditor.innerHTML = `<div class="empty">模块清单加载失败</div>`;
            return;
        }

        draftRoles = {};
        Object.keys(moduleMeta.roleDefaults || {}).forEach(role => {
            draftRoles[role] = { ...(perms && perms.roles && perms.roles[role] ? perms.roles[role] : moduleMeta.roleDefaults[role]) };
        });

        root.querySelector('#perm-enabled').checked = !perms || perms.modulePermEnabled !== false;
        paintTabs();
        paintMatrix();
    };

    permTabs.addEventListener('click', e => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        activeRole = tab.dataset.role;
        paintTabs();
        paintMatrix();
    });

    root.querySelector('#perm-save').addEventListener('click', async () => {
        if (!guardAdmin('保存模块权限')) return;
        const enabled = root.querySelector('#perm-enabled').checked;
        const roles = Object.keys(draftRoles).filter(r => r !== '系统管理员');

        for (const role of roles) {
            const res = await api.system.perms.save({ role, matrix: draftRoles[role], modulePermEnabled: enabled });
            if (!res || !res.ok) {
                toast((res && res.message) || `「${role}」权限保存失败`, 'danger');
                return;
            }
        }
        // 总开关单独提交一次（role 为空时只更新开关）
        await api.system.perms.save({ modulePermEnabled: enabled });
        toast('模块权限已保存，其它会话需重新登录生效', 'success');
        await loadPerms();
    });

    root.querySelector('#perm-enabled').addEventListener('change', e => {
        if (!guardAdmin('切换权限总开关')) { e.target.checked = !e.target.checked; return; }
    });

    root.querySelector('#btn-perm-reset').addEventListener('click', async () => {
        if (!guardAdmin('恢复默认权限')) return;
        if (!confirm('将「运维员 / 审计员」的模块权限恢复为系统内置默认值？')) return;
        const res = await api.system.perms.reset({});
        toast(res && res.ok ? '已恢复默认权限' : '操作失败', res && res.ok ? 'success' : 'danger');
        await loadPerms();
    });

    root.querySelector('#btn-perm-reset-users').addEventListener('click', async () => {
        if (!guardAdmin('清空用户覆写')) return;
        if (!confirm('清空所有账号的独立模块权限，统一回归角色权限？')) return;
        const res = await api.system.perms.reset({ scope: 'users' });
        toast(res && res.ok ? '已清空用户级覆写' : '操作失败', res && res.ok ? 'success' : 'danger');
        await Promise.all([loadUsers(), loadPerms()]);
    });

    /* ---------------- 环境 / 运行参数 ---------------- */

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

    /* ---------------- 用户 ---------------- */

    /** 用户弹窗内的模块矩阵（按角色默认值初始化） */
    const paintUserMatrix = () => {
        if (!moduleMeta) return;
        const role = root.querySelector('#u-role').value;
        const base = draftMatrix
            || (perms && perms.roles && perms.roles[role])
            || (moduleMeta.roleDefaults || {})[role]
            || {};
        draftMatrix = { ...base };
        root.querySelector('#u-matrix').innerHTML = matrixEditor(`user_${role}`, draftMatrix, false);
        root.querySelector('#u-matrix').querySelectorAll('.perm-opt').forEach(opt => {
            opt.addEventListener('click', () => {
                const tr = opt.closest('tr[data-module]');
                if (!tr) return;
                draftMatrix[tr.dataset.module] = opt.dataset.value || null;
                tr.querySelectorAll('.perm-opt').forEach(o => o.classList.toggle('active', o === opt));
                const input = opt.querySelector('input');
                if (input) input.checked = true;
            });
        });
    };

    const openUserModal = (user) => {
        editingUser = user || null;
        draftMatrix = null;
        root.querySelector('#user-modal-title').textContent = user ? `编辑用户 · ${user.username}` : '添加用户';
        root.querySelector('#u-name').value = user ? user.username : '';
        root.querySelector('#u-name').disabled = !!user;
        root.querySelector('#u-role').value = user ? user.role : '运维员';
        root.querySelector('#u-password').value = '';
        root.querySelector('#u-password').placeholder = user ? '留空表示不修改' : '留空则使用 Init@123456';

        const override = !!(user && user.modulePermOverride);
        root.querySelector('#u-override').checked = override;
        root.querySelector('#u-matrix-wrap').style.display = override ? 'block' : 'none';
        if (override) {
            draftMatrix = { ...(user.modules || {}) };
            paintUserMatrix();
            draftMatrix = { ...(user.modules || {}) };
            root.querySelector('#u-matrix').querySelectorAll('.perm-opt').forEach(opt => {
                const tr = opt.closest('tr[data-module]');
                if (tr) opt.classList.toggle('active', (draftMatrix[tr.dataset.module] || null) === (opt.dataset.value || null));
            });
        }
        userModal.classList.add('open');
    };

    root.querySelector('#btn-add-user').addEventListener('click', () => {
        if (!guardAdmin('新增用户')) return;
        openUserModal(null);
    });
    userModal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => userModal.classList.remove('open')));

    root.querySelector('#u-role').addEventListener('change', () => {
        draftMatrix = null;
        if (root.querySelector('#u-override').checked) paintUserMatrix();
    });

    root.querySelector('#u-override').addEventListener('change', e => {
        const on = e.target.checked;
        root.querySelector('#u-matrix-wrap').style.display = on ? 'block' : 'none';
        draftMatrix = null;
        if (on) paintUserMatrix();
    });

    root.querySelector('#user-save').addEventListener('click', async () => {
        if (!guardAdmin('保存用户')) return;
        const username = root.querySelector('#u-name').value.trim();
        const role = root.querySelector('#u-role').value;
        const override = root.querySelector('#u-override').checked;

        if (!editingUser && !username) { toast('请填写用户名', 'warn'); return; }
        if (override && role === '系统管理员') { toast('系统管理员固定拥有全部模块权限，无需自定义', 'warn'); return; }

        const payload = {
            id: editingUser ? editingUser.id : undefined,
            username: username || (editingUser && editingUser.username),
            role,
            enabled: editingUser ? editingUser.enabled !== false : true,
            modulePerms: override ? draftMatrix : null
        };
        const pwd = root.querySelector('#u-password').value;
        if (pwd) payload.password = pwd;

        const res = await api.system.users.save(payload);
        if (res && res.ok) {
            toast(editingUser ? '用户已更新' : '用户已添加', 'success');
            userModal.classList.remove('open');
            await Promise.all([loadUsers(), loadPerms()]);
        } else {
            toast((res && res.message) || '保存失败', 'danger');
        }
    });

    userTbody.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.closest('tr').dataset.id;
        const user = users.find(u => u.id === id);
        if (!user) return;

        if (btn.dataset.act === 'perms') {
            if (!guardAdmin('配置用户权限')) return;
            openUserModal(user);
        } else if (btn.dataset.act === 'toggle') {
            if (!guardAdmin('启停用户')) return;
            const res = await api.system.users.save({ id, username: user.username, role: user.role, enabled: !user.enabled });
            if (res && res.ok) { toast(`用户已${user.enabled ? '停用' : '启用'}`, 'success'); await loadUsers(); }
            else toast((res && res.message) || '操作失败', 'danger');
        } else if (btn.dataset.act === 'delete') {
            if (!guardAdmin('删除用户')) return;
            if (!confirm(`确认删除用户 ${user.username}？`)) return;
            const res = await api.system.users.remove(id);
            if (res && res.ok) { toast('用户已删除', 'success'); await Promise.all([loadUsers(), loadPerms()]); }
            else toast((res && res.message) || '删除失败', 'danger');
        }
    });

    /* AI 模型与 Agent 能力已迁移到独立页面「系统运维 → AI 配置」，此处不再重复维护 */

    await Promise.all([loadUsers(), loadPerms()]);
    applyReadonly(root);
}

