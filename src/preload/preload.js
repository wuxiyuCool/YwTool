const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染进程 ↔ 主进程安全桥接
 * 仅放行下列业务通道，其余通道一律拒绝
 */
const validChannels = [
    // 应用
    'app:info',

    // 应用菜单栏（结构下发 + 可见范围同步；菜单点击事件经 menu:navigate 反推）
    'menu:model', 'menu:update',

    // 认证与权限
    'auth:login', 'auth:logout', 'auth:session', 'auth:password', 'auth:resetPassword',

    // 告警中心
    'alerts:list', 'alerts:unread', 'alerts:ack', 'alerts:ackAll', 'alerts:clear',

    // 定时任务
    'schedules:list', 'schedules:save', 'schedules:delete', 'schedules:toggle', 'schedules:runNow',

    // 主机管理
    'hosts:list', 'hosts:save', 'hosts:delete', 'hosts:test', 'hosts:exec',

    // 任务执行
    'tasks:list', 'tasks:detail', 'tasks:validate', 'tasks:run', 'tasks:export',

    // 脚本管理
    'scripts:list', 'scripts:detail', 'scripts:save', 'scripts:delete',
    'scripts:run', 'scripts:lint', 'scripts:execOne',

    // 敏感词规则
    'rules:list', 'rules:save', 'rules:delete', 'rules:toggle', 'rules:validate',

    // 多系统账号
    'accounts:list', 'accounts:save', 'accounts:delete', 'accounts:reveal',
    'accounts:reset', 'accounts:loginTest', 'accounts:policy:save',

    // 凭据台账（聚合查看与解密，仅系统管理员）
    'ledger:list', 'ledger:reveal',

    // 日志审计
    'audit:query', 'audit:stats', 'audit:append', 'audit:cleanup', 'audit:paths',

    // SQL 工作台
    'sql:execute', 'sql:export', 'db:tables', 'db:describe', 'db:schema',
    'sqlScripts:list', 'sqlScripts:save', 'sqlScripts:delete', 'sqlHistory:list',

    // 数据集成（ETL）：库对库 / 文件对库 / 库对文件
    'db:etl:preview', 'db:etl:run', 'db:etl:pickFile',
    'db:etl:tasks:list', 'db:etl:tasks:save', 'db:etl:tasks:delete', 'db:etl:runs',

    // 数据库配置（数据库运维域）
    'dbconfig:list', 'dbconfig:detail', 'dbconfig:drivers', 'dbconfig:save',
    'dbconfig:delete', 'dbconfig:toggle', 'dbconfig:test',
    'dbconfig:export', 'dbconfig:import',

    // 系统管理
    'system:env', 'system:config:get', 'system:config:save',
    'system:backup:export', 'system:backup:import',
    'system:users:list', 'system:users:save', 'system:users:delete',
    'system:modules:list', 'system:perms:get', 'system:perms:save', 'system:perms:reset',

    // 总览
    'dashboard:overview',

    // AI 助手（配置 / 对话 / 会话管理 / 模型切换 / Agent 能力 / 脚本生成与优化）
    'ai:config:get', 'ai:config:save', 'ai:test',
    'ai:chat', 'ai:chat:history', 'ai:chat:clear',
    'ai:sessions:list', 'ai:sessions:new', 'ai:sessions:switch', 'ai:sessions:delete',
    'ai:script:generate', 'ai:script:optimize',
    'ai:model:get', 'ai:model:save',
    'ai:agent:get', 'ai:agent:save', 'ai:agent:toggle', 'ai:agent:tools'
];

contextBridge.exposeInMainWorld('electron', {
    invoke: (channel, data) => {
        if (validChannels.includes(channel)) {
            return ipcRenderer.invoke(channel, data);
        }
        return Promise.reject(new Error(`Invalid channel: ${channel}`));
    },

    /** 主进程主动推送（任务执行进度、告警、菜单导航、AI 流式回复） */
    on: (channel, callback) => {
        const pushChannels = ['task:progress', 'alert:new', 'schedule:progress', 'menu:navigate', 'ai:stream', 'ai:step', 'data:progress'];
        if (!pushChannels.includes(channel)) return () => {};
        const listener = (event, payload) => callback(payload);
        ipcRenderer.on(channel, listener);
        return () => ipcRenderer.removeListener(channel, listener);
    }
});
