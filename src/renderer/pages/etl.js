/**
 * 数据集成（ETL）· 独立页面 · 类 Kettle 的库对库 / 文件对库 / 库对文件
 *
 * 四步向导：
 *   ① 选择源（数据库表 / 查询 / CSV|JSON|SQL|Excel 文件 / 粘贴文本）
 *   ② 选择目标（数据库表：追加 / UPSERT / REPLACE；或导出为文件）
 *   ③ 字段映射（源列 → 转换规则 → 目标列，支持常量字段与默认值）
 *   ④ 试运行 / 执行（进度条 + 统计 + 错误明细），可保存为任务复用
 *
 * 与主进程 main/etl.js 对应；大文件内容不经过渲染进程，只回传解析出的列与样例行。
 * 数据源清单自行拉取（api.dbConfig.list），不再依赖 SQL 工作台注入。
 */
import { api, demoMode } from '../api.js';
import { esc, toast, demoBanner, guardAdmin, applyReadonly } from '../ui.js';

const TRANSFORMS = [
    { value: 'none', label: '直接写入' },
    { value: 'trim', label: '去首尾空格' },
    { value: 'upper', label: '转大写' },
    { value: 'lower', label: '转小写' },
    { value: 'string', label: '转文本' },
    { value: 'integer', label: '转整数' },
    { value: 'number', label: '转数值' },
    { value: 'boolean', label: '转布尔' },
    { value: 'date', label: '转日期时间' },
    { value: 'const', label: '固定值' }
];

const TYPE_BADGE = { integer: 'blue', number: 'blue', boolean: 'purple', datetime: 'amber', string: 'gray', empty: 'gray' };
const TYPE_TEXT = { integer: '整数', number: '数值', boolean: '布尔', datetime: '日期', string: '文本', empty: '空' };

const MODE_HINT = {
    insert: '追加写入；主键/唯一键冲突时该批失败',
    upsert: 'MySQL：冲突时更新非键列（Oracle 暂不支持）',
    replace: 'MySQL：REPLACE INTO，冲突时先删后插（Oracle 暂不支持）'
};

let el = {};
let sources = [];        // 数据源清单（mount 时拉取）
let unsubProgress = null;

const state = {
    step: 1,
    source: { kind: 'db', sourceId: '', mode: 'table', table: '', sql: '', columns: '', where: '', filePath: '', fileName: '', format: 'csv', hasHeader: true, content: '', delimiter: '' },
    target: { kind: 'db', sourceId: '', table: '', mode: 'insert', keyColumns: '', clearFirst: false, format: 'csv', filePath: '' },
    mapping: [],
    options: { limit: 50000, batchSize: 500, emptyAsNull: true, stopOnError: true },
    preview: null,          // { columns:[{name,type}], sample:[], total }
    targetColumns: [],      // [{name,type,key}]
    taskId: null,
    running: false
};

const typeBadge = t => `<span class="badge ${TYPE_BADGE[t] || 'gray'}" style="font-size:10.5px;padding:0 6px">${esc(TYPE_TEXT[t] || '文本')}</span>`;

/* ------------------------------------------------------------------
 * 视图骨架
 * ------------------------------------------------------------------ */

export function render() {
    return `
    ${demoBanner(demoMode)}
    <div class="card etl-page">
        <div class="card-header">
            <div>
                <div class="card-title">数据集成向导</div>
                <div class="card-desc">库对库 / 文件对库 / 库对文件 · 大文件仅在主进程解析 · 执行与任务保存仅系统管理员可操作</div>
            </div>
            <div class="etl-head-actions">
                <select class="select" id="etl-task-list" title="加载已保存的任务"></select>
                <button class="btn btn-ghost btn-sm" id="etl-task-save" data-write>保存为任务</button>
                <button class="btn btn-ghost btn-sm" id="etl-task-del" data-write>删除</button>
            </div>
        </div>

        <div class="etl-steps" id="etl-steps">
            <div class="etl-step active" data-step="1"><i>1</i><span>选择源</span></div>
            <div class="etl-step" data-step="2"><i>2</i><span>选择目标</span></div>
            <div class="etl-step" data-step="3"><i>3</i><span>字段映射</span></div>
            <div class="etl-step" data-step="4"><i>4</i><span>试运行 / 执行</span></div>
        </div>

        <div class="etl-body etl-page-body">
                <!-- ① 源 -->
                <div class="etl-pane" data-pane="1">
                    <div class="form-row">
                        <div class="form-item">
                            <label>源类型</label>
                            <select class="select" id="etl-src-kind">
                                <option value="db">数据库表 / 自定义查询</option>
                                <option value="file">文件（CSV / JSON / SQL 脚本 / Excel）</option>
                                <option value="text">粘贴文本</option>
                            </select>
                        </div>
                        <div class="form-item" id="etl-src-source-wrap">
                            <label>源数据源</label>
                            <select class="select" id="etl-src-source"></select>
                        </div>
                    </div>

                    <div id="etl-src-db">
                        <div class="form-row">
                            <div class="form-item">
                                <label>读取方式</label>
                                <select class="select" id="etl-src-mode">
                                    <option value="table">整表读取</option>
                                    <option value="sql">自定义查询</option>
                                </select>
                            </div>
                            <div class="form-item" id="etl-src-table-wrap">
                                <label>源表</label>
                                <select class="select" id="etl-src-table"></select>
                            </div>
                        </div>
                        <div class="form-item" id="etl-src-sql-wrap" style="display:none">
                            <label>只读查询 SQL</label>
                            <textarea class="textarea code-input" id="etl-src-sql" rows="4" spellcheck="false"
                                placeholder="SELECT id, host_name, status FROM app_host WHERE status = 'online'"></textarea>
                            <div class="form-hint">仅支持 SELECT / SHOW / DESC / EXPLAIN / WITH，不支持多语句</div>
                        </div>
                        <div class="form-row">
                            <div class="form-item">
                                <label>读取列（可选，逗号分隔，留空 = 全部）</label>
                                <input class="input mono" id="etl-src-cols" placeholder="id,host_name,status">
                            </div>
                            <div class="form-item">
                                <label>WHERE 条件（可选，不含关键字）</label>
                                <input class="input mono" id="etl-src-where" placeholder="status = 'online'">
                            </div>
                        </div>
                    </div>

                    <div id="etl-src-file" style="display:none">
                        <div class="toolbar">
                            <button class="btn btn-ghost" id="etl-pick-file" data-write>选择文件…</button>
                            <span class="muted" id="etl-file-info" style="font-size:12.5px">支持 CSV / TSV、JSON、INSERT 脚本、Excel</span>
                            <div class="spacer"></div>
                            <label class="check-item" style="padding:6px 10px">
                                <input type="checkbox" id="etl-has-header" checked>
                                <div><strong style="font-size:12.5px">首行是表头</strong></div>
                            </label>
                        </div>
                    </div>

                    <div id="etl-src-text" style="display:none">
                        <div class="form-row">
                            <div class="form-item">
                                <label>文本格式</label>
                                <select class="select" id="etl-text-format">
                                    <option value="csv">CSV / TSV</option>
                                    <option value="json">JSON</option>
                                </select>
                            </div>
                            <div class="form-item">
                                <label>分隔符（留空自动探测）</label>
                                <input class="input mono" id="etl-text-delim" maxlength="1" placeholder=",">
                            </div>
                        </div>
                        <div class="form-item">
                            <label>粘贴数据</label>
                            <textarea class="textarea code-input" id="etl-src-text-content" rows="6" spellcheck="false"
                                placeholder="id,name,status&#10;1,app-server-01,online&#10;2,db-server-01,online"></textarea>
                        </div>
                    </div>

                    <div class="toolbar">
                        <button class="btn btn-primary" id="etl-load-source" data-write>读取并预览</button>
                        <span class="muted" id="etl-src-status" style="font-size:12px"></span>
                    </div>
                    <div id="etl-src-preview"></div>
                </div>

                <!-- ② 目标 -->
                <div class="etl-pane" data-pane="2" style="display:none">
                    <div class="form-row">
                        <div class="form-item">
                            <label>目标类型</label>
                            <select class="select" id="etl-tgt-kind">
                                <option value="db">数据库表（写入）</option>
                                <option value="file">文件（导出）</option>
                            </select>
                        </div>
                        <div class="form-item" id="etl-tgt-source-wrap">
                            <label>目标数据源</label>
                            <select class="select" id="etl-tgt-source"></select>
                        </div>
                    </div>

                    <div id="etl-tgt-db">
                        <div class="form-item">
                            <label>目标表</label>
                            <select class="select" id="etl-tgt-table"></select>
                        </div>
                        <div class="form-row">
                            <div class="form-item">
                                <label>写入模式</label>
                                <select class="select" id="etl-tgt-mode">
                                    <option value="insert">追加 INSERT</option>
                                    <option value="upsert">更新插入 UPSERT</option>
                                    <option value="replace">替换 REPLACE</option>
                                </select>
                            </div>
                            <div class="form-item">
                                <label>主键 / 唯一键列（UPSERT 判断用，逗号分隔）</label>
                                <input class="input mono" id="etl-key-cols" placeholder="id">
                            </div>
                        </div>
                        <div class="form-hint" id="etl-mode-hint"></div>
                        <label class="check-item danger" style="margin-top:10px">
                            <input type="checkbox" id="etl-clear-first">
                            <div><strong>执行前清空目标表（DELETE）</strong>
                                <span class="muted" style="font-size:11.5px">危险且不可恢复，执行前会再次确认</span></div>
                        </label>
                    </div>

                    <div id="etl-tgt-file" style="display:none">
                        <div class="form-row">
                            <div class="form-item">
                                <label>导出格式</label>
                                <select class="select" id="etl-tgt-format">
                                    <option value="csv">CSV（带 BOM，Excel 可直接打开）</option>
                                    <option value="json">JSON（对象数组）</option>
                                    <option value="sql">SQL（INSERT 脚本）</option>
                                    <option value="xlsx">Excel 工作簿（需 npm install xlsx）</option>
                                </select>
                            </div>
                            <div class="form-item">
                                <label>输出文件</label>
                                <div class="toolbar" style="margin:0">
                                    <input class="input mono" id="etl-tgt-path" readonly placeholder="点击右侧选择保存位置" style="flex:1">
                                    <button class="btn btn-ghost" id="etl-pick-save" data-write>选择…</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="toolbar">
                        <button class="btn btn-primary" id="etl-load-target" data-write>读取目标结构</button>
                        <span class="muted" id="etl-tgt-status" style="font-size:12px"></span>
                    </div>
                    <div id="etl-tgt-preview"></div>
                </div>

                <!-- ③ 字段映射 -->
                <div class="etl-pane" data-pane="3" style="display:none">
                    <div class="toolbar">
                        <button class="btn btn-ghost" id="etl-auto-map">同名自动匹配</button>
                        <button class="btn btn-ghost" id="etl-add-map">+ 添加映射</button>
                        <button class="btn btn-ghost" id="etl-add-const">+ 常量字段</button>
                        <div class="spacer"></div>
                        <span class="muted" id="etl-map-status" style="font-size:12px"></span>
                    </div>
                    <div class="etl-map-head">
                        <span>源字段</span><span>转换规则</span><span>目标字段 / 默认值</span><span></span>
                    </div>
                    <div id="etl-mapping"><div class="empty">请先在上一步「读取并预览」源数据</div></div>
                    <div id="etl-map-warn"></div>
                </div>

                <!-- ④ 执行 -->
                <div class="etl-pane" data-pane="4" style="display:none">
                    <div class="form-row">
                        <div class="form-item">
                            <label>最大行数</label>
                            <input class="input" id="etl-limit" type="number" min="1" max="1000000" value="50000">
                        </div>
                        <div class="form-item">
                            <label>每批行数</label>
                            <input class="input" id="etl-batch" type="number" min="1" value="500">
                        </div>
                        <div class="form-item">
                            <label>失败处理</label>
                            <select class="select" id="etl-stop-on-error">
                                <option value="true">遇错停止</option>
                                <option value="false">跳过错误继续</option>
                            </select>
                        </div>
                    </div>
                    <label class="check-item">
                        <input type="checkbox" id="etl-empty-null" checked>
                        <div><strong>空字符串按 NULL 写入</strong>
                            <span class="muted" style="font-size:11.5px">关闭后空串原样写入（可能触发非空校验失败）</span></div>
                    </label>

                    <div class="toolbar">
                        <button class="btn btn-ghost" id="etl-dry" data-write>试运行</button>
                        <button class="btn btn-primary" id="etl-run" data-write>开始执行</button>
                        <span class="muted" id="etl-run-status" style="font-size:12px"></span>
                        <div class="spacer"></div>
                        <button class="btn btn-ghost btn-sm" id="etl-runs-toggle">执行记录</button>
                    </div>

                    <div class="etl-progress" id="etl-progress" style="display:none">
                        <div class="etl-progress-bar"><i id="etl-progress-fill"></i></div>
                        <span class="muted" id="etl-progress-text" style="font-size:12px"></span>
                    </div>

                    <div id="etl-result"></div>
                    <div id="etl-runs-panel" style="display:none"></div>
                </div>
            </div>

        <div class="etl-page-foot">
            <button class="btn btn-ghost" id="etl-prev">上一步</button>
            <button class="btn btn-primary" id="etl-next">下一步</button>
            <div class="spacer"></div>
            <span class="muted" id="etl-foot-status" style="font-size:12px"></span>
        </div>
    </div>`;
}

/* ------------------------------------------------------------------
 * 步骤切换
 * ------------------------------------------------------------------ */

function goStep(step) {
    const next = Math.min(Math.max(step, 1), 4);
    state.step = next;
    el.panes.forEach(pane => { pane.style.display = Number(pane.dataset.pane) === next ? '' : 'none'; });
    el.steps.forEach(node => {
        const n = Number(node.dataset.step);
        node.classList.toggle('active', n === next);
        node.classList.toggle('done', n < next);
    });
    el.prev.disabled = next === 1;
    el.next.disabled = next === 4;
    if (next === 3) paintMapping();
    if (next === 4) paintPlanSummary();
}

function footStatus(text) {
    if (el.footStatus) el.footStatus.textContent = text || '';
}

/* ------------------------------------------------------------------
 * 数据源 / 表清单
 * ------------------------------------------------------------------ */

function fillSources() {
    const options = sources.length
        ? sources.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')
        : '<option value="">暂无可用数据源</option>';
    el.srcSource.innerHTML = options;
    el.tgtSource.innerHTML = options;
    if (state.source.sourceId) el.srcSource.value = state.source.sourceId;
    if (state.target.sourceId) el.tgtSource.value = state.target.sourceId;
}

async function loadSources() {
    try {
        const all = await api.dbConfig.list();
        sources = Array.isArray(all) ? all : [];
    } catch (err) {
        sources = [];
    }
    fillSources();
}

async function loadTables(which) {
    const isSource = which === 'source';
    const sourceId = isSource ? el.srcSource.value : el.tgtSource.value;
    const selectEl = isSource ? el.srcTable : el.tgtTable;
    if (!sourceId) {
        selectEl.innerHTML = '<option value="">请选择数据源</option>';
        return;
    }
    try {
        const res = await api.sql.tables(sourceId);
        const tables = (res && res.ok) ? (res.tables || []) : [];
        selectEl.innerHTML = tables.length
            ? tables.map(t => `<option value="${esc(t.name)}">${esc(t.name)}${t.comment ? ' · ' + esc(t.comment) : ''}</option>`).join('')
            : '<option value="">（无表）</option>';
        if (isSource) state.source.table = selectEl.value;
        else state.target.table = selectEl.value;
        if (!res || !res.ok) toast((res && res.message) || '表清单加载失败', 'warn');
    } catch (err) {
        toast('表清单加载失败：' + err.message, 'warn');
    }
}

/* ------------------------------------------------------------------
 * 源 / 目标配置读写
 * ------------------------------------------------------------------ */

function syncSourceFromDom() {
    const kind = el.srcKind.value;
    state.source.kind = kind;
    state.source.sourceId = el.srcSource.value;
    state.source.filePath = state.source.filePath || '';
    state.source.hasHeader = el.hasHeader.checked;
    state.source.content = el.textContent.value;
    state.source.delimiter = el.textDelim.value.trim();
    state.source.format = kind === 'file'
        ? (state.source.format || 'csv')
        : (el.textFormat.value || 'csv');
    if (kind === 'db') {
        state.source.mode = el.srcMode.value;
        state.source.table = el.srcTable.value;
        state.source.sql = el.srcSql.value;
        state.source.columns = el.srcCols.value;
        state.source.where = el.srcWhere.value;
    }
}

function syncTargetFromDom() {
    state.target.kind = el.tgtKind.value;
    state.target.sourceId = el.tgtSource.value;
    state.target.table = el.tgtTable.value;
    state.target.mode = el.tgtMode.value;
    state.target.keyColumns = el.keyCols.value;
    state.target.clearFirst = el.clearFirst.checked;
    state.target.format = el.tgtFormat.value;
    state.options.limit = Number(el.limit.value) || 50000;
    state.options.batchSize = Number(el.batch.value) || 500;
    state.options.emptyAsNull = el.emptyNull.checked;
    state.options.stopOnError = el.stopOnError.value === 'true';
}

function paintKindVisibility() {
    const kind = el.srcKind.value;
    el.srcDb.style.display = kind === 'db' ? '' : 'none';
    el.srcFile.style.display = kind === 'file' ? '' : 'none';
    el.srcText.style.display = kind === 'text' ? '' : 'none';
    el.srcSourceWrap.style.display = kind === 'db' ? '' : 'none';

    const isSql = el.srcMode.value === 'sql';
    el.srcSqlWrap.style.display = isSql ? '' : 'none';
    el.srcTableWrap.style.display = isSql ? 'none' : '';

    const tgtKind = el.tgtKind.value;
    el.tgtDb.style.display = tgtKind === 'db' ? '' : 'none';
    el.tgtFile.style.display = tgtKind === 'file' ? '' : 'none';
    el.tgtSourceWrap.style.display = tgtKind === 'db' ? '' : 'none';
    el.modeHint.textContent = MODE_HINT[el.tgtMode.value] || '';
}

/* ------------------------------------------------------------------
 * 源预览
 * ------------------------------------------------------------------ */

function paintSourcePreview() {
    const preview = state.preview;
    if (!preview) { el.srcPreview.innerHTML = ''; return; }
    const head = `<div class="etl-preview-head">
        <strong>源字段 ${esc(preview.columns.length)} 个</strong>
        <span class="muted">共 ${esc(preview.total === null || preview.total === undefined ? '未知' : preview.total)} 行 · 以下为样例 ${esc(preview.sample.length)} 行</span>
    </div>`;
    const cols = `<div class="etl-col-chips">${preview.columns.map(c =>
        `<span class="etl-col-chip">${esc(c.name)} ${typeBadge(c.type)}</span>`).join('')}</div>`;
    const rows = preview.sample.length
        ? `<div class="table-wrap" style="max-height:220px;overflow:auto;margin-top:10px">
            <table class="table"><thead><tr><th>#</th>${preview.columns.map(c => `<th class="mono">${esc(c.name)}</th>`).join('')}</tr></thead>
            <tbody>${preview.sample.slice(0, 10).map((r, i) => `<tr><td class="muted">${i + 1}</td>${preview.columns.map(c => {
            const v = r[c.name];
            const text = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
            return `<td class="mono" style="max-width:220px;word-break:break-all">${esc(text)}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">未取到样例数据</div>';
    const warn = (preview.warnings || []).length
        ? `<div class="alert warn" style="margin-top:10px"><span>${preview.warnings.map(esc).join('<br>')}</span></div>`
        : '';
    el.srcPreview.innerHTML = head + cols + rows + warn;
}

async function readSource() {
    if (!guardAdmin('读取源数据')) return;
    syncSourceFromDom();
    if (state.source.kind === 'db' && !state.source.sourceId) { toast('请选择源数据源', 'warn'); return; }
    if (state.source.kind === 'file' && !state.source.filePath) { toast('请先选择源文件', 'warn'); return; }
    if (state.source.kind === 'text' && !state.source.content.trim()) { toast('请粘贴要解析的数据', 'warn'); return; }

    el.srcStatus.textContent = '正在读取...';
    try {
        const res = await api.etl.preview(sourcePayload(), targetPayload());
        if (!res || !res.ok) {
            el.srcStatus.textContent = (res && res.message) || '读取失败';
            toast((res && res.message) || '读取失败', 'danger');
            return;
        }
        state.preview = res;
        if (Array.isArray(res.targetColumns) && res.targetColumns.length) state.targetColumns = res.targetColumns;
        paintSourcePreview();
        // 首次读取源后自动生成映射
        if (!state.mapping.length) autoMap(false);
        el.srcStatus.textContent = `已读取 ${res.total === null || res.total === undefined ? '未知' : res.total} 行 · ${res.columns.length} 列`;
        footStatus(`源：${res.columns.length} 列 / ${res.total === null || res.total === undefined ? '未知' : res.total} 行`);
        toast('源数据已就绪', 'success');
    } catch (err) {
        el.srcStatus.textContent = '读取失败：' + err.message;
        toast('读取失败：' + err.message, 'danger');
    }
}

async function readTarget() {
    if (!guardAdmin('读取目标结构')) return;
    syncTargetFromDom();
    if (state.target.kind !== 'db') { toast('目标为文件时无需读取表结构', 'info'); return; }
    if (!state.target.sourceId || !state.target.table) { toast('请选择目标数据源与表', 'warn'); return; }

    el.tgtStatus.textContent = '正在读取表结构...';
    try {
        const res = await api.etl.preview(sourcePayload(), targetPayload());
        if (!res || !res.ok) {
            el.tgtStatus.textContent = (res && res.message) || '读取失败';
            return;
        }
        if (Array.isArray(res.targetColumns)) state.targetColumns = res.targetColumns;
        const cols = state.targetColumns || [];
        el.tgtPreview.innerHTML = cols.length
            ? `<div class="etl-col-chips" style="margin-top:10px">${cols.map(c =>
                `<span class="etl-col-chip">${esc(c.name)} <span class="muted">${esc(c.type || '')}</span>${c.key === 'PRI' ? ' <span class="badge amber" style="font-size:10px;padding:0 4px">PK</span>' : ''}</span>`).join('')}</div>`
            : '<div class="empty">未读取到目标表结构</div>';
        el.tgtStatus.textContent = `目标表 ${state.target.table} · ${cols.length} 列`;
        autoMap(false);
    } catch (err) {
        el.tgtStatus.textContent = '读取失败：' + err.message;
    }
}

function sourcePayload() {
    const s = state.source;
    if (s.kind === 'db') {
        return {
            kind: 'db', sourceId: s.sourceId,
            sql: s.mode === 'sql' ? s.sql : '',
            table: s.mode === 'sql' ? '' : s.table,
            columns: s.mode === 'sql' ? '' : s.columns,
            where: s.mode === 'sql' ? '' : s.where
        };
    }
    if (s.kind === 'file') {
        return { kind: 'file', filePath: s.filePath, format: s.format, hasHeader: s.hasHeader };
    }
    return { kind: 'text', content: s.content, format: s.format || 'csv', hasHeader: s.hasHeader, delimiter: s.delimiter || undefined };
}

function targetPayload() {
    const t = state.target;
    if (t.kind !== 'db') return null;
    return { kind: 'db', sourceId: t.sourceId, table: t.table };
}

/* ------------------------------------------------------------------
 * 字段映射
 * ------------------------------------------------------------------ */

const sampleValueOf = name => {
    if (!state.preview || !state.preview.sample) return '';
    const row = state.preview.sample.find(r => r[name] !== null && r[name] !== undefined && String(r[name]) !== '');
    const v = row ? row[name] : null;
    if (v === null) return '';
    return (typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 22);
};

/** 收集 DOM 上的映射改动（重绘前调用） */
function collectMapping() {
    if (!el.mapping.querySelector('.etl-map-row')) return;
    const rows = [];
    el.mapping.querySelectorAll('.etl-map-row').forEach(row => {
        const fromEl = row.querySelector('.etl-m-from');
        const trEl = row.querySelector('.etl-m-transform');
        const toEl = row.querySelector('.etl-m-to');
        const defEl = row.querySelector('.etl-m-default');
        const transform = trEl ? trEl.value : 'none';
        rows.push({
            from: transform === 'const' ? null : (fromEl ? fromEl.value || null : null),
            to: toEl ? (toEl.value || '') : '',
            transform,
            default: defEl && defEl.value !== '' ? defEl.value : undefined
        });
    });
    if (rows.length) state.mapping = rows;
}

function autoMap(notify = true) {
    const srcCols = (state.preview && state.preview.columns) || [];
    if (!srcCols.length) { if (notify) toast('请先读取源数据', 'warn'); return; }
    const normalize = s => String(s || '').toLowerCase().replace(/[_\s-]/g, '');
    const tgtCols = state.target.kind === 'db' ? state.targetColumns : null;
    // 库目标：按列名匹配（匹配不上的留空由用户指定）；文件目标：同名输出
    state.mapping = srcCols.map(col => {
        const hit = (tgtCols || []).find(c => normalize(c.name) === normalize(col.name));
        return {
            from: col.name,
            to: tgtCols ? (hit ? hit.name : '') : col.name,
            transform: suggestTransform(col.type),
            default: undefined
        };
    });
    paintMapping();
    if (notify) toast('已按列名自动匹配', 'success');
}

/** 目标名清单（库目标取表结构；文件目标取当前映射中的输出列） */
function targetNames() {
    if (state.target.kind === 'db') return (state.targetColumns || []).map(c => c.name);
    return [...new Set(state.mapping.map(m => m.to).filter(Boolean))];
}

/** 依源字段类型给出建议转换（整数/数值/日期自动带转，便于跨库类型差异） */
const suggestTransform = type => {
    if (type === 'integer') return 'integer';
    if (type === 'number') return 'number';
    if (type === 'datetime') return 'date';
    return 'none';
};

function paintMapping() {
    const srcCols = (state.preview && state.preview.columns) || [];
    if (!srcCols.length) {
        el.mapping.innerHTML = '<div class="empty">请先在第 ① 步「读取并预览」源数据</div>';
        return;
    }
    const isDbTarget = state.target.kind === 'db';
    const dbTargets = targetNames();

    el.mapping.innerHTML = state.mapping.map((m, idx) => {
        const isConst = m.transform === 'const';
        const fromOptions = srcCols.map(c =>
            `<option value="${esc(c.name)}"${!isConst && c.name === m.from ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
        const toControl = isDbTarget
            ? `<select class="select etl-m-to">
                   <option value="">（不写入）</option>
                   ${dbTargets.map(n => `<option value="${esc(n)}"${n === m.to ? ' selected' : ''}>${esc(n)}</option>`).join('')}
                   ${m.to && !dbTargets.includes(m.to) ? `<option value="${esc(m.to)}" selected>${esc(m.to)}（表中无此列）</option>` : ''}
               </select>`
            : `<input class="input mono etl-m-to" value="${esc(m.to || '')}" placeholder="输出列名">`;

        return `
        <div class="etl-map-row" data-idx="${idx}">
            <div class="etl-map-cell">
                ${isConst
                ? '<span class="badge purple" style="font-size:11px">常量</span>'
                : `<select class="select etl-m-from">${fromOptions}</select>
                       <span class="muted mono etl-map-sample">${esc(sampleValueOf(m.from))}</span>`}
            </div>
            <div class="etl-map-cell">
                <select class="select etl-m-transform">
                    ${TRANSFORMS.map(t => `<option value="${t.value}"${t.value === m.transform ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}
                </select>
            </div>
            <div class="etl-map-cell">
                ${toControl}
                <input class="input mono etl-m-default" value="${esc(m.default === undefined || m.default === null ? '' : m.default)}"
                       placeholder="${isConst ? '固定值' : '默认值(可空)'}">
            </div>
            <div class="etl-map-cell etl-map-ops">
                <button class="btn-link danger etl-m-del" title="删除该映射">×</button>
            </div>
        </div>`;
    }).join('');

    const mapped = state.mapping.filter(m => m.to).length;
    el.mapStatus.textContent = `${mapped} / ${state.mapping.length} 个字段已映射`;
    const warn = [];
    if (!mapped) warn.push('尚未映射任何字段');
    if (isDbTarget) {
        state.mapping.filter(m => m.to).forEach(m => {
            if (dbTargets.length && !dbTargets.includes(m.to)) warn.push(`目标表可能不存在列「${m.to}」`);
        });
        const used = state.mapping.filter(m => m.to).map(m => m.to);
        const dup = [...new Set(used.filter((v, i) => used.indexOf(v) !== i))];
        if (dup.length) warn.push('目标列重复映射：' + dup.join('、'));
    }
    el.mapWarn.innerHTML = warn.length
        ? `<div class="alert warn" style="margin-top:12px"><span>${warn.map(esc).join('<br>')}</span></div>`
        : '';
}

/* ------------------------------------------------------------------
 * 试运行 / 执行
 * ------------------------------------------------------------------ */

const isDbTarget = () => state.target.kind === 'db';

function buildTask() {
    syncSourceFromDom();
    syncTargetFromDom();
    collectMapping();
    return {
        name: state.taskName || null,
        source: sourcePayload(),
        target: isDbTarget()
            ? { kind: 'db', sourceId: state.target.sourceId, table: state.target.table, mode: state.target.mode, keyColumns: (state.target.keyColumns || '').split(',').map(s => s.trim()).filter(Boolean) }
            : { kind: 'file', format: state.target.format, filePath: state.target.filePath },
        mapping: state.mapping.filter(m => m.to),
        options: {
            limit: state.options.limit,
            batchSize: state.options.batchSize,
            mode: state.target.mode,
            keyColumns: (state.target.keyColumns || '').split(',').map(s => s.trim()).filter(Boolean),
            clearFirst: state.target.clearFirst,
            emptyAsNull: state.options.emptyAsNull,
            stopOnError: state.options.stopOnError
        }
    };
}

function paintPlanSummary() {
    const srcCols = (state.preview && state.preview.columns) || [];
    const mapped = state.mapping.filter(m => m.to).length;
    const targetDesc = isDbTarget()
        ? `库表 ${state.target.table || '未选'}（${state.target.mode}）`
        : `文件 ${state.target.format.toUpperCase()}${state.target.filePath ? ' · ' + state.target.filePath : '（执行时选择）'}`;
    el.runStatus.textContent = `源 ${srcCols.length} 列 → 目标 ${mapped} 列 · ${targetDesc}`;
}

async function dryRun() {
    if (!guardAdmin('试运行')) return;
    const task = buildTask();
    if (!validateBeforeRun(task)) return;
    el.dry.disabled = true;
    const old = el.dry.textContent;
    el.dry.textContent = '校验中...';
    try {
        const res = await api.etl.run({ ...task, options: { ...task.options, dryRun: true } });
        if (res && res.ok && res.dryRun) {
            el.result.innerHTML = `<div class="alert info" style="margin-top:12px">
                <span><strong>试运行通过</strong>：计划处理 ${esc(res.plannedRows)} 行 / ${esc(res.plannedBatches)} 批 ·
                目标 ${res.targetKind === 'db' ? esc(res.targetTable) : esc(res.filePath || '文件')}
                ${res.modeLabel ? '（' + esc(res.modeLabel) + '）' : ''}<br>
                ${res.sampleSql ? `<span class="mono" style="font-size:12px">${esc(res.sampleSql)}</span>` : ''}
                ${res.sampleText ? `<span class="mono" style="font-size:12px">${esc(res.sampleText)}</span>` : ''}
                </span></div>
                ${(res.warnings || []).length ? `<div class="alert warn" style="margin-top:10px"><span>${res.warnings.map(esc).join('<br>')}</span></div>` : ''}`;
            toast('试运行通过', 'success');
        } else {
            el.result.innerHTML = `<div class="alert danger" style="margin-top:12px"><span>${esc((res && res.message) || '试运行失败')}</span></div>`;
            toast((res && res.message) || '试运行失败', 'danger');
        }
    } catch (err) {
        el.result.innerHTML = `<div class="alert danger" style="margin-top:12px"><span>${esc(err.message)}</span></div>`;
    } finally {
        el.dry.disabled = false;
        el.dry.textContent = old;
    }
}

function validateBeforeRun(task) {
    if (!(state.preview && state.preview.columns.length)) { toast('请先在第 ① 步读取源数据', 'warn'); goStep(1); return false; }
    if (!task.mapping.length) { toast('请在第 ③ 步配置字段映射', 'warn'); goStep(3); return false; }
    if (task.target.kind === 'db') {
        if (!task.target.sourceId || !task.target.table) { toast('请在第 ② 步选择目标数据源与表', 'warn'); goStep(2); return false; }
    } else if (!task.target.filePath) {
        toast('请在第 ② 步选择输出文件位置（或执行时再选）', 'info');
    }
    return true;
}

async function runTask() {
    if (state.running) return;
    if (!guardAdmin('执行数据同步')) return;
    const task = buildTask();
    if (!validateBeforeRun(task)) return;
    if (task.options.clearFirst && !confirm(`确认先清空目标表「${task.target.table}」再写入？该操作不可恢复！`)) return;

    state.running = true;
    el.run.disabled = true;
    el.run.textContent = '执行中...';
    el.progress.style.display = '';
    el.progressFill.style.width = '2%';
    el.progressText.textContent = '正在启动任务...';
    el.result.innerHTML = '';

    try {
        const res = await api.etl.run(task);
        paintRunResult(res);
    } catch (err) {
        el.result.innerHTML = `<div class="alert danger" style="margin-top:12px"><span>${esc(err.message)}</span></div>`;
    } finally {
        state.running = false;
        el.run.disabled = false;
        el.run.textContent = '开始执行';
        el.progress.style.display = 'none';
    }
}

function paintRunResult(res) {
    if (res && res.canceled) { el.runStatus.textContent = '已取消'; return; }
    if (!res || (!res.ok && !res.partial)) {
        el.result.innerHTML = `<div class="alert danger" style="margin-top:12px"><span>${esc((res && res.message) || '执行失败')}</span></div>`;
        toast((res && res.message) || '执行失败', 'danger');
        return;
    }
    const ok = !!res.ok;
    el.result.innerHTML = `
        <div class="alert ${ok ? 'success' : 'warn'}" style="margin-top:12px">
            <span>${ok ? '同步完成' : '部分成功'}：读取 <strong>${esc(res.read)}</strong> 行 →
            写入 <strong>${esc(res.written)}</strong> 行，失败 ${esc(res.failed)} 行 ·
            ${esc(res.batches)} 批 · 耗时 ${esc(res.durationMs)} ms
            ${res.filePath ? `<br><span class="mono" style="font-size:12px">${esc(res.filePath)}</span>` : ''}</span>
        </div>
        ${(res.errors || []).length ? `<div class="table-wrap" style="max-height:200px;overflow:auto;margin-top:10px">
            <table class="table"><thead><tr><th>批次</th><th>行数</th><th>失败原因</th></tr></thead>
            <tbody>${res.errors.map(e => `<tr><td>${esc(e.batch)}</td><td>${esc(e.rows)}</td><td class="mono" style="font-size:12px">${esc(e.message)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    toast(ok ? '同步完成' : '部分批次失败，请查看明细', ok ? 'success' : 'warn');
    loadRuns(false);
}

/* ------------------------------------------------------------------
 * 任务库 / 执行记录
 * ------------------------------------------------------------------ */

let tasks = [];

async function loadTasks() {
    try {
        const res = await api.etl.tasks.list();
        tasks = Array.isArray(res) ? res : [];
        el.taskList.innerHTML = '<option value="">— 加载已保存任务 —</option>'
            + tasks.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    } catch (err) {
        tasks = [];
    }
}

function applyTask(task) {
    if (!task) return;
    state.taskId = task.id || null;
    state.taskName = task.name || null;
    state.source = { ...state.source, ...(task.source || {}) };
    state.target = { ...state.target, ...(task.target || {}) };
    state.mapping = (task.mapping || []).map(m => ({ ...m }));
    state.options = { ...state.options, ...(task.options || {}) };

    // 回填表单
    el.srcKind.value = state.source.kind || 'db';
    paintKindVisibility();
    if (state.source.sourceId) el.srcSource.value = state.source.sourceId;
    el.srcMode.value = state.source.mode || 'table';
    el.srcCols.value = state.source.columns || '';
    el.srcWhere.value = state.source.where || '';
    el.srcSql.value = state.source.sql || '';
    el.hasHeader.checked = state.source.hasHeader !== false;
    el.textFormat.value = state.source.format === 'json' ? 'json' : 'csv';
    el.textContent.value = state.source.content || '';
    if (state.source.filePath) {
        el.fileInfo.innerHTML = `<strong>${esc(state.source.fileName || state.source.filePath)}</strong>`;
        el.fileInfo.dataset.path = state.source.filePath;
    }

    el.tgtKind.value = state.target.kind || 'db';
    if (state.target.sourceId) el.tgtSource.value = state.target.sourceId;
    el.tgtMode.value = state.target.mode || 'insert';
    el.keyCols.value = state.target.keyColumns || '';
    el.clearFirst.checked = !!state.target.clearFirst;
    el.tgtFormat.value = state.target.format || 'csv';
    el.tgtPath.value = state.target.filePath || '';
    el.limit.value = state.options.limit || 50000;
    el.batch.value = state.options.batchSize || 500;
    el.emptyNull.checked = state.options.emptyAsNull !== false;
    el.stopOnError.value = state.options.stopOnError === false ? 'false' : 'true';
    paintKindVisibility();

    Promise.all([loadTables('source'), loadTables('target')]).then(() => {
        if (state.source.table) el.srcTable.value = state.source.table;
        if (state.target.table) el.tgtTable.value = state.target.table;
        return api.etl.preview(sourcePayload(), targetPayload());
    }).then(res => {
        if (res && res.ok) {
            state.preview = res;
            if (Array.isArray(res.targetColumns)) state.targetColumns = res.targetColumns;
            paintSourcePreview();
        }
    }).catch(() => { /* 任务可能引用已删除的数据源，静默 */ });

    footStatus(`已加载任务「${task.name}」`);
    toast(`已加载任务「${task.name}」`, 'success');
}

async function saveTask() {
    if (!guardAdmin('保存同步任务')) return;
    syncSourceFromDom();
    syncTargetFromDom();
    collectMapping();
    const name = prompt('任务名称', state.taskName || '未命名同步任务');
    if (!name) return;
    const task = buildTask();
    task.name = name;
    task.id = state.taskId || undefined;
    const res = await api.etl.tasks.save(task);
    if (res && res.ok) {
        state.taskId = res.task.id;
        state.taskName = res.task.name;
        toast('任务已保存', 'success');
        await loadTasks();
        el.taskList.value = res.task.id;
    } else {
        toast((res && res.message) || '保存失败', 'danger');
    }
}

async function loadRuns(show = true) {
    try {
        const runs = await api.etl.runs(20);
        if (!show) return;
        const list = Array.isArray(runs) ? runs : [];
        el.runsPanel.innerHTML = list.length
            ? `<div class="table-wrap" style="margin-top:12px;max-height:240px;overflow:auto">
                <table class="table"><thead><tr><th>时间</th><th>任务</th><th>路径</th><th>模式</th><th>读取</th><th>写入</th><th>失败</th><th>耗时</th><th>操作人</th></tr></thead>
                <tbody>${list.map(r => `<tr>
                    <td class="muted">${esc(r.createdAt || '')}</td>
                    <td>${esc(r.name || '未命名')}</td>
                    <td class="muted">${esc(r.targetKind === 'db' ? (r.targetTable || '-') : (r.fileName || '文件'))}</td>
                    <td>${esc(r.modeLabel || '导出')}</td>
                    <td>${esc(r.read || 0)}</td>
                    <td>${esc(r.written || 0)}</td>
                    <td class="${r.failed ? 'text-danger' : 'muted'}">${esc(r.failed || 0)}</td>
                    <td class="muted">${esc(r.durationMs || 0)} ms</td>
                    <td class="muted">${esc(r.user || '-')}</td>
                </tr>`).join('')}</tbody></table></div>`
            : '<div class="empty">暂无执行记录</div>';
    } catch (err) {
        if (show) el.runsPanel.innerHTML = `<div class="empty">执行记录加载失败：${esc(err.message)}</div>`;
    }
}

/* ------------------------------------------------------------------
 * 挂载
 * ------------------------------------------------------------------ */

export async function mount(root) {
    const q = sel => root.querySelector(sel);
    el = {
        steps: [...root.querySelectorAll('.etl-step')],
        panes: [...root.querySelectorAll('.etl-pane')],
        prev: q('#etl-prev'), next: q('#etl-next'), footStatus: q('#etl-foot-status'),

        srcKind: q('#etl-src-kind'), srcSourceWrap: q('#etl-src-source-wrap'), srcSource: q('#etl-src-source'),
        srcDb: q('#etl-src-db'), srcMode: q('#etl-src-mode'), srcTableWrap: q('#etl-src-table-wrap'), srcTable: q('#etl-src-table'),
        srcSqlWrap: q('#etl-src-sql-wrap'), srcSql: q('#etl-src-sql'), srcCols: q('#etl-src-cols'), srcWhere: q('#etl-src-where'),
        srcFile: q('#etl-src-file'), fileInfo: q('#etl-file-info'), hasHeader: q('#etl-has-header'),
        srcText: q('#etl-src-text'), textFormat: q('#etl-text-format'), textDelim: q('#etl-text-delim'), textContent: q('#etl-src-text-content'),
        srcStatus: q('#etl-src-status'), srcPreview: q('#etl-src-preview'),
        pickFile: q('#etl-pick-file'), loadSource: q('#etl-load-source'),

        tgtKind: q('#etl-tgt-kind'), tgtSourceWrap: q('#etl-tgt-source-wrap'), tgtSource: q('#etl-tgt-source'),
        tgtDb: q('#etl-tgt-db'), tgtTable: q('#etl-tgt-table'), tgtMode: q('#etl-tgt-mode'), keyCols: q('#etl-key-cols'),
        clearFirst: q('#etl-clear-first'), modeHint: q('#etl-mode-hint'),
        tgtFile: q('#etl-tgt-file'), tgtFormat: q('#etl-tgt-format'), tgtPath: q('#etl-tgt-path'), pickSave: q('#etl-pick-save'),
        tgtStatus: q('#etl-tgt-status'), tgtPreview: q('#etl-tgt-preview'), loadTarget: q('#etl-load-target'),

        mapping: q('#etl-mapping'), mapStatus: q('#etl-map-status'), mapWarn: q('#etl-map-warn'),
        autoMapBtn: q('#etl-auto-map'), addMap: q('#etl-add-map'), addConst: q('#etl-add-const'),

        limit: q('#etl-limit'), batch: q('#etl-batch'), emptyNull: q('#etl-empty-null'), stopOnError: q('#etl-stop-on-error'),
        dry: q('#etl-dry'), run: q('#etl-run'), runStatus: q('#etl-run-status'),
        progress: q('#etl-progress'), progressFill: q('#etl-progress-fill'), progressText: q('#etl-progress-text'),
        result: q('#etl-result'), runsPanel: q('#etl-runs-panel'), runsToggle: q('#etl-runs-toggle'),

        taskList: q('#etl-task-list'), taskSave: q('#etl-task-save'), taskDel: q('#etl-task-del')
    };

    await loadSources();
    paintKindVisibility();

    /* 步骤导航 */
    el.steps.forEach(node => node.addEventListener('click', () => {
        syncSourceFromDom(); syncTargetFromDom();
        goStep(Number(node.dataset.step));
    }));
    el.prev.addEventListener('click', () => goStep(state.step - 1));
    el.next.addEventListener('click', () => {
        syncSourceFromDom(); syncTargetFromDom();
        if (state.step === 1 && !state.preview) toast('建议先「读取并预览」源数据', 'info');
        goStep(state.step + 1);
    });

    /* 源配置 */
    el.srcKind.addEventListener('change', () => { paintKindVisibility(); });
    el.srcMode.addEventListener('change', () => { paintKindVisibility(); });
    el.srcSource.addEventListener('change', () => { state.source.sourceId = el.srcSource.value; loadTables('source'); });
    el.srcTable.addEventListener('change', () => { state.source.table = el.srcTable.value; });
    el.hasHeader.addEventListener('change', () => { state.source.hasHeader = el.hasHeader.checked; });
    el.pickFile.addEventListener('click', async () => {
        const res = await api.etl.pickFile('open');
        if (!res || !res.ok) { if (res && !res.canceled) toast(res.message, 'warn'); return; }
        state.source.filePath = res.filePath;
        state.source.fileName = res.fileName;
        if (res.format) state.source.format = res.format;
        el.fileInfo.innerHTML = `<strong>${esc(res.fileName)}</strong> · ${esc((res.format || '').toUpperCase())}`;
        el.fileInfo.dataset.path = res.filePath;
        toast('已选择源文件，点「读取并预览」解析', 'success');
    });
    el.loadSource.addEventListener('click', readSource);

    /* 目标配置 */
    el.tgtKind.addEventListener('change', () => { paintKindVisibility(); });
    el.tgtSource.addEventListener('change', () => { state.target.sourceId = el.tgtSource.value; loadTables('target'); });
    el.tgtTable.addEventListener('change', () => { state.target.table = el.tgtTable.value; state.targetColumns = []; });
    el.tgtMode.addEventListener('change', () => { el.modeHint.textContent = MODE_HINT[el.tgtMode.value] || ''; });
    el.pickSave.addEventListener('click', async () => {
        const res = await api.etl.pickFile('save');
        if (!res || !res.ok) { if (res && !res.canceled) toast(res.message, 'warn'); return; }
        state.target.filePath = res.filePath;
        el.tgtPath.value = res.filePath;
        const ext = (res.fileName.split('.').pop() || '').toLowerCase();
        if (['csv', 'json', 'sql', 'xlsx'].includes(ext)) el.tgtFormat.value = ext;
        toast('已选择输出文件', 'success');
    });
    el.loadTarget.addEventListener('click', readTarget);

    /* 映射操作 */
    el.autoMapBtn.addEventListener('click', () => autoMap(true));
    el.addMap.addEventListener('click', () => {
        collectMapping();
        state.mapping.push({ from: (state.preview && state.preview.columns[0] || {}).name || null, to: '', transform: 'none' });
        paintMapping();
    });
    el.addConst.addEventListener('click', () => {
        collectMapping();
        state.mapping.push({ from: null, to: '', transform: 'const', default: '' });
        paintMapping();
    });
    el.mapping.addEventListener('change', e => {
        const row = e.target.closest('.etl-map-row');
        if (!row) return;
        // 切换为常量时需重绘（源列下拉 ↔ 常量标记）
        if (e.target.classList.contains('etl-m-transform')) {
            collectMapping();
            paintMapping();
            return;
        }
        collectMapping();
        if (e.target.classList.contains('etl-m-to')) paintMapping();
    });
    el.mapping.addEventListener('input', e => {
        if (e.target.classList.contains('etl-m-default')) collectMapping();
    });
    el.mapping.addEventListener('click', e => {
        const del = e.target.closest('.etl-m-del');
        if (!del) return;
        const row = del.closest('.etl-map-row');
        collectMapping();
        state.mapping.splice(Number(row.dataset.idx), 1);
        paintMapping();
    });

    /* 执行 */
    el.dry.addEventListener('click', dryRun);
    el.run.addEventListener('click', runTask);
    el.runsToggle.addEventListener('click', () => {
        const showing = el.runsPanel.style.display !== 'none';
        el.runsPanel.style.display = showing ? 'none' : '';
        if (!showing) loadRuns(true);
    });

    /* 任务库 */
    el.taskList.addEventListener('change', () => {
        const task = tasks.find(t => t.id === el.taskList.value);
        if (task) applyTask(task);
    });
    el.taskSave.addEventListener('click', saveTask);
    el.taskDel.addEventListener('click', async () => {
        const id = el.taskList.value;
        if (!id) { toast('请先选择要删除的任务', 'warn'); return; }
        if (!guardAdmin('删除同步任务')) return;
        const task = tasks.find(t => t.id === id);
        if (!confirm(`确认删除任务「${task ? task.name : id}」？`)) return;
        const res = await api.etl.tasks.remove(id);
        if (res && res.ok) {
            toast('任务已删除', 'success');
            state.taskId = null;
            state.taskName = null;
            await loadTasks();
        } else {
            toast((res && res.message) || '删除失败', 'danger');
        }
    });

    /* 进度订阅（仅一次） */
    if (typeof api.onDataProgress === 'function' && !unsubProgress) {
        unsubProgress = api.onDataProgress(payload => {
            if (!payload || state.running === false) return;
            const { read = 0, written = 0, message } = payload;
            el.progressText.textContent = `${message || ''} · 已读取 ${read} 行 · 已写入 ${written} 行`;
            if (payload.phase === 'done') {
                el.progressFill.style.width = '100%';
            } else {
                const limit = Number(state.options.limit) || 50000;
                const percent = Math.min(98, Math.max(2, Math.round((read / limit) * 100)));
                el.progressFill.style.width = percent + '%';
            }
        });
    }

    await loadTasks();
    await loadRuns(false);
    goStep(1);
    applyReadonly(root);
}
