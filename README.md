# Mink 🐾


**Mink** — A minimalist WYSIWYG Markdown desktop editor.

> The name "Mink" sounds like "ink", symbolizing writing and creation.

## ✨ Features

- **WYSIWYG** — Type Markdown, see it rendered instantly
- **Minimalist UI** — Distraction-free writing experience
- **AI Writing Assistant** — Select text → Continue / Rewrite / Translate / Summarize
- **AI Chat Sidebar** — Context-aware AI chat panel (`Cmd+Shift+L`)
- **AI Autocomplete** — Smart ghost-text suggestions, Tab to accept
- **Multi-AI Provider** — OpenAI, Claude, Ollama — configure in Settings
- **File Management** — Sidebar file tree with create/rename/delete
- **Outline Navigation** — Auto-generated heading outline
- **Source Mode** — Toggle raw Markdown with `Cmd+/`
- **Search & Replace** — `Cmd+F` full-text search and replace
- **Dark Theme** — One-click light/dark switch
- **Code Highlighting** — Built-in syntax highlighting (One Dark)
- **Table Editing** — Visual tables with resizable columns
- **Task Lists** — Checkable todo items
- **i18n** — Chinese and English interface
- **Live Stats** — Word/character/line count

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start development
npm start

# Package for distribution
npm run make
```

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|--------|------|
| `Cmd+N` | New file |
| `Cmd+O` | Open file |
| `Cmd+S` | Save |
| `Cmd+F` | Search & Replace |
| `Cmd+B/I/E` | Bold/Italic/Inline code |
| `Cmd+K` | Insert link |
| `Cmd+1~4` | Heading 1-4 |
| `Cmd+/` | Source code mode |
| `Cmd+\` | Toggle sidebar |
| `Cmd+Shift+L` | AI Chat sidebar |

## 🏗 Tech Stack

| Technology | Purpose |
|------|------|
| Electron | Desktop app framework |
| TipTap (ProseMirror) | WYSIWYG editor core |
| Vite | Build tool |
| Turndown + Marked | Markdown ↔ HTML conversion |
| lowlight (highlight.js) | Code syntax highlighting |

## 📦 Packaging & Distribution

```bash
# Package as macOS .app (unsigned, for local use)
npm run package

# Build distributable .dmg + .zip
npm run make
```

Output in the `out/` directory:

| Command | Output Path | Format |
|---------|-----------|--------|
| `npm run package` | `out/Mink-darwin-arm64/Mink.app` | Runnable .app bundle |
| `npm run make` | `out/make/Mink-x.x.x-arm64.dmg` | macOS disk image |
| `npm run make` | `out/make/zip/darwin/arm64/` | Distributable .zip |

> **Note**: To distribute via the Mac App Store or allow other users to run without Gatekeeper warnings,
> you'll need to configure Apple Developer code signing.

## 📜 License

[MIT](LICENSE)

