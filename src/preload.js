// Preload — contextBridge 安全 API
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // File events from main process
    onFileNew: (callback) => ipcRenderer.on('file-new', callback),
    onFileOpened: (callback) => ipcRenderer.on('file-opened', (_, data) => callback(data)),
    onFileSaved: (callback) => ipcRenderer.on('file-saved', callback),
    onFolderOpened: (callback) => ipcRenderer.on('folder-opened', (_, data) => callback(data)),
    onTitleChanged: (callback) => ipcRenderer.on('title-changed', (_, data) => callback(data)),

    // Menu commands
    onMenuCommand: (callback) => ipcRenderer.on('menu-command', (_, data) => callback(data)),

    // Language change
    onLanguageChanged: (callback) => ipcRenderer.on('language-changed', (_, lang) => callback(lang)),

    // Content change notification
    contentModified: () => ipcRenderer.send('content-modified'),

    // File operations
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
    openFileFromPath: (filePath) => ipcRenderer.invoke('open-file-from-path', filePath),
    createFileInFolder: () => ipcRenderer.invoke('create-file-in-folder'),
    deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
    renameFile: (oldPath, newName) => ipcRenderer.invoke('rename-file', oldPath, newName),
    saveImage: (base64Data) => ipcRenderer.invoke('save-image', base64Data),

    // 文件拖拽回调
    onFileDropped: (callback) => ipcRenderer.on('file-dropped', (_, data) => callback(data)),

    // AI
    aiChat: (opts) => ipcRenderer.invoke('ai-chat', opts),
    aiStreamStart: (opts) => ipcRenderer.invoke('ai-stream-start', opts),
    aiStreamStop: () => ipcRenderer.send('ai-stream-stop'),
    onAIStreamChunk: (callback) => { ipcRenderer.removeAllListeners('ai-stream-chunk'); ipcRenderer.on('ai-stream-chunk', (_, text) => callback(text)); },
    onAIStreamDone: (callback) => { ipcRenderer.removeAllListeners('ai-stream-done'); ipcRenderer.on('ai-stream-done', (_, text) => callback(text)); },
    onAIStreamError: (callback) => { ipcRenderer.removeAllListeners('ai-stream-error'); ipcRenderer.on('ai-stream-error', (_, err) => callback(err)); },
    getAIConfig: () => ipcRenderer.invoke('get-ai-config'),
    setAIConfig: (config) => ipcRenderer.invoke('set-ai-config', config),

    // AI Chat History
    getChatHistory: () => ipcRenderer.invoke('get-chat-history'),
    saveChatSession: (session) => ipcRenderer.invoke('save-chat-session', session),
    deleteChatSession: (id) => ipcRenderer.invoke('delete-chat-session', id),
});

// ===== 全局文件拖拽 =====
// 拖拽文件到编辑器时，在光标处插入 [文件名](文件路径) 链接。
// 必须在 preload 脚本中处理，因为 webUtils.getPathForFile() 需要原始 File 对象引用。
// 使用 capture 阶段监听，确保在 ProseMirror 编辑器拦截之前处理。
document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
}, true);

document.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
        const file = files[0];
        try {
            const filePath = webUtils.getPathForFile(file);
            if (filePath) {
                // 直接用 File API 的 name 属性获取文件名
                const fileName = file.name;
                // 通过 IPC 中继给渲染进程，在编辑器中插入链接
                ipcRenderer.send('file-dropped-from-preload', { name: fileName, path: filePath });
            }
        } catch (err) {
            console.error('[Mink] 拖拽获取文件路径失败:', err);
        }
    }
}, true);



