// ===== Markdown ↔ HTML 转换 =====
import { marked } from 'marked';
import TurndownService from 'turndown';

// 零宽空格，用于标记空段落
const ZWSP = '\u200B';

// ===== HTML → Markdown (TurndownService) =====
const turndown = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
});

// Task list support
turndown.addRule('taskListItem', {
    filter: (node) => {
        return node.nodeName === 'LI' && node.querySelector('input[type="checkbox"]');
    },
    replacement: (content, node) => {
        const checkbox = node.querySelector('input[type="checkbox"]');
        const checked = checkbox && checkbox.checked ? 'x' : ' ';
        const text = content.replace(/^\s*\[[ x]\]\s*/, '').trim();
        return `- [${checked}] ${text}\n`;
    },
});

// Table support
turndown.addRule('table', {
    filter: 'table',
    replacement: (content, node) => {
        const rows = Array.from(node.querySelectorAll('tr'));
        if (rows.length === 0) return content;

        const result = [];
        rows.forEach((row, i) => {
            const cells = Array.from(row.querySelectorAll('th, td'));
            const rowContent = cells.map(cell => cell.textContent.trim()).join(' | ');
            result.push(`| ${rowContent} |`);

            if (i === 0) {
                const separator = cells.map(() => '---').join(' | ');
                result.push(`| ${separator} |`);
            }
        });

        return '\n' + result.join('\n') + '\n\n';
    },
});

// Strikethrough
turndown.addRule('strikethrough', {
    filter: ['del', 's', 'strike'],
    replacement: (content) => `~~${content}~~`,
});

// Highlight
turndown.addRule('highlight', {
    filter: 'mark',
    replacement: (content) => `==${content}==`,
});

// Image（处理 file:// 协议和 data URL）
turndown.addRule('image', {
    filter: 'img',
    replacement: (content, node) => {
        let src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || '';
        // 去掉 file:// 协议前缀，存储纯路径
        if (src.startsWith('file://')) {
            src = src.replace('file://', '');
        }
        if (src.startsWith('data:')) {
            return `<img src="${src}" alt="${alt}">`;
        }
        return `![${alt}](${src})`;
    },
});

export function htmlToMarkdown(html) {
    if (!html || html === '<p></p>') return '';
    let processed = html.replace(/<p>\s*(<br[^>]*\/?>)?\s*<\/p>/gi, `<p>${ZWSP}</p>`);
    return turndown.turndown(processed);
}

// ===== Markdown → HTML (Marked) =====
marked.setOptions({
    breaks: true,
    gfm: true,
});

export function markdownToHtml(md) {
    if (!md || !md.trim()) return '<p></p>';
    let html = marked.parse(md);
    html = html.replace(/<p>\u200B<\/p>/g, '<p><br></p>');
    // 将本地绝对路径图片加上 file:// 协议前缀以便显示
    html = html.replace(/<img\s+src="(\/[^"]+)"/g, '<img src="file://$1"');
    // 将 marked 生成的标准 task list HTML 转为 Tiptap 兼容格式
    // marked 输出: <li><input type="checkbox" disabled> text</li>
    // Tiptap 需要: <li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>text</p></div></li>
    // 同时给包含 task item 的 <ul> 加上 data-type="taskList"
    html = html.replace(
        /<li><input\s+(?:checked=""?\s*)?(?:disabled=""?\s*)?type="checkbox"(?:\s+checked=""?)?(?:\s+disabled=""?)?>\s*(.*?)<\/li>/gi,
        (match, text, offset, fullStr) => {
            const isChecked = /checked/i.test(match);
            return `<li data-type="taskItem" data-checked="${isChecked}"><label><input type="checkbox"${isChecked ? ' checked' : ''}></label><div><p>${text.trim()}</p></div></li>`;
        }
    );
    // 给包含 taskItem 的 <ul> 添加 data-type="taskList"
    html = html.replace(/<ul>\s*(<li data-type="taskItem")/g, '<ul data-type="taskList">$1');
    return html;
}

