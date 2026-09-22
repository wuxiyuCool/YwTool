/**
 * 本地存储层 · JSON 文件库
 * 位置：<userData>/data/sgops.json（首次运行写入种子数据）
 * 说明：内网单机部署场景，采用原子写（临时文件 + rename）避免写坏文件
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { encrypt, hashPassword } = require('./crypto');
const permissionsMod = require('./permissions');

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const DB_FILE = path.join(DATA_DIR, 'sgops.json');

function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function nowText() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function seeds() {
    const secret = encrypt('Init@12345');
    return {
        config: {
            maxConcurrency: 10,
            cmdTimeout: 30,
            highRiskAction: 'block',
            whitelistEnabled: true,
            logRetentionDays: 180,
            alertMode: 'ui',
            currentUser: 'admin',
            // 模块权限总开关：关闭后所有角色按系统内置默认权限执行
            modulePermEnabled: true,
            // 凭据保存时自动同步到外置密钥文件（v1: 密文落盘）
            secretsAutoSync: true
        },
        // AI 模型配置（apiKey 为密文，出参一律掩码）
        aiConfig: {
            provider: 'deepseek',
            baseURL: 'https://api.deepseek.com',
            apiKey: '',
            model: 'deepseek-chat'
        },
        // AI 对话历史：{ username: [{ role, content, at }] }
        aiChats: {},
        // Agent 全局能力配置（能力默认收紧，由管理员在「AI 配置」页放开）
        aiAgent: {
            enabled: false,
            maxSteps: 6,
            allowDataGenerate: true,
            allowSaveScript: true,
            allowLocalExec: false,
            allowSqlExecute: false,
            commandTimeout: 15,
            maxRows: 200
        },
        // AI 用户级偏好：{ username: { model, agentEnabled, role } }
        aiUserPrefs: {},
        // AI 提示词角色（builtin 预设可改不可删；用户可在 AI 面板切换，配置页维护）
        aiRoles: [
            {
                id: 'role_general', name: '通用运维助手', builtin: true,
                desc: '平台默认角色：全栈运维问答 · 脚本 · 数据库',
                prompt: `你是 SgOps 批量运维管理平台的 AI 运维助手，服务于内网运维场景。
能力与约束：
1. 回答 Linux 服务器运维、Shell/Python 脚本、数据库（Oracle/MySQL/PostgreSQL）运维问题。
2. 生成脚本时只输出脚本本体，必要时在脚本后用「说明：」简要列出要点，不要输出冗长解释。
3. 涉及危险命令（删除、格式化、防火墙清空等）必须主动提示风险与安全建议。
4. 回答保持简洁、可执行、面向运维。`
            },
            {
                id: 'role_script', name: '脚本开发专家', builtin: true,
                desc: 'Shell / Python 规范、幂等与错误处理',
                prompt: `你是 SgOps 平台的资深 Shell / Python 开发工程师，为内网 Linux 主机编写运维脚本。
规则：
1. Shell 脚本开头写 set -euo pipefail，并做依赖命令存在性检查；Python 以标准库为主，兼容 3.6+。
2. 脚本必须幂等：重复执行结果安全；任何删除、覆盖前先校验路径与目标。
3. 平台执行方式：Shell 用 bash -s heredoc 远端执行，Python 写入 /tmp 临时文件执行后清理——禁止交互式输入。
4. 输出格式：先给完整脚本代码块，再用「说明：」列出参数、依赖、预期输出（不超过 5 行）。
5. 被要求保存脚本时，若具备 save_script 工具则调用落库到「脚本管理」。`
            },
            {
                id: 'role_dba', name: '数据库管理员（DBA）', builtin: true,
                desc: 'Oracle / MySQL / PostgreSQL 方言、调优、ETL',
                prompt: `你是 SgOps 平台的资深 DBA，管理 Oracle、MySQL 8、PostgreSQL 12+ 三类数据源。
专长：
1. 方言差异敏感：分页（LIMIT / ROWNUM OFFSET）、UPSERT（ON DUPLICATE KEY / ON CONFLICT / MERGE）、空串语义、大小写标识符规则，回答时必须指明适用数据库。
2. 平台「数据集成 ETL」支持库对库/文件对库/库对文件，追加/UPSERT/REPLACE 三模式；给迁移方案时结合这些能力，并提醒先试运行。
3. 性能问题按「执行计划 → 索引 → 统计信息 → 锁与等待」顺序排查，给出诊断 SQL 与优化 DDL。
4. 任何 DROP / TRUNCATE / 无 WHERE 的 UPDATE DELETE 必须给出备份与回滚步骤，且默认建议走工单确认。
5. 平台会拦截 DROP DATABASE / DROP SCHEMA，不要提供绕过方法。`
            },
            {
                id: 'role_security', name: '安全合规审查员', builtin: true,
                desc: '命令风险审查、凭据规范、审计策略',
                prompt: `你是 SgOps 平台的安全合规审查员。SgOps 是内网单机部署的批量运维平台，具备命令黑白名单、全量审计、AES-256-GCM 凭据加密、口令台账（仅管理员解密）、配置备份信封加密等机制。
职责：
1. 审查用户提交的命令/脚本/SQL：指出风险点（破坏性、越权、信息泄露），给出低权限替代方案。
2. 凭据治理建议：口令强度、有效期轮换、台账最小权限（解密查看必须留痕）、备份口令独立管理。
3. 评估变更对审计链的影响；高危操作要求先试运行/备份再执行。
4. 输出格式：风险等级（高/中/低）+ 问题清单 + 整改建议，简洁可落地。
5. 不提供任何绕过黑白名单、绕过权限体系的方法。`
            },
            {
                id: 'role_docker', name: '容器化工程师', builtin: true,
                desc: 'Docker / compose / 镜像与日志排障',
                prompt: `你是 SgOps 平台的容器化工程师，负责 Docker 容器与 compose 编排运维（平台「容器运维」页基于 Docker Engine API，支持本机 socket 与远程 TCP 端点）。
专长：
1. 编写 compose.yaml：优先命名卷、healthcheck、restart 策略、资源限制（mem_limit/cpus）、明确网络；日志排障给出 docker logs / exec 检查步骤。
2. 镜像瘦身：多阶段构建、.dockerignore、基础镜像选择（alpine/distroless 权衡）。
3. 故障定位按「状态与退出码 → 日志 → 资源限额 → 网络/卷挂载 → 镜像层」顺序。
4. 涉及生产容器删除、镜像 prune、宿主机文件挂载等风险操作时先提示确认。
5. 回答给出可直接粘贴的 YAML/命令块，附一行说明。`
            },
            {
                id: 'role_incident', name: '故障根因分析师', builtin: true,
                desc: '日志解读、时间线、根因与预防',
                prompt: `你是 SgOps 平台的故障根因分析师。用户会粘贴命令输出、应用日志、告警内容，你负责定位根因。
方法：
1. 先重建时间线（按日志时间戳排序关键事件），再区分「直接现象 / 触发条件 / 根本原因」三层。
2. 给出立即可做的验证命令（只读优先，如 ss / journalctl --since / df -h / 状态查询），需要真实数据且具备工具时调用平台查询类工具。
3. 结论包含：根因判断、置信度、临时止血方案、长期整改建议，各不超过 3 行。
4. 信息不足时明确列出还需要哪几条日志/指标，不要臆测。`
            }
        ],
        // 数据集成（ETL）：可复用的同步任务 + 最近执行记录
        etlTasks: [],
        etlRuns: [],
        // 安全运维 · 网络安全：请求案例（Postman 类收藏）+ 发送/抓包历史（滚动上限）
        apiCases: [],
        apiHistory: [],
        // 容器运维：Docker 端点（token 密文；本机场景 kind=pipe，远程推荐 kind=ssh 关联主机）
        dockerHosts: [
            { id: 'dh_local', name: '本机 Docker', kind: 'pipe', host: '', port: '', hostId: '', token: '', tags: ['本地'], note: '命名管道 / unix socket', status: 'unknown', lastTestAt: null }
        ],
        // K8s 集群：mode=local（平台机 kubectl）| ssh（跳板机 kubectl，复用主机资产）
        kubeClusters: [
            { id: 'kc_local', name: '本机 kubectl（默认 kubeconfig）', mode: 'local', hostId: '', namespace: 'default', note: '', status: 'unknown', lastTestAt: null }
        ],
        // 模块 → 角色 的界面/功能权限矩阵（未出现的角色使用内置默认值）
        modulePermissions: {
            '运维员': permissionsMod.roleDefaults('运维员'),
            '审计员': permissionsMod.roleDefaults('审计员')
        },        counter: { task: 31 },
        hosts: [
            { id: 'h_01', name: 'app-server-01', ip: '10.0.12.11', port: 22, user: 'root', authType: 'key', keyPath: '', password: '', tags: ['生产', '应用'], status: 'unknown', lastConnectedAt: '2026-09-16 14:02' },
            { id: 'h_02', name: 'app-server-02', ip: '10.0.12.12', port: 22, user: 'root', authType: 'key', keyPath: '', password: '', tags: ['生产', '应用'], status: 'unknown', lastConnectedAt: '2026-09-16 14:02' },
            { id: 'h_03', name: 'web-server-01', ip: '10.0.12.21', port: 22, user: 'deploy', authType: 'key', keyPath: '', password: '', tags: ['生产', 'Web'], status: 'unknown', lastConnectedAt: '2026-09-16 13:40' },
            { id: 'h_04', name: 'db-server-01', ip: '10.0.20.31', port: 22, user: 'oracle', authType: 'password', keyPath: '', password: secret, tags: ['生产', '数据库'], status: 'unknown', lastConnectedAt: '2026-09-16 11:40' },
            { id: 'h_05', name: 'db-server-02', ip: '10.0.20.32', port: 22, user: 'oracle', authType: 'password', keyPath: '', password: secret, tags: ['生产', '数据库'], status: 'offline', lastConnectedAt: '2026-09-15 22:10' },
            { id: 'h_06', name: 'bigdata-node-01', ip: '10.0.30.41', port: 22, user: 'root', authType: 'key', keyPath: '', password: '', tags: ['大数据'], status: 'unknown', lastConnectedAt: '2026-09-16 10:15' },
            { id: 'h_07', name: 'bigdata-node-02', ip: '10.0.30.42', port: 22, user: 'root', authType: 'key', keyPath: '', password: '', tags: ['大数据'], status: 'unknown', lastConnectedAt: '2026-09-16 10:15' },
            { id: 'h_08', name: 'test-server-01', ip: '192.168.5.11', port: 22, user: 'root', authType: 'password', keyPath: '', password: secret, tags: ['测试'], status: 'unknown', lastConnectedAt: '2026-09-16 09:31' },
            { id: 'h_09', name: 'backup-server-01', ip: '10.0.40.51', port: 2222, user: 'backup', authType: 'key', keyPath: '', password: '', tags: ['备份'], status: 'unknown', lastConnectedAt: '2026-09-16 03:00' }
        ],
        scripts: [
            { id: 's_01', name: 'check_disk.sh', type: 'shell', desc: '磁盘使用率巡检，超 85% 告警', version: 'v3', author: 'admin', content: '#!/bin/bash\n# 磁盘使用率巡检\nTHRESHOLD=85\nUSED=$(df -h / | awk \'NR==2 {print $5}\' | tr -d \'%\')\nif [ "$USED" -ge "$THRESHOLD" ]; then\n  echo "[WARN] 根分区使用率 ${USED}%"\n  exit 1\nfi\necho "[OK] 根分区使用率 ${USED}%"', createdAt: '2026-09-12 10:20', updatedAt: '2026-09-12 10:20' },
            { id: 's_02', name: 'clean_logs.sh', type: 'shell', desc: '清理 7 天前的历史日志', version: 'v5', author: 'admin', content: '#!/bin/bash\n# 清理历史日志\nfind /var/log -type f -mtime +7 -name "*.log" -delete\necho "日志清理完成"', createdAt: '2026-09-10 15:02', updatedAt: '2026-09-10 15:02' },
            { id: 's_03', name: 'sync_config.sh', type: 'shell', desc: '从配置中心拉取并分发配置', version: 'v2', author: 'ops01', content: '#!/bin/bash\n# 同步配置\ncurl -s -o /tmp/app.conf http://config.corp.local/app.conf\ncp /tmp/app.conf /etc/app/app.conf\necho "配置已同步"', createdAt: '2026-09-08 09:41', updatedAt: '2026-09-08 09:41' },
            { id: 's_04', name: 'update_cert.py', type: 'python', desc: '批量续期 HTTPS 证书并 reload nginx', version: 'v1.3', author: 'admin', content: 'import subprocess\n\ndef main():\n    subprocess.run(["certbot", "renew", "--quiet"], check=True)\n    subprocess.run(["systemctl", "reload", "nginx"], check=True)\n    print("证书续期完成")\n\nif __name__ == "__main__":\n    main()', createdAt: '2026-09-14 08:30', updatedAt: '2026-09-16 09:47' },
            { id: 's_05', name: 'reset_password.py', type: 'python', desc: '第三方系统模拟登录重置密码', version: 'v2.1', author: 'admin', content: '# 第三方系统模拟登录并重置密码\n# 入参：系统地址 / 账号 / 新密码（由平台注入）\nimport os, requests\n\ndef main():\n    url = os.environ["SYS_URL"]\n    user = os.environ["SYS_USER"]\n    newpwd = os.environ["NEW_PASSWORD"]\n    s = requests.Session()\n    s.post(f"{url}/login", data={"username": user, "password": newpwd})\n    print("密码重置完成：", user)\n\nif __name__ == "__main__":\n    main()', createdAt: '2026-09-14 11:05', updatedAt: '2026-09-14 11:05' },
            { id: 's_06', name: 'db_backup.sh', type: 'shell', desc: 'Oracle 数据库逻辑备份导出', version: 'v4', author: 'ops01', content: '#!/bin/bash\n# Oracle 逻辑备份\nexpdp system/password@orcl directory=DPUMP dumpfile=full_$(date +%F).dmp full=y\necho "备份完成"', createdAt: '2026-09-05 16:20', updatedAt: '2026-09-05 16:20' }
        ],
        rules: [
            { id: 'r_01', pattern: 'rm\\s+-rf\\s+/', desc: '递归强制删除根路径', level: '高危', mode: 'blacklist', enabled: true, hits: 6 },
            { id: 'r_02', pattern: 'mkfs', desc: '格式化文件系统', level: '高危', mode: 'blacklist', enabled: true, hits: 0 },
            { id: 'r_03', pattern: 'dd\\s+if=.*of=/dev/', desc: '覆写磁盘设备', level: '高危', mode: 'blacklist', enabled: true, hits: 0 },
            { id: 'r_04', pattern: ':\\(\\)\\s*\\{.*\\};\\s*:', desc: 'Fork 炸弹', level: '高危', mode: 'blacklist', enabled: true, hits: 1 },
            { id: 'r_05', pattern: 'shutdown|reboot', desc: '关机 / 重启服务器', level: '中危', mode: 'blacklist', enabled: true, hits: 2 },
            { id: 'r_06', pattern: 'userdel|groupdel', desc: '删除用户 / 用户组', level: '中危', mode: 'blacklist', enabled: true, hits: 0 },
            { id: 'r_07', pattern: 'iptables\\s+-F', desc: '清空防火墙规则', level: '中危', mode: 'blacklist', enabled: true, hits: 0 },
            { id: 'r_08', pattern: '^df -h$', desc: '磁盘查看（白名单免校验）', level: '低危', mode: 'whitelist', enabled: true, hits: 41 },
            { id: 'r_09', pattern: '^systemctl status .+', desc: '服务状态查询（白名单免校验）', level: '低危', mode: 'whitelist', enabled: true, hits: 28 },
            { id: 'r_10', pattern: '^ls .*', desc: '目录浏览（白名单免校验）', level: '低危', mode: 'whitelist', enabled: false, hits: 15 }
        ],
        accounts: [
            { id: 'a_01', name: '堡垒机系统', url: 'https://bastion.corp.local', user: 'svc_ops', password: secret, scriptName: 'login_bastion.py', status: 'ok', lastSyncAt: '2026-09-16 08:00' },
            { id: 'a_02', name: 'OA 办公系统', url: 'https://oa.corp.local', user: 'svc_admin', password: secret, scriptName: 'login_oa.py', status: 'ok', lastSyncAt: '2026-09-15 18:30' },
            { id: 'a_03', name: '邮件系统', url: 'https://mail.corp.local', user: 'svc_mail', password: secret, scriptName: 'login_mail.py', status: 'expired', lastSyncAt: '2026-09-14 10:00' },
            { id: 'a_04', name: '财务共享平台', url: 'https://fin.corp.local', user: 'svc_fin', password: secret, scriptName: 'login_fin.py', status: 'ok', lastSyncAt: '2026-09-16 06:00' },
            { id: 'a_05', name: '监控平台', url: 'https://zabbix.corp.local', user: 'svc_monitor', password: secret, scriptName: 'login_zabbix.py', status: 'error', lastSyncAt: '2026-09-10 09:00' }
        ],
        tasks: [
            { id: 'T-20260916-0031', cmd: 'df -h', hostIds: ['h_01', 'h_02'], hostCount: 12, status: 'running', operator: 'admin', createdAt: '2026-09-16 14:02:11', results: [] },
            { id: 'T-20260916-0030', cmd: 'find /var/log -mtime +7 -delete', hostIds: ['h_03'], hostCount: 8, status: 'success', operator: 'admin', createdAt: '2026-09-16 11:40:02', results: [] },
            { id: 'T-20260916-0029', cmd: 'systemctl restart nginx', hostIds: ['h_03'], hostCount: 3, status: 'success', operator: 'ops01', createdAt: '2026-09-16 10:15:33', results: [] },
            { id: 'T-20260916-0028', cmd: 'rm -rf /var/log', hostIds: ['h_01'], hostCount: 16, status: 'blocked', operator: 'ops01', createdAt: '2026-09-16 09:31:20', results: [] },
            { id: 'T-20260915-0047', cmd: 'sysctl -p', hostIds: ['h_06'], hostCount: 26, status: 'failed', operator: 'admin', createdAt: '2026-09-15 17:22:45', results: [] }
        ],
        users: [
            { id: 'u_01', username: 'admin', role: '系统管理员', enabled: true, lastLoginAt: '2026-09-16 09:12', password: hashPassword('admin@123'), mustChangePassword: true },
            { id: 'u_02', username: 'ops01', role: '运维员', enabled: true, lastLoginAt: '2026-09-16 13:05', password: hashPassword('ops@123'), mustChangePassword: true },
            { id: 'u_03', username: 'auditor01', role: '审计员', enabled: true, lastLoginAt: '2026-09-15 16:40', password: hashPassword('audit@123'), mustChangePassword: true },
            { id: 'u_04', username: 'ops02', role: '运维员', enabled: false, lastLoginAt: '2026-08-30 10:12', password: hashPassword('ops@123'), mustChangePassword: true }
        ],
        dbSources: [
            { id: 'd_01', type: 'oracle', name: 'Oracle（生产库）', host: '10.0.20.31', port: 1521, database: 'orcl', user: 'system', password: secret, status: 'configured', note: '连接池 8', enabled: true, tags: ['生产', 'Oracle'], lastTestAt: '2026-09-16 11:00:12', lastTestOk: true, createdAt: '2026-09-10 09:20' },
            { id: 'd_02', type: 'mysql', name: 'MySQL（业务库）', host: '', port: 3306, database: '', user: '', password: '', status: 'unconfigured', note: '', enabled: true, tags: ['业务', 'MySQL'], lastTestAt: null, lastTestOk: null, createdAt: '2026-09-10 09:22' },
            { id: 'd_03', type: 'postgres', name: 'PostgreSQL', host: '', port: 5432, database: '', user: '', password: '', status: 'pending', note: '驱动接口已预留，待后续版本接入', enabled: false, tags: ['预留'], lastTestAt: null, lastTestOk: null, createdAt: '2026-09-10 09:25' }
        ],
        schedules: [
            {
                id: 'sc_01', name: '每日磁盘巡检', mode: 'daily', time: '08:30',
                cmd: 'df -h', scriptId: null, hostIds: ['h_01', 'h_02', 'h_03'],
                concurrency: 5, timeout: 30, enabled: true,
                nextRunAt: null, lastRunAt: '2026-09-16 08:30:01', lastStatus: 'success', lastTaskId: null
            },
            {
                id: 'sc_02', name: '每 30 分钟日志清理', mode: 'interval', intervalMinutes: 30,
                cmd: '', scriptId: 's_02', hostIds: ['h_01', 'h_02'],
                concurrency: 3, timeout: 60, enabled: false,
                nextRunAt: null, lastRunAt: null, lastStatus: null, lastTaskId: null
            }
        ],
        sqlScripts: [
            {
                id: 'sq_01', name: '慢查询 Top 10', sourceType: 'mysql',
                sql: 'SELECT * FROM information_schema.processlist\nWHERE command <> \'Sleep\'\nORDER BY time DESC\nLIMIT 10;',
                author: 'admin', createdAt: '2026-09-16 10:00', updatedAt: '2026-09-16 10:00'
            },
            {
                id: 'sq_02', name: '表容量概览', sourceType: 'mysql',
                sql: 'SELECT table_name, table_rows,\n       ROUND(data_length / 1024 / 1024, 2) AS data_mb,\n       ROUND(index_length / 1024 / 1024, 2) AS index_mb\nFROM information_schema.tables\nWHERE table_schema = DATABASE()\nORDER BY data_length DESC\nLIMIT 50;',
                author: 'admin', createdAt: '2026-09-16 10:05', updatedAt: '2026-09-16 10:05'
            }
        ],
        alerts: [],
        sqlHistory: [
            {
                id: 'q_seed01', sourceId: 'd_01', sourceName: 'Oracle（生产库）', type: 'oracle', user: 'admin',
                sql: "SELECT s.sid, s.username FROM v$session s WHERE s.status = 'ACTIVE'",
                result: 'success', statementCount: 1, durationMs: 88, rowCount: 12,
                createdAt: '2026-09-16 11:02:45'
            },
            {
                id: 'q_seed02', sourceId: 'd_02', sourceName: 'MySQL（业务库）', type: 'mysql', user: 'ops01',
                sql: 'DROP DATABASE bizdb',
                result: 'blocked', statementCount: 1, durationMs: 0, rowCount: 0,
                message: '已拦截：不允许执行 DROP DATABASE / DROP SCHEMA',
                createdAt: '2026-09-16 09:20:03'
            }
        ]
    };
}

let db = null;

function ensureDirs() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function load() {
    if (db) return db;
    ensureDirs();
    if (fs.existsSync(DB_FILE)) {
        try {
            db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (e) {
            // 文件损坏时备份并重建种子数据
            fs.copyFileSync(DB_FILE, DB_FILE + '.broken-' + Date.now());
            db = seeds();
            persist();
        }
    } else {
        db = seeds();
        persist();
    }
    migrate();
    return db;
}

/**
 * 老版本数据文件迁移：补齐新增集合与字段，避免升级后功能缺字段
 */
function migrate() {
    const defaults = seeds();
    let changed = false;

    ['hosts', 'scripts', 'rules', 'accounts', 'tasks', 'users', 'dbSources', 'schedules', 'sqlScripts', 'sqlHistory', 'alerts',
        'etlTasks', 'etlRuns', 'apiCases', 'apiHistory', 'dockerHosts', 'kubeClusters'].forEach(key => {
        if (!Array.isArray(db[key])) {
            db[key] = defaults[key] || [];
            changed = true;
        }
    });

    if (!db.config) { db.config = defaults.config; changed = true; }
    if (!db.counter) { db.counter = defaults.counter; changed = true; }

    // AI 模型配置 / 对话历史（老库没有 → 补默认）
    if (!db.aiConfig || typeof db.aiConfig !== 'object') { db.aiConfig = defaults.aiConfig; changed = true; }
    if (!db.aiChats || typeof db.aiChats !== 'object' || Array.isArray(db.aiChats)) { db.aiChats = {}; changed = true; }
    // Agent 配置 / 用户级 AI 偏好（老库补默认值，缺失字段由 ai.getAgentConfig 兜底）
    if (!db.aiAgent || typeof db.aiAgent !== 'object' || Array.isArray(db.aiAgent)) { db.aiAgent = defaults.aiAgent; changed = true; }
    if (!db.aiUserPrefs || typeof db.aiUserPrefs !== 'object' || Array.isArray(db.aiUserPrefs)) { db.aiUserPrefs = {}; changed = true; }
    // 提示词角色（老库缺失 → 写入内置预设；空数组视为已清空也重新播种）
    if (!Array.isArray(db.aiRoles) || !db.aiRoles.length) {
        db.aiRoles = defaults.aiRoles;
        changed = true;
    }

    // 模块权限矩阵（老库没有该集合 → 按角色内置默认值补全）
    if (!db.modulePermissions || typeof db.modulePermissions !== 'object' || Array.isArray(db.modulePermissions)) {
        db.modulePermissions = {};
        changed = true;
    }
    Object.keys(permissionsMod.ROLE_MODULE_DEFAULTS).forEach(role => {
        if (role === '系统管理员') return; // 管理员始终全权限，不落库
        if (!db.modulePermissions[role]) {
            db.modulePermissions[role] = permissionsMod.roleDefaults(role);
            changed = true;
        } else {
            // 新增模块：老矩阵里没有该键时按角色内置默认值回填（显式 null 视为「已决策」不动）
            const matrix = db.modulePermissions[role];
            permissionsMod.MODULES.forEach(m => {
                if (!(m.id in matrix)) {
                    matrix[m.id] = permissionsMod.roleDefaults(role)[m.id] || null;
                    changed = true;
                }
            });
            const normalized = permissionsMod.sanitizeMatrixForRole(matrix, role);
            if (JSON.stringify(normalized) !== JSON.stringify(matrix)) {
                db.modulePermissions[role] = normalized;
                changed = true;
            }
        }
    });
    // 用户级模块权限覆写（存在则规范化，缺失时保持 null 表示继承角色）
    (db.users || []).forEach(user => {
        if (user.modulePerms && typeof user.modulePerms === 'object') {
            const normalized = permissionsMod.sanitizeMatrixForRole(user.modulePerms, user.role);
            if (JSON.stringify(normalized) !== JSON.stringify(user.modulePerms)) {
                user.modulePerms = normalized;
                changed = true;
            }
        }
    });

    // 数据源新增字段（启用开关 / 标签 / 最近测试）
    (db.dbSources || []).forEach(src => {
        if (typeof src.enabled !== 'boolean') { src.enabled = src.type !== 'postgres'; changed = true; }
        if (!Array.isArray(src.tags)) { src.tags = []; changed = true; }
        if (!('note' in src)) { src.note = ''; changed = true; }
        if (!('lastTestAt' in src)) { src.lastTestAt = null; changed = true; }
        if (!('lastTestOk' in src)) { src.lastTestOk = null; changed = true; }
    });

    // 用户表新增口令字段（老库没有密码 → 补默认口令并要求修改）
    (db.users || []).forEach((user, index) => {
        if (!user.password) {
            const fallback = defaults.users.find(u => u.username === user.username) || defaults.users[index] || defaults.users[0];
            user.password = fallback.password;
            user.mustChangePassword = true;
            changed = true;
        }
    });

    if (changed) persist();
}

function persist() {
    ensureDirs();
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
}

const list = coll => load()[coll] || [];
const get = key => load()[key];
const find = (coll, id) => list(coll).find(x => x.id === id) || null;

function set(key, value) {
    load()[key] = value;
    persist();
    return value;
}

function upsert(coll, item) {
    const arr = list(coll);
    const prefix = {
        hosts: 'h_', scripts: 's_', rules: 'r_', accounts: 'a_', users: 'u_',
        dbSources: 'd_', tasks: 'T-', etlTasks: 'et_', etlRuns: 'er_', sqlScripts: 'sq_',
        dockerHosts: 'dh_', aiRoles: 'ar_', kubeClusters: 'kc_'
    }[coll] || 'x_';
    if (item.id) {
        const idx = arr.findIndex(x => x.id === item.id);
        if (idx >= 0) {
            arr[idx] = { ...arr[idx], ...item };
            persist();
            return arr[idx];
        }
    }
    const created = { ...item, id: item.id || uid(prefix) };
    arr.unshift(created);
    persist();
    return created;
}

function remove(coll, id) {
    const arr = list(coll);
    const idx = arr.findIndex(x => x.id === id);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    persist();
    return true;
}

/** 任务编号：T-YYYYMMDD-XXXX */
function nextTaskId() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    const state = load();
    state.counter.task = (state.counter.task || 0) + 1;
    persist();
    return `T-${day}-${String(state.counter.task).padStart(4, '0')}`;
}

module.exports = {
    load, persist, list, get, set, find, upsert, remove,
    nextTaskId, uid, nowText, ensureDirs,
    DATA_DIR, LOG_DIR, DB_FILE
};
