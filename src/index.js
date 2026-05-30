// Main Process — 窗口管理、文件系统、菜单
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { callAI } = require('./ai-service');
const { setLang, getLang, t } = require('./i18n');
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch {
  // electron-updater 在打包环境中可能不可用，优雅降级
  console.warn('[Mink] electron-updater not available, auto-update disabled');
}
let _manualUpdateCheck = false;

// App icon path - resolve dynamically for dev and production
function resolveIcon() {
  // Try app root first (works in dev mode)
  const fromApp = path.join(app.getAppPath(), 'assets', 'icon.png');
  if (fs.existsSync(fromApp)) return fromApp;
  // Try __dirname-based paths (production)
  const fromDir2 = path.join(__dirname, '../../assets/icon.png');
  if (fs.existsSync(fromDir2)) return fromDir2;
  const fromDir1 = path.join(__dirname, '../assets/icon.png');
  if (fs.existsSync(fromDir1)) return fromDir1;
  return null;
}

// Handle Squirrel startup (Windows only)
if (process.platform === 'win32') {
  try { if (require('electron-squirrel-startup')) app.quit(); } catch { }
}

// Set app name (shows in macOS menu bar)
app.name = 'Mink';

let mainWindow;
let currentFilePath = null;
let currentFolderPath = null;
let isModified = false;
let isWelcomeDoc = false;

// ===== Config Persistence（带内存缓存，减少磁盘 I/O） =====
const configPath = path.join(app.getPath('userData'), 'mink-config.json');
let _configCache = null;
function loadConfig() {
  if (_configCache) return _configCache;
  try {
    if (fs.existsSync(configPath)) {
      _configCache = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return _configCache;
    }
  } catch { }
  _configCache = { recentFiles: [], recentFolders: [], lastFolder: null, lastFile: null, welcomeShown: false, lang: 'zh' };
  return _configCache;
}
function saveConfig(config) {
  _configCache = config;
  try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8'); } catch { }
}
function setLastFile(filePath) {
  const config = loadConfig();
  config.lastFile = filePath || null;
  saveConfig(config);
}
function addRecentFile(filePath) {
  const config = loadConfig();
  config.recentFiles = [filePath, ...config.recentFiles.filter(f => f !== filePath)].slice(0, 10);
  saveConfig(config);
  buildMenu();
}
function addRecentFolder(folderPath) {
  const config = loadConfig();
  const folders = config.recentFolders || [];
  config.recentFolders = [folderPath, ...folders.filter(f => f !== folderPath)].slice(0, 5);
  saveConfig(config);
  buildMenu();
}

function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  if (!mainWindow.isMaximized()) mainWindow.maximize();
  mainWindow.focus();
  if (process.platform === 'darwin' && app.dock) app.dock.show();
}

function createWindow() {
  const isDev = Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    show: isDev, // Dev 模式直接显示窗口，避免等待渲染完成时看不到界面
    icon: resolveIcon(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // 允许加载本地 file:// 图片
    },
  });

  // Load the app - Vite plugin injects these variables
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    // Open DevTools in dev mode
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  updateTitle();
  buildMenu();

  // Show window after first paint. Also keep a fallback path for dev mode,
  // where ready-to-show may be delayed by renderer boot or HMR startup.
  mainWindow.once('ready-to-show', revealMainWindow);
  mainWindow.webContents.once('did-finish-load', revealMainWindow);
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[Mink] renderer load failed:', { errorCode, errorDescription, validatedURL });
    revealMainWindow();
  });
  setTimeout(revealMainWindow, isDev ? 3000 : 1500);

  // On page load: restore last file/folder, fallback to welcome doc.
  mainWindow.webContents.on('did-finish-load', () => {
    const config = loadConfig();
    let restoredLastFile = false;

    // If we already have a file open (HMR reload), re-send it
    if (currentFilePath && fs.existsSync(currentFilePath)) {
      try {
        const content = fs.readFileSync(currentFilePath, 'utf-8');
        mainWindow.webContents.send('file-opened', { content, path: currentFilePath });
        restoredLastFile = true;
      } catch { }
    }

    // Restore last opened file on fresh start
    if (!restoredLastFile && !currentFilePath && config.lastFile && fs.existsSync(config.lastFile)) {
      try {
        const content = fs.readFileSync(config.lastFile, 'utf-8');
        currentFilePath = config.lastFile;
        isModified = false;
        isWelcomeDoc = false;
        addRecentFile(config.lastFile);
        mainWindow.webContents.send('file-opened', { content, path: config.lastFile });
        updateTitle();
        restoredLastFile = true;
      } catch { }
    }

    // Show welcome doc only on very first launch if no file was restored.
    if (!restoredLastFile && !currentFilePath && !config.welcomeShown) {
      try {
        const welcomePath = path.join(__dirname, '../src/welcome.md');
        let content;
        if (fs.existsSync(welcomePath)) {
          content = fs.readFileSync(welcomePath, 'utf-8');
        } else {
          const altPath = path.join(app.getAppPath(), 'src/welcome.md');
          if (fs.existsSync(altPath)) {
            content = fs.readFileSync(altPath, 'utf-8');
          }
        }
        if (content) {
          isWelcomeDoc = true;
          mainWindow.webContents.send('file-opened', { content, path: null, isWelcome: true });
        }
      } catch { }
      config.welcomeShown = true;
      saveConfig(config);
    }

    // Always restore last folder
    if (config.lastFolder && fs.existsSync(config.lastFolder)) {
      currentFolderPath = config.lastFolder;
      const tree = readFolderTree(config.lastFolder);
      mainWindow.webContents.send('folder-opened', { path: config.lastFolder, tree });
      startWatchingFolder(config.lastFolder);
    }
  });
}

function updateTitle() {
  const name = currentFilePath ? path.basename(currentFilePath) : t('untitled');
  const mod = isModified ? ' •' : '';
  mainWindow.setTitle(`${name}${mod}`);
  mainWindow.webContents.send('title-changed', { name, isModified, path: currentFilePath });
}

// ===== File Operations =====
async function newFile() {
  if (isModified && !isWelcomeDoc) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: [t('btnSave'), t('btnDontSave'), t('btnCancel')],
      defaultId: 0,
      message: t('unsavedTitle'),
      detail: t('unsavedDetail'),
    });
    if (result.response === 0) await saveFile();
    if (result.response === 2) return;
  }
  currentFilePath = null;
  setLastFile(null);
  isModified = false;
  isWelcomeDoc = false;
  mainWindow.webContents.send('file-new');
  updateTitle();
}

async function openFile(filePath) {
  if (isModified && !isWelcomeDoc) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: [t('btnSave'), t('btnDontSave'), t('btnCancel')],
      defaultId: 0,
      message: t('unsavedTitle'),
    });
    if (result.response === 0) await saveFile();
    if (result.response === 2) return;
  }

  let targetPath = filePath;
  if (!targetPath) {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled) return;
    targetPath = result.filePaths[0];
  }

  try {
    const content = fs.readFileSync(targetPath, 'utf-8');
    currentFilePath = targetPath;
    setLastFile(targetPath);
    isModified = false;
    isWelcomeDoc = false;
    addRecentFile(targetPath);
    mainWindow.webContents.send('file-opened', { content, path: targetPath });
    updateTitle();
  } catch (e) {
    dialog.showErrorBox('打开失败', e.message);
  }
}

async function saveFile() {
  if (!currentFilePath) return saveFileAs();

  try {
    const content = await mainWindow.webContents.executeJavaScript('window.__getMarkdown()');
    fs.writeFileSync(currentFilePath, content, 'utf-8');
    isModified = false;
    updateTitle();
    mainWindow.webContents.send('file-saved');
  } catch (e) {
    dialog.showErrorBox(t('saveFailed'), e.message);
  }
}

async function saveFileAs() {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    defaultPath: currentFilePath || '未命名.md',
  });
  if (result.canceled) return;

  currentFilePath = result.filePath;
  setLastFile(currentFilePath);
  await saveFile();
}

async function openFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled) return;

  const folderPath = result.filePaths[0];
  currentFolderPath = folderPath;
  const config = loadConfig();
  config.lastFolder = folderPath;
  saveConfig(config);
  addRecentFolder(folderPath);
  const tree = readFolderTree(folderPath);
  mainWindow.webContents.send('folder-opened', { path: folderPath, tree });
  startWatchingFolder(folderPath);
}

function readFolderTree(dirPath, depth = 0) {
  if (depth > 3) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map(entry => {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          return { name: entry.name, path: fullPath, isDir: true, children: readFolderTree(fullPath, depth + 1) };
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (['.md', '.markdown', '.txt'].includes(ext)) {
          return { name: entry.name, path: fullPath, isDir: false };
        }
        return null;
      })
      .filter(Boolean);
  } catch { return []; }
}

// ===== 目录监听：文件变化时自动刷新文件树 =====
let _folderWatcher = null;
let _refreshTimer = null;

function startWatchingFolder(folderPath) {
  stopWatchingFolder();
  try {
    _folderWatcher = fs.watch(folderPath, { recursive: true }, (eventType, filename) => {
      // 忽略隐藏文件和非 markdown 文件的变化（减少不必要的刷新）
      if (filename && filename.split(path.sep).some(p => p.startsWith('.'))) return;
      // 防抖：500ms 内多次变化只刷新一次
      if (_refreshTimer) clearTimeout(_refreshTimer);
      _refreshTimer = setTimeout(() => {
        if (currentFolderPath && mainWindow && !mainWindow.isDestroyed()) {
          const tree = readFolderTree(currentFolderPath);
          mainWindow.webContents.send('folder-opened', { path: currentFolderPath, tree });
        }
      }, 500);
    });
  } catch (e) {
    console.error('[Mink] 目录监听失败:', e.message);
  }
}

function stopWatchingFolder() {
  if (_folderWatcher) {
    _folderWatcher.close();
    _folderWatcher = null;
  }
  if (_refreshTimer) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }
}

// ===== IPC Handlers =====
// 文件拖拽中继：preload → main → renderer
ipcMain.on('file-dropped-from-preload', (_, data) => {
  if (mainWindow) {
    mainWindow.webContents.send('file-dropped', data);
  }
});

ipcMain.on('content-modified', () => {
  if (isWelcomeDoc) return; // Don't mark welcome doc as modified
  if (!isModified) {
    isModified = true;
    updateTitle();
  }
});

ipcMain.handle('read-file', async (_, filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return null;
  }
});

ipcMain.handle('open-file-from-path', async (_, filePath) => {
  await openFile(filePath);
});

ipcMain.handle('create-file-in-folder', async () => {
  const defaultDir = currentFolderPath || app.getPath('documents');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: t('newMarkdown'),
    defaultPath: path.join(defaultDir, '未命名.md'),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return { canceled: true };
  const filePath = result.filePath;
  try {
    fs.writeFileSync(filePath, '', 'utf-8');
    // Auto-set folder to file's directory and refresh tree
    const fileDir = path.dirname(filePath);
    if (!currentFolderPath) {
      currentFolderPath = fileDir;
    }
    const tree = readFolderTree(currentFolderPath);
    mainWindow.webContents.send('folder-opened', { path: currentFolderPath, tree });
    // Open the new file
    await openFile(filePath);
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('delete-file', async (_, filePath) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: [t('btnDelete'), t('btnCancel')],
    defaultId: 1,
    message: `${t('confirmDelete')} ${path.basename(filePath)}？`,
    detail: t('deleteIrreversible'),
  });
  if (result.response !== 0) return { canceled: true };
  try {
    fs.unlinkSync(filePath);
    if (currentFolderPath) {
      const tree = readFolderTree(currentFolderPath);
      mainWindow.webContents.send('folder-opened', { path: currentFolderPath, tree });
    }
    if (currentFilePath === filePath) {
      setLastFile(null);
      await newFile();
    }
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('rename-file', async (_, oldPath, newName) => {
  const dir = path.dirname(oldPath);
  const newPath = path.join(dir, newName);
  try {
    if (fs.existsSync(newPath)) return { error: '文件名已存在' };
    fs.renameSync(oldPath, newPath);
    if (currentFilePath === oldPath) {
      currentFilePath = newPath;
      setLastFile(newPath);
      updateTitle();
    }
    if (currentFolderPath) {
      const tree = readFolderTree(currentFolderPath);
      mainWindow.webContents.send('folder-opened', { path: currentFolderPath, tree });
    }
    return { success: true };
  } catch (e) {
    return { error: e.message };
  }
});

// 粘贴图片保存到本地文件（类似 Typora 模式）
ipcMain.handle('save-image', async (_, base64Data) => {
  try {
    // 确定保存目录：当前文件同级的 assets 文件夹
    let saveDir;
    if (currentFilePath) {
      saveDir = path.join(path.dirname(currentFilePath), 'assets');
    } else if (currentFolderPath) {
      saveDir = path.join(currentFolderPath, 'assets');
    } else {
      saveDir = path.join(app.getPath('documents'), 'Mink-images');
    }
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }

    // 解析 base64 数据
    const matches = base64Data.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) return { error: '无效的图片数据' };
    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const buffer = Buffer.from(matches[2], 'base64');

    // 生成文件名：image-时间戳.ext
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const fileName = `image-${timestamp}.${ext}`;
    const filePath = path.join(saveDir, fileName);

    fs.writeFileSync(filePath, buffer);
    return { path: filePath };
  } catch (e) {
    return { error: e.message };
  }
});

// ===== AI IPC Handlers =====
let _activeAIStream = null;

ipcMain.handle('get-ai-config', () => {
  const config = loadConfig();
  return config.ai || { provider: 'openai', apiKey: '', model: '', baseUrl: '' };
});

ipcMain.handle('set-ai-config', (_, aiConfig) => {
  const config = loadConfig();
  config.ai = aiConfig;
  saveConfig(config);
  return { success: true };
});

ipcMain.handle('ai-chat', async (_, opts) => {
  try {
    const config = loadConfig();
    const ai = config.ai || {};
    const result = await callAI({
      provider: opts.provider || ai.provider || 'openai',
      apiKey: opts.apiKey || ai.apiKey,
      model: opts.model || ai.model,
      baseUrl: opts.baseUrl || ai.baseUrl,
      messages: opts.messages,
      stream: false,
    });
    return { result };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('ai-stream-start', async (_, opts) => {
  try {
    const config = loadConfig();
    const ai = config.ai || {};
    const provider = opts.provider || ai.provider || 'openai';
    const apiKey = opts.apiKey || ai.apiKey || '';
    const model = opts.model || ai.model || '';
    const baseUrl = opts.baseUrl || ai.baseUrl || '';
    console.log('[AI Stream] provider:', provider, 'apiKey:', apiKey ? apiKey.slice(0, 8) + '...' : '(empty)', 'model:', model, 'baseUrl:', baseUrl || '(default)');
    _activeAIStream = 'running';

    const result = await callAI({
      provider,
      apiKey,
      model,
      baseUrl,
      messages: opts.messages,
      stream: true,
      onChunk: (text) => {
        if (_activeAIStream === 'stopped') return;
        mainWindow?.webContents.send('ai-stream-chunk', text);
      },
    });

    _activeAIStream = null;
    mainWindow?.webContents.send('ai-stream-done', result);
    return { success: true };
  } catch (e) {
    _activeAIStream = null;
    mainWindow?.webContents.send('ai-stream-error', e.message);
    return { error: e.message };
  }
});

ipcMain.on('ai-stream-stop', () => {
  _activeAIStream = 'stopped';
});

// ===== AI Chat History =====
const chatHistoryPath = path.join(app.getPath('userData'), 'mink-chat-history.json');

function loadChatHistory() {
  try {
    if (fs.existsSync(chatHistoryPath)) {
      return JSON.parse(fs.readFileSync(chatHistoryPath, 'utf-8'));
    }
  } catch { }
  return [];
}

function saveChatHistory(sessions) {
  try { fs.writeFileSync(chatHistoryPath, JSON.stringify(sessions, null, 2), 'utf-8'); } catch { }
}

ipcMain.handle('get-chat-history', () => loadChatHistory());

ipcMain.handle('save-chat-session', (_, session) => {
  let sessions = loadChatHistory();
  // 去重：先移除同 ID 的旧记录
  sessions = sessions.filter(s => s.id !== session.id);
  sessions.unshift(session); // 最新在前
  // 最多保留 50 个会话
  saveChatHistory(sessions.slice(0, 50));
  return { success: true };
});

ipcMain.handle('delete-chat-session', (_, id) => {
  const sessions = loadChatHistory();
  const filtered = sessions.filter(s => s.id !== id);
  saveChatHistory(filtered);
  return { success: true };
});

// ===== Menu =====
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        {
          label: t('about'), click: () => {
            const iconPath = resolveIcon();
            const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined;
            const isZh = getLang() === 'zh';
            const desc = isZh
              ? `版本 ${app.getVersion()}\n\n一个简约的所见即所得 Markdown 编辑器\n\n© 2024 irwinai`
              : `Version ${app.getVersion()}\n\nA minimalist WYSIWYG Markdown editor\n\n© 2024 irwinai`;
            const buttons = [isZh ? '官方网站' : 'Website', 'GitHub', isZh ? '关闭' : 'Close'];
            dialog.showMessageBox(mainWindow, {
              type: 'info', icon, title: t('about'), message: 'Mink', detail: desc,
              buttons, defaultId: 2, cancelId: 2,
            }).then(({ response }) => {
              if (response === 0) shell.openExternal('https://mink.irwinai.com');
              if (response === 1) shell.openExternal('https://github.com/irwinai/Mink');
            });
          }
        },
        { type: 'separator' },
        { role: 'hide', label: t('hide') },
        { role: 'hideOthers', label: t('hideOthers') },
        { role: 'unhide', label: t('showAll') },
        { type: 'separator' },
        { role: 'quit', label: t('quit') },
      ],
    }] : []),
    {
      label: t('file'),
      submenu: [
        { label: t('newFile'), accelerator: 'CmdOrCtrl+N', click: newFile },
        { label: t('open'), accelerator: 'CmdOrCtrl+O', click: () => openFile() },
        { label: t('openFolder'), accelerator: 'CmdOrCtrl+Shift+O', click: openFolder },
        {
          label: t('recentOpen'),
          submenu: (() => {
            const config = loadConfig();
            const items = [];
            const recentFiles = (config.recentFiles || []).filter(f => fs.existsSync(f));
            if (recentFiles.length > 0) {
              items.push({ label: t('files'), enabled: false });
              recentFiles.forEach(f => items.push({
                label: `  ${path.basename(f)}`,
                sublabel: f,
                click: () => openFile(f),
              }));
            }
            const recentFolders = (config.recentFolders || []).filter(f => fs.existsSync(f));
            if (recentFolders.length > 0) {
              if (items.length > 0) items.push({ type: 'separator' });
              items.push({ label: t('folders'), enabled: false });
              recentFolders.forEach(f => items.push({
                label: `  📁 ${path.basename(f)}`,
                sublabel: f,
                click: () => {
                  currentFolderPath = f;
                  const cfg = loadConfig();
                  cfg.lastFolder = f;
                  saveConfig(cfg);
                  const tree = readFolderTree(f);
                  mainWindow.webContents.send('folder-opened', { path: f, tree });
                  startWatchingFolder(f);
                },
              }));
            }
            if (items.length === 0) return [{ label: t('noRecent'), enabled: false }];
            items.push({ type: 'separator' });
            items.push({
              label: t('clearRecent'), click: () => {
                const cfg = loadConfig(); cfg.recentFiles = []; cfg.recentFolders = []; saveConfig(cfg); buildMenu();
              }
            });
            return items;
          })(),
        },
        { type: 'separator' },
        { label: t('save'), accelerator: 'CmdOrCtrl+S', click: saveFile },
        { label: t('saveAs'), accelerator: 'CmdOrCtrl+Shift+S', click: saveFileAs },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' }] : [{ role: 'quit', label: t('quit') }]),
      ],
    },
    {
      label: t('edit'),
      submenu: [
        { role: 'undo', label: t('undo') },
        { role: 'redo', label: t('redo') },
        { type: 'separator' },
        { role: 'cut', label: t('cut') },
        { role: 'copy', label: t('copy') },
        { role: 'paste', label: t('paste') },
        { role: 'selectAll', label: t('selectAll') },
        { type: 'separator' },
        { label: getLang() === 'zh' ? '查找与替换' : 'Find & Replace', accelerator: 'CmdOrCtrl+F', click: () => sendCmd('find') },
      ],
    },
    {
      label: t('paragraph'),
      submenu: [
        { label: `${t('heading')} 1`, accelerator: 'CmdOrCtrl+1', click: () => sendCmd('heading', { level: 1 }) },
        { label: `${t('heading')} 2`, accelerator: 'CmdOrCtrl+2', click: () => sendCmd('heading', { level: 2 }) },
        { label: `${t('heading')} 3`, accelerator: 'CmdOrCtrl+3', click: () => sendCmd('heading', { level: 3 }) },
        { label: `${t('heading')} 4`, accelerator: 'CmdOrCtrl+4', click: () => sendCmd('heading', { level: 4 }) },
        { type: 'separator' },
        { label: t('increaseHeading'), accelerator: 'CmdOrCtrl+=', click: () => sendCmd('heading-increase') },
        { label: t('decreaseHeading'), accelerator: 'CmdOrCtrl+-', click: () => sendCmd('heading-decrease') },
        { type: 'separator' },
        { label: t('bulletList'), click: () => sendCmd('bulletList') },
        { label: t('orderedList'), click: () => sendCmd('orderedList') },
        { label: t('taskList'), click: () => sendCmd('taskList') },
        { type: 'separator' },
        { label: t('blockquote'), click: () => sendCmd('blockquote') },
        { label: t('codeBlock'), click: () => sendCmd('codeBlock') },
        { label: t('horizontalRule'), click: () => sendCmd('horizontalRule') },
        { label: t('table'), click: () => sendCmd('table') },
      ],
    },
    {
      label: getLang() === 'zh' ? '格式' : 'Format',
      submenu: [
        { label: t('bold'), accelerator: 'CmdOrCtrl+B', click: () => sendCmd('bold') },
        { label: t('italic'), accelerator: 'CmdOrCtrl+I', click: () => sendCmd('italic') },
        { label: t('strikethrough'), accelerator: 'CmdOrCtrl+Shift+X', click: () => sendCmd('strike') },
        { label: t('inlineCode'), accelerator: 'CmdOrCtrl+E', click: () => sendCmd('code') },
        { type: 'separator' },
        { label: t('link'), accelerator: 'CmdOrCtrl+K', click: () => sendCmd('link') },
      ],
    },
    {
      label: t('view'),
      submenu: [
        { label: t('toggleSidebar'), accelerator: 'CmdOrCtrl+\\', click: () => sendCmd('toggle-sidebar') },
        { label: t('toggleOutline'), accelerator: 'CmdOrCtrl+Shift+1', click: () => sendCmd('toggle-outline') },
        { type: 'separator' },
        { label: t('toggleSource'), accelerator: 'CmdOrCtrl+/', click: () => sendCmd('toggle-source') },
        { type: 'separator' },
        { label: t('toggleTheme'), click: () => sendCmd('toggle-theme') },
        { type: 'separator' },
        { label: t('toggleFullscreen'), accelerator: 'Ctrl+Cmd+F', click: () => { if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); } },
        { label: t('toggleDevTools'), accelerator: 'Alt+CmdOrCtrl+I', click: () => { if (mainWindow) mainWindow.webContents.toggleDevTools(); } },
      ],
    },
    {
      label: t('ai'),
      submenu: [
        { label: t('aiChat'), accelerator: 'CmdOrCtrl+Shift+L', click: () => sendCmd('ai-chat') },
        { type: 'separator' },
        { label: t('aiSettings'), click: () => sendCmd('ai-settings') },
      ],
    },
    {
      label: t('language'),
      submenu: [
        {
          label: t('chinese'),
          type: 'radio',
          checked: getLang() === 'zh',
          click: () => switchLanguage('zh'),
        },
        {
          label: t('english'),
          type: 'radio',
          checked: getLang() === 'en',
          click: () => switchLanguage('en'),
        },
      ],
    },
    {
      label: t('help'),
      submenu: [
        {
          label: t('website'),
          click: () => shell.openExternal('https://github.com/irwinai/Mink'),
        },
        {
          label: t('changelog'),
          click: () => shell.openExternal('https://github.com/irwinai/Mink/releases'),
        },
        {
          label: t('reportBug'),
          click: () => shell.openExternal('https://github.com/irwinai/Mink/issues'),
        },
        { type: 'separator' },
        {
          label: t('checkUpdate'), click: () => {
            if (!app.isPackaged) {
              dialog.showMessageBox(mainWindow, { type: 'info', title: t('checkUpdate'), message: getLang() === 'zh' ? '开发模式下无法检查更新，请使用打包后的应用。' : 'Update check is only available in the packaged app.' });
              return;
            }
            _manualUpdateCheck = true;
            if (autoUpdater) {
              autoUpdater.checkForUpdates().catch(err => {
                dialog.showMessageBox(mainWindow, { type: 'error', title: getLang() === 'zh' ? '检查更新失败' : 'Update Check Failed', message: String(err.message || err) });
              });
            }
          },
        },
        { type: 'separator' },
        {
          label: t('openSource'),
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: t('openSource'),
              message: 'Mink Editor — Open Source Libraries',
              detail: [
                '• Electron — Desktop app framework',
                '• TipTap / ProseMirror — WYSIWYG editor',
                '• Vite — Build tool',
                '• Turndown — HTML to Markdown',
                '• Marked — Markdown to HTML',
                '• lowlight / highlight.js — Code highlighting',
                '',
                'GitHub: https://github.com/irwinai/Mink',
              ].join('\n'),
            });
          },
        },
        {
          label: t('license'),
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: t('license'),
              message: 'MIT License',
              detail: 'Copyright (c) 2024 irwinai\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction.',
            });
          },
        },

      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function switchLanguage(lang) {
  setLang(lang);
  const config = loadConfig();
  config.lang = lang;
  saveConfig(config);
  buildMenu();
  updateTitle();
  // Notify renderer to update UI strings
  mainWindow.webContents.send('language-changed', lang);
}

function sendCmd(command, payload = {}) {
  mainWindow.webContents.send('menu-command', { command, ...payload });
}

// ===== App Lifecycle =====
app.whenReady().then(() => {
  // Restore language preference
  const config = loadConfig();
  if (config.lang) setLang(config.lang);

  // Set dock icon on macOS
  if (process.platform === 'darwin' && app.dock) {
    try {
      const iconFile = resolveIcon();
      if (iconFile) {
        const icon = nativeImage.createFromPath(iconFile);
        if (!icon.isEmpty()) app.dock.setIcon(icon);
      }
    } catch { }
  }
  createWindow();

  // ===== Auto-Updater =====
  if (autoUpdater) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: getLang() === 'zh' ? '发现新版本' : 'Update Available',
          message: getLang() === 'zh' ? `发现新版本 v${info.version}，正在后台下载…` : `Version v${info.version} is available. Downloading in background...`,
        });
      }
    });

    autoUpdater.on('update-not-available', () => {
      if (_manualUpdateCheck && mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: getLang() === 'zh' ? '检查更新' : 'Check for Updates',
          message: getLang() === 'zh' ? '当前已是最新版本。' : 'You are using the latest version.',
        });
      }
      _manualUpdateCheck = false;
    });

    autoUpdater.on('update-downloaded', (info) => {
      if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: getLang() === 'zh' ? '更新已就绪' : 'Update Ready',
          message: getLang() === 'zh' ? `v${info.version} 已下载完成，重启后自动安装。` : `v${info.version} has been downloaded. It will be installed on restart.`,
          buttons: [getLang() === 'zh' ? '立即重启' : 'Restart Now', getLang() === 'zh' ? '稍后' : 'Later'],
        }).then(({ response }) => {
          if (response === 0) autoUpdater.quitAndInstall();
        });
      }
    });

    autoUpdater.on('error', (err) => {
      console.error('Auto-updater error:', err);
      if (_manualUpdateCheck && mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: getLang() === 'zh' ? '检查更新失败' : 'Update Check Failed',
          message: getLang() === 'zh' ? `无法检查更新：${err.message}` : `Failed to check for updates: ${err.message}`,
        });
      }
      _manualUpdateCheck = false;
    });

    // 打包后才自动检查更新
    if (app.isPackaged) {
      setTimeout(() => autoUpdater.checkForUpdates().catch(() => { }), 5000);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      revealMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopWatchingFolder();
  if (process.platform !== 'darwin') app.quit();
});

// Handle file open from OS (drag & drop or Open With)
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    openFile(filePath);
  }
});
