/**
 * SSH 批量执行模块
 * - 依赖：ssh2（懒加载，未安装时给出明确提示，不影响主程序启动）
 * - 并发：受 config.maxConcurrency 限制，分批执行，避免压垮内网
 */
const fs = require('fs');
const secrets = require('./secrets');

function loadSsh2() {
    try {
        return require('ssh2');
    } catch (e) {
        return null;
    }
}

const MISSING_DEP = '未安装 ssh2 依赖，请先执行：npm install ssh2';

/**
 * 算法优选：优先协商 Node 原生 OpenSSL 加速的套件（curve25519/ECDH、aes-gcm、etm），
 * 避开 ssh2 纯 JS 实现的慢路径（dh-group1/blowfish/cast 等），握手 CPU 与协商耗时显著下降。
 * 服务端不支持的项会被自动跳过，不影响兼容性。
 */
const FAST_ALGORITHMS = {
    kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256',
        'diffie-hellman-group16-sha512', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
        'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group14-sha1'],
    cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
        'aes128-cbc', 'aes256-cbc'],
    hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha1-etm@openssh.com',
        'hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1'],
    serverHostKey: ['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256', 'ecdsa-sha2-nistp256', 'ssh-rsa'],
    compress: ['none', 'zlib@openssh.com', 'zlib']
};

/** 按主机配置组装认证参数（password/key 二选一；外置密钥文件优先） */
function authOptions(host) {
    if (host.authType === 'password') {
        return { password: secrets.resolve('host:' + host.id, host.password) };
    }
    if (host.keyPath && fs.existsSync(host.keyPath)) {
        const out = { privateKey: fs.readFileSync(host.keyPath) };
        if (host.passphrase) out.passphrase = secrets.resolve('host:' + host.id + ':passphrase', host.passphrase);
        return out;
    }
    if (host.privateKey) return { privateKey: host.privateKey };
    return null;
}

/** 单主机执行命令（一次连接，执行完即断开）；maxOutput 可按调用方需要放宽（如 kubectl -o json） */
function execOnHost(host, cmd, timeoutSec = 30, maxOutput = 20000) {
    return new Promise(resolve => {
        const started = Date.now();
        const base = {
            hostId: host.id, hostName: host.name, ip: host.ip,
            status: 'failed', exitCode: null, output: '', error: '', durationMs: 0
        };

        const ssh2 = loadSsh2();
        if (!ssh2) {
            return resolve({ ...base, error: MISSING_DEP, durationMs: Date.now() - started });
        }

        const conn = new ssh2.Client();
        let settled = false;
        const finish = (patch) => {
            if (settled) return;
            settled = true;
            try { conn.end(); } catch (e) { /* ignore */ }
            resolve({ ...base, ...patch, durationMs: Date.now() - started });
        };

        const timer = setTimeout(() => finish({ error: `执行超时（${timeoutSec}s）` }), timeoutSec * 1000);

        conn.on('ready', () => {
            conn.exec(cmd, (err, stream) => {
                if (err) { clearTimeout(timer); return finish({ error: '命令执行失败：' + err.message }); }
                let stdout = '';
                let stderr = '';
                stream.on('data', d => { stdout += d.toString('utf8'); });
                stream.stderr.on('data', d => { stderr += d.toString('utf8'); });
                stream.on('close', (code) => {
                    clearTimeout(timer);
                    finish({
                        status: code === 0 ? 'success' : 'failed',
                        exitCode: code,
                        output: stdout.slice(0, maxOutput),
                        error: stderr.slice(0, 4000)
                    });
                });
            });
        });

        conn.on('error', err => {
            clearTimeout(timer);
            finish({ error: 'SSH 连接失败：' + err.message });
        });

        const auth = authOptions(host);
        if (!auth) {
            clearTimeout(timer);
            return finish({ error: '未配置认证信息：私钥认证需指定私钥文件路径，或改用密码认证' });
        }
        conn.connect({
            host: host.ip,
            port: host.port || 22,
            username: host.user,
            readyTimeout: Math.max(timeoutSec, 10) * 1000,
            keepaliveInterval: 10000,
            algorithms: FAST_ALGORITHMS,
            ...auth
        });
    });
}

/**
 * 并发批量执行
 * @param {Array} hosts 目标主机
 * @param {string} cmd 命令（或脚本内容）
 * @param {{concurrency?:number, timeout?:number, onProgress?:Function}} opts
 */
async function execBatch(hosts, cmd, opts = {}) {
    const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || 5, 50));
    const timeout = Number(opts.timeout) || 30;
    const results = new Array(hosts.length);
    let cursor = 0;
    let done = 0;

    async function worker() {
        while (cursor < hosts.length) {
            const index = cursor++;
            const host = hosts[index];
            // eslint-disable-next-line no-await-in-loop
            const res = await execOnHost(host, cmd, timeout);
            results[index] = res;
            done++;
            if (typeof opts.onProgress === 'function') opts.onProgress(done, hosts.length, res);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
    return results;
}

/**
 * 连接测试：TCP + 密钥交换 + 认证通过即视为在线。
 * 不再额外开 exec 通道跑 echo（省 1 个 RTT 与通道建立），配合原生算法套件显著缩短单次测试耗时。
 */
function testConnection(host) {
    return new Promise(resolve => {
        const started = Date.now();
        const ssh2 = loadSsh2();
        if (!ssh2) return resolve({ ok: false, message: MISSING_DEP, durationMs: 0 });

        const conn = new ssh2.Client();
        let settled = false;
        const finish = (ok, message) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { conn.end(); } catch (e) { /* ignore */ }
            resolve({ ok, message, durationMs: Date.now() - started });
        };
        const timer = setTimeout(() => finish(false, '连接测试超时（8s）'), 8000);

        conn.on('ready', () => finish(true, 'SSH 连接成功'));
        conn.on('error', err => finish(false, 'SSH 连接失败：' + err.message));

        const auth = authOptions(host);
        if (!auth) return finish(false, '未配置认证信息：私钥认证需指定私钥文件路径，或改用密码认证');
        conn.connect({
            host: host.ip, port: host.port || 22, username: host.user,
            readyTimeout: 8000, algorithms: FAST_ALGORITHMS, ...auth
        });
    });
}

module.exports = { execOnHost, execBatch, testConnection, authOptions, MISSING_DEP, FAST_ALGORITHMS, hasDriver: () => !!loadSsh2() };
