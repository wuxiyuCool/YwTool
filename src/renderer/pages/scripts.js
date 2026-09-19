/**
 * 脚本管理页
 * 数据流：
 *   scripts:list / scripts:save（内容变更自动升版本）/ scripts:delete
 *   scripts:lint（Python 语法预检） / scripts:run（选择主机批量执行）
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, emptyRow, loadingRow, applyReadonly, guardAdmin } from '../ui.js';
import * as aiPanel from '../aiPanel.js';

let scripts = [];
let hosts = [];
let filter = 'all';
let keyword = '';

const typeBadge = t => t === 'shell'
    ? '<span class="badge green">Shell</span>'
    : t === 'compose'
        ? '<span class="badge blue">Compose</span>'
        : '<span class="badge purple">Python</span>';

function rowHtml(s) {
    return `
    <tr data-id="${esc(s.id)}">
        <td><strong class="mono">${esc(s.name)}</strong></td>
        <td>${typeBadge(s.type)}</td>
        <td>${esc(s.desc || '-')}</td>
        <td class="muted">${esc(s.version || 'v1')}</td>
        <td class="muted">${esc(s.author || '-')}</td>
        <td class="muted">${esc(s.updatedAt || '-')}</td>
        <td style="white-space:nowrap">
            <button class="btn-link" data-act="run" data-write>执行</button>
            <button class="btn-link" data-act="edit" data-write>编辑</button>
            <button class="btn-link danger" data-act="delete" data-write>删除</button>
        </td>
    </tr>`;
}

function bodyHtml() {
    const kw = keyword.toLowerCase();
    const rows = scripts.filter(s =>
        (filter === 'all' || s.type === filter) && s.name.toLowerCase().includes(kw));
    return rows.length ? rows.map(rowHtml).join('') : emptyRow(7, '暂无脚本');
}

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="card">
        <div class="toolbar">
            <div class="tabs" style="margin:0;border:none" id="script-tabs">
                <div class="tab active" data-filter="all">全部</div>
                <div class="tab" data-filter="shell">Shell</div>
                <div class="tab" data-filter="python">Python</div>
                <div class="tab" data-filter="compose">Compose</div>
            </div>
            <div class="spacer"></div>
            <input class="input" id="script-search" placeholder="搜索脚本名..." style="width:200px">
            <button class="btn btn-ghost" id="btn-refresh-scripts">刷新</button>
            <button class="btn btn-primary" id="btn-new-script" data-write>+ 新建脚本</button>
        </div>
        <div class="table-wrap">
            <table class="table">
                <thead><tr><th>脚本名</th><th>类型</th><th>描述</th><th>版本</th><th>创建人</th><th>更新时间</th><th>操作</th></tr></thead>
                <tbody id="script-tbody">${loadingRow(7)}</tbody>
            </table>
        </div>
    </div>

    <div class="alert info">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>脚本统一托管在本地脚本库：Shell 以 heredoc 方式交给远端 bash 执行，Python 写入远端临时文件后由 python3 执行并自动清理；执行同样经过敏感词校验。</span>
    </div>

    <!-- 编辑弹窗 -->
    <div class="modal-mask" id="script-modal">
        <div class="modal" style="width:720px">
            <div class="modal-header">
                <h3 id="script-modal-title">新建脚本</h3>
                <button class="modal-close" data-close>×</button>
            </div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-item">
                        <label>脚本名</label>
                        <input class="input mono" id="s-name" placeholder="check_disk.sh">
                    </div>
                    <div class="form-item">
                        <label>类型</label>
                        <select class="select" id="s-type" style="width:100%">
                            <option value="shell">Shell</option>
                            <option value="python">Python</option>
                            <option value="compose">Compose 编排文件（在容器运维页执行）</option>
                        </select>
                    </div>
                </div>
                <div class="form-item">
                    <label>描述</label>
                    <input class="input" id="s-desc" placeholder="磁盘使用率巡检">
                </div>
                <div class="form-item">
                    <label>脚本内容</label>
                    <textarea class="textarea" id="s-content" rows="12" placeholder="#!/bin/bash&#10;echo hello"></textarea>
                    <div class="form-hint" id="s-lint">保存前可先做语法预检</div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" id="btn-lint">语法预检</button>
                <button class="btn btn-ghost" id="btn-ai-edit" data-write>🤖 AI 生成 / 优化</button>
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="script-save">保存</button>
            </div>
        </div>
    </div>

    <!-- AI 生成 / 优化弹窗 -->
    <div class="modal-mask" id="ai-modal">
        <div class="modal" style="width:680px">
            <div class="modal-header">
                <h3 id="ai-modal-title">AI 生成脚本</h3>
                <button class="modal-close" data-close>×</button>
            </div>
            <div class="modal-body">
                <div class="form-row">
                    <div class="form-item" style="flex:2">
                        <label>需求说明 <button class="btn-link" id="ai-extra" data-write>优化我的脚本</button></label>
                        <textarea class="textarea" id="ai-requirement" rows="3" placeholder="例如：磁盘使用率超过 85% 时输出告警"></textarea>
                    </div>
                </div>
                <div id="ai-result"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" id="ai-apply" disabled>应用到编辑器</button>
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="ai-run">生成</button>
            </div>
        </div>
    </div>

    <!-- 执行弹窗 -->
    <div class="modal-mask" id="run-modal">
        <div class="modal">
            <div class="modal-header">
                <h3 id="run-title">执行脚本</h3>
                <button class="modal-close" data-close>×</button>
            </div>
            <div class="modal-body">
                <div class="form-item">
                    <label>目标主机（已选 <span id="run-count">0</span> 台）</label>
                    <div class="check-grid" id="run-grid"></div>
                </div>
                <div class="form-row">
                    <div class="form-item">
                        <label>并发数</label>
                        <input class="input" id="run-concurrency" type="number" value="10" min="1" max="50">
                    </div>
                    <div class="form-item">
                        <label>超时（秒）</label>
                        <input class="input" id="run-timeout" type="number" value="60" min="5" max="600">
                    </div>
                </div>
                <div id="run-result"></div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-ghost" data-close>取消</button>
                <button class="btn btn-primary" id="run-submit">执行</button>
            </div>
        </div>
    </div>`;
}

export async function mount(root) {
    const tbody = root.querySelector('#script-tbody');
    const editModal = root.querySelector('#script-modal');
    const runModal = root.querySelector('#run-modal');
    const aiModal = root.querySelector('#ai-modal');
    let editingId = null;
    let runningScript = null;
    let aiMode = 'generate';   // generate | optimize
    let aiResult = null;       // { script, explanation, type }

    const refresh = async () => {
        try {
            scripts = await api.scripts.list();
            tbody.innerHTML = bodyHtml();
            root.querySelector('#script-tabs').innerHTML = `
                <div class="tab ${filter === 'all' ? 'active' : ''}" data-filter="all">全部 (${scripts.length})</div>
                <div class="tab ${filter === 'shell' ? 'active' : ''}" data-filter="shell">Shell (${scripts.filter(s => s.type === 'shell').length})</div>
                <div class="tab ${filter === 'python' ? 'active' : ''}" data-filter="python">Python (${scripts.filter(s => s.type === 'python').length})</div>
                <div class="tab ${filter === 'compose' ? 'active' : ''}" data-filter="compose">Compose (${scripts.filter(s => s.type === 'compose').length})</div>`;
        } catch (err) {
            tbody.innerHTML = emptyRow(7, '脚本加载失败：' + err.message);
        }
    };

    const openEdit = (script) => {
        editingId = script ? script.id : null;
        root.querySelector('#script-modal-title').textContent = script ? `编辑脚本 · ${script.name}` : '新建脚本';
        root.querySelector('#s-name').value = script ? script.name : '';
        root.querySelector('#s-type').value = script ? script.type : 'shell';
        root.querySelector('#s-desc').value = script ? (script.desc || '') : '';
        root.querySelector('#s-content').value = script ? (script.content || '') : '';
        root.querySelector('#s-lint').textContent = '保存前可先做语法预检';
        // 打开编辑弹窗即把脚本注入 AI 工作台上下文（新建时清空；换页时由 router 自动清空）
        aiPanel.setTarget(script ? {
            kind: 'script',
            name: script.name,
            type: script.type,
            desc: script.desc || '',
            content: script.content || ''
        } : null);
        editModal.classList.add('open');
    };

    root.querySelector('#btn-new-script').addEventListener('click', () => openEdit(null));
    root.querySelector('#btn-refresh-scripts').addEventListener('click', refresh);
    editModal.querySelectorAll('[data-close]').forEach(el =>
        el.addEventListener('click', () => editModal.classList.remove('open')));
    runModal.querySelectorAll('[data-close]').forEach(el =>
        el.addEventListener('click', () => runModal.classList.remove('open')));

    root.querySelector('#script-tabs').addEventListener('click', e => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        filter = tab.dataset.filter;
        refresh();
    });

    root.querySelector('#script-search').addEventListener('input', e => {
        keyword = e.target.value.trim();
        tbody.innerHTML = bodyHtml();
    });

    // 语法预检
    root.querySelector('#btn-lint').addEventListener('click', async () => {
        const res = await api.scripts.lint({
            type: root.querySelector('#s-type').value,
            content: root.querySelector('#s-content').value
        });
        root.querySelector('#s-lint').innerHTML = `<span class="${res.ok ? 'text-success' : 'text-danger'}">${esc(res.message)}</span>`;
    });

    // 保存
    root.querySelector('#script-save').addEventListener('click', async () => {
        const payload = {
            id: editingId || undefined,
            name: root.querySelector('#s-name').value.trim(),
            type: root.querySelector('#s-type').value,
            desc: root.querySelector('#s-desc').value.trim(),
            content: root.querySelector('#s-content').value
        };
        if (!payload.name) { toast('请填写脚本名', 'warn'); return; }
        if (!payload.content.trim()) { toast('脚本内容不能为空', 'warn'); return; }

        const res = await api.scripts.save(payload);
        if (res && res.ok) {
            toast(`脚本已保存（${res.script.version}）`, 'success');
            editModal.classList.remove('open');
            await refresh();
        } else {
            toast((res && res.message) || '保存失败', 'danger');
        }
    });

    /* ---------------- AI 生成 / 优化 ---------------- */

    const openAiModal = (mode) => {
        aiMode = mode;
        aiResult = null;
        root.querySelector('#ai-modal-title').textContent =
            mode === 'optimize' ? 'AI 优化脚本' : 'AI 生成脚本';
        root.querySelector('#ai-requirement').value = '';
        root.querySelector('#ai-result').innerHTML = '';
        root.querySelector('#ai-run').textContent = mode === 'optimize' ? '开始优化' : '生成';
        root.querySelector('#ai-apply').disabled = true;
        aiModal.classList.add('open');
    };

    // 编辑弹窗中的「AI 生成 / 优化」入口
    root.querySelector('#btn-ai-edit').addEventListener('click', () => {
        // 已有内容走优化，否则走生成
        openAiModal(root.querySelector('#s-content').value.trim() ? 'optimize' : 'generate');
    });

    // 需求框内的「优化我的脚本」快捷切换
    root.querySelector('#ai-extra').addEventListener('click', () => {
        openAiModal('optimize');
    });

    const paintAiResult = () => {
        const html = aiResult
            ? `<div class="ai-result">
                <pre class="code-block">${esc(aiResult.script)}</pre>
                ${aiResult.explanation ? `<div class="form-hint">${esc(aiResult.explanation)}</div>` : ''}
               </div>`
            : '';
        root.querySelector('#ai-result').innerHTML = html;
    };

    root.querySelector('#ai-run').addEventListener('click', async () => {
        if (!guardAdmin('使用 AI 生成/优化脚本')) return;
        const req = root.querySelector('#ai-requirement').value.trim();
        const sType = root.querySelector('#s-type').value;
        const btn = root.querySelector('#ai-run');
        btn.disabled = true;
        btn.textContent = 'AI 生成中…';
        root.querySelector('#ai-result').innerHTML = '<div class="empty">正在调用 AI，请稍候...</div>';

        let res;
        if (aiMode === 'optimize') {
            res = await api.ai.script.optimize(
                root.querySelector('#s-name').value.trim(), sType,
                root.querySelector('#s-content').value, req);
        } else {
            if (!req) { toast('请描述脚本需求', 'warn'); btn.disabled = false; btn.textContent = '生成'; return; }
            res = await api.ai.script.generate(req, sType);
        }

        if (res && res.ok) {
            aiResult = res;
            paintAiResult();
            root.querySelector('#ai-apply').disabled = false;
        } else {
            root.querySelector('#ai-result').innerHTML =
                `<div class="alert danger"><span>${esc((res && res.message) || 'AI 请求失败')}</span></div>`;
        }
        btn.disabled = false;
        btn.textContent = aiMode === 'optimize' ? '开始优化' : '生成';
    });

    // 应用到编辑器：覆盖脚本内容（保留脚本名/类型）
    root.querySelector('#ai-apply').addEventListener('click', () => {
        if (!aiResult) return;
        root.querySelector('#s-content').value = aiResult.script;
        aiModal.classList.remove('open');
        toast('AI 结果已应用到编辑器', 'success');
    });

    aiModal.querySelectorAll('[data-close]').forEach(el =>
        el.addEventListener('click', () => aiModal.classList.remove('open')));

    // 行内操作
    tbody.addEventListener('click', async e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.closest('tr').dataset.id;
        const script = scripts.find(s => s.id === id);
        if (btn.dataset.act === 'edit') {
            const detail = await api.scripts.detail(id);
            openEdit(detail || script);
        } else if (btn.dataset.act === 'delete') {
            if (!confirm(`确认删除脚本 ${script.name}？`)) return;
            const res = await api.scripts.remove(id);
            if (res && res.ok) { toast('脚本已删除', 'success'); await refresh(); }
            else toast('删除失败', 'danger');
        } else if (btn.dataset.act === 'run') {
            if (script.type === 'compose') {
                toast('compose 文件请到「服务器运维 → 容器运维」页执行编排', 'info');
                return;
            }
            runningScript = script;
            root.querySelector('#run-title').textContent = `执行脚本 · ${script.name}`;
            root.querySelector('#run-result').innerHTML = '';
            if (!hosts.length) {
                try { hosts = await api.hosts.list(); } catch (err) { hosts = []; }
            }
            root.querySelector('#run-grid').innerHTML = hosts.length ? hosts.map(h => `
                <label class="check-item">
                    <input type="checkbox" data-host="${esc(h.id)}">
                    <span><strong>${esc(h.name)}</strong><br><span class="mono muted">${esc(h.ip)}</span></span>
                </label>`).join('') : '<div class="empty">暂无主机</div>';
            const updateRunCount = () => {
                root.querySelector('#run-count').textContent = root.querySelectorAll('#run-grid input:checked').length;
                root.querySelectorAll('#run-grid .check-item').forEach(item =>
                    item.classList.toggle('checked', item.querySelector('input').checked));
            };
            root.querySelector('#run-grid').onchange = updateRunCount;
            updateRunCount();
            runModal.classList.add('open');
        }
    });

    // 执行脚本
    root.querySelector('#run-submit').addEventListener('click', async () => {
        const hostIds = [...root.querySelectorAll('#run-grid input:checked')].map(i => i.dataset.host);
        if (!hostIds.length) { toast('请选择目标主机', 'warn'); return; }

        const btn = root.querySelector('#run-submit');
        btn.disabled = true;
        btn.textContent = '执行中...';
        root.querySelector('#run-result').innerHTML = '<div class="alert info">正在下发脚本并等待结果...</div>';

        const res = await api.scripts.run({
            id: runningScript.id, hostIds,
            concurrency: parseInt(root.querySelector('#run-concurrency').value, 10) || 10,
            timeout: parseInt(root.querySelector('#run-timeout').value, 10) || 60
        });

        if (res && res.blocked) {
            root.querySelector('#run-result').innerHTML = `<div class="alert danger">${esc(res.message)}</div>`;
        } else if (res && res.ok) {
            const t = res.task;
            root.querySelector('#run-result').innerHTML = `
                <div class="alert ${t.status === 'success' ? 'success' : 'warn'}">
                    ${esc(t.id)} 执行完成：成功 ${esc(t.successCount)} · 失败 ${esc(t.failedCount)}（详见「任务执行」）
                </div>`;
            toast('脚本执行完成', t.status === 'success' ? 'success' : 'warn');
        } else {
            root.querySelector('#run-result').innerHTML = `<div class="alert danger">${esc((res && res.message) || '执行失败')}</div>`;
        }

        btn.disabled = false;
        btn.textContent = '执行';
    });

    await refresh();
    applyReadonly(root);
}
