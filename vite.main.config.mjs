import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

// 自定义插件：将本地 CJS 模块复制到构建输出目录
// @electron-forge/plugin-vite 对 main process 使用 lib 模式，
// CJS require('./xxx') 不会被 Rollup 内联，需要手动复制
function copyLocalModules() {
    const modules = ['ai-service.js', 'i18n.js'];
    return {
        name: 'copy-local-modules',
        closeBundle() {
            const outDir = path.resolve(__dirname, '.vite/build');
            for (const mod of modules) {
                const src = path.resolve(__dirname, 'src', mod);
                const dest = path.join(outDir, mod);
                if (fs.existsSync(src)) {
                    fs.copyFileSync(src, dest);
                    console.log(`[copy-local-modules] ${mod} → .vite/build/`);
                }
            }
        },
    };
}

export default defineConfig({
    plugins: [copyLocalModules()],
    build: {
        rollupOptions: {
            external: ['electron', 'electron-updater', 'electron-squirrel-startup'],
        },
    },
});
