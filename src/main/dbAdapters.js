/**
 * 多数据库适配模块
 * - MySQL（mysql2）/ Oracle（oracledb）/ PostgreSQL（pg）均已实现
 * 统一接口：testConnection / query / listTables / describeTable
 * 元数据浏览：metaObjects(支持的分类) / listObjects(分类对象) / objectDdl(对象定义)
 *   - MySQL：表 · 视图 · 存储过程 · 函数 · 触发器 · 定时事件
 *   - Oracle：表 · 视图 · 存储过程/函数 · 包 · 序列 · 触发器 · 调度作业(Scheduler)
 *   - PostgreSQL：表 · 视图(含物化) · 函数 · 序列 · 触发器 · 定时作业(需 pg_cron)
 */
const { decrypt } = require('./crypto');

function loadDriver(name) {
    try {
        return require(name);
    } catch (e) {
        return null;
    }
}

/**
 * 按不区分大小写的键名取值
 * Oracle 在 OUT_FORMAT_OBJECT 下会把列名统一为大写（别名 name → NAME），
 * MySQL 则保留别名原样，因此所有行数据一律通过本函数取值，避免适配层各自处理。
 */
function pick(row, key) {
    if (!row || typeof row !== 'object') return undefined;
    if (key in row) return row[key];
    const upper = key.toUpperCase();
    if (upper in row) return upper === key ? row[key] : row[upper];
    const lower = key.toLowerCase();
    if (lower in row) return row[lower];
    const hit = Object.keys(row).find(k => k.toLowerCase() === lower);
    return hit ? row[hit] : undefined;
}

/** 归一化一行数据的所有键为小写，便于上层统一消费 */
function lowerKeys(row) {
    const out = {};
    if (!row || typeof row !== 'object') return out;
    Object.keys(row).forEach(k => { out[k.toLowerCase()] = row[k]; });
    return out;
}

const DEP_HINT = {
    mysql: '未安装 mysql2 依赖，请先执行：npm install mysql2',
    oracle: '未安装 oracledb 依赖，请先执行：npm install oracledb（需 Oracle Instant Client）',
    postgres: '未安装 pg 依赖，请先执行：npm install pg'
};

const UNSUPPORTED = type => new Error(`暂不支持的数据库类型：${type}`);

/** 对象名白名单：仅允许字母数字下划线与 $ .，防止元数据接口被当作 SQL 注入入口 */
function assertName(name) {
    if (!/^[A-Za-z0-9_$.]+$/.test(String(name))) throw new Error('非法对象名');
    return String(name);
}
const qMySQL = name => '`' + assertName(name).replace(/`/g, '') + '`';
const qPG = name => '"' + assertName(name).replace(/"/g, '') + '"';

async function testConnection(source) {
    const started = Date.now();
    try {
        if (source.type === 'mysql') return await testMysql(source, started);
        if (source.type === 'oracle') return await testOracle(source, started);
        if (source.type === 'postgres') return await testPostgres(source, started);
        return { ok: false, durationMs: Date.now() - started, message: DEP_HINT[source.type] || UNSUPPORTED(source.type).message };
    } catch (e) {
        return { ok: false, durationMs: Date.now() - started, message: '连接失败：' + e.message };
    }
}

async function testMysql(source, started) {
    const mysql = loadDriver('mysql2/promise');
    if (!mysql) return { ok: false, durationMs: Date.now() - started, message: DEP_HINT.mysql };

    const conn = await mysql.createConnection({
        host: source.host,
        port: source.port || 3306,
        user: source.user,
        password: decrypt(source.password),
        database: source.database || undefined,
        connectTimeout: 8000
    });
    const [rows] = await conn.query('SELECT VERSION() AS v');
    await conn.end();
    return {
        ok: true, durationMs: Date.now() - started,
        message: `连接成功 · MySQL ${rows[0].v}`
    };
}

async function testOracle(source, started) {
    const oracledb = loadDriver('oracledb');
    if (!oracledb) return { ok: false, durationMs: Date.now() - started, message: DEP_HINT.oracle };

    const conn = await oracledb.getConnection({
        user: source.user,
        password: decrypt(source.password),
        connectString: `${source.host}:${source.port || 1521}/${source.database}`
    });
    const result = await conn.execute('SELECT banner FROM v$version WHERE rownum = 1');
    await conn.close();
    return {
        ok: true, durationMs: Date.now() - started,
        message: '连接成功 · ' + (result.rows[0] ? result.rows[0][0] : 'Oracle')
    };
}

async function testPostgres(source, started) {
    const pg = loadDriver('pg');
    if (!pg) return { ok: false, durationMs: Date.now() - started, message: DEP_HINT.postgres };
    const client = new pg.Client({
        host: source.host, port: source.port || 5432, user: source.user,
        password: decrypt(source.password), database: source.database || undefined,
        connectionTimeoutMillis: 8000
    });
    await client.connect();
    const r = await client.query('SELECT version() AS v');
    await client.end();
    return {
        ok: true, durationMs: Date.now() - started,
        message: '连接成功 · ' + String(r.rows[0].v).split(',')[0]
    };
}

async function query(source, sql, params = []) {
    if (source.type === 'mysql') {
        const mysql = loadDriver('mysql2/promise');
        if (!mysql) throw new Error(DEP_HINT.mysql);
        const conn = await mysql.createConnection({
            host: source.host, port: source.port || 3306, user: source.user,
            password: decrypt(source.password), database: source.database || undefined
        });
        try {
            const [res] = await conn.query(sql, params);
            // SELECT → 数组；INSERT/UPDATE/DELETE → OkPacket（含 affectedRows）
            if (Array.isArray(res)) {
                return { columns: res[0] ? Object.keys(res[0]) : [], rows: res, affectedRows: null };
            }
            return { columns: [], rows: [], affectedRows: res.affectedRows, info: res.info };
        } finally {
            await conn.end();
        }
    }

    if (source.type === 'oracle') {
        const oracledb = loadDriver('oracledb');
        if (!oracledb) throw new Error(DEP_HINT.oracle);
        const conn = await oracledb.getConnection({
            user: source.user, password: decrypt(source.password),
            connectString: `${source.host}:${source.port || 1521}/${source.database}`
        });
        try {
            // Oracle 默认不自动提交，且本函数每次调用即开即关连接：DML 必须 autoCommit，否则 close 时回滚（表现为「写入成功但无数据」）
            const isDml = /^\s*(insert|update|delete|merge)\b/i.test(sql);
            const result = await conn.execute(sql, params, {
                outFormat: oracledb.OUT_FORMAT_OBJECT,
                autoCommit: isDml
            });
            const rows = Array.isArray(result.rows) ? result.rows : [];
            return {
                columns: result.metaData ? result.metaData.map(m => m.name) : [],
                rows,
                affectedRows: result.rowsAffected != null && rows.length === 0 ? result.rowsAffected : null
            };
        } finally {
            await conn.close();
        }
    }

    if (source.type === 'postgres') {
        const pg = loadDriver('pg');
        if (!pg) throw new Error(DEP_HINT.postgres);
        const client = new pg.Client({
            host: source.host, port: source.port || 5432, user: source.user,
            password: decrypt(source.password), database: source.database || undefined
        });
        await client.connect();
        try {
            const res = await client.query(sql, params);
            return {
                columns: res.fields && res.fields.length ? res.fields.map(f => f.name) : (res.rows[0] ? Object.keys(res.rows[0]) : []),
                rows: res.rows || [],
                affectedRows: typeof res.rowCount === 'number' && !(res.rows || []).length ? res.rowCount : null
            };
        } finally {
            await client.end();
        }
    }

    throw new Error(DEP_HINT[source.type] || UNSUPPORTED(source.type).message);
}

/**
 * 表清单（含注释）
 * 返回：[{ name, comment }]
 */
async function listTables(source) {
    if (source.type === 'mysql') {
        const r = await query(source,
            `SELECT table_name AS name, table_comment AS comment
             FROM information_schema.tables
             WHERE table_schema = ? AND table_type = 'BASE TABLE'
             ORDER BY table_name`, [source.database || null]);
        return r.rows.map(row => ({ name: pick(row, 'name'), comment: pick(row, 'comment') || '' }));
    }
    if (source.type === 'oracle') {
        // comment 是 Oracle 保留字，别名必须加引号（否则 ORA-00923）
        const r = await query(source,
            `SELECT t.table_name AS name, c.comments AS "comment"
             FROM user_tables t LEFT JOIN user_tab_comments c ON c.table_name = t.table_name
             ORDER BY t.table_name`);
        return r.rows.map(row => ({ name: pick(row, 'name'), comment: pick(row, 'comment') || '' }));
    }
    if (source.type === 'postgres') {
        const r = await query(source,
            `SELECT tablename AS name, obj_description(c.oid) AS comment
             FROM pg_catalog.pg_tables t
             JOIN pg_class c ON c.relname = t.tablename
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
             WHERE t.schemaname = current_schema()
             ORDER BY tablename`);
        return r.rows.map(row => ({ name: pick(row, 'name'), comment: pick(row, 'comment') || '' }));
    }
    throw UNSUPPORTED(source.type);
}

/**
 * 单表结构：列名 / 类型 / 可空 / 键 / 默认值
 * 返回：{ columns: [{ name, type, nullable, key, default, extra }] }
 */
async function describeTable(source, table) {
    if (source.type === 'mysql') {
        const r = await query(source,
            `SELECT column_name AS name, column_type AS type, is_nullable AS nullable,
                    column_key AS \`key\`, column_default AS \`default\`, extra
             FROM information_schema.columns
             WHERE table_schema = ? AND table_name = ?
             ORDER BY ordinal_position`, [source.database || null, assertName(table)]);
        return r.rows;
    }
    if (source.type === 'oracle') {
        const r = await query(source,
            `SELECT column_name AS name, data_type || CASE WHEN data_precision IS NOT NULL
                        THEN '(' || data_precision || ')' ELSE '' END AS type,
                    nullable, data_default AS "DEFAULT"
             FROM user_tab_columns WHERE table_name = :1 ORDER BY column_id`, [String(table).toUpperCase()]);
        return r.rows.map(row => lowerKeys({ ...row, key: '', extra: '' }));
    }
    if (source.type === 'postgres') {
        const r = await query(source,
            `SELECT c.column_name AS name, c.data_type AS type, c.is_nullable AS nullable,
                    CASE WHEN kcu.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "key",
                    c.column_default AS "default", '' AS extra
             FROM information_schema.columns c
             LEFT JOIN information_schema.table_constraints tc
                    ON tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND tc.constraint_type = 'PRIMARY KEY'
             LEFT JOIN information_schema.key_column_usage kcu
                    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = c.table_schema
                   AND kcu.table_name = c.table_name AND kcu.column_name = c.column_name
             WHERE c.table_schema = current_schema() AND c.table_name = $1
             ORDER BY c.ordinal_position`, [assertName(table)]);
        return r.rows;
    }
    throw UNSUPPORTED(source.type);
}

/* ==================================================================
 * 元数据对象分类（视图 / 存储过程 / 函数 / 触发器 / 序列 / 作业 / 事件）
 * ================================================================== */

/** 各方言支持的对象分类（tables 恒有；其余按需列出） */
const OBJECT_META = {
    mysql: [
        { id: 'views', label: '视图' },
        { id: 'procedures', label: '存储过程' },
        { id: 'functions', label: '函数' },
        { id: 'triggers', label: '触发器' },
        { id: 'events', label: '定时事件' }
    ],
    oracle: [
        { id: 'views', label: '视图' },
        { id: 'procedures', label: '存储过程/函数' },
        { id: 'packages', label: '包' },
        { id: 'sequences', label: '序列' },
        { id: 'triggers', label: '触发器' },
        { id: 'jobs', label: '调度作业' }
    ],
    postgres: [
        { id: 'views', label: '视图' },
        { id: 'matviews', label: '物化视图' },
        { id: 'functions', label: '函数/过程' },
        { id: 'sequences', label: '序列' },
        { id: 'triggers', label: '触发器' },
        { id: 'jobs', label: '定时作业(cron)' }
    ]
};

function metaObjects(source) {
    return [{ id: 'tables', label: '表' }].concat(OBJECT_META[source.type] || []);
}

/** 列出某分类下的对象：[{ name, comment }] */
async function listObjects(source, category) {
    const type = source.type;
    const db = source.database || null;

    if (category === 'tables') return listTables(source);

    if (type === 'mysql') {
        const SQLS = {
            views: `SELECT table_name AS name, '' AS comment FROM information_schema.views WHERE table_schema = ? ORDER BY table_name`,
            procedures: `SELECT routine_name AS name, routine_comment AS comment FROM information_schema.routines
                         WHERE routine_schema = ? AND routine_type = 'PROCEDURE' ORDER BY routine_name`,
            functions: `SELECT routine_name AS name, routine_comment AS comment FROM information_schema.routines
                         WHERE routine_schema = ? AND routine_type = 'FUNCTION' ORDER BY routine_name`,
            triggers: `SELECT trigger_name AS name, event_table AS comment FROM information_schema.triggers
                       WHERE trigger_schema = ? GROUP BY trigger_name, event_table ORDER BY trigger_name`,
            events: `SELECT event_name AS name, event_comment AS comment FROM information_schema.events WHERE event_schema = ? ORDER BY event_name`
        };
        if (!SQLS[category]) throw new Error(`暂不支持的对象分类：${type} · ${category}`);
        const r = await query(source, SQLS[category], [db]);
        return r.rows.map(row => ({ name: pick(row, 'name'), comment: pick(row, 'comment') || '' }));
    }

    if (type === 'oracle') {
        // comment 是 Oracle 保留字，别名统一加引号
        const SQLS = {
            views: `SELECT view_name AS name, '' AS "comment" FROM user_views ORDER BY view_name`,
            procedures: `SELECT object_name AS name, object_type AS "comment" FROM user_objects
                          WHERE object_type IN ('PROCEDURE','FUNCTION') ORDER BY object_name`,
            packages: `SELECT object_name AS name, status AS "comment" FROM user_objects WHERE object_type = 'PACKAGE' ORDER BY object_name`,
            sequences: `SELECT sequence_name AS name, 'MIN ' || min_value || ' MAX ' || max_value || ' + ' || increment_by AS "comment"
                         FROM user_sequences ORDER BY sequence_name`,
            triggers: `SELECT trigger_name AS name, table_name AS "comment" FROM user_triggers ORDER BY trigger_name`,
            jobs: `SELECT job_name AS name, enabled AS "comment" FROM user_scheduler_jobs ORDER BY job_name`
        };
        if (!SQLS[category]) throw new Error(`暂不支持的对象分类：${type} · ${category}`);
        const r = await query(source, SQLS[category]);
        return r.rows.map(row => ({ name: pick(row, 'name'), comment: pick(row, 'comment') || '' }));
    }

    if (type === 'postgres') {
        const SQLS = {
            views: `SELECT viewname AS name, '' AS comment FROM pg_views WHERE schemaname = current_schema() ORDER BY viewname`,
            matviews: `SELECT matviewname AS name, '' AS comment FROM pg_matviews WHERE schemaname = current_schema() ORDER BY matviewname`,
            functions: `SELECT p.proname AS name,
                               CASE COALESCE(p.prokind,'f') WHEN 'p' THEN '过程' WHEN 'a' THEN '聚合' ELSE '函数' END
                               || ' · ' || pg_get_function_identity_arguments(p.oid) AS comment
                        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = current_schema() ORDER BY p.proname`,
            sequences: `SELECT sequencename AS name, 'start ' || start_value || ' inc ' || increment_by AS comment
                        FROM pg_sequences WHERE schemaname = current_schema() ORDER BY sequencename`,
            triggers: `SELECT t.tgname AS name, c.relname AS comment
                       FROM pg_trigger t
                       JOIN pg_class c ON c.oid = t.tgrelid
                       JOIN pg_namespace n ON n.oid = c.relnamespace
                       WHERE n.nspname = current_schema() AND NOT t.tgisinternal ORDER BY t.tgname`,
            jobs: `SELECT jobname AS name, schedule || ' · ' || command AS comment FROM cron.job ORDER BY jobname`
        };
        if (!SQLS[category]) throw new Error(`暂不支持的对象分类：${type} · ${category}`);
        const r = await query(source, SQLS[category]);
        return r.rows.map(row => ({ name: pick(row, 'name'), comment: pick(row, 'comment') || '' }));
    }

    throw UNSUPPORTED(type);
}

/** 对象定义文本（视图 SELECT / 过程体 / 触发器定义 / 序列属性…）；表不提供 DDL，用列结构展示 */
async function objectDdl(source, category, name) {
    const type = source.type;
    const db = source.database || null;

    if (category === 'tables' || category === 'matviews') {
        const cols = await describeTable(source, name).catch(() => []);
        return `-- 表 ${name}（列结构见展开面板）\n` + cols.map(c => {
            const row = lowerKeys(c);
            return `--   ${row.name} ${row.type || ''}${row.nullable === 'NO' ? ' NOT NULL' : ''}${row.key === 'PRI' ? ' PK' : ''}`;
        }).join('\n');
    }

    if (type === 'mysql') {
        if (category === 'views') {
            const r = await query(source, `SELECT view_definition AS d FROM information_schema.views WHERE table_schema = ? AND table_name = ?`, [db, assertName(name)]);
            return r.rows[0] ? String(pick(r.rows[0], 'd') || '') : '';
        }
        if (category === 'procedures' || category === 'functions') {
            const r = await query(source,
                `SELECT routine_definition AS d, data_type AS ret FROM information_schema.routines
                 WHERE routine_schema = ? AND routine_name = ? AND routine_type = ?`,
                [db, assertName(name), category === 'procedures' ? 'PROCEDURE' : 'FUNCTION']);
            const row = r.rows[0] || {};
            const head = category === 'procedures' ? `CREATE PROCEDURE \`${name}\`` : `CREATE FUNCTION \`${name}\``;
            const body = pick(row, 'd');
            return body ? `-- ${head} ${category === 'functions' ? 'RETURNS ' + (pick(row, 'ret') || '') : ''}\n${body}`
                : '-- 无权限读取例程体（查看 routine 需要全局 SELECT 权限），可在服务器上执行 SHOW CREATE ' + category.toUpperCase();
        }
        if (category === 'triggers') {
            const r = await query(source,
                `SELECT action_statement AS d, event_manipulation AS m, event_object_table AS t, action_timing AS tm
                 FROM information_schema.triggers WHERE trigger_schema = ? AND trigger_name = ? LIMIT 1`, [db, assertName(name)]);
            const row = r.rows[0] || {};
            return row.d ? `-- CREATE TRIGGER \`${name}\` ${pick(row, 'tm')} ${pick(row, 'm')} ON \`${pick(row, 't')}\`\n${pick(row, 'd')}` : '';
        }
        if (category === 'events') {
            const r = await query(source,
                `SELECT event_definition AS d, execute_at, interval_value, interval_field, status
                 FROM information_schema.events WHERE event_schema = ? AND event_name = ?`, [db, assertName(name)]);
            return r.rows[0] ? JSON.stringify(lowerKeys(r.rows[0]), null, 2) : '';
        }
    }

    if (type === 'oracle') {
        const upper = String(assertName(name)).toUpperCase();
        if (category === 'views') {
            const r = await query(source, `SELECT text_vc AS d FROM user_views WHERE view_name = :1`, [upper]);
            const d = r.rows[0] ? pick(r.rows[0], 'd') : '';
            return d ? `-- CREATE OR REPLACE VIEW "${name}" AS\n${d}`
                : '-- 未取到视图定义（text_vc 需 Oracle 12c+；旧版本请在服务器端查询 user_views.text）';
        }
        if (category === 'procedures' || category === 'packages' || category === 'triggers') {
            const types = category === 'packages' ? ['PACKAGE', 'PACKAGE BODY'] : [category === 'triggers' ? 'TRIGGER' : 'PROCEDURE', 'FUNCTION'];
            const parts = [];
            for (const t of types) {
                // eslint-disable-next-line no-await-in-loop
                const r = await query(source, `SELECT line AS l FROM user_source WHERE name = :1 AND type = :2 ORDER BY sequence`, [upper, t]);
                const text = r.rows.map(row => pick(row, 'l')).join('');
                if (text.trim()) parts.push(text);
            }
            return parts.join('\n/\n') || `-- user_source 中未找到 "${upper}"（可能属于其它 Schema 或无权限）`;
        }
        if (category === 'sequences') {
            const r = await query(source,
                `SELECT 'CREATE SEQUENCE ' || sequence_name || ' MINVALUE ' || min_value || ' MAXVALUE ' || max_value
                        || ' START WITH ' || last_number || ' INCREMENT BY ' || increment_by || decode(cycle_flags, 'Y', ' CYCLE', '') AS d
                 FROM user_sequences WHERE sequence_name = :1`, [upper]);
            return r.rows[0] ? String(pick(r.rows[0], 'd')) : '';
        }
        if (category === 'jobs') {
            const r = await query(source,
                `SELECT job_name, enabled, state, repeat_interval, job_action, last_start_date, next_date
                 FROM user_scheduler_jobs WHERE job_name = :1`, [upper]);
            return r.rows[0] ? JSON.stringify(lowerKeys(r.rows[0]), null, 2) : '';
        }
    }

    if (type === 'postgres') {
        if (category === 'views') {
            const r = await query(source,
                `SELECT pg_get_viewdef(c.oid, true) AS d FROM pg_class c
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = current_schema() AND c.relname = $1 AND c.relkind = 'v'`, [assertName(name)]);
            return r.rows[0] ? `-- CREATE OR REPLACE VIEW ${qPG(name)} AS\n${pick(r.rows[0], 'd')}` : '';
        }
        if (category === 'functions') {
            const r = await query(source,
                `SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = current_schema() AND p.proname = $1 LIMIT 1`, [assertName(name)]);
            return r.rows[0] ? String(pick(r.rows[0], 'd')) : '';
        }
        if (category === 'sequences') {
            const r = await query(source,
                `SELECT 'CREATE SEQUENCE ' || quote_ident(schemaname) || '.' || quote_ident(sequencename)
                        || ' INCREMENT ' || increment_by || ' MINVALUE ' || start_value
                        || ' START ' || COALESCE(last_value, start_value) AS d
                 FROM pg_sequences WHERE schemaname = current_schema() AND sequencename = $1`, [assertName(name)]);
            return r.rows[0] ? String(pick(r.rows[0], 'd')) : '';
        }
        if (category === 'triggers') {
            const r = await query(source,
                `SELECT pg_get_triggerdef(t.oid) AS d FROM pg_trigger t
                 JOIN pg_class c ON c.oid = t.tgrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = current_schema() AND t.tgname = $1 LIMIT 1`, [assertName(name)]);
            return r.rows[0] ? String(pick(r.rows[0], 'd')) : '';
        }
        if (category === 'jobs') {
            const r = await query(source, `SELECT jobname, schedule, command FROM cron.job WHERE jobname = $1`, [assertName(name)]);
            return r.rows[0] ? JSON.stringify(lowerKeys(r.rows[0]), null, 2) : '';
        }
    }

    throw UNSUPPORTED(type);
}

/** 驱动可用性一览（用于前端展示） */
function driverStatus() {
    return {
        mysql: !!loadDriver('mysql2/promise'),
        oracle: !!loadDriver('oracledb'),
        postgres: !!loadDriver('pg')
    };
}

module.exports = {
    testConnection, query, listTables, describeTable, driverStatus, DEP_HINT,
    metaObjects, listObjects, objectDdl
};
