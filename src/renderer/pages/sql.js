/**
 * SQL 工作台
 * 数据流：
 *   数据源列表 ← system:dbsource:list
 *   库表结构   ← db:schema（失败自动降级为 db:tables 懒加载）
 *   脚本库     ← sqlScripts:list|save|delete
 *   执行 SQL   ← sql:execute（主进程逐条执行，拦截 DROP DATABASE）
 *   执行历史   ← sqlHistory:list
 *   结果导出   ← sql:export（主进程生成 CSV，前端触发下载）
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow, shortTime, guardAdmin, applyReadonly } from '../ui.js';
import * as etl from '../etl.js';

const MAX_ROWS_RENDER = 300;

const TYPE_META = {
    mysql: { label: 'MySQL', badge: 'blue' },
    oracle: { label: 'Oracle', badge: 'red' },
    postgres: { label: 'PostgreSQL', badge: 'purple' }
};

let sources = [];
let scripts = [];
let history = [];
let activeSourceId = null;
let schema = [];
let keyword = '';
let lastResult = null;
let editingScriptId = null;

const typeBadge = t => {
    const meta = TYPE_META[t] || { label: t || '-', badge: 'gray' };
    return `<span class="badge ${meta.badge}">${esc(meta.label)}</span>`;
};

const sourceReady = s => !!(s.host && s.user);

function sourceCard(s, active) {
    const usable = sourceReady(s);
    const statusBadge = !usable ? '<span class="badge gray">未配置</span>'
        : s.status === 'error' ? '<span class="badge red">连接异常</span>'
        : '<span class="badge green">已配置</span>';
    return `
    <div class="card db-card ${active ? 'active' : ''}" data-id="${esc(s.id)}" style="${usable ? '' : 'opacity:.7'}">
        <div class="card-header" style="margin-bottom:8px;align-items:center">
            <div style="display:flex;align-items:center;gap:8px;min-width:0">
                <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</strong>
                ${typeBadge(s.type)}
            </div>
            ${statusBadge}
        </div>
        <div class="muted mono" style="font-size:12px;line-height:1.7;word-break:break-all">
            ${s.host ? esc(s.host) + ':' + esc(s.port) + (s.database ? '/' + esc(s.database) : '') : '未填写连接地址'}
        </div>
        <div class="toolbar" style="margin-top:10px;gap:6px">
            <button class="btn btn-ghost btn-sm" data-act="use" ${usable ? '' : 'disabled'}>${active ? '当前使用' : '切换到此库'}</button>
            <button class="btn-link" data-act="test" data-write>测试</button>
            <button class="btn-link" data-act="refresh">刷新结构</button>
        </div>
    </div>`;
}

function scriptItem(s) {
    const meta = TYPE_META[s.sourceType || ''] || null;
    return `
    <div class="list-item" data-id="${esc(s.id)}">
        <div style="min-width:0">
            <div class="list-item-title">${esc(s.name)}</div>
            <div class="list-item-sub mono">${esc((s.sql || '').replace(/\s+/g, ' ').slice(0, 70))}</div>
            <div class="list-item-sub">${meta ? esc(meta.label) : '通用'} · ${esc(s.author || '-')} · ${esc(shortTime(s.updatedAt))}</div>
        </div>
        <div class="list-item-actions">
            <button class="btn-link" data-act="load">载入</button>
            <button class="btn-link" data-act="run" data-write>运行</button>
            <button class="btn-link" data-act="edit" data-write>编辑</button>
            <button class="btn-link danger" data-act="delete" data-write>删除</button>
        </div>
    </div>`;
}

function schemaTree() {
    if (!schema.length) return '<div class="empty">暂无库表结构（点击「刷新结构」加载）</div>';
    const kw = keyword.trim().toLowerCase();
    const list = kw ? schema.filter(t => (t.name || '').toLowerCase().includes(kw)) : schema;
    if (!list.length) return `<div class="empty">未找到匹配「${esc(kw)}」的表</div>`;

    return list.map(t => {
        const count = t.columns !== null
            ? `${t.columns.length} 列`
            : (t.loading ? '加载中…' : '');
        const body = t.loading
            ? '<div class="tree-cols muted" style="font-size:11.5px">表结构加载中...</div>'
            : (t.open && t.columns !== null
                ? `<div class="tree-cols">${t.columns.map(c => `
                    <div class="tree-col" data-col="${esc(c.name)}" data-table="${esc(t.name)}">
                        <span class="mono">${esc(c.name)}</span>
                        <span class="muted">${esc(c.type || '')}</span>
                        ${c.key === 'PRI' ? '<span class="badge amber" style="font-size:10px;padding:0 4px">PK</span>' : ''}
                    </div>`).join('')}</div>`
                : (t.error ? `<div class="tree-cols muted" style="font-size:11.5px">结构读取失败：${esc(t.error)}</div>` : ''));
        return `
        <div class="tree-node" data-table="${esc(t.name)}">
            <div class="tree-title" data-expanded="${t.open ? '1' : '0'}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;flex-shrink:0"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>
                <span class="mono">${esc(t.name)}</span>
                ${t.comment ? `<span class="muted tree-comment">${esc(t.comment)}</span>` : ''}
                <span class="tree-count">${count}</span>
            </div>
            ${body}
        </div>`;
    }).join('');
}

function resultHtml(res) {
    if (!res) return '';
    if (res.blocked) {
        return `<div class="alert danger" style="margin-top:14px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>${esc(res.message || '执行被拦截')}</span></div>`;
    }
    if (!res.statements) {
        return `<div class="alert danger" style="margin-top:14px"><span>${esc(res.message || '执行失败')}</span></div>`;
    }

    const head = `<div class="result-head">
        <div class="muted" style="font-size:12.5px">
            数据源 <strong>${esc((res.source || {}).name || '-')}</strong> ·
            ${res.statements.length} 条语句 ·
            总耗时 ${esc(res.totalDurationMs)} ms
            ${res.partial ? '<span class="badge amber" style="margin-left:6px">部分成功</span>' : ''}
        </div>
    </div>`;

    const blocks = res.statements.map((st, i) => {
        if (!st.ok) {
            return `<div class="sql-block">
                <div class="sql-block-head"><span class="badge red">语句 ${i + 1} 失败</span>
                    <span class="mono muted">${esc(st.durationMs)} ms</span></div>
                <pre class="code-block">${esc(st.sql)}</pre>
                <div class="alert danger" style="margin-top:10px"><span>${esc(st.error || '执行失败')}</span></div>
            </div>`;
        }

        const hasRows = (st.rows || []).length > 0;
        const body = hasRows
            ? `<div class="table-wrap" style="max-height:420px;overflow:auto">
                <table class="table">
                    <thead><tr><th style="width:46px">#</th>${(st.columns || []).map(c => `<th class="mono">${esc(c)}</th>`).join('')}</tr></thead>
                    <tbody>${(st.rows || []).slice(0, MAX_ROWS_RENDER).map((row, ri) => `
                        <tr>
                            <td class="muted">${ri + 1}</td>
                            ${(st.columns || []).map(c => {
                                const v = Array.isArray(row) ? row[st.columns.indexOf(c)] : row[c];
                                const text = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
                                return `<td class="mono" style="max-width:280px;word-break:break-all">${esc(text)}</td>`;
                            }).join('')}
                        </tr>`).join('')}</tbody>
                </table>
            </div>`
            : `<div class="alert success" style="margin-top:10px">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                <span>执行成功${st.affectedRows !== null && st.affectedRows !== undefined ? ` · 影响 ${esc(st.affectedRows)} 行` : ''}</span>
            </div>`;

        return `<div class="sql-block">
            <div class="sql-block-head">
                <span class="badge green">语句 ${i + 1} 成功</span>
                <span class="muted" style="font-size:12px">
                    ${hasRows ? `返回 ${esc(st.rowCount)} 行${st.truncated ? '（已截断至 500 行）' : ''}` : '无结果集'}
                    · ${esc(st.durationMs)} ms
                </span>
                <div class="spacer"></div>
                ${hasRows ? `<button class="btn btn-ghost btn-sm" data-export-idx="${i}">导出 CSV</button>` : ''}
            </div>
            <pre class="code-block">${esc(st.sql)}</pre>
            ${body}
        </div>`;
    }).join('');

    return head + blocks;
}

function historyRow(h) {
    const resultMap = {
        success: '<span class="badge green">成功</span>',
        partial: '<span class="badge amber">部分成功</span>',
        failed: '<span class="badge red">失败</span>',
        blocked: '<span class="badge amber">已拦截</span>'
    };
    return `
    <tr data-id="${esc(h.id)}">
        <td class="muted">${esc(shortTime(h.createdAt))}</td>
        <td>${esc(h.sourceName || '-')}</td>
        <td>${typeBadge(h.type)}</td>
        <td class="mono" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(h.sql)}">${esc((h.sql || '').replace(/\s+/g, ' '))}</td>
        <td>${esc(h.statementCount || 1)}</td>
        <td class="muted">${esc(h.rowCount || 0)}</td>
        <td class="muted">${esc(h.durationMs || 0)} ms</td>
        <td>${resultMap[h.result] || esc(h.result || '-')}</td>
        <td class="muted">${esc(h.user || '-')}</td>
    </tr>`;
}

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="db-source-grid" id="source-grid">${emptyRow(1, '数据源加载中...')}</div>

    <div class="sql-layout">
        <div class="sql-side">
            <div class="card">
                <div class="card-header">
                    <div>
                        <div class="card-title">库表结构</div>
                        <div class="card-desc" id="schema-source">-</div>
                    </div>
                    <button class="btn btn-ghost btn-sm" id="btn-refresh-schema">刷新结构</button>
                </div>
                <div class="schema-toolbar">
                    <input class="input schema-search" id="schema-search" type="text"
                        placeholder="搜索表名（双击表名加载结构）" autocomplete="off">
                </div>
                <div class="tree" id="schema-tree"><div class="empty">加载中...</div></div>
            </div>

            <div class="card">
                <div class="card-header">
                    <div>
                        <div class="card-title">SQL 脚本库</div>
                        <div class="card-desc">常用语句可保存复用</div>
                    </div>
                    <button class="btn btn-primary btn-sm" data-write id="btn-new-sql">+ 新建</button>
                </div>
                <div class="list" id="sql-list"><div class="empty">加载中...</div></div>
            </div>
        </div>

        <div class="sql-main">
            <div class="card">
                <div class="card-header">
                    <div>
                        <div class="card-title">SQL 编辑器</div>
                        <div class="card-desc">支持多语句（分号分隔，单次最多 10 条）；DROP DATABASE / DROP SCHEMA 一律拒绝并记入审计</div>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center">
                        <select class="select" id="exec-source" style="min-width:170px"></select>
                        <button class="btn btn-ghost btn-sm" data-write id="btn-etl">数据集成</button>
                        <button class="btn btn-primary btn-sm" data-write id="btn-run-sql">执行 (Ctrl+Enter)</button>
                    </div>
                </div>

                <textarea class="textarea code-input" id="sql-input" rows="9" spellcheck="false"
                    placeholder="SELECT * FROM information_schema.tables LIMIT 20;">SELECT table_name, table_rows,
       ROUND(data_length / 1024 / 1024, 2) AS data_mb
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY data_length DESC
LIMIT 20;</textarea>

                <div class="toolbar" style="margin-top:12px">
                    <button class="btn btn-ghost btn-sm" id="btn-clear-sql">清空</button>
                    <button class="btn btn-ghost btn-sm" id="btn-save-sql" data-write>保存为脚本</button>
                    <button class="btn btn-ghost btn-sm" id="btn-format-sql">格式化</button>
                    <div class="spacer"></div>
                    <span class="muted" id="exec-status" style="font-size:12px"></span>
                </div>

                <div id="sql-result">${resultHtml(null)}</div>
            </div>

            <div class="card">
                <div class="card-header">
                    <div>
                        <div class="card-title">执行历史</div>
                        <div class="card-desc">最近 60 条 SQL 执行记录（含被拦截操作）</div>
                    </div>
                    <button class="btn btn-ghost btn-sm" id="btn-reload-history">刷新</button>
                </div>
                <div class="table-wrap">
                    <table class="table">
                        <thead><tr><th>时间</th><th>数据源</th><th>类型</th><th>SQL</th><th>语句数</th><th>行数</th><th>耗时</th><th>结果</th><th>操作人</th></tr></thead>
                        <tbody id="sql-history">${loadingRow(9)}</tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>

    <div class="modal-mask" id="sql-modal">
        <div class="modal" style="width:620px">
            <div class="modal-header">
                <h3 id="sql-modal-title">保存 SQL 脚本</h3>
                <button class="modal-close" data-close>×</button>
            </div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-item">
                        <label>脚本名称</label>
                        <input class="input" id="sq-name" placeholder="例如：慢查询 Top 10">
                    </div>
                    <div class="form-item">
                        <label>适用类型</label>
                        <select class="select" id="sq-type" style="width:100%">
                            <option value="mysql">MySQL</option>
                            <option value="oracle">Oracle</option>
                            <option value="postgres">PostgreSQL</option>
                        </select>
                    </div>
                </div>
                <div class="form-item">
                    <label>SQL 内容</label>
                    <textarea class="textarea code-input" id="sq-sql" rows="8" spellcheck="false"></textarea>
                </div>
                <div id="sq-msg" class="form-hint"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="sql-save">保存</button>
            </div>
        </div>
    </div>

    ${etl.render()}`;
}

export async function mount(root) {
    const grid = root.querySelector('#source-grid');
    const treeEl = root.querySelector('#schema-tree');
    const listEl = root.querySelector('#sql-list');
    const inputEl = root.querySelector('#sql-input');
    const resultEl = root.querySelector('#sql-result');
    const historyEl = root.querySelector('#sql-history');
    const sourceSel = root.querySelector('#exec-source');
    const modal = root.querySelector('#sql-modal');
    const statusEl = root.querySelector('#exec-status');

    const currentSource = () => sources.find(s => s.id === activeSourceId) || null;

    /* ---------------- 数据源 ---------------- */

    const paintSources = () => {
        grid.innerHTML = sources.length
            ? sources.map(s => sourceCard(s, s.id === activeSourceId)).join('')
            : '<div class="empty">暂无数据源，请到「数据库运维 → 数据库配置」新增</div>';
        sourceSel.innerHTML = sources.length
            ? sources.map(s => `<option value="${esc(s.id)}" ${s.id === activeSourceId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
            : '<option value="">暂无数据源</option>';
        const cur = currentSource();
        root.querySelector('#schema-source').textContent = cur
            ? `${cur.name}${sourceReady(cur) ? '' : '（未配置连接信息）'}`
            : '请先选择数据源';
    };

    const loadSources = async () => {
        try {
            // 已停用的数据源不在工作台展示（配置页可管理）
            const all = await api.dbConfig.list();
            sources = all.filter(s => s.enabled !== false);
            const usable = sources.filter(sourceReady);
            if (!activeSourceId || !sources.some(s => s.id === activeSourceId)) {
                // 优先沿用「数据库配置」页传递过来的数据源
                let preferred = null;
                try { preferred = sessionStorage.getItem('sgops.activeSourceId'); } catch (err) { /* 忽略 */ }
                activeSourceId = (sources.some(s => s.id === preferred) ? preferred : null)
                    || (usable[0] || sources[0] || {}).id || null;
                try { sessionStorage.removeItem('sgops.activeSourceId'); } catch (err) { /* 忽略 */ }
            }
            paintSources();
        } catch (err) {
            grid.innerHTML = `<div class="alert danger"><span>数据源加载失败：${esc(err.message)}</span></div>`;
        }
    };

    /* ---------------- 库表结构（懒加载） ---------------- */

    const renderTree = () => { treeEl.innerHTML = schemaTree(); };

    /** 首次只拉表名列表（列结构在双击表名时懒加载） */
    const loadSchema = async () => {
        const src = currentSource();
        if (!src) { treeEl.innerHTML = '<div class="empty">请先选择数据源</div>'; return; }
        keyword = '';
        searchEl.value = '';
        schema = [];
        treeEl.innerHTML = '<div class="empty">结构加载中...</div>';
        try {
            const t = await api.sql.tables(src.id);
            if (!t || !t.ok) {
                schema = [];
                treeEl.innerHTML = `<div class="empty">${esc((t && t.message) || '结构加载失败')}</div>`;
                return;
            }
            schema = (t.tables || []).map(x => ({
                name: x.name, comment: x.comment,
                columns: null, open: false, loading: false, error: null
            }));
            renderTree();
        } catch (err) {
            treeEl.innerHTML = `<div class="empty">结构加载失败：${esc(err.message)}</div>`;
        }
    };

    /** 双击表名：首次请求该表列结构，之后在该表展开 / 收起 */
    const toggleTable = async name => {
        const t = schema.find(x => x.name === name);
        if (!t) return;
        if (t.columns === null) {
            if (t.loading) return;
            t.loading = true;
            renderTree();
            try {
                const res = await api.sql.describe(activeSourceId, name);
                t.columns = (res && res.ok) ? (res.columns || []) : [];
                t.error = (res && !res.ok) ? (res.message || '结构读取失败') : null;
                t.open = true;
            } catch (err) {
                t.columns = [];
                t.error = err.message;
                t.open = true;
            }
            t.loading = false;
            renderTree();
        } else {
            t.open = !t.open;
            renderTree();
        }
    };

    const searchEl = root.querySelector('#schema-search');
    searchEl.addEventListener('input', () => {
        keyword = searchEl.value;
        renderTree();
    });

    /* ---------------- 脚本库 ---------------- */

    const loadScripts = async () => {
        try {
            scripts = await api.sql.scripts.list();
            listEl.innerHTML = scripts.length ? scripts.map(scriptItem).join('') : '<div class="empty">暂无保存的脚本</div>';
        } catch (err) {
            listEl.innerHTML = `<div class="empty">脚本加载失败：${esc(err.message)}</div>`;
        }
    };

    const openModal = (script) => {
        editingScriptId = script ? script.id : null;
        root.querySelector('#sql-modal-title').textContent = script ? `编辑脚本 · ${script.name}` : '保存 SQL 脚本';
        root.querySelector('#sq-name').value = script ? script.name : '';
        root.querySelector('#sq-type').value = script ? (script.sourceType || 'mysql') : ((currentSource() || {}).type || 'mysql');
        root.querySelector('#sq-sql').value = script ? script.sql : inputEl.value;
        root.querySelector('#sq-msg').textContent = '';
        modal.classList.add('open');
    };

    /* ---------------- 执行 ---------------- */

    const runSql = async (sql) => {
        const src = currentSource();
        if (!src) { toast('请先选择数据源', 'warn'); return; }
        if (!sourceReady(src)) { toast(`「${src.name}」未配置连接信息，请先到「数据库配置」完成配置`, 'warn'); return; }
        const statement = String(sql === undefined ? inputEl.value : sql).trim();
        if (!statement) { toast('请输入要执行的 SQL', 'warn'); return; }

        const btn = root.querySelector('#btn-run-sql');
        btn.disabled = true;
        btn.textContent = '执行中...';
        statusEl.textContent = '正在执行...';

        try {
            const res = await api.sql.execute(src.id, statement);
            lastResult = res;
            resultEl.innerHTML = resultHtml(res);
            if (res && res.ok) toast(res.partial ? '部分语句执行成功' : 'SQL 执行完成', res.partial ? 'warn' : 'success');
            else if (res && res.blocked) toast(res.message, 'danger');
            else toast((res && res.message) || '执行失败', 'danger');
            statusEl.textContent = res && res.totalDurationMs ? `耗时 ${res.totalDurationMs} ms` : '';
            await Promise.all([refreshHistory(), loadSchema(), loadSources()]);
        } catch (err) {
            resultEl.innerHTML = `<div class="alert danger" style="margin-top:14px"><span>${esc(err.message)}</span></div>`;
            statusEl.textContent = '';
        } finally {
            btn.disabled = false;
            btn.textContent = '执行 (Ctrl+Enter)';
        }
    };

    const refreshHistory = async () => {
        try {
            history = await api.sql.history();
            historyEl.innerHTML = history.length ? history.map(historyRow).join('') : emptyRow(9, '暂无执行记录');
        } catch (err) {
            historyEl.innerHTML = emptyRow(9, '历史加载失败：' + err.message);
        }
    };

    /* ---------------- 事件绑定 ---------------- */

    // 数据源卡片
    grid.addEventListener('click', async e => {
        const card = e.target.closest('[data-id]');
        if (!card) return;
        const id = card.dataset.id;
        const btn = e.target.closest('[data-act]');

        if (!btn || btn.dataset.act === 'use') {
            if (activeSourceId === id) return;
            activeSourceId = id;
            paintSources();
            await loadSchema();
            return;
        }
        if (btn.dataset.act === 'test') {
            btn.textContent = '测试中...';
            const res = await api.dbConfig.test(id);
            toast(res && res.ok ? res.message : `连接失败：${(res && res.message) || ''}`, res && res.ok ? 'success' : 'danger');
            await loadSources();
        } else if (btn.dataset.act === 'refresh') {
            if (activeSourceId !== id) { activeSourceId = id; paintSources(); }
            await loadSchema();
            toast('库表结构已刷新', 'success');
        }
    });

    sourceSel.addEventListener('change', async () => {
        activeSourceId = sourceSel.value;
        paintSources();
        await loadSchema();
    });

    root.querySelector('#btn-refresh-schema').addEventListener('click', loadSchema);

    // 表 / 字段点击 → 生成查询语句
    treeEl.addEventListener('click', e => {
        const col = e.target.closest('.tree-col');
        const table = e.target.closest('.tree-title');
        if (col) {
            const sql = `SELECT ${col.dataset.col}\nFROM ${col.dataset.table}\nLIMIT 100;`;
            inputEl.value = sql;
        } else if (table) {
            const name = table.closest('.tree-node').dataset.table;
            inputEl.value = `SELECT *\nFROM ${name}\nLIMIT 100;`;
        } else {
            return;
        }
        inputEl.focus();
    });

    // 双击表名 → 懒加载并展开该表列结构（首次请求，之后切换展开/收起）
    treeEl.addEventListener('dblclick', e => {
        const title = e.target.closest('.tree-title');
        if (!title || e.target.closest('.tree-col')) return;
        const name = title.closest('.tree-node').dataset.table;
        if (name) toggleTable(name);
    });

    // 脚本库
    root.querySelector('#btn-new-sql').addEventListener('click', () => {
        if (!guardAdmin('保存 SQL 脚本')) return;
        openModal(null);
    });

    listEl.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const item = btn.closest('[data-id]');
        const script = scripts.find(s => s.id === item.dataset.id);
        if (!script) return;

        if (btn.dataset.act === 'load') {
            inputEl.value = script.sql;
            if (script.sourceId && sources.some(s => s.id === script.sourceId)) {
                activeSourceId = script.sourceId;
                paintSources();
            }
            toast(`已载入脚本「${script.name}」`, 'success');
        } else if (btn.dataset.act === 'run') {
            if (!guardAdmin('执行 SQL')) return;
            if (script.sourceId && sources.some(s => s.id === script.sourceId)) {
                activeSourceId = script.sourceId;
                paintSources();
            }
            inputEl.value = script.sql;
            await runSql(script.sql);
        } else if (btn.dataset.act === 'edit') {
            if (!guardAdmin('编辑 SQL 脚本')) return;
            openModal(script);
        } else if (btn.dataset.act === 'delete') {
            if (!guardAdmin('删除 SQL 脚本')) return;
            if (!confirm(`确认删除脚本「${script.name}」？`)) return;
            const res = await api.sql.scripts.remove(script.id);
            if (res && res.ok) { toast('已删除', 'success'); await loadScripts(); }
            else toast('删除失败', 'danger');
        }
    });

    // 编辑器
    root.querySelector('#btn-run-sql').addEventListener('click', () => runSql());

    inputEl.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); }
    });

    root.querySelector('#btn-clear-sql').addEventListener('click', () => {
        inputEl.value = '';
        resultEl.innerHTML = '';
        statusEl.textContent = '';
        inputEl.focus();
    });

    root.querySelector('#btn-save-sql').addEventListener('click', () => {
        if (!guardAdmin('保存 SQL 脚本')) return;
        if (!inputEl.value.trim()) { toast('SQL 内容为空，无法保存', 'warn'); return; }
        openModal(null);
    });

    root.querySelector('#btn-format-sql').addEventListener('click', () => {
        const formatted = inputEl.value
            .split(';')
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => s
                .replace(/\s*\b(FROM|WHERE|GROUP BY|ORDER BY|LIMIT|HAVING|LEFT JOIN|RIGHT JOIN|INNER JOIN|JOIN|UNION|VALUES|SET|AND|OR)\b/gi,
                    m => '\n' + m.toUpperCase().replace(/\s+/g, ' '))
                .replace(/\n\s*\n/g, '\n'))
            .join(';\n\n');
        inputEl.value = formatted ? formatted + ';' : formatted;
        toast('已格式化', 'success');
    });

    modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => modal.classList.remove('open')));

    root.querySelector('#sql-save').addEventListener('click', async () => {
        if (!guardAdmin('保存 SQL 脚本')) return;
        const payload = {
            id: editingScriptId || undefined,
            name: root.querySelector('#sq-name').value.trim(),
            sourceType: root.querySelector('#sq-type').value,
            sourceId: activeSourceId,
            sql: root.querySelector('#sq-sql').value
        };
        if (!payload.name) { root.querySelector('#sq-msg').innerHTML = '<span class="text-danger">请填写脚本名称</span>'; return; }
        if (!payload.sql.trim()) { root.querySelector('#sq-msg').innerHTML = '<span class="text-danger">SQL 内容不能为空</span>'; return; }

        const res = await api.sql.scripts.save(payload);
        if (res && res.ok) {
            toast('脚本已保存', 'success');
            modal.classList.remove('open');
            await loadScripts();
        } else {
            root.querySelector('#sq-msg').innerHTML = `<span class="text-danger">${esc((res && res.message) || '保存失败')}</span>`;
        }
    });

    // 结果集导出
    resultEl.addEventListener('click', async e => {
        const btn = e.target.closest('[data-export-idx]');
        if (!btn) return;
        const st = ((lastResult || {}).statements || [])[Number(btn.dataset.exportIdx)];
        if (!st) return;
        const res = await api.sql.exportCsv({ columns: st.columns, rows: st.rows });
        if (!res || !res.ok) { toast((res && res.message) || '导出失败', 'danger'); return; }
        const blob = new Blob(['\ufeff' + res.content], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = res.filename;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('结果已导出', 'success');
    });

    root.querySelector('#btn-reload-history').addEventListener('click', refreshHistory);

    // 数据集成（ETL）：库对库 / 文件对库 / 库对文件，共享本页的数据源与选中库
    await etl.mount(root, {
        getSources: () => sources,
        getActiveId: () => activeSourceId
    });
    root.querySelector('#btn-etl').addEventListener('click', () => etl.open());

    applyReadonly(root);

    /* ---------------- 初始化 ---------------- */
    await loadSources();
    await Promise.all([loadSchema(), loadScripts(), refreshHistory()]);
}
