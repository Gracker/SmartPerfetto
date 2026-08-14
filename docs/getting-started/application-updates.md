# 应用更新

[English](application-updates.en.md) | [中文](application-updates.md)

<!-- i18n-headings: paired -->

SmartPerfetto 会检查公开发布元数据，并在存在更新版本时提示。更新检查只负责通知：
未经用户明确操作，它不会安装软件包、替换文件、修改源码 checkout、重启容器或改变
当前运行中的应用。

## 更新检查会报告什么

结果会说明当前 Build、识别到的分发方式、发布渠道、匹配的最新版本、上次检查时间和
建议动作。Docker stable 使用不可变的 SemVer tag；只有用户明确选择该渠道时才会显示
可变的 `nightly` tag。

## 使用入口

### Web UI

AI Assistant 横幅和 **设置 → 应用更新** 会显示当前状态，以及与分发方式匹配的更新动作。
点击 **立即检查** 可以显式刷新公开发布元数据。

### CLI

npm CLI 提供相同的状态：

```bash
smp update check
smp update check --format json
```

交互式文本命令结束后，可能在 stderr 输出经过限频的更新提醒。CI、重定向输出、
机器可读命令、help、version 和 `update` 命令本身不会收到额外提醒。完整命令契约见
[CLI 参考](../reference/cli.md#应用更新)。

## 各分发方式的更新动作

| 分发方式 | 建议动作 |
|---|---|
| npm CLI | 运行界面显示的 `npm install -g` 命令。 |
| Docker stable | 固定界面显示的不可变 SemVer tag，然后 pull 并重建服务。 |
| Docker nightly | 只有明确选择该渠道时，才继续使用可变的 `nightly` tag。 |
| 免安装包 | 下载匹配 target 的资产；GitHub 提供 SHA256 时，校验界面显示的摘要。 |
| 源码 checkout | 查看链接中的 commit 或 release，再通过正常 Git 流程更新。 |

免安装包更新不会覆盖已有安装目录或用户数据目录。替换包或移动数据前，请先阅读对应
平台说明：[Windows 指南](windows.md) 或
[免安装包](../reference/portable-packaging.md)。

## 关闭更新检查

启动前设置以下环境变量，可以关闭应用更新检查和提醒：

```bash
SMARTPERFETTO_UPDATE_CHECK=off
```

## 相关参考

- [CLI 更新命令](../reference/cli.md#应用更新)
- [更新 API](../reference/api.md#应用更新)
- [平台兼容](../reference/platform-compatibility.md)
