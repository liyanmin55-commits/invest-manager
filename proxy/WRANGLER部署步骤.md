# 安装并部署 wrangler 行情代理（真机步骤）

> 本文由「1号」生成。起因：`README.md` 被 Obsidian 锁定无法编辑，故另存此专项步骤；你跑通后我会把它合并回 `README.md`。

## 为什么要在你真机装
wrangler 是 Cloudflare 的官方部署工具，要连**你的** Cloudflare 账号，把行情代理（`proxy/worker.js`）发布上线。WorkBuddy 的沙箱里装了也用不到你的账号，所以必须由你在自己电脑上跑。

## 终端选择（重要）
请用 **CMD（命令提示符）** 或 **Git Bash**。
**不要直接用 PowerShell**——它会因执行策略拦截 `npm`/`npx` 的 `.ps1` 包装脚本，报 `PSSecurityException`，让你误以为命令坏了，其实不是。

## 步骤（逐行复制，每行回车执行）

```
node -v
npm -v
npm install -g wrangler
wrangler --version
wrangler login
cd /d "D:\lym12\WorkBuddy\投资管理系统\proxy"
wrangler deploy
```

- **第 1–2 行**：确认 Node 已装且 ≥ v18。若提示"不是内部或外部命令"或版本 < v18，先去 https://nodejs.org 装 LTS 版。
- **第 3 行**：全局安装 wrangler。
- **第 4 行**：应打印版本号（如 `3.x.x` / `4.x.x`），证明装好了。
- **第 5 行**：弹出浏览器让你登录 Cloudflare。**这步必须你本人点授权，AI 无法代劳。** 看到 `Successfully logged in.` 即成功。
- **第 6 行**：进到代理目录。Git Bash 用户把这行改成 `cd /d/lym12/WorkBuddy/投资管理系统/proxy`。
- **第 7 行**：部署。成功会打印一行 `https://invest-quote-proxy.<你的子域>.workers.dev`。

## 部署后接进 App
1. 复制上面那个 `workers.dev` 地址
2. 打开「投资管家」→ 设置 → 行情代理 → 粘贴保存
3. 点顶部「刷新行情」→ 状态栏提示「行情已更新 N 个标的」即打通

## 备选：没有全局 Node / 版本过低
用 WorkBuddy 自带的 managed node（v22，满足要求），在 `proxy` 目录**本地**装，不污染系统：

```
cd /d "D:\lym12\WorkBuddy\投资管理系统\proxy"
"C:\Users\lym12\.workbuddy\binaries\node\versions\22.22.2\node.exe" "C:\Users\lym12\.workbuddy\binaries\node\versions\22.22.2\node_modules\npm\bin\npm-cli.js" install wrangler
.\node_modules\.bin\wrangler.cmd login
.\node_modules\.bin\wrangler.cmd deploy
```

> 本地装出的 wrangler 在 `.\node_modules\.bin\wrangler.cmd`，调用时带 `.cmd` 后缀即可，不受 PowerShell 执行策略影响。

## 跑完告诉我
把 `wrangler --version` 的输出 + 部署后的 `workers.dev` 地址发我，我帮你确认，并等你在 Obsidian 关掉 `README.md` 后，把这份步骤合并回去。
