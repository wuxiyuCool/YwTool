/**
 * AI Agent 工具层
 * ------------------------------------------------------------------
 * 把「平台能力」暴露给大模型做 function calling（OpenAI 兼容协议）。
 *
 * 设计约束：
 *   1. 工具默认最小可用：读能力（list_hosts）常开，写/执行类默认关闭
 *   2. 每个工具可声明 gate —— 对应 aiAgent 配置中的开关键，未开启时拒绝执行
 *   3. 本机命令执行必须二次过 security.validate（白名单放行 / 黑名单拦截 + 留痕）
 *   4. 所有写类操作统一写审计日志
 *   5. 返回给模型的文本一律截断，避免长输出撑爆上下文
 *
 * 新增工具：在 TOOLS 里加一条 { name, label, desc, risk, gate, schema, run }
 *   —— 会同时出现在 function calling schema 与「AI 配置」页的工具清单里。
 */
const { exec } = require('child_process');
const os = require('os');
const store = require('./store');
const security = require('./security');
const audit = require('./auditLogger');
const dbAdapters = require('./dbAdapters');
const ssh = require('./ssh');
const containers = require('./containers');

/** 结果文本截断长度（避免长结果撑爆上下文窗口） */
const MAX_RESULT_CHARS = 1800;

const clamp = text => {
    const s = String(text === undefined || text === null ? '' : text);
    return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + `\n…（已截断，共 ${s.length} 字符）` : s;
};

/** 命令跑完但退出码非零（ls 路径不存在 / diff 有差异 / grep 无匹配）是证据而非工具故障 */
const exitNote = (code, base) => {
    const parts = base ? [base] : [];
    if (code !== 0 && code !== null && code !== undefined) {
        parts.push(`命令退出码 ${code}：非零是命令本身的结果（路径不存在/有差异/无匹配等），输出与 stderr 仍是有效证据，不算工具失败，不要因此重试或中断`);
    }
    return parts.length ? parts.join('；') : undefined;
};

/** 会话当前 shell 是否仍在目标主机上（用户可能嵌套 ssh 跳走）；IP/主机名任一命中即算 */
const whereMatches = (w, host) => !!w && (
    (w.ips || []).includes(host.ip) ||
    (!!w.host && (w.host === host.name || w.host === host.ip))
);
const whereText = w => `${w.host || '未知主机'}${(w.ips || []).length ? `（${w.ips.join(', ')}）` : ''}`;

/* ---------------- 随机数据生成（可复现的种子随机） ---------------- */

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SURNAME = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张';
const GIVEN = '伟芳娜秀敏静丽强磊洋艳勇军杰娟涛明超秀霞平刚桂英华';
const DOMAIN = ['corp.local', 'example.com', 'sgops.io', 'test.cn'];
const OS_LIST = ['CentOS 7.9', 'CentOS 8.5', 'Ubuntu 20.04', 'Ubuntu 22.04', 'Rocky 9.2', 'openEuler 22.03'];

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

/** 生成单个字段值 */
function fieldValue(rnd, field, index) {
    const type = String((field && field.type) || 'string').toLowerCase();
    const opts = Array.isArray(field && field.options) && field.options.length ? field.options : null;
    switch (type) {
        case 'int': case 'integer': case 'number': {
            const min = Number.isFinite(field.min) ? field.min : 1;
            const max = Number.isFinite(field.max) ? field.max : 10000;
            return Math.floor(rnd() * (max - min + 1)) + min;
        }
        case 'float': case 'decimal': {
            const min = Number.isFinite(field.min) ? field.min : 0;
            const max = Number.isFinite(field.max) ? field.max : 1000;
            return Number((rnd() * (max - min) + min).toFixed(2));
        }
        case 'bool': case 'boolean': return rnd() > 0.5;
        case 'enum': return opts ? pick(rnd, opts) : '-';
        case 'date': case 'datetime': {
            const base = Date.now() - Math.floor(rnd() * 365 * 24 * 3600 * 1000);
            const d = new Date(base);
            const p = n => String(n).padStart(2, '0');
            const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
            return type === 'date' ? day : `${day} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        }
        case 'phone': return `1${pick(rnd, ['3', '5', '7', '8', '9'])}${String(Math.floor(rnd() * 1e9)).padStart(9, '0')}`;
        case 'email': return `user${index + 1}@${pick(rnd, DOMAIN)}`;
        case 'ip': case 'ipv4': return `${10 + Math.floor(rnd() * 3)}.${Math.floor(rnd() * 256)}.${Math.floor(rnd() * 256)}.${1 + Math.floor(rnd() * 254)}`;
        case 'uuid': return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.floor(rnd() * 16);
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
        case 'name': return pick(rnd, SURNAME.split('')) + pick(rnd, GIVEN.split('')) + (rnd() > 0.6 ? pick(rnd, GIVEN.split('')) : '');
        case 'hostname': return `${pick(rnd, ['app', 'web', 'db', 'cache', 'mq'])}-node-${String(index + 1).padStart(2, '0')}`;
        case 'os': return pick(rnd, OS_LIST);
        default: {
            if (opts) return pick(rnd, opts);
            return `${String((field && field.name) || 'field')}_${index + 1}`;
        }
    }
}

const sqlQuote = v => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    return "'" + String(v).replace(/'/g, "''") + "'";
};

/* ---------------- 工具定义 ---------------- */

const TOOLS = {
    /** 读取主机清单（脱敏）：让 Agent 具备「平台资产」上下文 */
    list_hosts: {
        name: 'list_hosts',
        label: '查询主机清单',
        desc: '查询平台内的主机资产清单（名称/IP/登录用户/状态/标签），不含任何凭据',
        risk: '只读',
        gate: null,
        schema: {
            type: 'object',
            properties: {
                keyword: { type: 'string', description: '按名称/IP/标签过滤，可留空' },
                limit: { type: 'integer', description: '返回条数，默认 20，最大 100' }
            }
        },
        async run(args = {}) {
            const kw = String(args.keyword || '').trim().toLowerCase();
            const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
            const hosts = store.list('hosts')
                .map(h => ({
                    id: h.id, name: h.name, ip: h.ip, port: h.port,
                    user: h.user, authType: h.authType, status: h.status, tags: h.tags || []
                }))
                .filter(h => !kw || [h.name, h.ip, (h.tags || []).join(' ')].join(' ').toLowerCase().includes(kw))
                .slice(0, limit);
            return { ok: true, count: hosts.length, hosts };
        }
    },

    /** 结构化测试数据生成：全部本地合成，不外发 */
    generate_data: {
        name: 'generate_data',
        label: '生成测试数据',
        desc: '按字段定义生成结构化测试数据，支持 json / csv / sql 三种输出格式，数据只在本机合成',
        risk: '低危',
        gate: 'allowDataGenerate',
        schema: {
            type: 'object',
            properties: {
                rows: { type: 'integer', description: '生成行数，最大 1000' },
                format: { type: 'string', enum: ['json', 'csv', 'sql'], description: '输出格式，默认 json' },
                table: { type: 'string', description: 'format=sql 时的目标表名，默认 t_demo' },
                fields: {
                    type: 'array',
                    description: '字段定义：[{name, type, options?, min?, max?}]，type 支持 int/float/string/bool/enum/date/datetime/phone/email/ip/uuid/name/hostname/os',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            type: { type: 'string' },
                            options: { type: 'array', items: { type: 'string' } },
                            min: { type: 'number' },
                            max: { type: 'number' }
                        },
                        required: ['name', 'type']
                    }
                }
            },
            required: ['fields']
        },
        async run(args = {}, ctx = {}) {
            const fields = Array.isArray(args.fields) ? args.fields.filter(f => f && f.name) : [];
            if (!fields.length) return { ok: false, error: 'fields 不能为空' };

            const total = Math.min(Math.max(Number(args.rows) || 10, 1), 1000);
            const maxRows = Number((ctx.agent || {}).maxRows) || 200;
            if (total > maxRows) {
                return { ok: false, error: `请求 ${total} 行超过单次上限 ${maxRows} 行（可在 AI 配置中调整「单工具最大行数」）` };
            }

            const rnd = mulberry32(Date.now() % 2147483647);
            const rows = [];
            for (let i = 0; i < total; i++) {
                const row = {};
                fields.forEach(f => { row[f.name] = fieldValue(rnd, f, i); });
                rows.push(row);
            }

            const format = String(args.format || 'json').toLowerCase();
            if (format === 'csv') {
                const head = fields.map(f => f.name).join(',');
                const body = rows.map(r => fields.map(f => {
                    const v = String(r[f.name] === undefined ? '' : r[f.name]);
                    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
                }).join(','));
                return { ok: true, rowCount: rows.length, format, content: [head].concat(body).join('\n') };
            }
            if (format === 'sql') {
                const table = String(args.table || 't_demo').replace(/[^A-Za-z0-9_$]/g, '');
                const cols = fields.map(f => `\`${f.name}\``).join(', ');
                const values = rows.map(r => `(${fields.map(f => sqlQuote(r[f.name])).join(', ')})`);
                return {
                    ok: true, rowCount: rows.length, format, table,
                    content: `INSERT INTO ${table} (${cols}) VALUES\n${values.join(',\n')};`
                };
            }
            return { ok: true, rowCount: rows.length, format: 'json', content: JSON.stringify(rows, null, 2) };
        }
    },

    /** 把 Agent 产出的代码落库到「脚本管理」 */
    save_script: {
        name: 'save_script',
        label: '保存为脚本',
        desc: '把生成的 Shell / Python 脚本保存到平台的「脚本管理」模块（同名脚本自动升版本号）',
        risk: '中危',
        gate: 'allowSaveScript',
        schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: '脚本名，如 check_disk.sh' },
                type: { type: 'string', enum: ['shell', 'python'], description: '脚本类型' },
                content: { type: 'string', description: '脚本正文' },
                desc: { type: 'string', description: '脚本描述（可选）' }
            },
            required: ['name', 'type', 'content']
        },
        async run(args = {}, ctx = {}) {
            const name = String(args.name || '').trim();
            const type = args.type === 'python' ? 'python' : 'shell';
            const content = String(args.content || '');
            if (!name) return { ok: false, error: '脚本名不能为空' };
            if (!content.trim()) return { ok: false, error: '脚本内容为空' };
            if (content.length > 20000) return { ok: false, error: '脚本内容超过 20000 字符上限' };

            const existing = store.list('scripts').find(s => s.name === name);
            const bump = prev => {
                const m = /^v(\d+)$/.exec(String(prev || 'v0'));
                return 'v' + ((m ? Number(m[1]) : 0) + 1);
            };
            const now = store.nowText();
            const saved = store.upsert('scripts', {
                id: existing ? existing.id : undefined,
                name, type,
                desc: String(args.desc || '').trim() || (existing ? existing.desc : 'AI Agent 生成'),
                content,
                version: bump(existing ? existing.version : 'v0'),
                author: ctx.user || 'ai-agent',
                createdAt: existing ? existing.createdAt : now,
                updatedAt: now
            });
            audit.write({ type: '操作', user: ctx.user || '-', detail: `AI Agent 保存脚本「${name}」（${saved.version}）` });
            return { ok: true, scriptId: saved.id, name: saved.name, version: saved.version };
        }
    },

    /** 本机命令执行：默认关闭，且必须过敏感词黑白名单 */
    run_local_command: {
        name: 'run_local_command',
        label: '执行本机命令',
        desc: '在运行本平台的这台机器上执行一条 Shell 命令并返回输出；受敏感词规则与安全开关约束',
        risk: '高危',
        gate: 'allowLocalExec',
        needsApproval: true,
        schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: '待执行的命令' }
            },
            required: ['command']
        },
        async run(args = {}, ctx = {}) {
            const command = String(args.command || '').trim();
            if (!command) return { ok: false, error: '命令为空' };

            // 先过黑白名单（命中黑名单会写审计 + 触发告警）
            const check = security.validate(command, { user: ctx.user, source: 'AI Agent' });
            if (!check.ok) {
                audit.write({ type: '拦截', user: ctx.user || '-', detail: `AI Agent 命令被拦截：${command}`, result: 'blocked' });
                return { ok: false, blocked: true, error: check.reason };
            }

            const timeoutSec = Number((ctx.agent || {}).commandTimeout) || 15;
            const started = Date.now();
            const output = await new Promise(resolve => {
                exec(command, {
                    timeout: timeoutSec * 1000,
                    maxBuffer: 1024 * 512,
                    cwd: os.homedir(),
                    windowsHide: true
                }, (err, stdout, stderr) => {
                    if (err && !stdout && !stderr) {
                        resolve({ ok: false, error: `执行失败：${err.message}` });
                        return;
                    }
                    resolve({
                        ok: !err,
                        exitCode: err && typeof err.code === 'number' ? err.code : 0,
                        stdout: String(stdout || ''),
                        stderr: String(stderr || (err ? err.message : ''))
                    });
                });
            });

            audit.write({
                type: '命令', user: ctx.user || '-', source: 'AI Agent',
                detail: `AI Agent 本机执行命令：${command}`,
                result: output.ok ? 'success' : 'failed'
            });
            return { ok: output.ok, durationMs: Date.now() - started, ...output };
        }
    },

    /** 数据源只读查询 */
    execute_sql: {
        name: 'execute_sql',
        label: '查询数据源',
        desc: '在已配置的数据源上执行只读 SQL（仅 SELECT / SHOW / DESC / EXPLAIN），返回前若干行结果',
        risk: '高危',
        gate: 'allowSqlExecute',
        scopeKind: 'db', scopeArg: 'sourceId',
        schema: {
            type: 'object',
            properties: {
                sourceId: { type: 'string', description: '数据源 id，可先用 list_db_sources 查询' },
                sql: { type: 'string', description: '只读 SQL 语句' },
                limit: { type: 'integer', description: '返回行数上限，默认 50' }
            },
            required: ['sourceId', 'sql']
        },
        async run(args = {}, ctx = {}) {
            const sql = String(args.sql || '').trim().replace(/;+\s*$/, '');
            if (!sql) return { ok: false, error: 'SQL 为空' };
            if (!/^(select|show|desc|describe|explain)\b/i.test(sql)) {
                return { ok: false, error: '仅允许执行 SELECT / SHOW / DESC / EXPLAIN 等只读语句' };
            }
            if (/;\s*\S/.test(sql)) return { ok: false, error: '不支持一次执行多条语句' };

            const source = store.list('dbSources').find(s => s.id === String(args.sourceId || ''));
            if (!source) return { ok: false, error: '数据源不存在或已被删除' };
            if (source.enabled === false) return { ok: false, error: `数据源「${source.name}」已停用` };

            const limit = Math.min(Math.max(Number(args.limit) || 50, 1), Number((ctx.agent || {}).maxRows) || 200);
            const started = Date.now();
            try {
                // dbAdapters.query 返回 { columns, rows, affectedRows } —— 取 rows 后再裁剪
                const res = await dbAdapters.query(source, sql);
                const list = Array.isArray(res.rows) ? res.rows.slice(0, limit) : [];
                const columns = list.length ? Object.keys(list[0]) : [];
                audit.write({
                    type: '操作', user: ctx.user || '-',
                    detail: `AI Agent 查询数据源「${source.name}」，返回 ${list.length} 行`,
                    result: 'success'
                });
                return { ok: true, sourceName: source.name, rowCount: list.length, columns, rows: list, durationMs: Date.now() - started };
            } catch (err) {
                audit.write({
                    type: '操作', user: ctx.user || '-',
                    detail: `AI Agent 查询数据源「${source.name}」失败：${err.message}`,
                    result: 'failed'
                });
                return { ok: false, error: err.message };
            }
        }
    },

    /** 数据源清单（配合 execute_sql 使用） */
    list_db_sources: {
        name: 'list_db_sources',
        label: '查询数据源清单',
        desc: '列出已配置且启用的数据源（id / 名称 / 类型 / 地址），不含账号密码',
        risk: '只读',
        gate: null,
        schema: { type: 'object', properties: {} },
        async run() {
            const list = store.list('dbSources')
                .filter(s => s.enabled !== false)
                .map(s => ({ id: s.id, name: s.name, type: s.type, host: s.host, port: s.port, database: s.database }));
            return { ok: true, count: list.length, sources: list };
        }
    },

    /** 表结构查看：配合 execute_sql 做数据问题诊断（同属数据源能力开关） */
    describe_table: {
        name: 'describe_table',
        label: '查看表结构',
        desc: '查询数据源中某张表的列结构（名称/类型/可空/主键/默认值），只读元数据',
        risk: '低危',
        gate: 'allowSqlExecute',
        scopeKind: 'db', scopeArg: 'sourceId',
        schema: {
            type: 'object',
            properties: {
                sourceId: { type: 'string', description: '数据源 id（list_db_sources 可查）' },
                table: { type: 'string', description: '表名（仅限字母数字下划线）' }
            },
            required: ['sourceId', 'table']
        },
        async run(args = {}, ctx = {}) {
            const source = store.list('dbSources').find(s => s.id === String(args.sourceId || ''));
            if (!source) return { ok: false, error: '数据源不存在或已被删除' };
            if (source.enabled === false) return { ok: false, error: `数据源「${source.name}」已停用` };
            try {
                const columns = await dbAdapters.describeTable(source, String(args.table || ''));
                audit.write({ type: '操作', user: ctx.user || '-', detail: `AI Agent 查看表结构：${source.name} · ${args.table}` });
                return { ok: true, sourceName: source.name, type: source.type, table: args.table, columns: columns.slice(0, 200) };
            } catch (err) {
                return { ok: false, error: err.message };
            }
        }
    },

    /** 脚本库清单：配合 save_script / 脚本执行链路 */
    list_scripts: {
        name: 'list_scripts',
        label: '查询脚本清单',
        desc: '列出「脚本管理」中托管的 Shell / Python / Compose 脚本（名称/类型/版本/描述），不含正文',
        risk: '只读',
        gate: null,
        schema: {
            type: 'object',
            properties: {
                keyword: { type: 'string', description: '按名称/描述过滤，可留空' }
            }
        },
        async run(args = {}) {
            const kw = String(args.keyword || '').trim().toLowerCase();
            const list = store.list('scripts')
                .filter(s => !kw || `${s.name} ${s.desc || ''}`.toLowerCase().includes(kw))
                .slice(0, 60)
                .map(s => ({ id: s.id, name: s.name, type: s.type, version: s.version, desc: s.desc || '' }));
            return { ok: true, count: list.length, scripts: list };
        }
    },

    /** 远程主机执行单条命令：独立开关，默认关闭；同样过黑白名单 */
    run_host_command: {
        name: 'run_host_command',
        label: '远程主机执行命令',
        desc: '在平台纳管的某台主机上执行一条命令并返回输出；该主机已有用户打开的终端会话时自动复用会话（延续其目录/环境），否则新建 SSH 连接；受敏感词黑白名单约束，建议先用 list_hosts 获取 hostId',
        risk: '高危',
        gate: 'allowRemoteExec',
        scopeKind: 'host', scopeArg: 'hostId', needsApproval: true,
        schema: {
            type: 'object',
            properties: {
                hostId: { type: 'string', description: '主机 id（list_hosts 可查）' },
                command: { type: 'string', description: '待执行的 Shell 命令（单条）' }
            },
            required: ['hostId', 'command']
        },
        async run(args = {}, ctx = {}) {
            const host = store.list('hosts').find(h => h.id === String(args.hostId || ''));
            if (!host) return { ok: false, error: '主机不存在，请先用 list_hosts 查询' };
            const command = String(args.command || '').trim();
            if (!command) return { ok: false, error: '命令为空' };
            if (/[\r\n]/.test(command)) return { ok: false, error: '仅支持单行命令；多步操作请生成脚本走「任务执行」' };

            const check = security.validate(command, { user: ctx.user, source: `AI Agent → ${host.name}` });
            if (!check.ok) {
                audit.write({ type: '拦截', user: ctx.user || '-', detail: `AI Agent 远程命令被拦截（${host.name}）：${command}`, result: 'blocked' });
                return { ok: false, blocked: true, error: check.reason };
            }
            const timeoutSec = store.get('config').cmdTimeout || 30;
            const started = Date.now();
            // 优先复用用户已打开的同主机终端会话（延续其 cwd/环境），避免重复建连丢上下文
            const terminal = require('./handlers/terminalHandler');
            const sess = terminal.listSessions()
                .filter(s => s.hostId === host.id)
                .sort((a, b) => a.idleMs - b.idleMs)[0];
            let jumpNote;
            if (sess) {
                // 先无副作用探测当前 shell 的有效主机：用户可能已嵌套 ssh 跳到别的机器，跳走则不能复用
                const probe = await terminal.agentExec(sess.sessionId, ':', 5000);
                const where = probe.ok && !probe.partial ? { host: probe.currentHost, ips: probe.currentIps || [] } : null;
                if (where && !whereMatches(where, host)) {
                    jumpNote = `终端会话已 ssh 跳转：当前 shell 在 ${whereText(where)}，与目标主机 ${host.name}（${host.ip}）不符，未复用会话，改为新建连接`;
                } else if (where) {
                    const r = await terminal.agentExec(sess.sessionId, command, Math.min(Math.max(timeoutSec, 5), 60) * 1000);
                    if (r.ok) {
                        audit.write({
                            type: '命令', user: ctx.user || '-', source: 'AI Agent',
                            detail: `AI Agent 复用终端会话在 ${host.name}（${host.ip}）执行：${command.slice(0, 200)}（exit=${r.exitCode === null || r.exitCode === undefined ? '?' : r.exitCode}${r.currentHost ? ` @${r.currentHost}` : ''}${r.partial ? '，超时未结束' : ''}）`,
                            result: r.exitCode === 0 ? 'success' : 'failed'
                        });
                        return {
                            ok: true, via: 'terminal-session', sessionId: sess.sessionId,
                            host: host.name, ip: host.ip, durationMs: Date.now() - started,
                            exitCode: r.exitCode === undefined ? null : r.exitCode,
                            currentHost: r.currentHost || null, currentIps: r.currentIps || [],
                            output: clamp(String(r.output || '')),
                            partial: r.partial || undefined,
                            note: exitNote(r.exitCode, '复用用户已打开的终端会话，延续其当前目录与环境')
                        };
                    }
                    // 会话恰好失效（被关闭/断开）：落回新建连接
                }
                // 探测失败（会话失效）：落回新建连接
            }
            const res = await ssh.execOnHost(host, command, timeoutSec);
            const ran = res.exitCode !== null && res.exitCode !== undefined;
            audit.write({
                type: '命令', user: ctx.user || '-', source: 'AI Agent',
                detail: `AI Agent 在 ${host.name}（${host.ip}）执行：${command.slice(0, 200)}` +
                    (ran ? `（exit=${res.exitCode}）` : '') +
                    (res.status !== 'success' && res.error ? ` → ${String(res.error).slice(0, 160)}` : ''),
                result: res.status === 'success' ? 'success' : 'failed'
            });
            return {
                ok: ran || res.status === 'success',
                host: host.name,
                ip: host.ip,
                durationMs: Date.now() - started,
                exitCode: ran ? res.exitCode : null,
                output: clamp(String(res.output || '')),
                stderr: ran && res.error ? clamp(String(res.error)) : undefined,
                error: ran ? undefined : (res.error || '执行失败'),
                note: [jumpNote, ran ? exitNote(res.exitCode) : null].filter(Boolean).join('；') || undefined
            };
        }
    },

    /** 批量执行：与「任务执行」页同链路（execBatch 并发 + 审计），供 AI Agent 操作工作台批量能力 */
    run_batch_command: {
        name: 'run_batch_command',
        label: '批量执行命令',
        desc: '在多台主机（SSH）上并发执行同一条命令并返回逐台结果；受敏感词黑白名单约束，建议先用 list_hosts 获取 hostId 列表；单条命令失败不影响其它主机',
        risk: '高危',
        gate: 'allowRemoteExec',
        scopeKind: 'host', scopeArg: 'hostIds', needsApproval: true,
        schema: {
            type: 'object',
            properties: {
                hostIds: { type: 'array', items: { type: 'string' }, description: '目标主机 id 数组（list_hosts 可查）' },
                command: { type: 'string', description: '待执行的 Shell 命令（单条，所有主机相同）' },
                timeoutSec: { type: 'number', description: '每台主机超时（秒），默认取系统配置' }
            },
            required: ['hostIds', 'command']
        },
        async run(args = {}, ctx = {}) {
            const ids = Array.isArray(args.hostIds) ? args.hostIds.map(String) : [];
            if (!ids.length) return { ok: false, error: 'hostIds 为空，请先用 list_hosts 查询主机' };
            const targets = store.list('hosts').filter(h => ids.includes(String(h.id)));
            if (!targets.length) return { ok: false, error: '未匹配到任何主机（id 可能已失效）' };
            const command = String(args.command || '').trim();
            if (!command) return { ok: false, error: '命令为空' };
            if (/[\r\n]/.test(command)) return { ok: false, error: '仅支持单行命令；多步操作请生成脚本走「任务执行」' };

            const check = security.validate(command, { user: ctx.user, source: `AI Agent 批量 → ${targets.length} 台` });
            if (!check.ok) {
                audit.write({ type: '拦截', user: ctx.user || '-', detail: `AI Agent 批量命令被拦截（${targets.length} 台）：${command}`, result: 'blocked' });
                return { ok: false, blocked: true, error: check.reason };
            }
            const timeout = Number(args.timeoutSec) || store.get('config').cmdTimeout || 30;
            const results = await ssh.execBatch(targets, command, { timeout });
            const summary = results.map(r => {
                const ran = r.exitCode !== null && r.exitCode !== undefined;
                return {
                    host: r.hostName, ip: r.ip,
                    ok: ran || r.status === 'success',
                    exitCode: ran ? r.exitCode : null,
                    durationMs: r.durationMs, output: clamp(String(r.output || '')),
                    stderr: ran && r.error ? clamp(String(r.error)) : undefined,
                    error: ran ? undefined : (r.error || '执行失败')
                };
            });
            const okCount = summary.filter(r => r.ok).length;
            audit.write({
                type: '命令', user: ctx.user || '-', source: 'AI Agent',
                detail: `AI Agent 批量执行：${command.slice(0, 200)}（${targets.length} 台，完成 ${okCount}）` +
                    (okCount < targets.length ? ` → ${summary.filter(r => !r.ok).map(r => `${r.host}:${r.error}`).join('；').slice(0, 160)}` : ''),
                result: okCount === targets.length ? 'success' : 'failed'
            });
            return { ok: okCount === targets.length, total: targets.length, success: okCount, results: summary };
        }
    },

    /** 终端会话清单：配合 terminal_run（在用户已打开的 shell 上排障） */
    list_terminals: {
        name: 'list_terminals',
        label: '查询终端会话',
        desc: '列出用户当前在终端工作台打开的交互式 SSH 会话（sessionId / 主机名 / 空闲时长 / currentHost+currentIps=最近探测到的有效主机，用户嵌套 ssh 跳转后会与建连主机不同），供 terminal_run 指定目标',
        risk: '只读',
        gate: null,
        schema: { type: 'object', properties: {} },
        async run() {
            const sessions = require('./handlers/terminalHandler').listSessions();
            return { ok: true, count: sessions.length, sessions };
        }
    },

    /** 在指定终端会话执行命令：与用户共享同一 shell（cwd/环境变量延续），适合排障 */
    terminal_run: {
        name: 'terminal_run',
        label: '终端会话执行命令',
        desc: '在用户已打开的某个终端会话（交互式 SSH shell）中执行一条单行命令并回传输出；先用 list_terminals 获取 sessionId。与新建连接不同，这里延续用户当前 shell 的目录与环境，适合顺着用户排障上下文继续操作',
        risk: '高危',
        gate: 'allowRemoteExec',
        scopeKind: 'terminal', scopeArg: 'sessionId', needsApproval: true,
        schema: {
            type: 'object',
            properties: {
                sessionId: { type: 'string', description: '终端会话 id（list_terminals 可查）' },
                command: { type: 'string', description: '待执行的单行命令' },
                timeoutSec: { type: 'number', description: '等待输出上限（秒），默认 20' }
            },
            required: ['sessionId', 'command']
        },
        async run(args = {}, ctx = {}) {
            const terminal = require('./handlers/terminalHandler');
            const command = String(args.command || '').trim();
            if (!command) return { ok: false, error: '命令为空' };
            // 与 run_host_command 同边界：Agent 下发的命令必须过黑白名单（用户手动键入不在此列）
            const check = security.validate(command, { user: ctx.user, source: 'AI Agent → 终端会话' });
            if (!check.ok) {
                audit.write({ type: '拦截', user: ctx.user || '-', detail: `AI Agent 终端命令被拦截：${command}`, result: 'blocked' });
                return { ok: false, blocked: true, error: check.reason };
            }
            const timeout = Math.min(Math.max(Number(args.timeoutSec) || 20, 5), 60) * 1000;
            const res = await terminal.agentExec(String(args.sessionId || ''), command, timeout);
            audit.write({
                type: '命令', user: ctx.user || '-', source: 'AI Agent',
                detail: `AI Agent 在终端会话（${res.hostName || args.sessionId}）执行：${command.slice(0, 200)}` +
                    (res.ok && res.exitCode !== null && res.exitCode !== undefined ? `（exit=${res.exitCode}）` : '') +
                    (res.ok && res.currentHost ? ` @${res.currentHost}` : '') +
                    (res.ok ? '' : ` → ${String(res.error || '').slice(0, 160)}`),
                result: res.ok ? 'success' : 'failed'
            });
            if (res.ok) {
                // 会话可能被用户嵌套 ssh 跳走：标明命令实际落在哪台机器，避免归因到建连主机
                const sess = terminal.listSessions().find(x => x.sessionId === String(args.sessionId || ''));
                const home = sess && store.list('hosts').find(h => h.id === sess.hostId);
                const where = { host: res.currentHost, ips: res.currentIps || [] };
                const jumped = home && (where.host || where.ips.length) && !whereMatches(where, home);
                const base = jumped
                    ? `该会话已 ssh 跳转：命令实际执行在 ${whereText(where)}，而非建连主机 ${home.name}（${home.ip}），结论请归因到有效主机`
                    : '在用户已打开的终端会话执行，延续其当前目录与环境';
                return { ...res, note: exitNote(res.exitCode, base) };
            }
            return res;
        }
    },

    /** 流量包聚合分析：只分析用户已在「流量分析」页打开的文件，不接收路径 */
    analyze_pcap: {
        name: 'analyze_pcap',
        label: '分析已打开的流量包',
        desc: '对用户当前在「安全运维→网络安全→流量分析」打开的 pcap/pcapng 做聚合分析：协议占比、Top 主机/会话、RST 与 SYN 无应答、HTTP 4xx/5xx 清单、TLS SNI 域名；未打开文件时返回引导提示，可配合 get_proxy_summary 做网络排障',
        risk: '只读',
        gate: null,
        schema: { type: 'object', properties: {} },
        async run(args = {}, ctx = {}) {
            const pcap = require('./pcap');
            const res = pcap.analyze();
            if (res.ok) audit.write({ type: '查询', user: ctx.user || '-', source: 'AI Agent', detail: `AI Agent 分析流量包 ${res.file}（${res.total} 报文）` });
            return res;
        }
    },

    /** 抓包代理概况：运行状态 + 流水统计 + 按进程聚合，不含 header/body */
    get_proxy_summary: {
        name: 'get_proxy_summary',
        label: '查看抓包代理概况',
        desc: '查看本地抓包代理（类 Fiddler）状态与流量统计。返回两个口径：thisRun=本次启动以来（与界面统计条一致）；history=持久化滚动历史（跨多次运行，旧记录可能无进程名）。回答时必须标注数字所属口径，不要把 history 条数说成当前流量。不含请求头与正文',
        risk: '只读',
        gate: null,
        schema: { type: 'object', properties: {} },
        async run() {
            return require('./netsec').trafficSummary();
        }
    },

    /** 容器概览：只读，默认本机 Docker 端点，可传端点 id */
    list_containers: {
        name: 'list_containers',
        label: '查询容器清单',
        desc: '查询 Docker 端点上的容器（名称/镜像/状态/compose 项目）；不传 hostId 时使用本机默认端点',
        risk: '只读',
        gate: null,
        schema: {
            type: 'object',
            properties: {
                hostId: { type: 'string', description: 'Docker 端点 id（可留空 = 本机第一个端点）' },
                runningOnly: { type: 'boolean', description: '仅看运行中容器，默认 false' }
            }
        },
        async run(args = {}) {
            const hosts = store.list('dockerHosts');
            const host = args.hostId ? hosts.find(h => h.id === String(args.hostId)) : hosts[0];
            if (!host) return { ok: false, error: '未配置 Docker 端点（请到「服务器运维 → 容器运维」添加）' };
            try {
                const list = await containers.listContainers(host, !args.runningOnly);
                return {
                    ok: true, endpoint: host.name, count: list.length,
                    containers: list.slice(0, 80).map(c => ({
                        id: c.id, name: c.name, image: c.image, state: c.state, status: c.status, project: c.project || ''
                    }))
                };
            } catch (err) {
                return { ok: false, error: err.message };
            }
        }
    },

    /** B2 结构化收尾报告（dsh Report 语义）：面板按状态徽章区分「完成/等人/失败」，不靠自由文本猜 */
    agent_report: {
        name: 'agent_report',
        label: '任务状态报告',
        desc: '报告结构化状态：progress=阶段进展播报（不结束任务，可继续干活；长任务每完成 2~3 个工具步骤播报一次，summary 必须含新信息，无新进展时重复播报会被平台判为空转）；ready=完成且结果可用；blocked=需要人决策或提供信息才能继续（必须给 question）；failed=尝试过但无法完成；dropped=检查后确认无需动作。除 progress 外调用即结束当前任务回合',
        risk: '只读',
        gate: null,
        schema: {
            type: 'object',
            properties: {
                status: { type: 'string', enum: ['progress', 'ready', 'blocked', 'failed', 'dropped'], description: 'progress=进展播报；其余为回合终态' },
                summary: { type: 'string', description: '一句话结论（完成了什么/缺什么/为何无需动作）' },
                evidence: { type: 'string', description: '关键证据：调用了哪些工具、关键输出' },
                question: { type: 'string', description: 'blocked 时必填：需要人回答的一个具体问题' }
            },
            required: ['status', 'summary']
        },
        async run(args = {}) {
            const status = ['progress', 'ready', 'blocked', 'failed', 'dropped'].includes(args.status) ? args.status : null;
            if (!status) return { ok: false, error: 'status 必须是 progress/ready/blocked/failed/dropped 之一' };
            const summary = String(args.summary || '').trim();
            if (!summary) return { ok: false, error: 'summary 不能为空' };
            const question = String(args.question || '').trim();
            if (status === 'blocked' && !question) return { ok: false, error: 'blocked 必须提供 question（一次只问一个具体问题）' };
            return {
                ok: true,
                report: { status, summary, evidence: String(args.evidence || '').trim() || undefined, question: question || undefined }
            };
        }
    },

    /** §6.12 对话接单（D20~D22）：多轮对话研判后生成工单草稿，人工在工作台确认后才派工 */
    propose_ticket: {
        name: 'propose_ticket',
        label: '生成工单草稿',
        desc: '把与用户对话澄清后的运维问题生成结构化工单草稿（标题/严重度/范围/详情）。草稿不会执行，需人工到「系统运维 → Agent 工作台」确认后才派工。仅在用户要求把问题立为工单处理时使用；范围只能引用 list_hosts/list_db_sources 给出的真实 id',
        risk: '只读',
        gate: null,
        schema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '不超过 40 字的工单标题' },
                detail: { type: 'string', description: '问题详情：现象/影响/对话中澄清的目标与期望结果/已核实的关键事实' },
                severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: '严重度，缺省 medium' },
                hostIds: { type: 'array', items: { type: 'string' }, description: '涉及的平台主机 id（可空）' },
                dbIds: { type: 'array', items: { type: 'string' }, description: '涉及的数据源 id（可空）' },
                profileId: { type: 'string', description: '可选：指定执行档案 id，留空跟随全局默认' }
            },
            required: ['title', 'detail']
        },
        async run(args = {}, ctx = {}) {
            // worker 执行中禁止再建单：扩权 = 新工单，必须人工发起（防递归派工）
            if (ctx.user === 'agent-worker') return { ok: false, error: '工单执行中不能再生成新工单（范围扩张需人工另行发起）' };
            const router = require('./agentRouter');   // 延迟加载避免 agentTools↔agentRouter 循环依赖
            const r = router.proposeTicket({
                title: args.title, detail: args.detail, severity: args.severity,
                scope: { hostIds: args.hostIds, dbIds: args.dbIds }, profileId: args.profileId
            });
            if (!r.ok) return { ok: false, error: r.message };
            return {
                ok: true, ticketId: r.ticket.id, title: r.ticket.title, severity: r.ticket.severity, scope: r.ticket.scope,
                note: '草稿已生成，尚未执行。请告知用户草稿标题与范围，并提示到「系统运维 → Agent 工作台」确认派工（演练模式下确认仅记录不执行）'
            };
        }
    },

    /** C6 压缩上下文检索（billion-context 模型驱动形态）：在摘要与原文中关键词检索 */
    search_context: {
        name: 'search_context',
        label: '检索压缩上下文',
        desc: '关键词检索已被压缩的历史摘要与原文，返回匹配摘录和块 key（key 供 decompress 恢复原文）',
        risk: '只读',
        gate: null,
        schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '检索关键词' }
            },
            required: ['query']
        },
        async run(args = {}) {
            const q = String(args.query || '').trim().toLowerCase();
            if (!q) return { ok: false, error: 'query 不能为空' };
            const list = store.get('aiCtxSummaries') || [];
            const hits = [];
            for (const e of list) {
                const hay = String(e.summary || '') + '\n' + String(e.original || '');
                const idx = hay.toLowerCase().indexOf(q);
                if (idx >= 0) hits.push({ key: e.key, excerpt: hay.slice(Math.max(0, idx - 80), idx + 200) });
            }
            return { ok: true, count: hits.length, hits: hits.slice(0, 8) };
        }
    },

    /** C6 按块恢复被压缩的原文（临时注入本轮上下文，不永久展开） */
    decompress: {
        name: 'decompress',
        label: '恢复压缩原文',
        desc: '按 search_context 返回的块 key 恢复被压缩历史的原文（只注入当前对话，不改变压缩状态）',
        risk: '只读',
        gate: null,
        schema: {
            type: 'object',
            properties: {
                key: { type: 'string', description: 'search_context 返回的块 key' }
            },
            required: ['key']
        },
        async run(args = {}) {
            const e = (store.get('aiCtxSummaries') || []).find(x => x.key === String(args.key || ''));
            if (!e) return { ok: false, error: '块不存在或已过期（缓存上限 200 条 LRU）' };
            const original = String(e.original || '');
            return {
                ok: true, key: e.key,
                original: original.length > 6000 ? original.slice(0, 6000) + `\n…（原文过长，已截断，共 ${original.length} 字符）` : (original || '（该块未保存原文）')
            };
        }
    }
};

/* ---------------- 对外接口 ---------------- */

/** OpenAI 兼容的 function calling schema */
const toolSchemas = (allowedTools = null) => Object.values(TOOLS)
    .filter(t => !allowedTools || allowedTools.includes(t.name))
    .map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: `${t.desc}（风险等级：${t.risk}）`,
            parameters: t.schema
        }
    }));

/** 工具元信息（供「AI 配置」页展示能力清单） */
const toolCatalog = () => Object.values(TOOLS).map(t => ({
    name: t.name, label: t.label, desc: t.desc, risk: t.risk, gate: t.gate,
    scopeKind: t.scopeKind || null, needsApproval: !!t.needsApproval
}));

/**
 * 执行单个工具
 * @param {string} name 工具名
 * @param {object} args 工具入参（已由调用方 JSON 解析）
 * @param {{user?:string, agent?:object}} ctx 执行上下文
 * @returns {Promise<{ok:boolean, [key:string]:any}>}
 */
async function runTool(name, args = {}, ctx = {}) {
    const tool = TOOLS[name];
    if (!tool) return { ok: false, error: `未知工具：${name}` };

    // 开关门禁：写/执行类工具未开启时直接拒绝
    if (tool.gate && !(ctx.agent || {})[tool.gate]) {
        return { ok: false, error: `工具「${tool.label}」未在 AI 配置中开启，请到「AI 配置 → Agent 能力」启用后重试` };
    }
    if (ctx.agent && ctx.agent.enabled === false) {
        return { ok: false, error: 'Agent 总开关已关闭，无法调用任何工具' };
    }

    // 目标圈定：用户在 AI 面板勾选了操作范围时，工具目标必须落在范围内
    if (tool.scopeKind) {
        const scopeErr = checkScope(tool, args, ctx);
        if (scopeErr) return { ok: false, error: scopeErr };
    }

    // 执行模式三态（B3/D4）：approve=弹窗审批 · observe=演练不实执 · auto=免审
    const execMode = ['approve', 'observe', 'auto'].includes((ctx.agent || {}).execMode)
        ? ctx.agent.execMode
        : ((ctx.agent || {}).execApproval === false ? 'auto' : 'approve');

    // 演练模式：高危执行不下发，只记录「本来会执行什么」；黑白名单照常校验（演练也要暴露违规）
    if (tool.needsApproval && execMode === 'observe') {
        const command = String(args.command || '');
        if (command) {
            const check = security.validate(command, { user: ctx.user, source: 'AI Agent 演练' });
            if (!check.ok) {
                audit.write({ type: '拦截', user: ctx.user || '-', detail: `AI Agent 演练命令被拦截：${command}`, result: 'blocked' });
                return { ok: false, blocked: true, error: check.reason };
            }
        }
        audit.write({ type: '操作', user: ctx.user || '-', detail: `AI Agent 演练（未下发）：${tool.label} ${JSON.stringify(args).slice(0, 200)}`, result: 'success' });
        return { ok: true, dryRun: true, wouldRun: { tool: name, label: tool.label, args } };
    }

    // 执行审批：approve 模式下高危执行前请求用户确认（拒绝/超时不执行）
    if (tool.needsApproval && execMode === 'approve' && typeof ctx.approve === 'function') {
        const approved = await ctx.approve({ name: tool.name, label: tool.label, args });
        if (!approved) {
            audit.write({ type: '拦截', user: ctx.user || '-', result: 'blocked', detail: `用户拒绝了 AI Agent 执行「${tool.label}」` });
            return { ok: false, denied: true, error: '用户拒绝了本次执行（可在对话中说明原因或换一种方式）' };
        }
    }

    try {
        const result = await tool.run(args, ctx);
        if (result && typeof result === 'object' && 'content' in result) return { ...result, content: clamp(result.content) };
        return result;
    } catch (err) {
        return { ok: false, error: `工具执行异常：${err.message}` };
    }
}

const SCOPE_KEY = { host: 'hostIds', db: 'dbIds', terminal: 'sessionIds' };
const SCOPE_LABEL = { host: '主机', db: '数据源', terminal: '终端会话' };

/** 返回错误文案（null=放行）。scope 缺失=未启用圈定；某类清单存在但为空 → 拒绝并提示圈定 */
function checkScope(tool, args = {}, ctx = {}) {
    const scope = ctx.scope;
    if (!scope) return null;
    const list = scope[SCOPE_KEY[tool.scopeKind]];
    if (!Array.isArray(list)) return null;
    if (!list.length) {
        return `当前未圈定任何${SCOPE_LABEL[tool.scopeKind]}目标：请提示用户在 AI 面板「操作目标」中勾选${SCOPE_LABEL[tool.scopeKind]}后再继续`;
    }
    const raw = args[tool.scopeArg];
    const targets = Array.isArray(raw) ? raw : [raw];
    const bad = targets.filter(x => !list.includes(String(x)));
    if (bad.length) {
        return `目标 [${bad.join(', ')}] 不在用户圈定的${SCOPE_LABEL[tool.scopeKind]}范围内；只允许：[${list.join(', ')}]`;
    }
    return null;
}

module.exports = { TOOLS, toolSchemas, toolCatalog, runTool };
