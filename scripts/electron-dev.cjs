const { api } = require('@electron-forge/core');

/**
electron-forge start 在当前这种非交互/后台启动场景下，父进程会很快退出。
父进程一退出，@electron-forge/plugin-vite 就会清理 Vite dev server，导致 Electron 访问 http://localhost:5173/ 时出现 ERR_CONNECTION_REFUSED，所以看起来像“没启动”。
我做的修复：

新增了一个自定义启动脚本，显式保持父进程存活到 Electron 子进程退出，并转发 SIGINT / SIGTERM。
*/
const keepAlive = setInterval(() => {}, 1000);
let currentChild = null;

function attachChildLifecycle(child) {
  currentChild = child;

  return new Promise((resolve) => {
    const cleanup = () => {
      child.removeListener('exit', onExit);
      child.removeListener('restarted', onRestart);
    };

    const onExit = (code) => {
      cleanup();
      if (child.restarted) return;
      process.exitCode = code ?? 0;
      resolve();
    };

    const onRestart = async (nextChild) => {
      cleanup();
      resolve(attachChildLifecycle(nextChild));
    };

    child.on('exit', onExit);
    child.on('restarted', onRestart);
  });
}

function forwardSignal(signal) {
  if (currentChild && !currentChild.killed) {
    currentChild.kill(signal === 'SIGINT' ? 'SIGTERM' : signal);
  }
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

(async () => {
  try {
    const child = await api.start({
      dir: process.cwd(),
      interactive: Boolean(process.stdin.isTTY),
      args: process.argv.slice(2),
    });

    await attachChildLifecycle(child);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearInterval(keepAlive);
  }
})();
