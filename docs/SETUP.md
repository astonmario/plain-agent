# 新机器环境搭建与运行指南

> 目标：在一台全新的电脑上，按本文顺序执行即可完成依赖安装、模型配置、运行和打包。
> 本文汇总了实际踩过的坑及规避方式，FAQ 里的问题都已在仓库内做了配置层面的处理。

## 1. 环境要求

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11 **正式版**、macOS 13+、Linux | **不要用 Windows Insider 预览版**：Build 26200/26300 与 Electron 41 不兼容，桌面端启动即崩溃（见 FAQ 3） |
| Node.js | ≥ 20，推荐 24 LTS | 安装路径**不能含空格**，否则 `pnpm exec` 解析参数会出错（见 FAQ 4） |
| pnpm | 10.14.0 | 仓库 `packageManager` 已锁定，corepack 进入项目后会自动切换 |
| 磁盘 | ≥ 2 GB | 依赖约 1 GB，Electron 运行时约 250 MB，另加打包产物 |

## 2. 安装 Node.js 与 pnpm

### Windows

1. 下载 Node 24 LTS 的 Windows x64 **zip**，解压到无空格路径，例如 `C:\nodejs`。
   - 不要用 `C:\Program Files\nodejs`（含空格）。
2. 把 `C:\nodejs` 加到用户 PATH 的**最前面**，新开终端验证：
   ```powershell
   node -v      # v24.x
   npm -v
   ```
3. 启用 pnpm：
   ```powershell
   corepack enable pnpm
   corepack install --global pnpm@10.14.0
   pnpm -v      # 10.14.0
   ```
4. 放开 PowerShell 脚本执行（否则 pnpm/npm 的 `.ps1` 会被拦截）：
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
   ```

### macOS / Linux

```bash
# 用 nvm / fnm 安装 Node 24
corepack enable pnpm
corepack install --global pnpm@10.14.0
pnpm -v
```

## 3. 获取代码并安装依赖

```bash
git clone <仓库地址>
cd plain-agent
pnpm install
```

也可以在 Windows 上直接跑一键脚本，它会检查环境、装依赖、准备 `.env`：

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/setup.ps1
# 没有 pwsh 时：
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

> `-ExecutionPolicy Bypass` 只对本次进程生效，不会修改系统策略。当仓库放在某些磁盘（例如本机的 D 盘）时，PowerShell 会把脚本当成远程文件而拒绝执行，加上该参数最稳妥。

关于下载镜像：仓库根目录的 [.npmrc](../.npmrc) 已配置两个镜像，**不需要手动设置**：

```ini
electron_mirror=https://npmmirror.com/mirrors/electron/
electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```

- `electron_mirror`：安装时下载 Electron 运行时（默认从 GitHub，国内经常超时）。
- `electron_builder_binaries_mirror`：打包时下载 winCodeSign / NSIS 等工具。

## 4. 配置模型

```bash
cp .env.example .env
```

编辑 `.env`：

```ini
API_KEY=sk-你的密钥
MODEL=deepseek-flash
BASE_URL=https://api.deepseek.com
```

可选模型（2026-10）：

| 模型 | 定位 | 大致价格（百万 tokens，空闲时段） |
|---|---|---|
| `deepseek-flash` | 轻量、高并发 | 输入 1 元 / 输出 4 元 |
| `deepseek-v4-pro` | 旗舰、强推理 | 输入 4.5 元 / 输出 13.5 元 |

`.env` 已在 `.gitignore` 中，不会被提交。

## 5. 运行

| 模式 | 命令 | 说明 |
|---|---|---|
| CLI | `pnpm cli` | 交互式命令行，最轻量，推荐先用它验证配置 |
| HTTP Server | `pnpm server` | 默认 `http://127.0.0.1:3000`，可用 `-- --port=3001` 改端口 |
| 桌面端（开发） | `pnpm dev:desktop` | 需要正式版系统；首次启动会构建 `desktop/out` |
| 桌面端（生产） | 见第 6 节 | 先构建再启动或打包 |

## 6. 打包桌面端

```powershell
# 免安装目录（最快，产物可直接运行）
pnpm --filter @plain-agent/desktop run pack

# 便携版单文件
pnpm --filter @plain-agent/desktop run build:win:portable

# NSIS 安装包（请在正式版 Windows 或 CI 上执行）
pnpm --filter @plain-agent/desktop run build:win:nsis
```

产物在 `desktop/dist/`：

| 命令 | 产物 |
|---|---|
| `run pack` | `dist/win-unpacked/`（含 `Plain Agent.exe`） |
| `build:win:portable` | `dist/Plain Agent-Portable-0.1.0-x64.exe` |
| `build:win:nsis` | `dist/Plain Agent-Setup-0.1.0-x64.exe` |

也可以用脚本（会设置镜像、关闭证书探测，并对预览版系统给出警告）：

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/build-win.ps1 -Target Portable
pwsh -ExecutionPolicy Bypass -File scripts/build-win.ps1 -Target Installer
```

注意事项：

- **打包不会启动 Electron**，所以预览版系统的启动崩溃不影响打包本身。
- 在 Windows Insider 预览版上，NSIS 安装包会在“生成卸载器”阶段失败（exit 2）。请改用 portable，或在正式版 Windows / CI 上打安装包。
- 未提供签名凭据时，构建脚本会关闭证书探测并跳过签名；签名方式见 6.1。
- 未提供 `desktop/resources/icon.ico` 时，打包会提示使用 Electron 默认图标，不影响产物。

### 6.1 代码签名

构建脚本 [scripts/build-win.ps1](../scripts/build-win.ps1) 会自动识别凭据：

| 凭据 | 行为 |
|---|---|
| 无 | 跳过签名，并设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 避免误用证书 |
| `CSC_LINK` + `CSC_KEY_PASSWORD` | 使用 PFX 证书签名 |
| `AZURE_TENANT_ID` 等 + `win.azureSignOptions` | Azure Trusted Signing |

**方式一：PFX 证书**

```powershell
$env:CSC_LINK = 'D:\certs\plain-agent.pfx'   # 本地路径或 base64
$env:CSC_KEY_PASSWORD = 'pfx 密码'
pwsh -ExecutionPolicy Bypass -File scripts/build-win.ps1 -Target Portable
```

**方式二：Azure Trusted Signing（CI 友好）**

在 `desktop/package.json` 的 `build.win` 中加入：

```json
"azureSignOptions": {
  "publisherName": "Plain Agent",
  "endpoint": "https://weu.codesigning.azure.net/",
  "codeSigningAccountName": "<Trusted Signing 账户名>",
  "certificateProfileName": "<证书配置名>"
}
```

并设置 `AZURE_TENANT_ID`、`AZURE_CLIENT_ID`、`AZURE_CLIENT_SECRET`。需要 Azure 订阅、Trusted Signing 账户与身份验证，约 $9.99/月。

**方式三：自签名（仅内部测试）**

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Plain Agent Test" -CertStoreLocation Cert:\CurrentUser\My
$pwd = ConvertTo-SecureString 'test123' -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath D:\certs\test.pfx -Password $pwd
```

签名本身会成功（`Get-AuthenticodeSignature` 能看到签名者），但其他机器会显示“未知发布者”，因为根证书不受信任。

**证书怎么选**

| 方式 | 费用 | 适用 |
|---|---|---|
| OV / EV 代码签名证书 | 约 $200–600/年 | 对外发布；EV 建立 SmartScreen 信誉更快 |
| Azure Trusted Signing | 约 $9.99/月 | CI 友好，无需硬件令牌 |
| 自签名 | 免费 | 仅内部测试 |

注意：

- 2023 年后主流 CA 要求私钥存放在硬件/HSM，纯 PFX 证书越来越少；CI 场景优先 Azure Trusted Signing 或云 HSM。
- 签名解决“发布者可信 / SmartScreen 提示”，**不改变** Insider 系统上 Electron 启动崩溃的问题。
- electron-builder 默认给签名附加时间戳，需要能访问时间戳服务器。

## 7. 验证安装是否完整

```bash
pnpm install --frozen-lockfile   # 期望输出 Already up to date
pnpm typecheck                   # 期望 5 个 workspace 包全部 Done
```

## 8. 常见问题（FAQ）

| # | 现象 | 原因 | 解决 |
|---|---|---|---|
| 1 | `pnpm install` 卡在 Electron 下载 | GitHub 直连慢或被墙 | 仓库 `.npmrc` 已配镜像；必要时临时设 `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'` |
| 2 | 打包报 `Get "https://github.com/.../winCodeSign...": connectex ... failed` | electron-builder 需要从 GitHub 下载工具链 | `.npmrc` 已配 `electron_builder_binaries_mirror`；也可设 `ELECTRON_BUILDER_BINARIES_MIRROR` |
| 3 | `pnpm dev:desktop` 启动即退出：`0x80000003` 或 `0xC0000005` | Windows Insider 26200/26300 与 Electron 41 的 Chromium 沙箱不兼容 | 换正式版 Windows 做桌面端开发；临时可用 `--no-sandbox` 启动已构建版本（有安全代价） |
| 4 | `pnpm exec ...` 报 `'C:\...\Author' 不是内部或外部命令` | Node 装在含空格的路径 + PowerShell 引号处理 | 把 Node 装到无空格路径（如 `C:\nodejs`），并放到 PATH 最前 |
| 5 | 执行 `pnpm --filter @plain-agent/desktop pack` 却生成了 `.tgz` | `pack` 是 pnpm 的内置命令，不会执行同名脚本 | 加 `run`：`pnpm --filter @plain-agent/desktop run pack` |
| 6 | NSIS 打包报 `Exit code: 2` | 预览版系统上临时安装器无法运行（与问题 3 同源） | 用 portable，或换正式版 / CI |
| 7 | 请求模型返回 404 / 模型不存在 | 模型名已过时（如 `deepseek-chat`） | 用 `deepseek-flash` 或 `deepseek-v4-pro` |
| 8 | PowerShell 报“在此系统上禁止运行脚本” | 执行策略为 Restricted | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| 9 | 桌面端启动后白屏 / 找不到 `index.html` | 没先构建，`out/` 不存在 | `pnpm --filter @plain-agent/desktop build` 后再启动 |
| 10 | `pnpm` 命令指向旧版本或报 nvm 相关错误 | 机器上装了带空格的第三方 nvm | 用官方 Node + corepack，或把 nvm 迁到无空格路径 |
| 11 | 运行 `scripts/*.ps1` 提示“未进行数字签名” | PowerShell 执行策略，或脚本所在磁盘被当成远程位置 | 用 `powershell -ExecutionPolicy Bypass -File <脚本>` 运行，仅对本次生效 |

## 9. 最小验收清单

- [ ] `node -v` ≥ 20，`pnpm -v` = 10.14.0
- [ ] `pnpm install --frozen-lockfile` 输出 `Already up to date`
- [ ] `.env` 已配置，`MODEL=deepseek-flash`
- [ ] `pnpm typecheck` 全部通过
- [ ] `pnpm cli` 能正常对话
- [ ] `pnpm --filter @plain-agent/desktop run pack` 生成 `desktop/dist/win-unpacked/`
- [ ] （正式版 Windows）`pnpm dev:desktop` 能打开窗口
