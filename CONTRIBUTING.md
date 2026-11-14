# 贡献指南

感谢你愿意改进 `dsh-mcloud`。这个项目是社区逆向实现的移动云盘（139）接入，
所以对**稳定性**和**不泄露凭据**的要求高于一般项目。

## 开发环境

- Node.js **>= 22**（插件用了内置 `fetch`、`AbortSignal.timeout`、`node:stream/promises`）
- Windows（宿主端用 Puppeteer 无依赖的 PowerShell + WinForms 处理系统对话框与 DPAPI；
  macOS / Linux 上凭据改用文件权限，但部分功能未验证）
- DeepSeek Harness `>= 0.2.1-rc.5, < 0.3.0`（插件 0.3.x 的兼容范围）

## 本地开发

```powershell
git clone https://github.com/GIYN-S/dsh-mcloud.git
cd dsh-mcloud
dsh plugin --profile desktop add "link:$PWD"
```

改完代码要**重启 DSH 的 Web 服务**才生效（插件在 profile 启动时加载）。

## 代码结构

```
lib/index.js      宿主端：139 客户端、12 个工具、/api/dsh-mcloud/* 路由、凭据存储
lib/transfer.js   传输层纯函数：分片切分、SHA256、流式 PUT、流式落盘
lib/client.js     客户端：会话页标签面板（右键菜单、上传面板、传输进度）
cordis.patch.yml  bundle patch
locale/*.json     面板标题与描述
```

**硬性约定：**

- `lib/client.js` 是**纯浏览器脚本**：不能用 `import` / `export`，不能写 JSX，
  必须包在 `window.__ModuleLoader__.load({ id, factory })` 里。
- 每个 React `apply()` 都必须**永不抛异常**（宿主上抛一次整个面板就白屏）。
- 所有 POST 必须带 `x-dsh-mcloud: 1`（CSRF 闸，同时挡跨站预检）。

## 提交前自查

```powershell
# 语法
node --check lib/index.js
node --check lib/transfer.js
node --check lib/client.js
```

**必须确认没有把个人信息提交上去：**

```powershell
git diff --cached | Select-String -Pattern 'gh[pousr]_|1[3-9]\d{9}|\*\*\*\*\*|Authorization|ud_id'
```

`.dpapi` / `authorization.json` / `.env` 已在 `.gitignore` 里，别用 `git add -f` 绕过。

## 提交信息

用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
feat: 新增 xxx 能力
fix: 修复 xxx 问题
perf: 优化 xxx 性能
docs: 更新文档
refactor: 重构（不改变行为）
```

## 关于逆向接口

移动云盘的接口不是公开 API，**随时可能变更**。改动协议相关代码时：

- 注释里写清为什么这么做（签名、分页、字段含义），不要只写「按文档来」——没有官方文档。
- 协议相关的改动需要你实际验证过再提交。
- 上游参考实现：[OpenList `drivers/139`](https://github.com/OpenListTeam/OpenList)
  （AGPL-3.0）、[cloud_driver_sdk](https://github.com/kong-hen/cloud_driver_sdk)。

## Issue / PR

提 Issue 时请附上：

- DSH 版本、Node 版本、操作系统
- **报错原文**（面板上的红色提示，或 DSH 日志）
- 复现步骤

⚠️ **绝不要在 Issue / PR 里粘贴 `Authorization` 或任何 cookie。**
如果怀疑是授权问题，只描述现象即可，维护者会告诉你需要什么信息。
