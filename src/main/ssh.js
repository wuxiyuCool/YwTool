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

        const options = {
            host: host.ip,
            port: host.port || 22,
            username: host.user,
            readyTimeout: Math.max(timeoutSec, 10) * 1000,
            keepaliveInterval: 10000
        };

        if (host.authType === 'password') {
            options.password = secrets.resolve('host:' + host.id, host.password);
        } else if (host.keyPath && fs.existsSync(host.keyPath)) {
            options.privateKey = fs.readFileSync(host.keyPath);
            if (host.passphrase) options.passphrase = secrets.resolve('host:' + host.id + ':passphrase', host.passphrase);
        } else if (host.privateKey) {
            options.privateKey = host.privateKey;
        } else {
            clearTimeout(timer);
            return finish({ error: '未配置认证信息：私钥认证需指定私钥文件路径，或改用密码认证' });
        }

        conn.connect(options);
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

/** 连接测试 */
async function testConnection(host) {
    const res = await execOnHost(host, 'echo __SGOPS_OK__', 10);
    return {
        ok: res.status === 'success' && res.output.includes('__SGOPS_OK__'),
        message: res.status === 'success' ? 'SSH 连接成功' : (res.error || 'SSH 连接失败'),
        durationMs: res.durationMs
    };
}

module.exports = { execOnHost, execBatch, testConnection, MISSING_DEP, hasDriver: () => !!loadSsh2() };
