/**
 * 会话与登录 · 顶栏用户区 · 告警中心铃铛
 * 职责：
 *   1. 启动时校验会话，未登录渲染登录覆盖层
 *   2. 登录成功后才初始化业务界面（router.initApp）
 *   3. 顶栏用户信息 / 退出登录 / 首次登录强制改密
 *   4. 告警铃铛：未读计数 + 下拉列表 + 实时推送
 */
import { api, setUnauthorizedHandler } from './api.js';
import { esc, toast, setPermissionProvider } from './ui.js';

let user = null;
let onReadyCallback = null;
let alertTimer = null;

export const getUser = () => user;
export const isAdmin = () => !!(user && user.caps && user.caps.admin);
export const canWrite = () => !!(user && user.caps && user.caps.write);
export const isReadonly = () => !!(user && user.caps && !user.caps.write);

const loginEl = () => document.getElementById('login-screen');

/* ---------------- 登录覆盖层 ---------------- */

function showLogin(message = '') {
    const el = loginEl();
    el.style.display = 'flex';
    el.innerHTML = `
    <div class="login-card">
        <div class="login-brand">
            <div class="brand-logo">Sg</div>
            <div>
                <h1>SgOps 批量运维管理平台</h1>
                <p>内网批量运维 · 命令安全校验 · 全量审计</p>
            </div>
        </div>
        <form class="login-form" id="login-form">
            <div class="form-item">
                <label>用户名</label>
                <input class="input" id="login-user" autocomplete="username" placeholder="admin" autofocus>
            </div>
            <div class="form-item">
                <label>登录密码</label>
                <input class="input" id="login-pass" type="password" autocomplete="current-password" placeholder="请输入登录密码">
            </div>
            <div class="login-error" id="login-error">${message ? esc(message) : ''}</div>
            <button class="btn btn-primary login-submit" type="submit" id="login-submit">登 录</button>
        </form>
        <div class="login-hint">
            首次使用默认账号：<span class="mono">admin / admin@123</span>（登录后请立即修改）<br>
            其他预置角色：<span class="mono">ops01 / ops@123</span>（运维员）、<span class="mono">auditor01 / audit@123</span>（审计员，只读）
        </div>
    </div>`;

    el.querySelector('#login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = el.querySelector('#login-submit');
        const errEl = el.querySelector('#login-error');
        const username = el.querySelector('#login-user').value.trim();
        const password = el.querySelector('#login-pass').value;
        if (!username || !password) { errEl.textContent = '请输入用户名和密码'; return; }

        btn.disabled = true;
        btn.textContent = '登录中...';
        errEl.textContent = '';

        const res = await api.auth.login({ username, password });
        btn.disabled = false;
        btn.textContent = '登 录';

        if (res && res.ok) {
            user = res.user;
            loginEl().style.display = 'none';
            await afterLogin();
        } else {
            errEl.textContent = (res && res.message) || '登录失败';
        }
    });

    setTimeout(() => el.querySelector('#login-user').focus(), 50);
}

/* ---------------- 登录后初始化 ---------------- */

async function afterLogin() {
    // 把当前用户能力 + 模块权限注入 ui 层，供各页面做写操作前置校验
    setPermissionProvider(() => ({
        ...(user && user.caps),
        role: user && user.role,
        modules: (user && user.modules) || {}
    }));

    paintUser();
    paintAlerts();
    startAlertWatcher();

    if (user && user.mustChangePassword) {
        toast('检测到默认口令，请尽快修改登录密码', 'warn');
        setTimeout(showChangePassword, 400);
    }

    if (typeof onReadyCallback === 'function') onReadyCallback();
}

function paintUser() {
    if (!user) return;
    const roleBadge = { '系统管理员': 'purple', '运维员': 'blue', '审计员': 'gray' }[user.role] || 'gray';
    const initial = String(user.username).slice(0, 1).toUpperCase();
    const moduleCount = (user.visibleModules || []).length;
    const override = user.modulePermOverride ? ' · 自定义权限' : '';

    const topbar = document.getElementById('topbar-user');
    if (topbar) {
        topbar.innerHTML = `
            <div class="avatar">${esc(initial)}</div>
            <div class="user-meta">
                <strong>${esc(user.username)}</strong>
                <span>${esc(user.role)}${moduleCount ? ` · ${moduleCount} 个模块` : ''}${override}</span>
            </div>
            <button class="btn btn-ghost btn-sm" id="btn-my-perms">我的权限</button>
            <button class="btn btn-ghost btn-sm" id="btn-change-pwd">修改密码</button>
            <button class="btn btn-ghost btn-sm" id="btn-logout">退出</button>`;
        topbar.querySelector('#btn-logout').addEventListener('click', doLogout);
        topbar.querySelector('#btn-change-pwd').addEventListener('click', showChangePassword);
        topbar.querySelector('#btn-my-perms').addEventListener('click', showMyPerms);
    }

    const sidebar = document.getElementById('sidebar-user');
    if (sidebar) {
        sidebar.innerHTML = `
            <div class="avatar">${esc(initial)}</div>
            <div class="user-meta">
                <strong>${esc(user.username)}</strong>
                <span>${esc(user.role)}${user.caps && !user.caps.write ? ' · 只读' : ''}</span>
            </div>`;
    }
}

/* ---------------- 我的权限 ---------------- */

const LEVEL_TEXT = { viewer: '只读', operator: '可操作', admin: '可管理' };
const LEVEL_BADGE = { viewer: 'gray', operator: 'blue', admin: 'purple' };

function showMyPerms() {
    const modules = (user && user.modules) || {};
    const rows = Object.keys(modules).map(id => {
        const level = modules[id];
        return `<tr>
            <td class="mono">${esc(id)}</td>
            <td>${level
                ? `<span class="badge ${LEVEL_BADGE[level]}">${LEVEL_TEXT[level]}</span>`
                : '<span class="badge gray">不可见</span>'}</td>
        </tr>`;
    }).join('');

    const mask = document.createElement('div');
    mask.className = 'modal-mask open';
    mask.innerHTML = `
    <div class="modal" style="width:460px">
        <div class="modal-header"><h3>我的权限</h3><button class="modal-close" data-close>×</button></div>
        <div class="modal-body">
            <div class="alert info" style="margin-bottom:0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <span>账号 <strong>${esc(user.username)}</strong> · 角色 <strong>${esc(user.role)}</strong>${user.modulePermOverride ? ' · 模块权限由管理员单独指定' : ' · 模块权限继承角色'}</span>
            </div>
            <div class="table-wrap" style="max-height:360px;overflow:auto">
                <table class="table">
                    <thead><tr><th>模块</th><th>权限</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="2"><div class="empty">无</div></td></tr>'}</tbody>
                </table>
            </div>
            <div class="form-hint">如需调整权限，请联系系统管理员在「系统运维 → 系统设置 → 用户与角色」中配置。</div>
        </div>
        <div class="modal-footer"><button class="btn btn-primary" data-close>知道了</button></div>
    </div>`;
    document.body.appendChild(mask);
    mask.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => mask.remove()));
}

async function doLogout() {
    if (!confirm('确认退出登录？')) return;
    await api.auth.logout();
    window.location.reload();
}

/* ---------------- 修改密码 ---------------- */

function showChangePassword() {
    const mask = document.createElement('div');
    mask.className = 'modal-mask open';
    mask.innerHTML = `
    <div class="modal" style="width:420px">
        <div class="modal-header"><h3>修改登录密码</h3><button class="modal-close" data-close>×</button></div>
        <div class="modal-body">
            <div class="form-item">
                <label>原密码</label>
                <input class="input" id="cp-old" type="password">
            </div>
            <div class="form-item">
                <label>新密码（至少 6 位）</label>
                <input class="input" id="cp-new" type="password">
            </div>
            <div class="form-item">
                <label>确认新密码</label>
                <input class="input" id="cp-confirm" type="password">
            </div>
            <div id="cp-msg" class="form-hint"></div>
        </div>
        <div class="modal-footer">
            <button class="btn btn-ghost" data-close>取消</button>
            <button class="btn btn-primary" id="cp-save">保存</button>
        </div>
    </div>`;
    document.body.appendChild(mask);

    const close = () => mask.remove();
    mask.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));

    mask.querySelector('#cp-save').addEventListener('click', async () => {
        const oldPwd = mask.querySelector('#cp-old').value;
        const newPwd = mask.querySelector('#cp-new').value;
        const confirmPwd = mask.querySelector('#cp-confirm').value;
        const msg = mask.querySelector('#cp-msg');

        if (newPwd !== confirmPwd) { msg.innerHTML = '<span class="text-danger">两次输入的新密码不一致</span>'; return; }
        const res = await api.auth.changePassword({ oldPassword: oldPwd, newPassword: newPwd });
        if (res && res.ok) {
            user = res.user;
            paintUser();
            toast('密码已修改', 'success');
            close();
        } else {
            msg.innerHTML = `<span class="text-danger">${esc((res && res.message) || '修改失败')}</span>`;
        }
    });
}

/* ---------------- 告警中心 ---------------- */

const levelClass = lv => (lv === 'danger' ? 'danger' : lv === 'warn' ? 'warn' : 'info');

async function paintAlerts() {
    const badge = document.getElementById('alert-badge');
    const dropdown = document.getElementById('alert-dropdown');
    if (!badge || !dropdown) return;

    try {
        const { count, latest } = await api.alerts.unread();
        badge.style.display = count ? 'inline-flex' : 'none';
        badge.textContent = count > 99 ? '99+' : String(count);

        dropdown.innerHTML = `
            <div class="dropdown-head">
                <strong>告警中心</strong>
                <div>
                    <button class="btn-link" id="btn-ack-all">全部确认</button>
                    ${isAdmin() ? '<button class="btn-link" id="btn-clear-ack">清理已确认</button>' : ''}
                </div>
            </div>
            <div class="dropdown-body">
                ${latest && latest.length ? latest.map(a => `
                    <div class="alert-item ${levelClass(a.level)}" data-ack="${esc(a.id)}">
                        <div class="alert-item-title">
                            ${esc(a.title)}
                            ${a.count > 1 ? `<span class="badge gray">×${esc(a.count)}</span>` : ''}
                        </div>
                        <div class="alert-item-detail">${esc(a.detail || '')}</div>
                        <div class="alert-item-time">${esc(a.lastAt || a.createdAt || '')} · <span class="ack-link">点击确认</span></div>
                    </div>`).join('') : '<div class="empty">暂无未确认告警</div>'}
            </div>`;

        dropdown.querySelector('#btn-ack-all').addEventListener('click', async () => {
            const res = await api.alerts.ackAll();
            toast(res && res.ok ? `已确认 ${res.count} 条告警` : '操作失败', 'success');
            await paintAlerts();
        });
        const clearBtn = dropdown.querySelector('#btn-clear-ack');
        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                if (!confirm('清理所有已确认的告警记录？')) return;
                const res = await api.alerts.clear();
                toast(res && res.ok ? `已清理 ${res.removed} 条` : '清理失败', 'success');
                await paintAlerts();
            });
        }
        dropdown.querySelectorAll('[data-ack]').forEach(item =>
            item.addEventListener('click', async () => {
                await api.alerts.ack(item.dataset.ack);
                await paintAlerts();
            }));
    } catch (err) {
        badge.style.display = 'none';
    }
}

function startAlertWatcher() {
    const btn = document.getElementById('btn-alerts');
    const dropdown = document.getElementById('alert-dropdown');
    if (btn && dropdown) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('open');
            if (dropdown.classList.contains('open')) paintAlerts();
        });
        document.addEventListener('click', (e) => {
            if (!dropdown.contains(e.target)) dropdown.classList.remove('open');
        });
    }

    if (typeof api.onAlert === 'function') {
        api.onAlert(() => paintAlerts());
    }
    if (alertTimer) clearInterval(alertTimer);
    alertTimer = setInterval(paintAlerts, 30000);
}

/* ---------------- 对外入口 ---------------- */

export async function bootstrap(onReady) {
    onReadyCallback = () => typeof onReady === 'function' && onReady();

    // 会话失效（如主进程重启）时回到登录页
    setUnauthorizedHandler(() => {
        user = null;
        showLogin('会话已失效，请重新登录');
    });

    // 浏览器演示模式：无 IPC 桥接，以演示身份放行
    if (api.demoMode) {
        user = { username: 'demo', role: '系统管理员', caps: { read: true, write: true, admin: true } };
        await afterLogin();
        return;
    }

    try {
        const res = await api.auth.session();
        if (res && res.loggedIn) {
            user = res.user;
            await afterLogin();
            return;
        }
    } catch (err) {
        console.error('[session] 会话校验失败', err);
    }
    showLogin();
}
