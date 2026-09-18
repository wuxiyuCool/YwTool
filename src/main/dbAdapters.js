/**
 * 多数据库适配模块
 * - 已实现：MySQL（依赖 mysql2）
 * - 预留：Oracle（依赖 oracledb，含原生模块）、PostgreSQL（预留驱动接口）
 * 统一接口：testConnection(source) / query(source, sql, params)
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
    if (upper in row) return row[upper];
    const lower = key.toLowerCase();
    if (lower in row) return row[lower];
    // 兜底：全表扫描一次（列数很少，开销可忽略）
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

async function testConnection(source) {
    const started = Date.now();
    try {
        if (source.type === 'mysql') return await testMysql(source, started);
        if (source.type === 'oracle') return await testOracle(source, started);
        return {
            ok: false, durationMs: Date.now() - started,
            message: DEP_HINT[source.type] || `暂不支持的数据库类型：${source.type}`
        };
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
            const result = await conn.execute(sql, params, { outFormat: oracledb.OUT_FORMAT_OBJECT });
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

    throw new Error(DEP_HINT[source.type] || `暂不支持的数据库类型：${source.type}`);
}

/**
 * 表结构浏览
 * 返回：{ tables: [{ name, comment? }] }
 */
async function listTables(source) {
    if (source.type === 'mysql') {
        const r = await query(source,
            `SELECT table_name AS name, table_comment AS comment
             FROM information_schema.tables
             WHERE table_schema = ?
             ORDER BY table_name`, [source.database || null]);
        return r.rows.map(row => ({ name: row.name, comment: row.comment }));
    }
    if (source.type === 'oracle') {
        const r = await query(source,
            `SELECT table_name AS name FROM user_tables ORDER BY table_name`);
        return r.rows.map(row => ({ name: pick(row, 'name'), comment: '' }));
    }
    if (source.type === 'postgres') {
        throw new Error(DEP_HINT.postgres);
    }
    throw new Error(`暂不支持的数据库类型：${source.type}`);
}

/**
 * 单表结构：列名 / 类型 / 可空 / 键 / 默认值
 * 返回：{ columns: [{ name, type, nullable, key, default, extra }] }
 */
async function describeTable(source, table) {
    // 表名仅允许 [字母数字_$.]，防止把表结构浏览接口当 SQL 注入入口
    if (!/^[A-Za-z0-9_$.$]+$/.test(String(table))) {
        throw new Error('非法表名');
    }

    if (source.type === 'mysql') {
        const r = await query(source,
            `SELECT column_name AS name, column_type AS type, is_nullable AS nullable,
                    column_key AS key, column_default AS default, extra
             FROM information_schema.columns
             WHERE table_schema = ? AND table_name = ?
             ORDER BY ordinal_position`, [source.database || null, table]);
        return r.rows;
    }
    if (source.type === 'oracle') {
        const r = await query(source,
            `SELECT column_name AS name, data_type AS type, nullable, data_default AS "DEFAULT"
             FROM user_tab_columns WHERE table_name = :1 ORDER BY column_id`, [table.toUpperCase()]);
        return r.rows.map(row => lowerKeys({ ...row, key: '', extra: '' }));
    }
    throw new Error(DEP_HINT[source.type] || `暂不支持的数据库类型：${source.type}`);
}

/** 驱动可用性一览（用于前端展示） */
function driverStatus() {
    return {
        mysql: !!loadDriver('mysql2/promise'),
        oracle: !!loadDriver('oracledb'),
        postgres: !!loadDriver('pg')
    };
}

module.exports = { testConnection, query, listTables, describeTable, driverStatus, DEP_HINT };
