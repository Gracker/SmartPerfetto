# Windows 配置与运行指南

<!-- i18n-headings: paired -->

[English](windows.en.md) | [中文](windows.md)

这份文档是 Windows 用户从下载到排障的权威入口。维护者打包与发布契约见
[Windows 打包参考](../reference/windows-exe.md)，通用 Provider 字段见
[配置指南](configuration.md)。

## 使用前先确认

- 普通 Windows 用户优先选择 **windows-x64 免安装包**，不需要另装 Node.js、Git、
  Python 或 Docker。
- 当前只发布 x64 包，没有 Windows ARM64 原生产物。
- 包清单的技术最低版本是 Windows 10 / Windows Server 2016；当前最终归档自动化证据
  来自 GitHub-hosted Windows Server 2025 x64。建议普通用户使用仍受支持的
  Windows 11 x64；技术最低版本不等于所有旧系统都做过桌面验收。
- 容器部署可以用 Docker Desktop + WSL2 backend；修改源码时再使用 WSL2 或开发者环境。

## 1. 下载并校验

1. 打开 [官方 Latest Release](https://github.com/Gracker/SmartPerfetto/releases/latest)。
2. 下载 **smartperfetto-v版本-windows-x64.zip**。不要下载 Source code (zip)，它不是
   可直接运行的 Windows 包。
3. 在下载目录打开 PowerShell：

        Get-FileHash .\smartperfetto-v版本-windows-x64.zip -Algorithm SHA256

4. 将结果与 Release 页面该资产显示的 SHA256 digest 对比。文件名、版本和 digest
   任一不一致时不要运行。

## 2. 完整解压

在资源管理器中右键 zip，选择“全部解压”。不要在 zip 预览中直接运行，也不要只复制
SmartPerfetto.exe；后端、前端、Node.js 和原生运行时都在同一目录树。

建议使用短、普通、当前用户可写的本地目录，例如：

    C:\Apps\SmartPerfetto\vX.Y.Z

第一次排障时先避开 Program Files、网络盘和 OneDrive 同步目录。路径可以包含空格或
中文，但安全软件或旧版解压工具报错时，先在短英文路径复测。

## 3. SmartScreen 与 Defender

当前公开 Windows 启动器还没有 Authenticode 签名，因此可能显示 Unknown Publisher、
SmartScreen 的“Windows 已保护你的电脑”，或被企业安全策略阻止。这是当前发布链的
已知缺口，SHA256 校验不能替代代码签名。

- 只在文件来自官方 Release 且 SHA256 一致时考虑继续。
- 不要全局关闭 Microsoft Defender，也不要添加宽泛目录排除。
- Defender 隔离文件时，先核对来源和 digest；无法确认就重新下载，不要恢复。
- 公司电脑如果策略不允许继续，请联系 IT，或在获准环境中使用 Docker；不要绕过
  AppLocker、WDAC 或企业 EDR。

Microsoft 的说明见
[SmartScreen reputation](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation)。

## 4. 第一次启动

双击解压目录中的 SmartPerfetto.exe。需要保留完整错误时，在该目录打开 PowerShell：

    .\SmartPerfetto.exe

启动器会打印：

    Data directory: D:\SmartPerfettoData
    Logs directory: D:\SmartPerfettoData\logs
    SmartPerfetto is running.
    Open: http://127.0.0.1:实际端口

上述 D 盘路径只是满足默认条件时的示例；保持启动器窗口打开，并以实际打印的
`Data directory`、`Logs directory` 和 `Open:` 为准。默认前端端口是 10000，但被占用时
会自动选择其他端口。浏览器没有自动打开也不表示启动失败，可以手动复制地址。服务只绑定
127.0.0.1，默认不会监听局域网地址。

## 5. 配置并激活 Provider

打开 **AI Assistant 设置 → Providers**：

1. 选择与账号匹配的 Provider，并以厂商控制台给出的协议、Base URL 和模型 ID 为准。
2. 填写 **Provider API Key**。Connection 页的 backend auth token 不是模型厂商 key，
   只有部署者设置了 SMARTPERFETTO_API_KEY 才需要填写。
3. 核对 runtime：Claude/Anthropic-compatible 通常用 Claude Agent SDK；
   OpenAI/OpenAI-compatible 通常用 OpenAI Agents SDK。
4. 保存 Provider。
5. 运行连接测试；失败时先核对 Base URL、模型 ID、协议、代理和系统时间。
6. 激活 Provider。只保存但不激活时，仍会使用之前的 active provider 或 env fallback。

普通免安装包的本地 Provider profile 保存在启动器打印的
**Data directory\providers**；普通 Provider 存储不使用 DPAPI。
请保护 Windows 登录账号和数据根目录，不要公开上传该目录。Windows enterprise 数据库
模式使用本地加密 SecretStore 时，master key 由当前用户的 DPAPI 保护；运维显式配置
master/server secret 时，以部署配置为准。

完整字段和优先级见[配置指南](configuration.md)。

## 6. 完成第一次分析

1. 打开启动器打印的 UI 地址。
2. 加载一个已知可用的 Perfetto trace。
3. 打开 AI Assistant，先问一个范围明确的问题。
4. 确认能看到 SQL/Skill 证据、结论和报告入口。

没有 Provider 时 UI 和时间线仍可打开，但模型分析会被拒绝。首次验证先用可分享的小样本，
不要直接使用唯一的大型生产 trace。

## 7. 数据、凭证与日志

标准模式把可变数据放在解压目录之外。`D:` 是本地固定磁盘且目标可写时，优先根目录是
`D:\SmartPerfettoData`；否则回退到 `%LOCALAPPDATA%\SmartPerfetto`。最终位置始终以
启动器打印的 `Data directory` 为准：

    <Data directory>\
      backend\
      providers\
      uploads\
      user\
      logs\
      env

- providers：本地 Provider profile 和相关状态。
- uploads：上传的 trace，可能含敏感信息。
- user：升级后仍应保留的用户状态。
- logs\backend.log、logs\frontend.log：排障日志。
- env：可选的脚本化 Provider 环境变量文件。

需要自定义完整根目录时，在启动前设置，例如：

    $env:SMARTPERFETTO_PORTABLE_DATA_DIR = "E:\SmartPerfettoData"
    .\SmartPerfetto.exe

不要把 `SMARTPERFETTO_PORTABLE_DATA_DIR` 写进上述 `env` 文件：启动器先确定数据根目录，
之后才加载该文件中的 Provider 配置。显式根目录覆盖会禁用自动和显式迁移。

设置 SMARTPERFETTO_PORTABLE_MODE=1 后，数据和日志改放在程序旁边；升级、权限和备份
由用户负责，而且自动与显式迁移都会禁用。

## 8. 停止、重启与端口

- 正常停止：在启动器窗口按 Ctrl+C，等待后端和前端退出。
- 重启：确认上一次窗口已经退出，再运行 SmartPerfetto.exe。
- 不建议同时启动同一解压目录的多个实例。
- 需要固定端口时，在启动前设置 SMARTPERFETTO_BACKEND_PORT 和
  SMARTPERFETTO_FRONTEND_PORT；未固定时启动器会选择可用端口。
- 关闭 console、注销或关机时，Windows Job Object 会清理子进程；端口仍被占用时按
  排障步骤确认残留进程。

## 9. 更新、备份与迁移

把新 zip 解压到新目录，不要覆盖旧版本目录。标准模式的数据位于启动器打印的数据根目录，
因此删除旧程序目录不会自动删除用户数据。

更新前停止 SmartPerfetto，再备份：

    $dataDir = "D:\SmartPerfettoData" # 替换为启动器实际打印的 Data directory
    $backup = "$dataDir.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item -LiteralPath $dataDir -Destination $backup -Recurse

新版选择 D 盘默认目录时，如果 `%LOCALAPPDATA%\SmartPerfetto` 非空且 D 盘目标不存在或
为空，启动器会原子复制整套数据、写迁移回执并保留 C 盘原目录；D 盘目标非空时不合并、
不覆盖。自动复制失败时会清理临时副本、打印警告并继续使用安全的 C 盘原目录。

旧版本曾把数据放在包内 data 目录时，新版第一次标准启动也会从当前包或严格更旧的
sibling 包中复制并保留旧数据。需要指定来源时，必须在第一次标准启动、当前选中的目标
目录尚不存在前运行：

    .\SmartPerfetto.exe --migrate-from "C:\path\to\old-package"

如果当前选中的目标已经存在，显式迁移会报错并保持来源和目标不变；不会合并或覆盖。
先备份并确认应该保留哪一份，再移动现有目标后重试。回滚旧版时不会从更高版本 sibling
自动倒灌数据，但旧版仍可能不认识新数据 schema。

## 10. 卸载与彻底清理

只删除程序目录会卸载程序，但保留数据根目录和迁移时保留的 C 盘副本。彻底清理时：

1. 按 Ctrl+C 停止并关闭所有 SmartPerfetto 窗口。
2. 备份需要保留的 trace、Provider 配置和报告。
3. 删除程序目录。
4. 只有确认不再需要任何数据时，才删除启动器打印的 **Data directory**；如果曾从
   `%LOCALAPPDATA%\SmartPerfetto` 自动迁移到 D 盘，再单独确认是否删除保留的 C 盘副本。
   此操作不能由 SmartPerfetto 恢复。

## Windows 排障

### 浏览器没有打开或页面无法访问

先看启动器是否打印 SmartPerfetto is running.，再手动打开实际 Open: 地址，不要假设
一定是 10000。启动器已经退出时，在 PowerShell 运行 .\SmartPerfetto.exe 保留错误。

### 后端没有就绪

查看最近日志：

    $dataDir = "D:\SmartPerfettoData" # 替换为启动器实际打印的 Data directory
    Get-Content "$dataDir\logs\backend.log" -Tail 200
    Get-Content "$dataDir\logs\frontend.log" -Tail 200

提示包内文件缺失时，删除当前解压目录，从已校验的 zip 重新“全部解压”。不要跨版本复制
node.exe、.node 或 trace_processor_shell.exe 混用。

### Provider 保存了但不能分析

确认 Provider 已测试且 active；核对 runtime、Base URL、模型 ID、协议和代理。
Connection 中的 backend auth token 不能代替 Provider API key。公司代理或 TLS 中间人
环境可能需要管理员提供可信 CA；不要关闭 TLS 校验。

### SmartScreen、Defender 或企业策略拦截

重新核对官方 Release 和 SHA256。企业策略不提供继续入口时联系 IT。不要改注册表、
关闭 Defender 或绕过组织策略。

### 迁移命令报目标已存在

这是防覆盖行为。不要直接删除目标。先停止程序并备份启动器打印的 Data directory，
确认旧来源与当前目标，再移动目标后重试。启用 SMARTPERFETTO_PORTABLE_MODE 或
SMARTPERFETTO_PORTABLE_DATA_DIR 时不能使用 --migrate-from。

### 企业 SecretStore 或 DPAPI 失败

DPAPI 绑定当前 Windows 用户与机器。切换账号、复制到另一台机器或 Windows
PowerShell/DPAPI 被策略禁用时，enterprise 本地 SecretStore 可能无法解密。不要删除
.master-key.dpapi；恢复原账号/机器，或由部署管理员用已备份的显式 master/server
secret 恢复。

## 发布前 Windows QA 清单

自动化不能代替桌面验收。公开发布前至少人工检查：

- Windows 11 x64 普通非管理员账号；承诺旧系统时分别验证对应版本。
- Explorer“全部解压”和 PowerShell Expand-Archive。
- 英文/中文用户名、空格目录、短路径与长路径。
- SmartScreen、Defender、企业安全策略的真实提示。
- Edge/Chrome/Firefox、无默认浏览器、默认端口占用。
- Provider Create → Save → Test → Activate，重启后保持。
- 小 trace 加载、AI 分析、报告生成。
- package-local 旧数据迁移、目标已存在、升级和回滚。
- Ctrl+C、关闭窗口后的子进程清理与端口释放。

## 常见问题

### 为什么 zip 很大

包内含 Node.js 24、后端、预构建 Perfetto UI、目标平台原生依赖、Agent runtime 和固定
trace_processor_shell，因此不需要另装这些运行时。

### Windows ARM64 能运行吗

当前没有 Windows ARM64 原生产物或验收承诺。系统模拟运行 x64 包也不属于当前发布验证。

### 为什么地址不是 10000

默认端口被占用后启动器会选择其他端口。始终使用窗口打印的 Open: 地址。

### 删除程序目录会删除数据吗

标准模式不会；数据保留在启动器打印的数据根目录。true portable 模式把数据放在程序
旁边，删除前必须自行备份。

### 能不能关闭 Defender

不能。先校验官方来源和 SHA256，企业策略阻止时联系 IT。项目后续仍需接入
Authenticode 和时间戳，才能改善身份与信誉验证。

## 提交问题时提供什么

请提供 Windows 版本与 OS build、x64/ARM64、是否普通账号、资产文件名和 SHA256、
解压路径类型、启动器完整错误、两份日志最后 200 行、实际 Open: 端口，以及 Provider
保存/测试/激活哪一步失败。

提交前删除 API key、Authorization header、cookie、企业域名、用户名、trace 内容和
个人路径。默认不要上传 trace、providers.json、env、.master-key.dpapi 或启动器打印的
整个数据目录。
