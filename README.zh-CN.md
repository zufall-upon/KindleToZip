[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

# KindleToZip

**截取、整理、归档。**

在 Windows 上截取 Kindle 网页阅读器中显示的页面，检查、拆分并整理 PNG 截图，再按顺序保存为 **ZIP / CBZ**。

**完全免费、开源 · Windows x64 · 无需注册 KindleToZip 账户 · 无付费 DLC**

> **实验性源代码版本 — 尚无公开的 Portable 可执行文件。**
> 仍有已知测试失败，不是已经验证、开箱即用的正式版本。

**[从源代码体验](docs/getting-started.zh-CN.md)** · [查看发布情况](https://github.com/zufall-upon/KindleToZip/releases)

## 从阅读页面到压缩包

1. **打开。** 在专用浏览器的 Kindle 官方页面登录，打开一本书并选择阅读标签页。
2. **获取。** 选择区域并检查预览。确认后，通过另一次操作明确开始获取。
3. **检查并保存。** 停止后检查图像，调整拆分、顺序或裁剪，再导出 ZIP / CBZ。

[![KindleToZip 真实界面：拆分预览、检查已重排的三张截图，以及六张图像的 ZIP 保存与回读验证成功](docs/images/kindletozip-overview.png)](docs/screenshots.md)

*使用自制样本的真实英语界面，由截图裁剪组合而成，并非模型图。本地导出路径已遮挡。样本成功不代表真实书籍获取或打包发行版已经通过验证。*

**查看原尺寸：** [预览](docs/screenshots.md#preview) · [检查与跨页拆分](docs/screenshots.md#review) · [ZIP 保存](docs/screenshots.md#export) · [日语界面](docs/screenshots.md#japanese-ui)

<details>
<summary>观看简短操作动图（日语界面 · 约8秒）</summary>

![作者录制的自制样本：在日语界面检查图像并保存 ZIP](docs/images/kindletozip-demo.gif)

*经过编辑的无声样本片段：已省略保存对话框，并遮挡本地路径。不验证真实书籍或发行版。[录制说明与静态图片](docs/screenshots.md#animation)。*

</details>

## 让截图更好用

以下功能已在源代码中实现，但仍受下文已知问题的影响：

- **获取前先检查。** 专用浏览器配置、区域选择、预览与明确确认，之后再单独开始。
- **拆分与排序。** 可选左右跨页拆分、阅读方向选择和图像重排。
- **保留原图。** 调整采用或排除状态，进行非破坏性裁剪；停止后无需重新获取即可检查已保存的图像。
- **有序归档。** 将采用的 PNG 导出为 ZIP / CBZ，不覆盖已有文件。
- **选择界面语言。** 支持日语、英语和简体中文。

## 从源代码体验

需要 **Windows x64、Git、Node.js 22+ 和 PowerShell 7**。[入门指南](docs/getting-started.zh-CN.md)会安装隔离的 Rust 工具链与专用浏览器，再通过 `npm start` 启动。建议先体验指南中的自制样本，无需 Amazon 登录或真实书籍。

希望无需开发环境就能使用？请等待[公开发布](https://github.com/zufall-upon/KindleToZip/releases)。虽然有 Portable 构建脚本，但**尚未公开经过验证的可执行文件**。

## 使用前须知

- **质量：** 初次公开源代码的 `npm test` 结果为 **125 项通过、12 项失败**。这是历史记录，不是正在修复的实现的最新结果，本次页面更新也未解决这些失败。详见[验证与已知失败](docs/validation.md)（英语）。
- **登录与本地数据：** 只在官方页面登录。**默认保存登录状态。** 关闭保留设置后会使用独立的临时配置，正常退出时删除，但异常退出可能留下文件。不要分享配置、Cookie、书籍信息或截图。详见[隐私与存储说明](docs/security-and-trust.md)（英语）。
- **网络与信任：** 没有应用自建的登录服务器、遥测或自动更新检查。官方阅读与认证服务、浏览器和安装过程仍会联网。开源**不等于安全保证**，详见[网络目标与信任边界](docs/security-and-trust.md)（英语）。
- **兼容性：** 当前入口面向日本地区的 Kindle 网页阅读器。其他地区、所有布局、干净的 Windows 环境、整本书获取、ZIP64 和所有 CBZ 阅读器均未验证。标准 / 2倍渲染有**每张 PNG 1600万像素 / 32 MiB** 的上限，无法恢复原始显示中不存在的细节。
- **条款与权利：** 不移除 DRM **不代表已获得法律或条款许可**。Amazon 的使用条件将机器人等数据收集工具排除在使用许可之外；自动获取和工具分发仍存在未解决的合同与版权问题。仅处理获准截取的内容，未经许可不要再分发页面。请阅读[法律注意事项](docs/legal-notes-ja.md)（日语）。

KindleToZip 是**非官方、独立项目**，与 Amazon 无关联，未获其认可或赞助。Amazon 和 Kindle 是 Amazon.com, Inc. 或其关联公司的商标。本项目不声称已获得 Amazon 或法律专业人士的批准。

## 常见问题

**免费吗？需要另行注册账户吗？**

KindleToZip 免费且开源，无需另行注册，没有付费配额、水印或付费功能解锁。Amazon 的账户要求及适用的内容购买或订阅仍然有效。

**它能移除 DRM，或操作 Windows 版 Kindle 桌面应用吗？**

不能。它截取网页阅读器显示的内容，不解密电子书文件，不绕过 DRM 或截图限制，也不操作桌面应用。

**能按正确顺序保存整本书吗？**

不保证。请自行检查范围、页面顺序、跨页拆分和停止位置。ZIP 验证成功不代表整本书已完整获取，拆分也不是语义页面识别。

**可以切换应用语言吗？**

可以在语言菜单选择日语、英语或简体中文。语言支持已经实现，但历史验证仍包含语言切换流程的测试失败。

## 支持开发

欢迎反馈与[问题报告](https://github.com/zufall-upon/KindleToZip/issues)。也可考虑 **[GitHub Sponsors](https://github.com/sponsors/zufall-upon)**；支持完全自愿，不影响功能使用。链接在尚未开放等情况下可能跳转至作者主页，**目前未确认已开始接受赞助**。

## 文档与许可证

[文档索引](docs/README.md) · [开发与构建](docs/development.md)（英语） · [发布验证](docs/releasing.md)（英语） · [截图与文档审查](docs/readme-review.md)（英语）

[GitHub Actions](https://github.com/zufall-upon/KindleToZip/actions) 包括源代码检查和单独手动运行的 Draft Release 工作流，不代表已具备发布质量、经过独立审计或能够按字节重现构建。

Copyright (C) 2026 **[zufall-upon](https://github.com/zufall-upon)**。**GNU GPL v3.0，仅此版本**（`GPL-3.0-only`），详见 [LICENSE](LICENSE)。软件不提供担保，依赖保留各自许可证；GPLv3 不授予书籍或所获取页面的使用权。
