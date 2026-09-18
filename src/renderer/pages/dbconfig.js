/**
 * 数据库运维 · 数据库配置页
 * 数据流：
 *   数据源列表 ← dbconfig:list（已脱敏）
 *   驱动状态   ← dbconfig:drivers
 *   新增/修改  ← dbconfig:save（密码密文落库，留空表示不修改）
 *   启停       ← dbconfig:toggle
 *   连接测试   ← dbconfig:test（回写状态与最近测试时间）
 *   导入/导出  ← dbconfig:export | dbconfig:import（导出不含口令，便于跨机迁移）
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, shortTime, guardWrite, guardAdmin } from '../ui.js';

const TYPE_META = {
    mysql: { label: 'MySQL', badge: 'blue', port: 3306, driver: 'mysql2' },
    oracle: { label: 'Oracle', badge: 'red', port: 1521, driver: 'oracledb' },
    postgres: { label: 'PostgreSQL', badge: 'purple', port: 5432, driver: 'pg' }
};

let sources = [];
let drivers = { drivers: {}, hints: {}, types: [] };
/** 列表筛选：全部 / 已启用 / 已停用 */
let filter = 'all';
let keyword = '';
let editingSource = null;

const typeBadge = t => {
    const meta = TYPE_META[t] || { label: t || '-', badge: 'gray' };
    return `<span class="badge ${meta.badge}">${esc(meta.label)}</span>`;
};

const hostText = s => (s.host ? `${s.host}:${s.port}${s.database ? '/' + s.database : ''}` : '未填写连接地址');

/** 状态徽标：综合「配置完整度 / 启用状态 / 最近测试结果」 */
function statusBadge(s) {
    if (!s.enabled) return '<span class="badge gray">已停用</span>';
    if (s.status === 'pending') return '<span class="badge gray">驱动预留</span>';
    if (!s.host || !s.user) return '<span class="badge amber">待配置</span>';
    if (s.lastTestOk === false || s.status === 'error') return '<span class="badge red">连接异常</span>';
    if (s.lastTestOk === true || s.status === 'connected') return '<span class="badge green">连接正常</span>';
    return '<span class="badge blue">已配置</span>';
}

function sourceCard(s) {
    const meta = TYPE_META[s.type] || {};
    const driverOk = drivers.drivers ? !!drivers.drivers[s.type] : true;
    const dim = !s.enabled ? 'opacity:.62;' : '';

    return `
    <div class="dbc-card" data-id="${esc(s.id)}" style="${dim}">
        <div class="dbc-head">
            <div class="dbc-title">
                <strong>${esc(s.name)}</strong>
                ${typeBadge(s.type)}
            </div>
            <div class="dbc-badges">${statusBadge(s)}</div>
        </div>

        <div class="dbc-host mono">${esc(hostText(s))}</div>

        <div class="dbc-meta">
            <span>用户 <strong class="mono">${esc(s.user || '-')}</strong></span>
            <span>${s.hasPassword ? '口令已加密' : '未设置口令'}</span>
        </div>

        <div class="dbc-tags">
            ${(s.tags || []).map(t => `<span class="badge gray">${esc(t)}</span>`).join('')}
            ${s.note ? `<span class="muted" style="font-size:11.5px">${esc(s.note)}</span>` : ''}
        </div>

        <div class="dbc-test">
            ${s.lastTestAt
                ? `<span class="muted">最近测试 ${esc(shortTime(s.lastTestAt))} · ${s.lastTestOk ? '<span class="text-success">通过</span>' : '<span class="text-danger">失败</span>'}</span>`
                : '<span class="muted">尚未测试连接</span>'}
        </div>

        ${driverOk ? '' : `<div class="dbc-warn">未安装 ${esc((meta.driver) || s.type)} 驱动，连接测试与 SQL 执行不可用</div>`}

        <div class="dbc-actions">
            <button class="btn btn-ghost btn-sm" data-act="use" data-write title="带着该数据源进入 SQL 工作台">去执行 SQL</button>
            <button class="btn-link" data-act="test" data-write>测试连接</button>
            <button class="btn-link" data-act="edit" data-write>配置</button>
            <button class="btn-link" data-act="toggle" data-write>${s.enabled ? '停用' : '启用'}</button>
            <button class="btn-link danger" data-act="delete" data-write>删除</button>
        </div>
    </div>`;
}

export function render() {
    return `
    ${demoBanner(demoMode)}

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">驱动状态</div>
                <div class="card-desc">依赖缺失时连接测试与 SQL 执行会给出明确提示，不影响应用启动</div>
            </div>
            <div class="toolbar" style="margin:0">
                <button class="btn btn-ghost btn-sm" id="btn-export-dbc">导出配置</button>
                <button class="btn btn-ghost btn-sm" data-write id="btn-import-dbc">导入配置</button>
                <button class="btn btn-primary btn-sm" data-write id="btn-add-source">+ 新增数据源</button>
            </div>
        </div>
        <div class="driver-grid" id="driver-grid">${emptyRow(1, '驱动状态加载中...')}</div>
    </div>

    <div class="card">
        <div class="card-header">
            <div>
                <div class="card-title">数据源</div>
                <div class="card-desc">Oracle / MySQL 已通过统一适配层接入；连接口令 AES-256-GCM 加密存储，绝不回显明文</div>
            </div>
            <div class="toolbar" style="margin:0">
                <select class="select" id="dbc-filter" style="width:130px">
                    <option value="all">全部数据源</option>
                    <option value="enabled">仅已启用</option>
                    <option value="disabled">仅已停用</option>
                    <option value="unready">仅待配置</option>
                </select>
                <input class="input" id="dbc-search" placeholder="搜索名称 / 主机" style="width:200px">
            </div>
        </div>
        <div class="db-source-grid" id="source-grid">${emptyRow(1, '数据源加载中...')}</div>
    </div>

    <div class="modal-mask" id="source-modal">
        <div class="modal" style="width:620px">
            <div class="modal-header">
                <h3 id="source-modal-title">配置数据源</h3>
                <button class="modal-close" data-close>×</button>
            </div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-item">
                        <label>数据库类型</label>
                        <select class="select" id="d-type" style="width:100%">
                            <option value="mysql">MySQL</option>
                            <option value="oracle">Oracle</option>
                            <option value="postgres">PostgreSQL（驱动预留）</option>
                        </select>
                    </div>
                    <div class="form-item">
                        <label>数据源名称</label>
                        <input class="input" id="d-name" placeholder="MySQL（业务库）">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-item">
                        <label>主机地址</label>
                        <input class="input mono" id="d-host" placeholder="10.0.20.32">
                    </div>
                    <div class="form-item">
                        <label>端口</label>
                        <input class="input" id="d-port" type="number" value="3306">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-item">
                        <label>库名 / 服务名</label>
                        <input class="input mono" id="d-database" placeholder="bizdb">
                    </div>
                    <div class="form-item">
                        <label>用户名</label>
                        <input class="input mono" id="d-user" placeholder="root">
                    </div>
                </div>
                <div class="form-item">
                    <label>连接口令</label>
                    <input class="input" id="d-password" type="password" placeholder="留空表示不修改">
                    <div class="form-hint">AES-256-GCM 加密后落库，仅用于连接测试与 SQL 执行</div>
                </div>
                <div class="form-row">
                    <div class="form-item">
                        <label>标签（逗号分隔）</label>
                        <input class="input" id="d-tags" placeholder="生产, MySQL">
                    </div>
                    <div class="form-item">
                        <label>启用状态</label>
                        <div style="display:flex;align-items:center;gap:10px;padding-top:6px">
                            <label class="switch">
                                <input type="checkbox" id="d-enabled" checked>
                                <span class="track"></span>
                            </label>
                            <span class="muted" style="font-size:12.5px">停用后不在 SQL 工作台展示</span>
                        </div>
                    </div>
                </div>
                <div class="form-item">
                    <label>备注</label>
                    <input class="input" id="d-note" placeholder="例如：连接池 8，仅限内网访问">
                </div>
                <div id="d-msg" class="form-hint"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" id="d-test" data-write>测试连接</button>
                <div class="spacer" style="flex:1"></div>
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="source-save">保存</button>
            </div>
        </div>
    </div>

    <div class="modal-mask" id="import-modal">
        <div class="modal" style="width:560px">
            <div class="modal-header">
                <h3>导入数据源配置</h3>
                <button class="modal-close" data-close>×</button>
            </div>
            <div class="modal-body">
                <div class="alert warn" style="margin-bottom:0">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    <span>导入内容不含口令，导入后需要为每个数据源补填连接口令。</span>
                </div>
                <div class="form-item">
                    <label>配置文件（JSON，或从「导出配置」得到的文件）</label>
                    <textarea class="textarea code-input" id="import-text" rows="9" spellcheck="false" placeholder='{"schemaVersion":1,"sources":[{"name":"MySQL（业务库）","type":"mysql","host":"10.0.20.32","port":3306,"database":"bizdb","user":"root"}]}'></textarea>
                </div>
                <div class="form-item">
                    <div style="display:flex;align-items:center;gap:10px">
                        <label class="switch">
                            <input type="checkbox" id="import-overwrite">
                            <span class="track"></span>
                        </label>
                        <span class="muted" style="font-size:12.5px">覆盖同名 / 同 ID 的已有数据源</span>
                    </div>
                </div>
                <div id="import-msg" class="form-hint"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="import-do">开始导入</button>
            </div>
        </div>
    </div>`;
}

export async function mount(root) {
    const grid = root.querySelector('#source-grid');
    const driverGrid = root.querySelector('#driver-grid');
    const modal = root.querySelector('#source-modal');
    const importModal = root.querySelector('#import-modal');

    /* ---------------- 驱动状态 ---------------- */

    const paintDrivers = () => {
        const types = drivers.types && drivers.types.length ? drivers.types : [
            { id: 'mysql', label: 'MySQL', driver: 'mysql2' },
            { id: 'oracle', label: 'Oracle', driver: 'oracledb' },
            { id: 'postgres', label: 'PostgreSQL', driver: 'pg' }
        ];
        driverGrid.innerHTML = types.map(t => {
            const ok = drivers.drivers ? !!drivers.drivers[t.id] : false;
            const hint = (drivers.hints || {})[t.id] || '';
            return `<div class="driver-card ${ok ? 'ok' : 'missing'}">
                <div class="driver-head">
                    <strong>${esc(t.label)}</strong>
                    ${ok ? '<span class="badge green">驱动就绪</span>' : '<span class="badge red">未安装</span>'}
                </div>
                <div class="driver-detail muted mono">npm 依赖：${esc(t.driver || '-')}</div>
                <div class="driver-detail muted">${ok ? '连接测试与 SQL 执行可用' : esc(hint || '请先安装对应依赖')}</div>
            </div>`;
        }).join('');
    };

    /* ---------------- 列表 ---------------- */

    const visible = () => sources.filter(s => {
        if (filter === 'enabled' && !s.enabled) return false;
        if (filter === 'disabled' && s.enabled) return false;
        if (filter === 'unready' && s.host && s.user) return false;
        if (keyword) {
            const kw = keyword.toLowerCase();
            if (!(`${s.name} ${s.host} ${s.user} ${(s.tags || []).join(' ')}`).toLowerCase().includes(kw)) return false;
        }
        return true;
    });

    const paintList = () => {
        const list = visible();
        grid.innerHTML = list.length
            ? list.map(sourceCard).join('')
            : `<div class="empty" style="grid-column:1/-1">${sources.length ? '没有符合筛选条件的数据源' : '暂无数据源，点击右上角「新增数据源」开始配置'}</div>`;
    };

    const load = async () => {
        try {
            sources = await api.dbConfig.list();
            paintList();
        } catch (err) {
            grid.innerHTML = `<div class="alert danger" style="grid-column:1/-1"><span>数据源加载失败：${esc(err.message)}</span></div>`;
        }
    };

    /* ---------------- 编辑弹窗 ---------------- */

    const readForm = () => ({
        id: editingSource ? editingSource.id : undefined,
        type: root.querySelector('#d-type').value,
        name: root.querySelector('#d-name').value.trim(),
        host: root.querySelector('#d-host').value.trim(),
        port: parseInt(root.querySelector('#d-port').value, 10),
        database: root.querySelector('#d-database').value.trim(),
        user: root.querySelector('#d-user').value.trim(),
        password: root.querySelector('#d-password').value,
        tags: root.querySelector('#d-tags').value,
        note: root.querySelector('#d-note').value.trim(),
        enabled: root.querySelector('#d-enabled').checked
    });

    const openModal = async (src) => {
        editingSource = src || null;
        root.querySelector('#source-modal-title').textContent = src ? `配置 · ${src.name}` : '新增数据源';
        root.querySelector('#d-type').value = src ? src.type : 'mysql';
        root.querySelector('#d-type').disabled = !!src;   // 类型一旦确定不建议改（端口/适配器绑定）
        root.querySelector('#d-name').value = src ? src.name : '';
        root.querySelector('#d-host').value = src ? (src.host || '') : '';
        root.querySelector('#d-port').value = src ? src.port : 3306;
        root.querySelector('#d-database').value = src ? (src.database || '') : '';
        root.querySelector('#d-user').value = src ? (src.user || '') : '';
        root.querySelector('#d-password').value = '';
        root.querySelector('#d-tags').value = src ? (src.tags || []).join(', ') : '';
        root.querySelector('#d-note').value = src ? (src.note || '') : '';
        root.querySelector('#d-enabled').checked = src ? src.enabled !== false : true;
        root.querySelector('#d-msg').textContent = '';
        modal.classList.add('open');

        // 若列表里是简版数据，补拉一次完整详情（含 tags / enabled / 测试时间）
        if (src && src.tags === undefined) {
            const res = await api.dbConfig.detail(src.id);
            if (res && res.ok && res.source) {
                const full = res.source;
                root.querySelector('#d-tags').value = (full.tags || []).join(', ');
                root.querySelector('#d-note').value = full.note || '';
                root.querySelector('#d-enabled').checked = full.enabled !== false;
                root.querySelector('#d-database').value = full.database || '';
                root.querySelector('#d-user').value = full.user || '';
                root.querySelector('#d-host').value = full.host || '';
                root.querySelector('#d-port').value = full.port;
            }
        }
    };

    root.querySelector('#btn-add-source').addEventListener('click', () => {
        if (!guardAdmin('新增数据源')) return;
        openModal(null);
    });
    modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => modal.classList.remove('open')));

    root.querySelector('#d-type').addEventListener('change', e => {
        const meta = TYPE_META[e.target.value] || {};
        root.querySelector('#d-port').value = meta.port || 3306;
    });

    root.querySelector('#source-save').addEventListener('click', async () => {
        if (!guardAdmin('保存数据源')) return;
        const payload = readForm();
        if (!payload.name) { root.querySelector('#d-msg').innerHTML = '<span class="text-danger">请填写数据源名称</span>'; return; }
        const res = await api.dbConfig.save(payload);
        if (res && res.ok) {
            toast('数据源已保存', 'success');
            modal.classList.remove('open');
            await load();
        } else {
            root.querySelector('#d-msg').innerHTML = `<span class="text-danger">${esc((res && res.message) || '保存失败')}</span>`;
        }
    });

    /**
     * 弹窗内「测试连接」：先落库再测试，保证测的就是即将保存的配置
     * 未保存过的新数据源需要先保存一次（提示用户）
     */
    root.querySelector('#d-test').addEventListener('click', async () => {
        if (!guardAdmin('测试连接')) return;
        if (!editingSource) { toast('请先保存数据源，再进行连接测试', 'warn'); return; }
        const btn = root.querySelector('#d-test');
        btn.disabled = true; btn.textContent = '测试中...';
        // 表单有改动时先保存，避免测的还是旧配置
        await api.dbConfig.save(readForm());
        const res = await api.dbConfig.test(editingSource.id);
        btn.disabled = false; btn.textContent = '测试连接';
        root.querySelector('#d-msg').innerHTML = res && res.ok
            ? `<span class="text-success">${esc(res.message)}</span>`
            : `<span class="text-danger">${esc((res && res.message) || '连接失败')}</span>`;
        toast(res && res.ok ? res.message : `连接失败：${(res && res.message) || ''}`, res && res.ok ? 'success' : 'danger');
        await load();
    });

    /* ---------------- 卡片操作 ---------------- */

    grid.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const card = btn.closest('[data-id]');
        if (!card) return;
        const id = card.dataset.id;
        const src = sources.find(s => s.id === id);
        if (!src) return;
        const act = btn.dataset.act;

        if (act === 'test') {
            if (!guardWrite('连接测试')) return;
            btn.textContent = '测试中...';
            const res = await api.dbConfig.test(id);
            toast(res && res.ok ? res.message : `连接失败：${(res && res.message) || ''}`, res && res.ok ? 'success' : 'danger');
            await load();
        } else if (act === 'edit') {
            if (!guardAdmin('配置数据源')) return;
            await openModal(src);
        } else if (act === 'toggle') {
            if (!guardAdmin('启停数据源')) return;
            const res = await api.dbConfig.toggle(id, !src.enabled);
            if (res && res.ok) { toast(`数据源已${src.enabled ? '停用' : '启用'}`, 'success'); await load(); }
            else toast((res && res.message) || '操作失败', 'danger');
        } else if (act === 'delete') {
            if (!guardAdmin('删除数据源')) return;
            if (!confirm(`确认删除数据源「${src.name}」？该操作不可撤销。`)) return;
            const res = await api.dbConfig.remove(id);
            if (res && res.ok) { toast('已删除', 'success'); await load(); }
            else toast((res && res.message) || '删除失败', 'danger');
        } else if (act === 'use') {
            if (!src.host || !src.user) { toast('该数据源尚未配置连接信息', 'warn'); return; }
            if (!src.enabled) { toast('该数据源已停用，请先启用', 'warn'); return; }
            // 通过 sessionStorage 传递默认数据源，SQL 工作台挂载时读取
            try { sessionStorage.setItem('sgops.activeSourceId', src.id); } catch (err) { /* 忽略 */ }
            const nav = document.querySelector('[data-page="sql"]');
            if (nav) nav.click();
            else toast('请切换到「SQL 工作台」继续操作', 'info');
        }
    });

    /* ---------------- 导入 / 导出 ---------------- */

    root.querySelector('#btn-export-dbc').addEventListener('click', async () => {
        const res = await api.dbConfig.exportConfig();
        if (!res || !res.ok) { toast('导出失败', 'danger'); return; }
        const blob = new Blob([JSON.stringify({
            schemaVersion: res.schemaVersion,
            exportedAt: res.exportedAt,
            count: res.count,
            sources: res.sources
        }, null, 2)], { type: 'application/json;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `dbconfig-${String(res.exportedAt || '').replace(/[: ]/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast(`已导出 ${res.count} 条数据源配置（不含口令）`, 'success');
    });

    root.querySelector('#btn-import-dbc').addEventListener('click', () => {
        if (!guardAdmin('导入配置')) return;
        root.querySelector('#import-text').value = '';
        root.querySelector('#import-msg').textContent = '';
        importModal.classList.add('open');
    });
    importModal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => importModal.classList.remove('open')));

    root.querySelector('#import-do').addEventListener('click', async () => {
        if (!guardAdmin('导入配置')) return;
        const text = root.querySelector('#import-text').value.trim();
        const msg = root.querySelector('#import-msg');
        if (!text) { msg.innerHTML = '<span class="text-danger">请粘贴配置内容</span>'; return; }

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            msg.innerHTML = '<span class="text-danger">JSON 解析失败，请检查格式</span>';
            return;
        }
        const list = Array.isArray(parsed) ? parsed : parsed.sources;
        if (!Array.isArray(list) || !list.length) {
            msg.innerHTML = '<span class="text-danger">未找到 sources 数组</span>';
            return;
        }

        const res = await api.dbConfig.importConfig(list, root.querySelector('#import-overwrite').checked);
        if (res && res.ok) {
            toast(`导入完成：新增 ${res.created} / 更新 ${res.updated} / 跳过 ${res.skipped}`, 'success');
            importModal.classList.remove('open');
            await load();
        } else {
            msg.innerHTML = `<span class="text-danger">${esc((res && res.message) || '导入失败')}</span>`;
        }
    });

    /* ---------------- 筛选 ---------------- */

    root.querySelector('#dbc-filter').addEventListener('change', e => {
        filter = e.target.value;
        paintList();
    });

    let searchTimer = null;
    root.querySelector('#dbc-search').addEventListener('input', e => {
        clearTimeout(searchTimer);
        const value = e.target.value;
        searchTimer = setTimeout(() => { keyword = value.trim(); paintList(); }, 180);
    });

    /* ---------------- 初始化 ---------------- */

    try {
        const res = await api.dbConfig.drivers();
        if (res) drivers = res;
    } catch (err) { /* 忽略，用默认值渲染 */ }
    paintDrivers();
    await load();
}
