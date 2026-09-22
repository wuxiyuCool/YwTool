/**
 * 渲染进程通用 UI 工具：Toast 提示、HTML 转义、空状态、演示模式提示
 */

export function esc(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastHost = null;

export function toast(message, type = 'info') {
    if (!toastHost) {
        toastHost = document.createElement('div');
        toastHost.className = 'toast-host';
        document.body.appendChild(toastHost);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    toastHost.appendChild(el);
    setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => el.remove(), 220);
    }, 2600);
}

/** 通用文本输入弹窗（替代 window.prompt——Electron 不支持，调用恒返回 undefined）
 *  resolve(去空白后的输入)；取消/ESC 返回 null */
export function promptText(title, value = '', placeholder = '') {
    return new Promise(resolve => {
        const mask = document.createElement('div');
        mask.className = 'modal-mask open';
        mask.innerHTML = `<div class="modal" style="width:420px">
            <div class="modal-header"><h3>${esc(title)}</h3><button class="modal-close" data-close>×</button></div>
            <div class="modal-body">
                <div class="form-item"><input class="input" placeholder="${esc(placeholder)}"></div>
            </div>
            <div class="modal-footer">
                <span class="spacer"></span>
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" data-ok>确定</button>
            </div>
        </div>`;
        const input = mask.querySelector('input');
        input.value = value;
        const onKey = e => { if (e.key === 'Escape') finish(null); };
        function finish(result) {
            document.removeEventListener('keydown', onKey);
            mask.remove();
            resolve(result);
        }
        mask.addEventListener('click', e => {
            if (e.target === mask || e.target.closest('[data-close]')) return finish(null);
            if (e.target.closest('[data-ok]')) return finish(input.value.trim());
        });
        input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(input.value.trim()); });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(mask);
        input.focus();
        input.select();
    });
}

/** 演示模式横幅（浏览器中直接打开时使用，Electron 内不显示） */
export function demoBanner(isDemo) {
    if (!isDemo) return '';
    return `<div class="alert warn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>演示模式：当前未连接本地服务（请用 <code>npm start</code> 启动应用以接入真实数据），写操作不会生效。</span>
    </div>`;
}

export function emptyRow(colspan, text = '暂无数据') {
    return `<tr><td colspan="${colspan}"><div class="empty">${esc(text)}</div></td></tr>`;
}

export function loadingRow(colspan, text = '加载中...') {
    return `<tr><td colspan="${colspan}"><div class="empty">${esc(text)}</div></td></tr>`;
}

export function shortTime(text) {
    const s = String(text || '');
    return s.length > 16 ? s.slice(5, 16) : s;
}

/** 捕获 IPC 异常，统一提示（桥未注入 / 主进程报错） */
export async function call(promise, errorHint = '操作失败') {
    try {
        return await promise;
    } catch (err) {
        toast(`${errorHint}：${err.message}`, 'danger');
        return { ok: false, message: err.message };
    }
}

/* ---------------- 权限辅助（由 session.js 注入当前用户能力） ---------------- */

let permProvider = () => ({ read: true, write: true, admin: true, role: '演示', modules: {} });

export function setPermissionProvider(fn) {
    permProvider = fn;
}

export const getPerm = () => permProvider() || {};
export const canWrite = () => !!getPerm().write;
export const canAdmin = () => !!getPerm().admin;

/** 当前用户在各模块上的权限等级：{ 模块id: viewer|operator|admin|null } */
export const getModules = () => getPerm().modules || {};

/**
 * 模块级权限判断
 * @param {string} moduleId 模块 id（对应主进程 permissions.js 的 MODULES）
 * @param {'viewer'|'operator'|'admin'} [need='viewer'] 需要达到的最低等级
 */
export function canModule(moduleId, need = 'viewer') {
    const rank = { viewer: 1, operator: 2, admin: 3 };
    const level = getModules()[moduleId];
    if (!level) return false;
    return (rank[level] || 0) >= (rank[need] || 1);
}

/** 当前用户对某模块的权限等级文本（用于徽标展示） */
export const moduleLevelText = moduleId => {
    const map = { viewer: '只读', operator: '可操作', admin: '可管理' };
    const level = getModules()[moduleId];
    return level ? map[level] || level : '不可见';
};

/**
 * 写操作前置校验：只读角色直接拦下并提示，避免无效请求
 * @param {string} label 操作名称
 * @param {string} [moduleId] 所属模块，传入后额外做模块级校验
 */
export function guardWrite(label = '该操作', moduleId) {
    if (moduleId && !canModule(moduleId, 'operator')) {
        const level = moduleLevelText(moduleId);
        toast(`${label}需要「${moduleId}」模块的写权限，当前为${level}`, 'warn');
        return false;
    }
    if (canWrite()) return true;
    toast(`${label}需要写权限，当前角色（${getPerm().role}）为只读`, 'warn');
    return false;
}

/** 管理员操作前置校验 */
export function guardAdmin(label = '该操作', moduleId) {
    const perm = getPerm();
    if (moduleId && !canModule(moduleId, 'admin')) {
        toast(`${label}需要「${moduleId}」模块的管理权限，当前为${moduleLevelText(moduleId)}`, 'warn');
        return false;
    }
    if (perm.admin) return true;
    toast(`${label}需要系统管理员权限，当前角色（${perm.role}）无权执行`, 'warn');
    return false;
}

/**
 * 为只读角色统一禁用页面内的写操作按钮
 * 除全局写能力外，还会检查元素上的 data-module 属性做模块级判定
 */
export function applyReadonly(root) {
    root.querySelectorAll('[data-write]').forEach(el => {
        const moduleId = el.dataset.module;
        const blocked = moduleId ? !canModule(moduleId, 'operator') : !canWrite();
        if (!blocked) return;
        el.disabled = true;
        el.title = moduleId
            ? `当前账号对「${moduleId}」模块仅有${moduleLevelText(moduleId)}权限`
            : '当前角色为只读，无法执行该操作';
        el.style.opacity = '.5';
        el.style.cursor = 'not-allowed';
    });
}
