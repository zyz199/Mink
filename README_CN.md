# Mink 🐾

🌐 **官网**: [https://website-xi-jet-21.vercel.app](https://website-xi-jet-21.vercel.app) · [English](README.md)

**Mink** — 一款极简 WYSIWYG Markdown 桌面编辑器。

> "Mink" 读起来像 "ink"（墨水），象征书写与创作。

## ✨ 功能特性

- **所见即所得** — 输入 Markdown，实时渲染
- **极简设计** — 无干扰写作体验
- **AI 写作助手** — 选中文字 → 续写 / 改写 / 翻译 / 总结
- **AI 聊天侧边栏** — 上下文感知的 AI 对话面板（`Cmd+Shift+L`）
- **AI 自动补全** — 智能灰色建议文字，Tab 接受
- **多 AI 提供商** — 支持 OpenAI、Claude、Ollama，在设置中配置
- **文件管理** — 侧边栏文件树，支持新建/重命名/删除
- **大纲导航** — 自动生成标题大纲
- **源码模式** — `Cmd+/` 切换原始 Markdown
- **搜索替换** — `Cmd+F` 全文搜索与替换
- **深色主题** — 一键切换明暗主题
- **代码高亮** — 内置 One Dark 语法高亮
- **表格编辑** — 可视化表格
- **任务列表** — 可勾选的 TODO 项
- **国际化** — 中英文界面可切换
- **实时统计** — 字数/字符/行数

## 🚀 快速开始

```bash
# 安装依赖
npm install

# 启动开发
npm start

# 打包发布
npm run make
```

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd+N` | 新建文件 |
| `Cmd+O` | 打开文件 |
| `Cmd+S` | 保存 |
| `Cmd+F` | 搜索与替换 |
| `Cmd+B/I/E` | 加粗/斜体/行内代码 |
| `Cmd+K` | 插入链接 |
| `Cmd+1~4` | 标题 1-4 |
| `Cmd+/` | 源代码模式 |
| `Cmd+\` | 切换侧边栏 |
| `Cmd+Shift+L` | AI 聊天侧边栏 |

## 🏗 技术栈

| 技术 | 用途 |
|------|------|
| Electron | 桌面应用框架 |
| TipTap (ProseMirror) | 所见即所得编辑器 |
| Vite | 构建工具 |
| Turndown + Marked | Markdown ↔ HTML |
| lowlight | 代码语法高亮 |

## 📦 打包部署

```bash
# 打包成 macOS .app（未签名，本地使用）
npm run package

# 生成可分发的 .dmg + .zip
npm run make
```

打包产物在 `out/` 目录下：

| 命令 | 产物路径 | 格式 |
|------|---------|------|
| `npm run package` | `out/Mink-darwin-arm64/Mink.app` | 可直接运行的 .app |
| `npm run make` | `out/make/Mink-x.x.x-arm64.dmg` | macOS 安装镜像 |
| `npm run make` | `out/make/zip/darwin/arm64/` | 可分发的 .zip |

> **注意**：如需发布到 Mac App Store 或让其他用户无警告运行，  
> 需要配置 Apple Developer 签名证书。

## 📜 许可证

[MIT](LICENSE)

## 🔗 链接

- **官网**: [https://website-xi-jet-21.vercel.app](https://website-xi-jet-21.vercel.app)
- **GitHub**: [https://github.com/irwinai/Mink](https://github.com/irwinai/Mink)
- **Issues**: [https://github.com/irwinai/Mink/issues](https://github.com/irwinai/Mink/issues)
- **Releases**: [https://github.com/irwinai/Mink/releases](https://github.com/irwinai/Mink/releases)
