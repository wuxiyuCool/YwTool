/**
 * 数据集成（ETL）引擎 · 类 Kettle 的库对库 / 文件对库 / 库对文件同步
 * ------------------------------------------------------------------
 * 统一模型：
 *   源（source）× 目标（target）× 字段映射（mapping） = 一次同步任务
 *
 *   源：数据库表 / 自定义查询 / CSV|TSV / JSON / SQL(INSERT 脚本) / Excel / 剪贴文本
 *   目标：数据库表（insert / upsert / replace，可跨库跨类型）/ 文件（导出）
 *
 * 组合即场景：
 *   库 → 文件   = 数据导出
 *   文件 → 库   = 数据导入
 *   库 → 库     = 库间同步 / 迁移
 *   文件 → 文件 = 格式转换
 *
 * 执行特征：
 *   - 源端分批读取、目标端分批写入，两端都不把全量数据驻留内存
 *   - 字段映射在中间统一转换（直传 / 常量 / 裁剪 / 大小写 / 类型转换 / 空值默认）
 *   - 支持试运行（dryRun）：只看计划与样例语句，不落库
 *   - 进度通过 onProgress 回调实时上报（主进程转发到 data:progress 推送通道）
 *
 * 安全：
 *   - 标识符（表/列名）走白名单正则；写入一律参数化绑定，杜绝 SQL 注入
 *   - UPSERT / REPLACE 仅对支持该语法的目标库开放
 *   - 「清空目标表」必须显式开启，且执行前写审计
 *   - xlsx 为可选依赖，缺失返回安装提示（与 dbAdapters 一致的懒加载策略）
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const audit = require('./auditLogger');
const auth = require('./auth');
const dbAdapters = require('./dbAdapters');

/** 源端分批读取大小 */
const READ_BATCH = 1000;
/** 目标端单批写入行数 */
const WRITE_BATCH_MYSQL = 500;
const WRITE_BATCH_ORACLE = 200;
/** 单次任务行数上限（防误操作把整表搬飞） */
const MAX_ROWS = 1000000;
const DEFAULT_LIMIT = 50000;
/** 预览样例行数 */
const SAMPLE_ROWS = 20;
/** 导入文件大小上限（MB） */
const MAX_FILE_MB = 50;
/** 错误明细最多返回条数 */
const MAX_ERROR_DETAIL = 30;
/** 执行记录保留条数 */
const RUN_HISTORY_LIMIT = 50;

const operator = () => (auth.getSession() || {}).username || '-';
const now = () => store.nowText();
const log = (detail, result = 'success') => audit.write({ type: '操作', user: operator(), detail, result });

/** 标识符白名单：字母数字 _ $ . */
const IDENT = /^[A-Za-z0-9_$.]+$/;
/** 只读语句前缀 */
const READONLY_PREFIX = /^\s*(select|show|desc|describe|explain|with)\b/i;
/** Oracle 分页辅助列 */
const ROWNUM_ALIAS = 'sg_rn';

const FILE_FORMATS = ['csv', 'json', 'sql', 'xlsx'];
const SOURCE_KINDS = ['db', 'file', 'text'];
const TARGET_KINDS = ['db', 'file'];
const XLSX_HINT = '未安装 xlsx 依赖，请先执行：npm install xlsx';

/** 写入模式说明（界面与返回体共用） */
const MODE_LABEL = { insert: '追加', upsert: '更新插入', replace: '替换' };

/* ------------------------------------------------------------------
 * 通用工具
 * ------------------------------------------------------------------ */

function electronDialog() {
    try {
        // eslint-disable-next-line global-require
        return require('electron').dialog || null;
    } catch (err) {
        return null;
    }
}

function loadXlsx() {
    try {
        // eslint-disable-next-line global-require
        return require('xlsx');
    } catch (err) {
        return null;
    }
}

const EXT_FILTERS = {
    csv: [{ name: 'CSV 文件', extensions: ['csv', 'txt'] }],
    json: [{ name: 'JSON 文件', extensions: ['json'] }],
    sql: [{ name: 'SQL 脚本', extensions: ['sql'] }],
    xlsx: [{ name: 'Excel 工作簿', extensions: ['xlsx', 'xls'] }]
};

function pickSource(sourceId, label = '数据源') {
    const source = store.find('dbSources', sourceId);
    if (!source) return { error: `${label}不存在` };
    if (source.enabled === false) return { error: `${label}「${source.name}」已停用，请先在「数据库配置」中启用` };
    if (!source.host || !source.user) {
        return { error: `${label}「${source.name}」未配置连接信息，请先在「数据库运维 → 数据库配置」中完成配置` };
    }
    return { source };
}

const parseColumnList = text => String(text || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

/** 按数据库方言生成分页语句 */
function paginate(type, baseSql, offset, size) {
    if (type === 'mysql') return `${baseSql} LIMIT ${size} OFFSET ${offset}`;
    if (type === 'oracle') {
        const end = offset + size;
        return `SELECT * FROM (SELECT sg_t.*, ROWNUM ${ROWNUM_ALIAS} FROM (${baseSql}) sg_t WHERE ROWNUM <= ${end}) WHERE ${ROWNUM_ALIAS} > ${offset}`;
    }
    throw new Error(dbAdapters.DEP_HINT[type] || `暂不支持的数据库类型：${type}`);
}

/** 剔除 Oracle 分页带出的辅助列 */
function stripRowNum(res) {
    if (!res || !Array.isArray(res.columns)) return res;
    const keep = res.columns.filter(c => String(c).toLowerCase() !== ROWNUM_ALIAS);
    if (keep.length === res.columns.length) return res;
    const rows = (res.rows || []).map(r => {
        const o = { ...r };
        delete o[ROWNUM_ALIAS];
        delete o[ROWNUM_ALIAS.toUpperCase()];
        return o;
    });
    return { ...res, columns: keep, rows };
}

/* ------------------------------------------------------------------
 * 文件解析（CSV / JSON / INSERT 脚本 / Excel）
 * ------------------------------------------------------------------ */

function detectDelimiter(text) {
    const line = String(text || '').split(/\r?\n/).find(l => l.trim()) || '';
    const candidates = [',', ';', '\t', '|'];
    let best = ',';
    let bestCount = 0;
    candidates.forEach(c => {
        const count = line.split(c).length - 1;
        if (count > bestCount) { bestCount = count; best = c; }
    });
    return best;
}

/** CSV / TSV 解析（引号包裹、"" 转义、CRLF、字段内换行） */
function parseDelimited(text, { delimiter, hasHeader = true } = {}) {
    const sep = delimiter || detectDelimiter(text);
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    let i = 0;

    const pushCell = () => { row.push(cell); cell = ''; };
    const pushRow = () => { pushCell(); rows.push(row); row = []; };

    while (i < text.length) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
                quoted = false; i++; continue;
            }
            cell += ch; i++; continue;
        }
        if (ch === '"' && cell === '') { quoted = true; i++; continue; }
        if (ch === sep) { pushCell(); i++; continue; }
        if (ch === '\r') { pushRow(); i += (text[i + 1] === '\n' ? 2 : 1); continue; }
        if (ch === '\n') { pushRow(); i++; continue; }
        cell += ch; i++;
    }
    if (cell !== '' || row.length) pushRow();

    const raw = rows.filter(r => r.some(v => String(v).trim() !== ''));
    if (!raw.length) return { columns: [], rows: [], warnings: ['文件内容为空'] };

    const headerRow = hasHeader ? raw.shift() : raw[0].map((_, idx) => `col${idx + 1}`);
    const columns = headerRow.map((h, idx) => String(h || `col${idx + 1}`).trim() || `col${idx + 1}`);

    const warnings = [];
    const records = raw.map((r, idx) => {
        if (r.length !== columns.length) {
            warnings.push(`第 ${idx + 2} 行字段数 ${r.length} 与表头 ${columns.length} 列不一致（多余忽略 / 缺失补空）`);
        }
        const obj = {};
        columns.forEach((c, ci) => { obj[c] = r[ci] === undefined ? null : r[ci]; });
        return obj;
    });
    return { columns, rows: records, delimiter: sep, warnings };
}

function parseJson(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        return { error: `JSON 解析失败：${err.message}` };
    }
    let list = data;
    if (!Array.isArray(list) && data && typeof data === 'object') {
        list = data.data || data.rows || data.records || null;
    }
    if (!Array.isArray(list)) return { error: 'JSON 需为对象数组，或包含 data / rows / records 数组字段' };
    if (!list.length) return { columns: [], rows: [], warnings: ['文件内容为空'] };
    const columns = [...new Set(list.flatMap(item => (item && typeof item === 'object' ? Object.keys(item) : [])))];
    return { columns, rows: list, warnings: [] };
}

/** 拆分 VALUES 后的多个元组（按顶层逗号切分，括号与引号内不切） */
function splitTuples(text) {
    const out = [];
    let depth = 0;
    let quoted = false;
    let buf = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            buf += ch;
            if (ch === "'") {
                if (text[i + 1] === "'") { buf += "'"; i++; } else quoted = false;
            }
            continue;
        }
        if (ch === "'") { quoted = true; buf += ch; continue; }
        if (ch === '(') { depth++; buf += ch; continue; }
        if (ch === ')') { depth--; buf += ch; continue; }
        if (ch === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
        buf += ch;
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter(t => t.startsWith('(')).map(t => t.replace(/^\(/, '').replace(/\)$/, ''));
}

/** 拆分元组内的各个值 */
function splitValues(text) {
    const out = [];
    let quoted = false;
    let buf = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            buf += ch;
            if (ch === "'") {
                if (text[i + 1] === "'") { buf += "'"; i++; } else quoted = false;
            }
            continue;
        }
        if (ch === "'") { quoted = true; buf += ch; continue; }
        if (ch === ',') { out.push(buf.trim()); buf = ''; continue; }
        buf += ch;
    }
    out.push(buf.trim());
    return out;
}

const literalToValue = tok => {
    const s = String(tok).trim();
    if (!s || /^null$/i.test(s)) return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
    if (/^".*"$/.test(s)) return JSON.parse(s);
    return s;
};

/**
 * 解析 INSERT 脚本
 * 必须按引号状态扫描语句边界 —— 正则会在字符串里的分号（'x;y'）处误截断导致丢数据
 */
function parseSqlInserts(text) {
    const headRe = /insert\s+(?:ignore\s+)?into\s+/gi;
    const statements = [];
    let match;

    while ((match = headRe.exec(text)) !== null) {
        const bodyStart = match.index + match[0].length;
        let i = bodyStart;
        let quoted = false;
        let end = text.length;
        while (i < text.length) {
            const ch = text[i];
            if (quoted) {
                if (ch === "'") {
                    if (text[i + 1] === "'") i++; else quoted = false;
                }
                i++;
                continue;
            }
            if (ch === "'") { quoted = true; i++; continue; }
            if (ch === ';') { end = i; break; }
            i++;
        }
        statements.push(text.slice(bodyStart, end));
        headRe.lastIndex = end;
    }

    if (!statements.length) return { error: '未从文件中解析出 INSERT 语句' };

    const columns = [];
    const rows = [];
    let table = null;

    statements.forEach(stmt => {
        let pos = 0;
        while (pos < stmt.length && /\s/.test(stmt[pos])) pos++;
        const nameStart = pos;
        while (pos < stmt.length && !/[\s(]/.test(stmt[pos])) pos++;
        if (!table) table = stmt.slice(nameStart, pos).replace(/[`"]/g, '');

        let p = pos;
        while (p < stmt.length && /\s/.test(stmt[p])) p++;
        if (stmt[p] === '(') {
            const close = stmt.indexOf(')', p);
            const colPart = stmt.slice(p + 1, close < 0 ? stmt.length : close);
            if (!columns.length) {
                colPart.split(',').forEach(c => {
                    const name = c.trim().replace(/[`"]/g, '');
                    if (name) columns.push(name);
                });
            }
            p = close < 0 ? stmt.length : close + 1;
        }

        const valuesIdx = stmt.toLowerCase().indexOf('values', p);
        if (valuesIdx < 0) return;
        splitTuples(stmt.slice(valuesIdx + 6)).forEach(tuple => {
            const values = splitValues(tuple).map(literalToValue);
            if (!columns.length) values.forEach((_, i) => columns.push(`col${i + 1}`));
            const obj = {};
            columns.forEach((c, i) => { obj[c] = values[i] === undefined ? null : values[i]; });
            rows.push(obj);
        });
    });

    if (!rows.length) return { error: 'INSERT 语句中未解析出任何数据行' };
    return { columns, rows, table, warnings: [] };
}

const formatOfFile = filePath => {
    const ext = path.extname(String(filePath || '')).toLowerCase().replace('.', '');
    if (ext === 'xls' || ext === 'xlsx') return 'xlsx';
    return FILE_FORMATS.includes(ext) ? ext : 'csv';
};

/** 解析文件 / 文本 → { columns, rows, warnings, format } */
function parseContent(text, format, options = {}) {
    if (format === 'xlsx') {
        const XLSX = loadXlsx();
        if (!XLSX) return { error: XLSX_HINT };
        const book = XLSX.read(text, { type: 'buffer' });
        const sheetName = book.SheetNames[0];
        if (!sheetName) return { error: '工作簿中没有可用的工作表' };
        const rows = XLSX.utils.sheet_to_json(book.Sheets[sheetName], { defval: null });
        if (!rows.length) return { columns: [], rows: [], warnings: ['文件内容为空'] };
        const columns = [...new Set(rows.flatMap(r => Object.keys(r)))];
        return { columns, rows, warnings: [] };
    }
    if (format === 'json') return parseJson(text);
    if (format === 'sql') return parseSqlInserts(text);
    return parseDelimited(text, { hasHeader: options.hasHeader !== false, delimiter: options.delimiter });
}

/** 读取文件内容（带大小校验） */
function readFileContent(filePath, format, options = {}) {
    const stat = fs.statSync(filePath);
    const sizeMb = stat.size / 1024 / 1024;
    if (sizeMb > MAX_FILE_MB) {
        return { error: `文件 ${sizeMb.toFixed(1)}MB 超过 ${MAX_FILE_MB}MB 上限，请拆分后再处理` };
    }
    const formatName = format || formatOfFile(filePath);
    if (formatName === 'xlsx') {
        const parsed = parseContent(fs.readFileSync(filePath), formatName, options);
        return parsed.error ? { error: parsed.error } : { ...parsed, format: formatName };
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = parseContent(text, formatName, options);
    return parsed.error ? { error: parsed.error } : { ...parsed, format: formatName };
}

function inferType(values) {
    const list = values.filter(v => v !== null && v !== undefined && String(v).trim() !== '');
    if (!list.length) return 'empty';
    if (list.every(v => /^-?\d+$/.test(String(v).trim()))) return 'integer';
    if (list.every(v => /^-?\d+(\.\d+)?$/.test(String(v).trim()))) return 'number';
    if (list.every(v => /^(true|false|0|1|yes|no|y|n)$/i.test(String(v).trim()))) return 'boolean';
    if (list.every(v => /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(String(v).trim()))) return 'datetime';
    return 'string';
}

/* ------------------------------------------------------------------
 * 字段映射管线
 * ------------------------------------------------------------------ */

const pad2 = n => String(n).padStart(2, '0');
const formatLocalDate = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

/**
 * 日期归一化：输出 YYYY-MM-DD HH:mm:ss
 *
 * 关键点：像 '2026-09-18' 这种字面量**不能**交给 new Date() 解析 ——
 * JS 会按 UTC 解释纯日期，本地时区（+08:00）下会变成 08:00:00，凭空跑出时差。
 * 因此优先按字面量直接归一，只有其他格式才退回 Date 解析（并用本地时间格式化）。
 */
function normalizeDate(value, fallback) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return formatLocalDate(value);

    const s = String(value).trim();
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/.exec(s);
    if (m) {
        return `${m[1]}-${pad2(m[2])}-${pad2(m[3])} ${pad2(m[4] || 0)}:${pad2(m[5] || 0)}:${pad2(m[6] || 0)}`;
    }
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return fallback || null;
    return formatLocalDate(d);
}

/**
 * 单值转换
 * @param {any} value 源值
 * @param {string} transform none|trim|upper|lower|string|number|integer|boolean|date|const
 */
function transformValue(value, transform, fallback) {
    const t = transform || 'none';
    if (t === 'const') return fallback === undefined ? null : fallback;

    let v = value;
    if (v === undefined) v = null;

    switch (t) {
        case 'trim': return v === null ? null : String(v).trim();
        case 'upper': return v === null ? null : String(v).trim().toUpperCase();
        case 'lower': return v === null ? null : String(v).trim().toLowerCase();
        case 'string': return v === null || v === undefined ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        case 'number':
        case 'integer': {
            if (v === null || v === '' || v === undefined) return null;
            const n = t === 'integer' ? parseInt(String(v).replace(/,/g, ''), 10) : Number(String(v).replace(/,/g, ''));
            return Number.isFinite(n) ? n : (fallback !== undefined && fallback !== null && fallback !== '' ? Number(fallback) : null);
        }
        case 'boolean': {
            if (v === null || v === undefined || v === '') return null;
            if (typeof v === 'boolean') return v;
            if (typeof v === 'number') return v !== 0;
            return /^(1|true|yes|y|是|on)$/i.test(String(v).trim());
        }
        case 'date': return normalizeDate(v, fallback);
        default: return v;
    }
}

/**
 * 按映射把源行转换为目标行
 * @param {object} row 源行
 * @param {Array<{from?:string,to?:string,transform?:string,default?:any}>} mapping
 * @param {{emptyAsNull?:boolean}} options
 */
function applyMapping(row, mapping, options = {}) {
    const emptyAsNull = options.emptyAsNull !== false;
    const out = {};
    (mapping || []).forEach(m => {
        if (!m || !m.to) return;
        const raw = (m.from === null || m.from === undefined || m.from === '')
            ? (m.default === undefined ? null : m.default)
            : (row[m.from] === undefined ? null : row[m.from]);

        let v = transformValue(raw, m.transform, m.default);
        if ((v === null || v === '') && m.default !== undefined && m.default !== null && m.default !== '') {
            v = transformValue(m.default, m.transform === 'const' ? 'none' : m.transform);
        }
        if (emptyAsNull && v === '') v = null;
        out[m.to] = v === undefined ? null : v;
    });
    return out;
}

/** 校验映射：给出目标库不存在的列等提示 */
function validateMapping(mapping, targetColumns) {
    const warnings = [];
    const used = (mapping || []).filter(m => m && m.to).map(m => m.to);
    if (!used.length) warnings.push('尚未配置任何字段映射');
    const dup = used.filter((v, i) => used.indexOf(v) !== i);
    if (dup.length) warnings.push('目标列重复映射：' + [...new Set(dup)].join('、'));
    (used || []).forEach(col => {
        if (!IDENT.test(String(col))) warnings.push(`目标列「${col}」含非法字符`);
    });
    if (Array.isArray(targetColumns) && targetColumns.length) {
        used.forEach(col => {
            if (!targetColumns.includes(col)) warnings.push(`目标表不存在列「${col}」`);
        });
    }
    return warnings;
}

/* ------------------------------------------------------------------
 * 目标端：数据库写入
 * ------------------------------------------------------------------ */

function normalizeValue(v, emptyAsNull = true) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim() === '' && emptyAsNull) return null;
    return v;
}

/**
 * 构造单批写入语句（参数化）
 * @returns {{sql:string, params:Array}}
 */
function buildBatch(sourceType, table, columns, rows, mode, keyColumns, emptyAsNull) {
    const params = rows.flatMap(r => columns.map(c => normalizeValue(r[c], emptyAsNull)));

    if (sourceType === 'mysql') {
        const placeholders = rows.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
        if (mode === 'replace') {
            return { sql: `REPLACE INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, params };
        }
        if (mode === 'upsert') {
            const updates = columns.filter(c => !(keyColumns || []).includes(c)).map(c => `${c}=VALUES(${c})`);
            if (!updates.length) {
                return { sql: `INSERT IGNORE INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, params };
            }
            return {
                sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${updates.join(',')}`,
                params
            };
        }
        return { sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, params };
    }

    if (sourceType === 'oracle') {
        if (mode === 'upsert') throw new Error('Oracle 的 UPSERT 需要 MERGE 语句，当前版本未开放，请使用「追加」模式');
        if (mode === 'replace') throw new Error('Oracle 不支持 REPLACE INTO，请使用「追加」模式');
        let idx = 0;
        const placeholders = rows.map(() => `(${columns.map(() => `:${++idx}`).join(',')})`).join(',');
        return { sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, params };
    }

    throw new Error(dbAdapters.DEP_HINT[sourceType] || `暂不支持的数据库类型：${sourceType}`);
}

/* ------------------------------------------------------------------
 * 目标端：文件写入（导出）
 * ------------------------------------------------------------------ */

const cellText = v => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
};

const csvEscape = v => {
    const s = cellText(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 单引号按标准 SQL 翻倍转义（Oracle 不认反斜杠） */
const sqlLiteral = v => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `'${s.replace(/'/g, "''")}'`;
};

const csvRow = (columns, row) => columns.map(c => csvEscape(row[c])).join(',');

const insertStatement = (table, columns, rows) =>
    `INSERT INTO ${table} (${columns.map(c => `\`${c}\``).join(', ')}) VALUES\n`
    + rows.map(r => `(${columns.map(c => sqlLiteral(r[c])).join(', ')})`).join(',\n') + ';';

/** 文件写入器：按格式累积文本，结束时落盘 */
function createFileWriter(format, filePath, tableName = 'data') {
    const chunks = [];
    let firstJson = true;
    let columns = null;

    return {
        /** @param {Array<object>} rows 已按映射转换的行 */
        write(rows) {
            if (!rows.length) return;
            if (!columns) columns = Object.keys(rows[0]);
            if (format === 'csv') {
                chunks.push(rows.map(r => csvRow(columns, r)).join('\r\n') + '\r\n');
            } else if (format === 'json') {
                rows.forEach(r => {
                    chunks.push((firstJson ? '' : ',') + JSON.stringify(r));
                    firstJson = false;
                });
            } else if (format === 'sql') {
                chunks.push(insertStatement(tableName, columns, rows) + '\n\n');
            }
        },
        header() {
            if (format === 'csv') return '\ufeff' + columns.map(csvEscape).join(',') + '\r\n';
            if (format === 'json') return '[';
            return '';
        },
        footer() {
            if (format === 'json') return ']';
            return '';
        },
        columns: () => columns || [],
        /** xlsx 走全量内存，其余流式拼接 */
        save(allRows) {
            if (format === 'xlsx') {
                const XLSX = loadXlsx();
                if (!XLSX) return { error: XLSX_HINT };
                const cols = columns || (allRows[0] ? Object.keys(allRows[0]) : []);
                const sheet = XLSX.utils.json_to_sheet(allRows.map(r => {
                    const o = {};
                    cols.forEach(c => { o[c] = r[c]; });
                    return o;
                }));
                const book = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(book, sheet, 'data');
                fs.writeFileSync(filePath, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
                return {};
            }
            fs.writeFileSync(filePath, this.header() + chunks.join('') + this.footer(), 'utf8');
            return {};
        }
    };
}

/* ------------------------------------------------------------------
 * 源端读取
 * ------------------------------------------------------------------ */

/** 解析源配置 → 基础查询 / 数据行 */
async function prepareSource(source = {}) {
    const kind = SOURCE_KINDS.includes(source.kind) ? source.kind : 'db';

    if (kind === 'db') {
        const picked = pickSource(source.sourceId, '源数据源');
        if (picked.error) return { error: picked.error };
        const db = picked.source;

        let baseSql;
        let label = 'query';
        if (String(source.sql || '').trim()) {
            const sql = String(source.sql).trim().replace(/;+\s*$/, '');
            if (!READONLY_PREFIX.test(sql)) return { error: '源端仅支持 SELECT / SHOW / DESC / EXPLAIN / WITH 等只读语句' };
            if (/;\s*\S/.test(sql)) return { error: '源端不支持一次执行多条语句' };
            baseSql = sql;
        } else {
            const table = String(source.table || '').trim();
            if (!table) return { error: '请选择源表，或填写自定义查询' };
            if (!IDENT.test(table)) return { error: `非法的源表名：${table}` };
            const cols = parseColumnList(source.columns);
            if (cols.some(c => !IDENT.test(c))) return { error: '源列名含非法字符' };
            const where = String(source.where || '').trim();
            if (where && /;|\b(drop|truncate|delete|update|insert|alter|create)\b/i.test(where)) {
                return { error: 'WHERE 条件不允许包含分号或写操作关键字' };
            }
            label = table;
            baseSql = `SELECT ${cols.length ? cols.join(', ') : '*'} FROM ${table}${where ? ` WHERE ${where}` : ''}`;
        }
        return { kind: 'db', db, baseSql, label };
    }

    if (kind === 'file') {
        const filePath = String(source.filePath || '');
        if (!filePath || !fs.existsSync(filePath)) return { error: '源文件不存在，请重新选择' };
        let parsed;
        try {
            parsed = readFileContent(filePath, source.format, { hasHeader: source.hasHeader, delimiter: source.delimiter });
        } catch (err) {
            return { error: `源文件读取失败：${err.message}` };
        }
        if (parsed.error) return { error: parsed.error };
        return { kind: 'file', columns: parsed.columns, rows: parsed.rows, warnings: parsed.warnings || [], filePath, suggestedTable: parsed.table };
    }

    // text：直接解析剪贴的文本
    const content = String(source.content || '');
    if (!content.trim()) return { error: '请粘贴要解析的数据文本' };
    const format = FILE_FORMATS.includes(source.format) ? source.format : 'csv';
    const parsed = parseContent(content, format, { hasHeader: source.hasHeader, delimiter: source.delimiter });
    if (parsed.error) return { error: parsed.error };
    return { kind: 'text', columns: parsed.columns, rows: parsed.rows, warnings: parsed.warnings || [] };
}

/** 源端预览：列清单（含推断类型）+ 样例行 + 总量 */
async function previewSource(source = {}) {
    const prepared = await prepareSource(source);
    if (prepared.error) return { ok: false, message: prepared.error };

    if (prepared.kind === 'db') {
        try {
            const res = stripRowNum(await dbAdapters.query(prepared.db, paginate(prepared.db.type, prepared.baseSql, 0, SAMPLE_ROWS)));
            const rows = res.rows || [];
            const columns = (res.columns || []).map(name => ({
                name, type: inferType(rows.slice(0, 50).map(r => r[name]))
            }));
            let total = null;
            try {
                const countRes = await dbAdapters.query(prepared.db, `SELECT COUNT(*) AS c FROM (${prepared.baseSql}) sg_cnt`);
                const first = (countRes.rows || [])[0];
                const key = first ? Object.keys(first).find(k => k.toLowerCase() === 'c') : null;
                if (key) total = Number(first[key]);
            } catch (err) { /* 计数失败不影响预览 */ }
            return { ok: true, kind: 'db', columns, sample: rows, total, label: prepared.label };
        } catch (err) {
            return { ok: false, message: `源端采样失败：${err.message}` };
        }
    }

    const rows = prepared.rows || [];
    return {
        ok: true,
        kind: prepared.kind,
        columns: (prepared.columns || []).map(name => ({ name, type: inferType(rows.slice(0, 50).map(r => r[name])) })),
        sample: rows.slice(0, SAMPLE_ROWS),
        total: rows.length,
        warnings: prepared.warnings || [],
        suggestedTable: prepared.suggestedTable || null
    };
}

/** 目标端表结构（用于映射下拉与校验） */
async function describeTarget(target = {}) {
    if (target.kind !== 'db') return { ok: true, columns: [] };
    const picked = pickSource(target.sourceId, '目标数据源');
    if (picked.error) return { ok: false, message: picked.error };
    const table = String(target.table || '').trim();
    if (!table || !IDENT.test(table)) return { ok: false, message: '请选择合法的目标表' };
    try {
        const columns = await dbAdapters.describeTable(picked.source, table);
        return { ok: true, table, columns: (columns || []).map(c => ({ name: c.name, type: c.type, key: c.key })) };
    } catch (err) {
        return { ok: false, message: err.message };
    }
}

/* ------------------------------------------------------------------
 * 执行
 * ------------------------------------------------------------------ */

/**
 * 执行一次同步任务
 * @param {{name?, source:object, target:object, mapping:Array, options?:object}} task
 * @param {{onProgress?:Function, user?:string}} ctx
 */
async function runEtl(task = {}, ctx = {}) {
    const { onProgress } = ctx;
    const user = ctx.user || operator();
    const options = task.options || {};
    const limit = Math.min(Number(options.limit) || DEFAULT_LIMIT, MAX_ROWS);
    const started = Date.now();

    const report = payload => { if (typeof onProgress === 'function') onProgress(payload); };

    // ---- 1. 准备源 ----
    const source = await prepareSource(task.source || {});
    if (source.error) return { ok: false, message: source.error };

    // ---- 2. 准备目标 ----
    const target = task.target || {};
    const targetKind = TARGET_KINDS.includes(target.kind) ? target.kind : 'db';
    let targetDb = null;
    let targetTable = '';
    let targetColumnNames = [];
    let filePath = '';
    let format = 'csv';

    if (targetKind === 'db') {
        const picked = pickSource(target.sourceId, '目标数据源');
        if (picked.error) return { ok: false, message: picked.error };
        targetDb = picked.source;
        targetTable = String(target.table || '').trim();
        if (!IDENT.test(targetTable)) return { ok: false, message: '请选择合法的目标表' };
        const desc = await describeTarget(target);
        if (desc.ok) targetColumnNames = (desc.columns || []).map(c => c.name);
    } else {
        filePath = String(target.filePath || '');
        format = FILE_FORMATS.includes(target.format) ? target.format : 'csv';
        if (format === 'xlsx' && !loadXlsx()) return { ok: false, message: XLSX_HINT };
        if (!filePath) {
            const dialog = electronDialog();
            if (!dialog) return { ok: false, message: '当前环境不支持文件保存对话框，请显式传入 filePath' };
            const stamp = now().replace(/[-: ]/g, '');
            const picked = await dialog.showSaveDialog({
                title: '导出数据到文件',
                defaultPath: `${(task.source || {}).table || 'data'}_${stamp}.${format}`,
                filters: EXT_FILTERS[format] || [{ name: '数据文件', extensions: [format] }]
            });
            if (picked.canceled || !picked.filePath) return { ok: false, canceled: true, message: '已取消' };
            filePath = picked.filePath;
        }
    }

    // ---- 3. 映射 ----
    let mapping = Array.isArray(task.mapping) ? task.mapping.filter(m => m && m.to) : [];
    if (!mapping.length && source.kind === 'file' || !mapping.length && source.kind === 'text') {
        // 未配置映射时，按同名列直通（文件场景的常见默认）
        mapping = (source.columns || []).map(c => ({ from: c, to: c, transform: 'none' }));
    }
    const warnings = validateMapping(mapping, targetKind === 'db' ? targetColumnNames : null);
    const targetColumns = [...new Set(mapping.map(m => m.to))];

    // ---- 4. 试运行 ----
    if (options.dryRun) {
        let sampleRows = [];
        if (source.kind === 'db') {
            const res = stripRowNum(await dbAdapters.query(source.db, paginate(source.db.type, source.baseSql, 0, 3)));
            sampleRows = applyMappingList(res.rows || [], mapping, options);
        } else {
            sampleRows = applyMappingList((source.rows || []).slice(0, 3), mapping, options);
        }
        const planned = source.kind === 'db' ? limit : (source.rows || []).length;
        const batchSize = writeBatchSize(targetDb, options);
        const plan = {
            ok: true, dryRun: true,
            targetKind, targetTable: targetTable || null, filePath: filePath || null,
            plannedRows: planned,
            plannedBatches: Math.ceil(planned / batchSize),
            targetColumns,
            mode: options.mode || 'insert',
            modeLabel: MODE_LABEL[options.mode || 'insert'],
            warnings,
            sampleRows
        };
        if (targetKind === 'db' && sampleRows.length) {
            try {
                const batch = buildBatch(targetDb.type, targetTable, targetColumns, sampleRows, options.mode || 'insert', options.keyColumns || [], options.emptyAsNull !== false);
                plan.sampleSql = batch.sql.length > 800 ? batch.sql.slice(0, 800) + ' …' : batch.sql;
                plan.sampleParams = batch.params.slice(0, 8);
            } catch (err) {
                return { ok: false, message: err.message, warnings };
            }
        } else if (sampleRows.length) {
            plan.sampleText = format === 'sql'
                ? insertStatement(targetTable || 'data', targetColumns, sampleRows)
                : sampleRows.slice(0, 3).map(r => targetColumns.map(c => cellText(r[c])).join(' | ')).join('\n');
        }
        return plan;
    }

    // ---- 5. 正式执行 ----
    report({ phase: 'start', read: 0, written: 0, batches: 0, message: '任务启动' });

    if (targetKind === 'db' && options.clearFirst === true) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await dbAdapters.query(targetDb, `DELETE FROM ${targetTable}`);
            log(`ETL：导入前清空目标表「${targetTable}」（用户显式确认）`);
        } catch (err) {
            return { ok: false, message: `清空目标表失败，已中止：${err.message}` };
        }
    }

    const batchSize = writeBatchSize(targetDb, options);
    const writer = targetKind === 'file' ? createFileWriter(format, filePath, targetTable || 'data') : null;
    let allRows = [];

    const stats = { read: 0, written: 0, failed: 0, batches: 0 };
    const errors = [];

    /** 处理一批源行：映射 → 写入目标 */
    async function consume(rawRows) {
        if (!rawRows.length) return;
        stats.read += rawRows.length;
        const rows = applyMappingList(rawRows, mapping, options);

        if (targetKind === 'file') {
            if (format === 'xlsx') allRows = allRows.concat(rows);
            else writer.write(rows);
            stats.written += rows.length;
            return;
        }

        for (let i = 0; i < rows.length; i += batchSize) {
            const slice = rows.slice(i, i + batchSize);
            try {
                const batch = buildBatch(targetDb.type, targetTable, targetColumns, slice,
                    options.mode || 'insert', options.keyColumns || [], options.emptyAsNull !== false);
                // eslint-disable-next-line no-await-in-loop
                const res = await dbAdapters.query(targetDb, batch.sql, batch.params);
                stats.written += res.affectedRows || slice.length;
                stats.batches++;
            } catch (err) {
                errors.push({ batch: stats.batches + 1, rows: slice.length, message: err.message });
                stats.failed += slice.length;
                if (options.stopOnError !== false) return;
            }
        }
    }

    if (source.kind === 'db') {
        for (let offset = 0; offset < limit; offset += READ_BATCH) {
            const size = Math.min(READ_BATCH, limit - offset);
            // eslint-disable-next-line no-await-in-loop
            const res = stripRowNum(await dbAdapters.query(source.db, paginate(source.db.type, source.baseSql, offset, size)));
            const rows = res.rows || [];
            // eslint-disable-next-line no-await-in-loop
            await consume(rows);
            report({
                phase: 'running', read: stats.read, written: stats.written,
                batches: stats.batches, message: `已读取 ${stats.read} 行`
            });
            if (rows.length < size) break;
            if (errors.length && options.stopOnError !== false) break;
        }
    } else {
        const rows = source.rows || [];
        const capped = rows.slice(0, limit);
        for (let i = 0; i < capped.length; i += READ_BATCH) {
            // eslint-disable-next-line no-await-in-loop
            await consume(capped.slice(i, i + READ_BATCH));
            report({
                phase: 'running', read: stats.read, written: stats.written,
                batches: stats.batches, message: `已处理 ${stats.read} 行`
            });
            if (errors.length && options.stopOnError !== false) break;
        }
    }

    let saved = {};
    if (targetKind === 'file') {
        saved = writer.save(allRows);
        if (saved.error) return { ok: false, message: saved.error };
        stats.batches = Math.ceil(stats.read / READ_BATCH);
    }

    const durationMs = Date.now() - started;
    const success = errors.length === 0;
    log(`ETL「${task.name || '未命名'}」：${stats.written}/${stats.read} 行` +
        `（${source.kind} → ${targetKind}${targetKind === 'db' ? ':' + targetTable : ''}` +
        `${targetKind === 'db' ? ' · ' + MODE_LABEL[options.mode || 'insert'] : ''}）`, success ? 'success' : 'failed');

    report({ phase: 'done', read: stats.read, written: stats.written, batches: stats.batches, message: '任务结束' });

    const result = {
        ok: success,
        partial: !success && stats.written > 0,
        name: task.name || null,
        sourceKind: source.kind,
        targetKind,
        targetTable: targetTable || null,
        filePath: filePath || null,
        fileName: filePath ? path.basename(filePath) : null,
        format: targetKind === 'file' ? format : null,
        mode: targetKind === 'db' ? (options.mode || 'insert') : null,
        modeLabel: targetKind === 'db' ? MODE_LABEL[options.mode || 'insert'] : null,
        read: stats.read, written: stats.written, failed: stats.failed,
        batches: stats.batches, durationMs,
        targetColumns,
        warnings,
        errors: errors.slice(0, MAX_ERROR_DETAIL)
    };
    recordRun({ ...result, user, createdAt: now() });
    return result;
}

function applyMappingList(rows, mapping, options) {
    return (rows || []).map(r => applyMapping(r, mapping, options));
}

function writeBatchSize(targetDb, options) {
    if (!targetDb) return WRITE_BATCH_MYSQL;
    const base = targetDb.type === 'oracle' ? WRITE_BATCH_ORACLE : WRITE_BATCH_MYSQL;
    return Math.min(Math.max(Number(options.batchSize) || base, 1), base);
}

/** 执行记录：仅保留最近 RUN_HISTORY_LIMIT 条 */
function recordRun(entry) {
    const state = store.load();
    if (!Array.isArray(state.etlRuns)) state.etlRuns = [];
    state.etlRuns.unshift({ id: store.uid('r_'), ...entry });
    if (state.etlRuns.length > RUN_HISTORY_LIMIT) state.etlRuns.length = RUN_HISTORY_LIMIT;
    store.persist();
    return entry;
}

/* ------------------------------------------------------------------
 * 任务库
 * ------------------------------------------------------------------ */

const listTasks = () => store.list('etlTasks');
const listRuns = () => store.list('etlRuns');

function saveTask(payload = {}) {
    const name = String(payload.name || '').trim();
    if (!name) return { ok: false, message: '请填写任务名称' };
    if (!payload.source || !payload.target) return { ok: false, message: '任务缺少源或目标配置' };

    const data = {
        ...payload,
        name,
        updatedAt: now(),
        author: payload.author || operator()
    };
    const isNew = !data.id;
    if (isNew) data.createdAt = data.updatedAt;
    const saved = store.upsert('etlTasks', data);
    log(`${isNew ? '新建' : '更新'}数据同步任务「${saved.name}」`);
    return { ok: true, task: saved };
}

function deleteTask(id) {
    const task = store.find('etlTasks', id);
    const ok = store.remove('etlTasks', id);
    if (ok && task) log(`删除数据同步任务「${task.name}」`);
    return { ok };
}

/** 选择文件（供前端「选择源文件」按钮调用，返回路径而不传内容） */
async function pickFile(kind = 'open') {
    const dialog = electronDialog();
    if (!dialog) return { ok: false, message: '当前环境不支持文件对话框' };
    if (kind === 'save') {
        const res = await dialog.showSaveDialog({
            title: '导出到文件',
            filters: [{ name: '数据文件', extensions: ['csv', 'json', 'sql', 'xlsx'] }, ...Object.values(EXT_FILTERS)]
        });
        if (res.canceled || !res.filePath) return { ok: false, canceled: true, message: '已取消' };
        return { ok: true, filePath: res.filePath, fileName: path.basename(res.filePath) };
    }
    const res = await dialog.showOpenDialog({
        title: '选择数据文件',
        properties: ['openFile'],
        filters: [{ name: '数据文件', extensions: ['csv', 'txt', 'json', 'sql', 'xlsx', 'xls'] }, ...Object.values(EXT_FILTERS)]
    });
    if (res.canceled || !(res.filePaths || [])[0]) return { ok: false, canceled: true, message: '已取消' };
    const filePath = res.filePaths[0];
    return { ok: true, filePath, fileName: path.basename(filePath), format: formatOfFile(filePath) };
}

module.exports = {
    FILE_FORMATS, SOURCE_KINDS, TARGET_KINDS, MODE_LABEL, IDENT, READONLY_PREFIX,
    MAX_ROWS, DEFAULT_LIMIT, MAX_FILE_MB, XLSX_HINT,
    previewSource, describeTarget, runEtl,
    listTasks, listRuns, saveTask, deleteTask, pickFile,
    // 解析与转换（供自检使用）
    parseDelimited, parseJson, parseSqlInserts, parseContent, detectDelimiter, inferType,
    transformValue, applyMapping, validateMapping, normalizeDate,
    csvEscape, sqlLiteral, insertStatement, paginate, stripRowNum, buildBatch
};
