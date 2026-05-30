// ===== Renderer — TipTap WYSIWYG Mink Editor =====
import './styles/app.css';
import './styles/editor.css';
import { Editor, Extension, InputRule, getMarkRange, markPasteRule } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { Link } from '@tiptap/extension-link';
import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Typography } from '@tiptap/extension-typography';
import { Highlight } from '@tiptap/extension-highlight';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { common, createLowlight } from 'lowlight';
import { htmlToMarkdown, markdownToHtml } from './markdown.js';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { DOMParser as PmDOMParser } from '@tiptap/pm/model';

// ===== Lowlight Setup =====
const lowlight = createLowlight(common);

// ===== Search Plugin =====
const searchPluginKey = new PluginKey('searchHighlight');

const SearchHighlight = Extension.create({
    name: 'searchHighlight',
    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: searchPluginKey,
                state: {
                    init() { return { matches: [], activeIndex: -1 }; },
                    apply(tr, prev) {
                        const meta = tr.getMeta(searchPluginKey);
                        if (meta) return meta;
                        if (tr.docChanged && prev.matches.length > 0) {
                            return {
                                matches: prev.matches.map(m => ({
                                    from: tr.mapping.map(m.from),
                                    to: tr.mapping.map(m.to),
                                })).filter(m => m.from < m.to),
                                activeIndex: prev.activeIndex,
                            };
                        }
                        return prev;
                    },
                },
                props: {
                    decorations(state) {
                        const { matches, activeIndex } = this.getState(state);
                        if (!matches || matches.length === 0) return DecorationSet.empty;
                        const decos = matches.map((m, i) =>
                            Decoration.inline(m.from, m.to, {
                                class: i === activeIndex ? 'search-highlight-active' : 'search-highlight',
                            })
                        );
                        return DecorationSet.create(state.doc, decos);
                    },
                },
            }),
        ];
    },
});

// ===== Typora-Style Inline Syntax Editing =====
const inlineBoldStarInputRegex = /(?<!\*)\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*)$/;
const inlineBoldStarPasteRegex = /(?<!\*)\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*)/g;
const inlineBoldUnderscoreInputRegex = /(?<!_)__(?!\s+__)((?:[^_]+))__(?!\s+__)$/;
const inlineBoldUnderscorePasteRegex = /(?<!_)__(?!\s+__)((?:[^_]+))__(?!\s+__)/g;
const inlineItalicStarInputRegex = /(?<!\*)\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*)$/;
const inlineItalicStarPasteRegex = /(?<!\*)\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*)/g;
const inlineItalicUnderscoreInputRegex = /(?<!_)_(?!\s+_)((?:[^_]+))_(?!\s+_)$/;
const inlineItalicUnderscorePasteRegex = /(?<!_)_(?!\s+_)((?:[^_]+))_(?!\s+_)/g;

let _activeInlineReveal = null;
let _syncingInlineReveal = false;
let _inlineRevealJustExpanded = false;
let _inlineRevealLastKeyEvent = null;
let _inlineRevealSuppressNextSelectionExpand = false;
const inlineRevealSyncMetaKey = 'inlineRevealSync';

function findActiveMarkRange(state, markName) {
    const { selection } = state;
    if (!selection.empty) return null;

    const tryAt = ($resolvedPos) => {
        const direct = $resolvedPos.marks().find(m => m.type.name === markName);
        const fromRight = ($resolvedPos.nodeAfter?.marks || []).find(m => m.type.name === markName);
        const fromLeft = ($resolvedPos.nodeBefore?.marks || []).find(m => m.type.name === markName);
        const mark = direct || fromRight || fromLeft;
        if (!mark) return null;
        const range = getMarkRange($resolvedPos, mark.type, mark.attrs);
        if (!range) return null;
        return range;
    };

    let range = tryAt(selection.$from);
    if (!range && selection.from > 1) {
        // Back off one char for boundary resolution only.
        range = tryAt(state.doc.resolve(selection.from - 1));
    }
    if (!range) return null;

    // Candidate must be within mark edges (left/right edge included).
    if (selection.from < range.from || selection.from > range.to) return null;
    return range;
}

function getRevealSyntax(markName) {
    if (markName === 'bold') return '**';
    if (markName === 'italic') return '*';
    return '';
}

function findRevealCandidate(state) {
    for (const markName of ['bold', 'italic']) {
        const range = findActiveMarkRange(state, markName);
        if (!range) continue;
        const markType = state.schema.marks[markName];
        if (!markType) continue;
        return { markName, range, markType, syntax: getRevealSyntax(markName) };
    }
    return null;
}

function findRevealCandidateRightOutside(state) {
    const { selection, schema } = state;
    if (!selection.empty) return null;
    const pos = selection.from;
    if (pos <= 1) return null;
    const $pos = state.doc.resolve(pos - 1);

    for (const markName of ['bold', 'italic']) {
        const markType = schema.marks[markName];
        if (!markType) continue;
        const mark =
            $pos.marks().find(m => m.type.name === markName) ||
            ($pos.nodeAfter?.marks || []).find(m => m.type.name === markName) ||
            ($pos.nodeBefore?.marks || []).find(m => m.type.name === markName);
        if (!mark) continue;
        const range = getMarkRange($pos, mark.type, mark.attrs);
        if (!range) continue;
        if (pos === range.to + 1) {
            return { markName, range, markType, syntax: getRevealSyntax(markName) };
        }
    }
    return null;
}

function createTyporaRevealInputRule(type, syntax, find, markName) {
    return new InputRule({
        find,
        handler: ({ state, range, match }) => {
            const innerText = match[1];
            const fullMatch = match[0] || '';
            if (!innerText) return;
            const innerOffset = fullMatch.indexOf(innerText);
            if (innerOffset < 0) return;

            const tr = state.tr;
            const textStart = range.from + innerOffset;
            const textEnd = textStart + innerText.length;

            if (textEnd < range.to) tr.delete(textEnd, range.to);
            if (textStart > range.from) tr.delete(range.from, textStart);

            const markFrom = range.from;
            const markTo = markFrom + innerText.length;
            const boldType = state.schema.marks.bold;
            const italicType = state.schema.marks.italic;
            if (markName === 'bold' && italicType) tr.removeMark(markFrom, markTo, italicType);
            if (markName === 'italic' && boldType) tr.removeMark(markFrom, markTo, boldType);
            tr.addMark(markFrom, markTo, type.create());
            tr.removeStoredMark(type);
            tr.setStoredMarks([]);

            tr.insertText(syntax, markTo);
            tr.insertText(syntax, markFrom);
            tr.removeMark(markFrom, markFrom + syntax.length, type);
            tr.removeMark(markTo + syntax.length, markTo + syntax.length * 2, type);

            const caret = markTo + syntax.length * 2;
            tr.setSelection(TextSelection.create(tr.doc, caret));
            tr.setMeta(inlineRevealSyncMetaKey, true);

            _activeInlineReveal = {
                markName,
                syntax,
                start: markFrom,
                end: markTo + syntax.length * 2,
                semantic: markName,
                leftLen: syntax.length,
                rightLen: syntax.length,
            };
            _inlineRevealJustExpanded = true;
            _syncingInlineReveal = true;
            return tr;
        },
    });
}

function expandInlineReveal(ed, candidate) {
    if (!candidate || !candidate.syntax) return;
    const { markName, range, markType, syntax } = candidate;
    const len = syntax.length;
    const oldPos = ed.state.selection.from;
    const doc = ed.state.doc;

    // If delimiters already exist around the range (e.g. state recovered after edits),
    // do not insert again to avoid duplicated asterisks.
    const hasLeft = range.from >= len && doc.textBetween(range.from - len, range.from, '\n', '\n') === syntax;
    const hasRight = doc.textBetween(range.to, range.to + len, '\n', '\n') === syntax;
    if (hasLeft && hasRight) {
        _activeInlineReveal = {
            markName,
            syntax,
            start: range.from - len,
            end: range.to + len,
        };
        return;
    }

    // Set active state before dispatch to avoid re-entrant onUpdate/onSelectionUpdate
    // reading a stale "not expanded" status.
    _activeInlineReveal = {
        markName,
        syntax,
        start: range.from,
        end: range.to + 2 * len,
        semantic: markName,
        leftLen: len,
        rightLen: len,
    };
    _inlineRevealJustExpanded = true;

    const tr = ed.state.tr;
    const boldType = ed.state.schema.marks.bold;
    const italicType = ed.state.schema.marks.italic;

    tr.insertText(syntax, range.to);
    tr.insertText(syntax, range.from);

    if (markName === 'bold' && italicType) tr.removeMark(range.from, range.to, italicType);
    if (markName === 'italic' && boldType) tr.removeMark(range.from, range.to, boldType);

    // Delimiters should remain plain text.
    tr.removeMark(range.from, range.from + len, markType);
    tr.removeMark(range.to + len, range.to + 2 * len, markType);

    const clampedPos = Math.max(range.from, Math.min(oldPos, range.to));
    let newPos = clampedPos + len;
    // At right edge, Typora keeps caret after the closing delimiter.
    if (oldPos === range.to) {
        newPos = range.to + 2 * len;
    } else if (oldPos > range.to) {
        // Keep stable relative caret position for right-outside fallback
        // (common when trailing plain text is deleted).
        newPos = tr.mapping.map(oldPos, 1);
    }
    tr.setSelection(TextSelection.create(tr.doc, newPos));
    tr.setMeta(inlineRevealSyncMetaKey, true);

    _syncingInlineReveal = true;
    ed.view.dispatch(tr);
    _syncingInlineReveal = false;
}

function collapseInlineReveal(ed) {
    if (!_activeInlineReveal) return;
    const { markName, syntax, start, end } = _activeInlineReveal;
    const len = syntax.length;
    const state = ed.state;
    const markerChar = syntax[0];
    let revealStart = start;
    let revealEnd = end;

    // Boundaries can drift by one char after marker edits; absorb nearby markers
    // so collapse always parses a complete inline fragment.
    let absorbLeft = 0;
    while (absorbLeft < len && revealStart > 1) {
        const ch = state.doc.textBetween(revealStart - 1, revealStart, '\n', '\n');
        if (ch !== markerChar) break;
        revealStart -= 1;
        absorbLeft += 1;
    }
    let absorbRight = 0;
    while (absorbRight < len && revealEnd < state.doc.content.size) {
        const ch = state.doc.textBetween(revealEnd, revealEnd + 1, '\n', '\n');
        if (ch !== markerChar) break;
        revealEnd += 1;
        absorbRight += 1;
    }

    const segment = state.doc.textBetween(revealStart, revealEnd, '\n', '\n');
    const oldPos = state.selection.from;

    let parsedType = null;
    let parsedInner = null;
    if (markName === 'bold') {
        const m = segment.match(/^\*\*([\s\S]+)\*\*$/) || segment.match(/^__([\s\S]+)__$/);
        if (m) {
            parsedType = 'bold';
            parsedInner = m[1];
        }
        if (!parsedType) {
            const mi = segment.match(/^\*([\s\S]+)\*$/) || segment.match(/^_([\s\S]+)_$/);
            if (mi) {
                parsedType = 'italic';
                parsedInner = mi[1];
            }
        }
        if (!parsedType) {
            if (segment.startsWith('**') && segment.endsWith('*') && segment.length >= 3) {
                parsedType = 'italic';
                parsedInner = segment.slice(2, -1);
            } else if (segment.startsWith('*') && segment.endsWith('**') && segment.length >= 3) {
                parsedType = 'italic';
                parsedInner = segment.slice(1, -2);
            } else if (segment.startsWith('__') && segment.endsWith('_') && segment.length >= 3) {
                parsedType = 'italic';
                parsedInner = segment.slice(2, -1);
            } else if (segment.startsWith('_') && segment.endsWith('__') && segment.length >= 3) {
                parsedType = 'italic';
                parsedInner = segment.slice(1, -2);
            }
        }
    } else if (markName === 'italic') {
        const m = segment.match(/^\*([\s\S]+)\*$/) || segment.match(/^_([\s\S]+)_$/);
        if (m) {
            parsedType = 'italic';
            parsedInner = m[1];
        }
        if (!parsedType) {
            const mb = segment.match(/^\*\*([\s\S]+)\*\*$/) || segment.match(/^__([\s\S]+)__$/);
            if (mb) {
                parsedType = 'bold';
                parsedInner = mb[1];
            }
        }
    }

    const tr = state.tr;
    tr.delete(revealStart, revealEnd);

    let insertedLen = 0;
    if (parsedType && parsedInner !== null) {
        const markType = state.schema.marks[parsedType];
        const boldType = state.schema.marks.bold;
        const italicType = state.schema.marks.italic;
        if (parsedInner.length > 0 && markType) {
            tr.insertText(parsedInner, revealStart);
            if (parsedType === 'bold' && italicType) tr.removeMark(revealStart, revealStart + parsedInner.length, italicType);
            if (parsedType === 'italic' && boldType) tr.removeMark(revealStart, revealStart + parsedInner.length, boldType);
            tr.addMark(revealStart, revealStart + parsedInner.length, markType.create());
            insertedLen = parsedInner.length;
        }
    } else {
        tr.insertText(segment, revealStart);
        insertedLen = segment.length;
    }

    let newPos = oldPos;
    if (oldPos > revealEnd) {
        newPos = oldPos - (revealEnd - revealStart) + insertedLen;
    } else if (oldPos >= revealStart) {
        if (parsedType && parsedInner !== null) {
            newPos = revealStart + Math.max(0, Math.min((oldPos - revealStart) - len, insertedLen));
        } else {
            newPos = revealStart + Math.max(0, Math.min(oldPos - revealStart, insertedLen));
        }
    }
    tr.setSelection(TextSelection.create(tr.doc, Math.max(1, Math.min(newPos, tr.doc.content.size))));
    tr.setMeta(inlineRevealSyncMetaKey, true);

    _syncingInlineReveal = true;
    ed.view.dispatch(tr);
    _syncingInlineReveal = false;
    _activeInlineReveal = null;
    _inlineRevealJustExpanded = false;
}

function reconcileActiveBoldRevealMarks(ed) {
    if (!_activeInlineReveal || _activeInlineReveal.markName !== 'bold') return false;
    const { start, end } = _activeInlineReveal;
    const state = ed.state;
    const segment = state.doc.textBetween(start, end, '\n', '\n');

    let target = null;
    let leftLen = 0;
    let rightLen = 0;
    if ((segment.startsWith('**') && segment.endsWith('**') && segment.length >= 4) ||
        (segment.startsWith('__') && segment.endsWith('__') && segment.length >= 4)) {
        target = 'bold';
        leftLen = 2; rightLen = 2;
    } else if ((segment.startsWith('*') && segment.endsWith('*') && segment.length >= 2) ||
        (segment.startsWith('_') && segment.endsWith('_') && segment.length >= 2)) {
        target = 'italic';
        leftLen = 1; rightLen = 1;
    } else if (segment.startsWith('**') && segment.endsWith('*') && segment.length >= 3) {
        target = 'italic';
        leftLen = 2; rightLen = 1;
    } else if (segment.startsWith('*') && segment.endsWith('**') && segment.length >= 3) {
        target = 'italic';
        leftLen = 1; rightLen = 2;
    } else if (segment.startsWith('__') && segment.endsWith('_') && segment.length >= 3) {
        target = 'italic';
        leftLen = 2; rightLen = 1;
    } else if (segment.startsWith('_') && segment.endsWith('__') && segment.length >= 3) {
        target = 'italic';
        leftLen = 1; rightLen = 2;
    } else {
        return false;
    }

    if (
        _activeInlineReveal.semantic === target &&
        _activeInlineReveal.leftLen === leftLen &&
        _activeInlineReveal.rightLen === rightLen
    ) {
        return false;
    }

    const innerFrom = start + leftLen;
    const innerTo = end - rightLen;
    if (innerFrom > innerTo) return false;

    const boldType = state.schema.marks.bold;
    const italicType = state.schema.marks.italic;
    const targetType = target === 'bold' ? boldType : italicType;
    if (!targetType) return false;

    const tr = state.tr;
    if (boldType) tr.removeMark(start, end, boldType);
    if (italicType) tr.removeMark(start, end, italicType);
    if (innerFrom < innerTo) {
        tr.addMark(innerFrom, innerTo, targetType.create());
    }
    tr.setMeta(inlineRevealSyncMetaKey, true);

    _activeInlineReveal.semantic = target;
    _activeInlineReveal.leftLen = leftLen;
    _activeInlineReveal.rightLen = rightLen;
    _syncingInlineReveal = true;
    ed.view.dispatch(tr);
    _syncingInlineReveal = false;
    return true;
}

function syncInlineReveal(ed, transaction = null) {
    if (!ed) return;
    if (_syncingInlineReveal) {
        if (transaction?.getMeta?.(inlineRevealSyncMetaKey)) {
            _syncingInlineReveal = false;
        }
        return;
    }
    if (isSourceMode) return;
    if (transaction?.getMeta?.(inlineRevealSyncMetaKey)) return;
    if (transaction?.docChanged) {
        _inlineRevealSuppressNextSelectionExpand = true;
    }
    if (_activeInlineReveal && transaction?.docChanged) {
        _activeInlineReveal.start = transaction.mapping.map(_activeInlineReveal.start, -1);
        _activeInlineReveal.end = transaction.mapping.map(_activeInlineReveal.end, -1);
        if (_activeInlineReveal.end < _activeInlineReveal.start) {
            _activeInlineReveal.end = _activeInlineReveal.start;
        }
        if (reconcileActiveBoldRevealMarks(ed)) return;
    }

    const { selection } = ed.state;
    if (!transaction && _inlineRevealLastKeyEvent) {
        const key = _inlineRevealLastKeyEvent.key;
        const recent = (Date.now() - _inlineRevealLastKeyEvent.at) < 220;
        const isTypingOrDelete = key.length === 1 || key === 'Backspace' || key === 'Delete';
        if (recent && isTypingOrDelete) return;
    }
    if (_activeInlineReveal) {
        if (_inlineRevealJustExpanded) {
            const pos = selection.empty ? selection.from : -1;
            const stillInside = selection.empty && pos >= _activeInlineReveal.start && pos <= _activeInlineReveal.end;
            _inlineRevealJustExpanded = false;
            if (stillInside) return;
        }
        if (!selection.empty) {
            collapseInlineReveal(ed);
            return;
        }

        const pos = selection.from;
        if (pos < _activeInlineReveal.start || pos > _activeInlineReveal.end) {
            collapseInlineReveal(ed);
            return;
        }
        return;
    }

    if (!selection.empty) return;
    if (!transaction && _inlineRevealSuppressNextSelectionExpand) {
        _inlineRevealSuppressNextSelectionExpand = false;
        return;
    }

    const recentDelete =
        _inlineRevealLastKeyEvent &&
        (Date.now() - _inlineRevealLastKeyEvent.at) < 220 &&
        (_inlineRevealLastKeyEvent.key === 'Backspace' || _inlineRevealLastKeyEvent.key === 'Delete');

    let candidate = findRevealCandidate(ed.state);
    if (!candidate && transaction?.docChanged && recentDelete) {
        candidate = findRevealCandidateRightOutside(ed.state);
    }
    if (candidate) {
        _inlineRevealSuppressNextSelectionExpand = false;
        expandInlineReveal(ed, candidate);
    }
}

function handleInlineRevealKeyDown(ed, event) {
    if (!_activeInlineReveal) return false;
    if (!ed || isSourceMode) return false;
    const { selection, doc } = ed.state;
    if (!selection.empty) return false;
    if (event.key !== 'Backspace' && event.key !== 'Delete') return false;

    const markerChar = _activeInlineReveal.syntax[0];
    const pos = selection.from;

    if (event.key === 'Backspace' && pos > 1) {
        const ch = doc.textBetween(pos - 1, pos, '\n', '\n');
        if (ch === markerChar) {
            const tr = ed.state.tr;
            tr.delete(pos - 1, pos);
            tr.setSelection(TextSelection.create(tr.doc, pos - 1));
            ed.view.dispatch(tr);
            event.preventDefault();
            return true;
        }
    }

    if (event.key === 'Delete') {
        const ch = doc.textBetween(pos, pos + 1, '\n', '\n');
        if (ch === markerChar) {
            const tr = ed.state.tr;
            tr.delete(pos, pos + 1);
            tr.setSelection(TextSelection.create(tr.doc, pos));
            ed.view.dispatch(tr);
            event.preventDefault();
            return true;
        }
    }

    return false;
}

const TyporaBold = Bold.extend({
    inclusive: false,
    addInputRules() {
        return [
            createTyporaRevealInputRule(this.type, '**', inlineBoldStarInputRegex, 'bold'),
            createTyporaRevealInputRule(this.type, '**', inlineBoldUnderscoreInputRegex, 'bold'),
        ];
    },
    addPasteRules() {
        return [
            markPasteRule({
                find: inlineBoldStarPasteRegex,
                type: this.type,
            }),
            markPasteRule({
                find: inlineBoldUnderscorePasteRegex,
                type: this.type,
            }),
        ];
    },
});

const TyporaItalic = Italic.extend({
    inclusive: false,
    addInputRules() {
        return [
            createTyporaRevealInputRule(this.type, '*', inlineItalicStarInputRegex, 'italic'),
            createTyporaRevealInputRule(this.type, '_', inlineItalicUnderscoreInputRegex, 'italic'),
        ];
    },
    addPasteRules() {
        return [
            markPasteRule({
                find: inlineItalicStarPasteRegex,
                type: this.type,
            }),
            markPasteRule({
                find: inlineItalicUnderscorePasteRegex,
                type: this.type,
            }),
        ];
    },
});

// ===== WYSIWYG Thick Cursor Overlay =====
let _wysiwygComposing = false;

function updateEditorCursor() {
    const cursorEl = document.getElementById('editor-cursor');
    if (cursorEl) cursorEl.classList.add('hidden');
}

// ===== Editor Instance =====
let editor = null;
let isSourceMode = false;
let suppressModified = false;

// 图片选中时显示 Markdown 语法（Typora 风格），自动选中文件名
function checkImageToolbar(editor) {
    const existing = document.getElementById('image-toolbar');
    if (existing) existing.remove();

    const { state } = editor;
    const { selection } = state;
    if (selection.node && selection.node.type.name === 'image') {
        const node = selection.node;
        const src = node.attrs.src || '';
        const alt = node.attrs.alt || '';
        const rawSrc = src.replace(/^file:\/\//, '');
        const displayAlt = alt || decodeURIComponent(rawSrc.split('/').pop() || '');
        const mdText = `![${displayAlt}](${rawSrc})`;

        // 获取图片 DOM 元素
        const pos = selection.from;
        const domNode = editor.view.nodeDOM(pos);
        if (!domNode) return;
        const imgEl = domNode.tagName === 'IMG' ? domNode : domNode.querySelector('img');
        if (!imgEl) return;

        // 在编辑器滚动容器中绝对定位
        const editorContainer = document.getElementById('editor');
        const containerRect = editorContainer.getBoundingClientRect();
        const imgRect = imgEl.getBoundingClientRect();

        const toolbar = document.createElement('div');
        toolbar.id = 'image-toolbar';
        toolbar.innerHTML = `<span class="image-md-icon">🖼</span><input type="text" value="${mdText}" class="image-md-input" />`;
        // 定位在图片正上方，相对于编辑器容器
        toolbar.style.cssText = `
            position: absolute;
            left: ${imgRect.left - containerRect.left}px;
            top: ${imgRect.top - containerRect.top + editorContainer.scrollTop - 28}px;
            z-index: 10;
        `;
        editorContainer.appendChild(toolbar);

        const input = toolbar.querySelector('input');
        input.style.width = Math.min(input.value.length * 7.2 + 20, 600) + 'px';
        input.focus();
        input.setSelectionRange(2, 2 + displayAlt.length);

        let finished = false;
        const finish = (save) => {
            if (finished) return;
            finished = true;
            if (save) {
                const match = input.value.match(/^\!\[([^\]]*)\]\(([^)]*)\)$/);
                if (match) {
                    const newAlt = match[1];
                    let newSrc = match[2];
                    if (newSrc.startsWith('/')) newSrc = 'file://' + newSrc;
                    editor.chain().focus().updateAttributes('image', { alt: newAlt, src: newSrc }).run();
                }
            }
            toolbar.remove();
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        // 失去焦点时自动保存
        input.addEventListener('blur', () => finish(true));
    }
}

function initEditor() {
    editor = new Editor({
        element: document.getElementById('editor'),
        extensions: [
            StarterKit.configure({
                codeBlock: false, // Use CodeBlockLowlight instead
                horizontalRule: false, // Use custom
                link: false, // Use separately configured Link
                bold: false, // Use custom bold input rules
                italic: false, // Use custom italic input rules
            }),
            TyporaBold,
            TyporaItalic,
            CodeBlockLowlight.configure({ lowlight }),
            HorizontalRule,

            TaskList,
            TaskItem.configure({ nested: true }),
            Table.configure({ resizable: true }),
            TableRow,
            // 共用 textAlign 属性扩展（避免 TableCell/TableHeader 重复定义）
            ...[TableCell, TableHeader].map(Ext => Ext.extend({
                addAttributes() {
                    return {
                        ...this.parent?.(),
                        textAlign: {
                            default: null,
                            parseHTML: el => el.style.textAlign || null,
                            renderHTML: attrs => attrs.textAlign ? { style: `text-align: ${attrs.textAlign}` } : {},
                        },
                    };
                },
            })),
            Link.configure({
                openOnClick: false,
                HTMLAttributes: { class: 'editor-link' },
            }),
            Image.configure({ inline: true }),
            Placeholder.configure({ placeholder: '开始写作…' }),
            Typography,
            Highlight,
            SearchHighlight,

        ],
        content: '<p></p>',
        autofocus: true,
        editorProps: {
            // 拦截 "- [] " 和 "- [ ] " 输入，在 BulletList input rule 之前转为 task list
            handleTextInput: (view, from, to, text) => {
                if (text !== ' ') return false;
                const { state } = view;
                const $from = state.selection.$from;
                const blockStart = $from.start();
                const textBefore = state.doc.textBetween(blockStart, from);
                // 在段落开头输入 "-[]" 或 "-[ ]" 后按空格（无中间空格的写法）
                if (/^-\[[\s]?\]$/.test(textBefore)) {
                    const tr = state.tr.delete(blockStart, from);
                    view.dispatch(tr);
                    editor.chain().focus().toggleTaskList().run();
                    return true;
                }
                // 在 bullet list item 内输入 "[]" 或 "[ ]" 后按空格
                if (/^\[[\s]?\]$/.test(textBefore)) {
                    // 使用正确的深度索引获取 listItem 父节点
                    for (let d = $from.depth; d > 0; d--) {
                        if ($from.node(d).type.name === 'listItem') {
                            const tr = state.tr.delete(blockStart, from);
                            view.dispatch(tr);
                            editor.chain().focus().toggleTaskList().run();
                            return true;
                        }
                    }
                }
                return false;
            },
            attributes: {
                class: 'mink-editor',
                spellcheck: 'false',
            },
            // 粘贴图片时保存到文件并用路径引用（类似 Typora）
            handlePaste: (view, event) => {
                const items = event.clipboardData?.items;
                if (!items) return false;
                for (const item of items) {
                    if (item.type.startsWith('image/')) {
                        event.preventDefault();
                        const file = item.getAsFile();
                        if (!file) return true;
                        const reader = new FileReader();
                        reader.onload = async (e) => {
                            const base64Data = e.target.result;
                            if (window.electronAPI && window.electronAPI.saveImage) {
                                const result = await window.electronAPI.saveImage(base64Data);
                                if (result && result.path) {
                                    editor.chain().focus().setImage({ src: 'file://' + result.path }).run();
                                }
                            } else {
                                // 无 API 时 fallback 为 base64
                                editor.chain().focus().setImage({ src: base64Data }).run();
                            }
                        };
                        reader.readAsDataURL(file);
                        return true;
                    }
                }
                return false;
            },
            handleDOMEvents: {
                compositionstart: (view) => {
                    _wysiwygComposing = true;
                    view.dom.classList.add('is-composing');
                    updateEditorCursor();
                    return false;
                },
                compositionend: (view) => {
                    _wysiwygComposing = false;
                    view.dom.classList.remove('is-composing');
                    setTimeout(() => updateEditorCursor(), 20);
                    return false;
                },
                focus: () => {
                    updateEditorCursor();
                    requestAnimationFrame(updateEditorCursor);
                    return false;
                },
                blur: () => {
                    if (_activeInlineReveal) collapseInlineReveal(editor);
                    updateEditorCursor();
                    return false;
                },
            },
            // 粘贴纯文本时检测 Markdown 语法并自动渲染
            clipboardTextParser: (text, $context, plain, view) => {
                // 检测文本是否包含 Markdown 语法
                const mdPatterns = [
                    /^#{1,6}\s+/m,           // 标题
                    /^\s*[-*+]\s+/m,          // 无序列表
                    /^\s*\d+\.\s+/m,          // 有序列表
                    /^\s*>\s+/m,              // 引用
                    /```[\s\S]*?```/,         // 代码块
                    /\*\*[^*]+\*\*/,          // 粗体
                    /\*[^*]+\*/,              // 斜体
                    /~~[^~]+~~/,              // 删除线
                    /\[.+?\]\(.+?\)/,         // 链接
                    /^---+$/m,               // 分隔线
                    /^\s*[-*]\s+\[[x ]\]/mi,  // 任务列表
                    /\|.+\|.+\|/,            // 表格
                ];
                const hasMarkdown = mdPatterns.some(p => p.test(text));
                if (!hasMarkdown) return; // 返回 undefined 走默认处理

                // 将 Markdown 转为 HTML，再解析为 ProseMirror Slice
                const html = markdownToHtml(text);
                const wrapper = document.createElement('div');
                wrapper.innerHTML = html;
                const parser = PmDOMParser.fromSchema(view.state.schema);
                return parser.parseSlice(wrapper, { preserveWhitespace: false });
            },
        },
        onUpdate: ({ editor: ed, transaction }) => {
            syncInlineReveal(ed, transaction);
            if (suppressModified) return;
            if (window.electronAPI) window.electronAPI.contentModified();
            updateStats(ed);
            updateOutline(ed);
        },
        onSelectionUpdate: () => {
            syncInlineReveal(editor);
            updateStats(editor);
            updateEditorCursor();
            checkTableToolbar();
            checkImageToolbar(editor);
        },
    });

    // Expose getMarkdown for main process save
    window.__getMarkdown = () => {
        if (isSourceMode) {
            return document.getElementById('source-editor').value;
        }
        return htmlToMarkdown(editor.getHTML());
    };

    updateStats(editor);
}

// ===== Stats =====
function updateStats(ed) {
    const text = ed.getText();
    const charCount = text.length;
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    const wordCount = chineseChars + englishWords;
    const lineCount = text.split('\n').length;

    document.getElementById('status-words').textContent = `${wordCount} 字`;
    document.getElementById('status-chars').textContent = `${charCount} 字符`;
    document.getElementById('status-lines').textContent = `${lineCount} 行`;
}

// ===== Outline =====
function updateOutline(ed) {
    const panel = document.getElementById('outline-panel');
    const json = ed.getJSON();
    const headings = [];

    function walkNodes(nodes) {
        if (!nodes) return;
        for (const node of nodes) {
            if (node.type === 'heading' && node.content) {
                const text = node.content.map(c => c.text || '').join('');
                headings.push({ level: node.attrs.level, text });
            }
            if (node.content) walkNodes(node.content);
        }
    }
    walkNodes(json.content);

    panel.innerHTML = headings.length === 0
        ? '<p class="outline-empty">无标题</p>'
        : headings.map(h => `<div class="outline-item outline-h${h.level}" data-text="${h.text}">${h.text}</div>`).join('');

    // Click to scroll to heading
    panel.querySelectorAll('.outline-item').forEach(item => {
        item.addEventListener('click', () => {
            const text = item.dataset.text;
            // Find the heading node and scroll to it
            const dom = document.querySelector('.mink-editor');
            const headingEls = dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
            for (const el of headingEls) {
                if (el.textContent === text) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    break;
                }
            }
        });
    });
}

// ===== Sidebar =====
function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const tabs = document.querySelectorAll('.sidebar-tab');
    const panels = document.querySelectorAll('.sidebar-panel');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab === 'files' ? 'file-tree' : 'outline-panel').classList.add('active');
        });
    });

    // Toggle sidebar
    document.getElementById('btn-sidebar').addEventListener('click', toggleSidebar);

    // New file button
    document.getElementById('btn-new-file').addEventListener('click', async () => {
        if (window.electronAPI) {
            const result = await window.electronAPI.createFileInFolder();
            if (result && result.error) alert(result.error);
        }
    });

    // Close context menu on click elsewhere
    document.addEventListener('click', () => {
        const existing = document.getElementById('ctx-menu');
        if (existing) existing.remove();
    });
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('hidden');
}

function showRenameDialog(item) {
    const overlay = document.createElement('div');
    overlay.className = 'table-insert-modal';
    // 去掉扩展名显示
    const nameWithoutExt = item.name.replace(/\.[^.]+$/, '');
    overlay.innerHTML = `
        <div class="table-insert-box">
            <h3>重命名文件</h3>
            <div style="margin-bottom: 16px;">
                <input id="rename-input" type="text" value="${nameWithoutExt}"
                    style="width: 100%; padding: 8px 12px; border: 1px solid var(--border);
                    border-radius: 6px; background: var(--bg-secondary); color: var(--text-primary);
                    font-size: 14px; outline: none; box-sizing: border-box;" />
            </div>
            <div class="table-insert-actions">
                <button id="rename-cancel">取消</button>
                <button id="rename-ok" class="primary">确定</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const input = document.getElementById('rename-input');
    input.focus();
    input.select();

    const doRename = async () => {
        const newName = input.value.trim();
        if (!newName || newName === nameWithoutExt) {
            overlay.remove();
            return;
        }
        const fileName = newName.endsWith('.md') ? newName : newName + '.md';
        overlay.remove();
        if (window.electronAPI) {
            const result = await window.electronAPI.renameFile(item.path, fileName);
            if (result.error) alert(result.error);
        }
    };

    document.getElementById('rename-ok').addEventListener('click', doRename);
    document.getElementById('rename-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doRename();
        if (e.key === 'Escape') overlay.remove();
    });
}

function showContextMenu(e, item) {
    e.preventDefault();
    e.stopPropagation();
    const existing = document.getElementById('ctx-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    menu.className = 'context-menu';
    menu.innerHTML = `
        <div class="ctx-item" data-action="rename">重命名</div>
        <div class="ctx-item" data-action="delete">删除</div>
    `;
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    document.body.appendChild(menu);

    menu.querySelector('[data-action="rename"]').addEventListener('click', () => {
        menu.remove();
        showRenameDialog(item);
    });

    menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        menu.remove();
        if (window.electronAPI) {
            await window.electronAPI.deleteFile(item.path);
        }
    });
}

function renderFileTree(tree, container, level = 0) {
    container.innerHTML = '';
    if (!tree || tree.length === 0) {
        container.innerHTML = '<p class="tree-empty">打开文件夹以查看文件</p>';
        return;
    }

    const ul = document.createElement('ul');
    ul.className = 'file-tree-list';

    for (const item of tree) {
        const li = document.createElement('li');
        li.style.paddingLeft = `${level * 16 + 8}px`;

        if (item.isDir) {
            li.className = 'tree-folder';
            li.innerHTML = `<span class="folder-icon">▶</span> ${item.name}`;
            const childContainer = document.createElement('div');
            childContainer.className = 'tree-children hidden';
            renderFileTree(item.children, childContainer, level + 1);
            li.appendChild(childContainer);

            li.addEventListener('click', (e) => {
                e.stopPropagation();
                childContainer.classList.toggle('hidden');
                li.querySelector('.folder-icon').textContent = childContainer.classList.contains('hidden') ? '▶' : '▼';
            });
        } else {
            li.className = 'tree-file';
            li.innerHTML = `📄 ${item.name}`;
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                window.electronAPI.openFileFromPath(item.path);
            });
            // Right-click context menu
            li.addEventListener('contextmenu', (e) => showContextMenu(e, item));
        }

        ul.appendChild(li);
    }

    container.appendChild(ul);
}

// ===== Source Mode =====
function toggleSourceMode() {
    if (!isSourceMode && _activeInlineReveal) {
        collapseInlineReveal(editor);
    }
    isSourceMode = !isSourceMode;
    const editorEl = document.getElementById('editor');
    const sourceContainer = document.getElementById('source-container');
    const sourceEl = document.getElementById('source-editor');
    const btn = document.getElementById('btn-source');

    if (isSourceMode) {
        // Hide editor cursor
        const editorCursorEl = document.getElementById('editor-cursor');
        if (editorCursorEl) editorCursorEl.classList.add('hidden');
        // Get text before cursor in WYSIWYG
        const cursorPos = editor.state.selection.from;
        const textBefore = editor.state.doc.textBetween(0, cursorPos, '\n', '\n');

        const md = htmlToMarkdown(editor.getHTML());
        sourceEl.value = md;
        editorEl.classList.add('hidden');
        sourceContainer.classList.remove('hidden');

        // Calculate cursor position in markdown
        let targetPos = 0;
        if (textBefore.length > 0) {
            const approxRatio = cursorPos / Math.max(1, editor.state.doc.content.size);
            const approxMdPos = Math.round(approxRatio * md.length);
            for (let len = Math.min(30, textBefore.length); len >= 3; len--) {
                const search = textBefore.slice(-len);
                let bestIdx = -1, bestDist = Infinity;
                let idx = md.indexOf(search);
                while (idx !== -1) {
                    const dist = Math.abs(idx + search.length - approxMdPos);
                    if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
                    idx = md.indexOf(search, idx + 1);
                }
                if (bestIdx !== -1) { targetPos = bestIdx + search.length; break; }
            }
        }
        sourceEl.selectionStart = sourceEl.selectionEnd = targetPos;
        sourceEl.classList.add('hide-caret');
        sourceEl.focus();
        btn.classList.add('active');
        updateLineNumbers();
        requestAnimationFrame(updateSourceLineHighlight);
    } else {
        const caretPos = sourceEl.selectionStart;
        const md = sourceEl.value;
        const mdBefore = md.substring(0, caretPos);
        const plainBefore = mdBefore
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/\*\*|__|~~|`/g, '')
            .replace(/^>\s*/gm, '')
            .replace(/^[-*+]\s+/gm, '')
            .replace(/^\d+\.\s+/gm, '')
            .replace(/^---+$/gm, '')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

        const html = markdownToHtml(md);
        suppressModified = true;
        editor.commands.setContent(html);
        suppressModified = false;
        sourceContainer.classList.add('hidden');
        editorEl.classList.remove('hidden');

        // Search for text near cursor in editor
        const fullText = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n');
        let pos = 1;
        if (plainBefore.length > 0) {
            const approxRatio = md.length > 0 ? caretPos / md.length : 0;
            for (let len = Math.min(30, plainBefore.length); len >= 3; len--) {
                const search = plainBefore.slice(-len);
                let bestIdx = -1;
                let bestDist = Infinity;
                let idx = fullText.indexOf(search);
                while (idx !== -1) {
                    const endPos = idx + search.length;
                    const approxTextPos = Math.round(approxRatio * fullText.length);
                    const dist = Math.abs(endPos - approxTextPos);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIdx = idx;
                    }
                    idx = fullText.indexOf(search, idx + 1);
                }
                if (bestIdx !== -1) {
                    const targetTextEnd = bestIdx + search.length;
                    let textCount = 0;
                    let pmPos = 1;
                    editor.state.doc.descendants((node, nodePos) => {
                        if (textCount >= targetTextEnd) return false;
                        if (node.isText) {
                            const start = textCount;
                            const end = textCount + node.text.length;
                            if (targetTextEnd >= start && targetTextEnd <= end) {
                                pmPos = nodePos + (targetTextEnd - start);
                                textCount = targetTextEnd;
                                return false;
                            }
                            textCount += node.text.length;
                        } else if (node.isBlock && node.type.name !== 'doc') {
                            textCount++;
                        }
                        return true;
                    });
                    pos = pmPos;
                    break;
                }
            }
        }
        try {
            editor.commands.focus();
            editor.commands.setTextSelection(Math.min(pos, editor.state.doc.content.size));
        } catch {
            editor.commands.focus('start');
        }
        btn.classList.remove('active');
        document.getElementById('source-line-highlight').classList.add('hidden');
        document.getElementById('source-cursor').classList.add('hidden');
    }
}

// ===== Line Numbers =====
function updateLineNumbers() {
    const sourceEl = document.getElementById('source-editor');
    const gutterEl = document.getElementById('source-line-numbers');
    if (!gutterEl || !sourceEl) return;
    const lines = sourceEl.value.split('\n');
    const nums = lines.map((_, i) => `<div>${i + 1}</div>`).join('');
    gutterEl.innerHTML = nums;
}

// ===== Mirror div technique for textarea caret coordinates =====
let _mirrorDiv = null;
const _mirrorProps = [
    'direction', 'boxSizing', 'width', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
    'fontSizeAdjust', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform',
    'textIndent', 'textDecoration', 'letterSpacing', 'wordSpacing',
    'tabSize', 'MozTabSize', 'whiteSpace', 'wordWrap', 'wordBreak',
];

function getCaretCoordinates(textarea, pos) {
    if (!_mirrorDiv) {
        _mirrorDiv = document.createElement('div');
        _mirrorDiv.id = 'source-mirror';
        _mirrorDiv.style.position = 'absolute';
        _mirrorDiv.style.visibility = 'hidden';
        _mirrorDiv.style.overflow = 'hidden';
        _mirrorDiv.style.pointerEvents = 'none';
        _mirrorDiv.style.top = '0';
        _mirrorDiv.style.left = '-9999px';
        document.body.appendChild(_mirrorDiv);
    }
    const style = getComputedStyle(textarea);
    _mirrorProps.forEach(p => { _mirrorDiv.style[p] = style[p]; });
    _mirrorDiv.style.whiteSpace = 'pre-wrap';
    _mirrorDiv.style.wordWrap = 'break-word';

    // Strip padding from mirror div — we add it back to coordinates
    // This avoids box-model confusion between textarea and mirror div
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    _mirrorDiv.style.padding = '0';
    _mirrorDiv.style.boxSizing = 'content-box';
    _mirrorDiv.style.width = (textarea.clientWidth - paddingLeft - paddingRight) + 'px';
    _mirrorDiv.style.height = 'auto';

    const text = textarea.value.substring(0, pos !== undefined ? pos : textarea.selectionStart);
    _mirrorDiv.textContent = text;

    const span = document.createElement('span');
    span.textContent = '\u200b';
    _mirrorDiv.appendChild(span);

    const rawTop = span.offsetTop;
    const rawLeft = span.offsetLeft;

    // Measure baseline offset: the browser vertically centers inline content
    // within line-height, so span.offsetTop is non-zero even at position 0.
    // Subtract this baseline so coordinates align with the textarea's text start.
    _mirrorDiv.textContent = '';
    const baseSpan = document.createElement('span');
    baseSpan.textContent = '\u200b';
    _mirrorDiv.appendChild(baseSpan);
    const baselineOffset = baseSpan.offsetTop;

    return {
        top: rawTop - baselineOffset + paddingTop,
        left: rawLeft + paddingLeft,
        height: parseInt(style.lineHeight),
    };
}

// ===== Source Editor Events =====
let _isComposing = false;
const _sourceEl = document.getElementById('source-editor');

_sourceEl.addEventListener('compositionstart', () => {
    _isComposing = true;
    _sourceEl.classList.remove('hide-caret');
    const cursorEl = document.getElementById('source-cursor');
    if (cursorEl) cursorEl.classList.add('hidden');
});
_sourceEl.addEventListener('compositionend', () => {
    _isComposing = false;
    _sourceEl.classList.add('hide-caret');
    requestAnimationFrame(updateSourceLineHighlight);
});
_sourceEl.addEventListener('input', () => {
    if (window.electronAPI) window.electronAPI.contentModified();
    updateLineNumbers();
    if (!_isComposing) requestAnimationFrame(updateSourceLineHighlight);
});
_sourceEl.addEventListener('click', () => requestAnimationFrame(updateSourceLineHighlight));
_sourceEl.addEventListener('keyup', () => {
    if (!_isComposing) requestAnimationFrame(updateSourceLineHighlight);
});
_sourceEl.addEventListener('keydown', () => {
    if (!_isComposing) requestAnimationFrame(updateSourceLineHighlight);
});
_sourceEl.addEventListener('scroll', () => {
    // Sync line numbers scroll with textarea
    const gutterEl = document.getElementById('source-line-numbers');
    if (gutterEl) gutterEl.scrollTop = _sourceEl.scrollTop;
    requestAnimationFrame(updateSourceLineHighlight);
});
_sourceEl.addEventListener('focus', () => requestAnimationFrame(updateSourceLineHighlight));
_sourceEl.addEventListener('blur', () => {
    const cursorEl = document.getElementById('source-cursor');
    if (cursorEl) cursorEl.classList.add('hidden');
});

function updateSourceLineHighlight() {
    const sourceEl = document.getElementById('source-editor');
    const wrapEl = document.getElementById('source-editor-wrap');
    const highlightEl = document.getElementById('source-line-highlight');
    const cursorEl = document.getElementById('source-cursor');
    if (!isSourceMode || !sourceEl || !highlightEl || _isComposing) {
        return;
    }

    highlightEl.classList.remove('hidden');
    cursorEl.classList.remove('hidden');

    const style = getComputedStyle(sourceEl);
    const lineHeight = parseFloat(style.lineHeight);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const caretPos = sourceEl.selectionStart;
    const text = sourceEl.value;

    // Find paragraph boundaries (previous and next \n)
    let paraStart = text.lastIndexOf('\n', caretPos - 1) + 1;
    let paraEnd = text.indexOf('\n', caretPos);
    if (paraEnd === -1) paraEnd = text.length;

    // Get pixel coordinates for paragraph start and caret
    // getCaretCoordinates returns positions relative to mirror div (includes padding)
    const paraStartCoords = getCaretCoordinates(sourceEl, paraStart);
    const paraEndCoords = getCaretCoordinates(sourceEl, paraEnd);
    const caretCoords = getCaretCoordinates(sourceEl, caretPos);

    // The textarea and highlight/cursor share the same parent (source-editor-wrap)
    // Mirror div coords include padding, so subtract scrollTop to get wrap-relative position
    const paraTopPx = paraStartCoords.top - sourceEl.scrollTop;
    const paraBottomPx = paraEndCoords.top + lineHeight - sourceEl.scrollTop;
    const paraHeight = paraBottomPx - paraTopPx;

    // Clip to visible area
    const visibleHeight = sourceEl.clientHeight;
    if (paraTopPx + paraHeight < 0 || paraTopPx > visibleHeight) {
        highlightEl.style.opacity = '0';
    } else {
        highlightEl.style.opacity = '1';
    }

    highlightEl.style.top = `${paraTopPx}px`;
    highlightEl.style.height = `${paraHeight}px`;

    // Thick cursor position — center vertically within line
    const cursorTopPx = caretCoords.top - sourceEl.scrollTop;
    if (cursorTopPx < 0 || cursorTopPx > visibleHeight) {
        cursorEl.style.opacity = '0';
    } else {
        cursorEl.style.opacity = '1';
    }
    const fontSize = parseFloat(style.fontSize) || 16;
    const cursorHeight = fontSize * 1.2;
    const verticalOffset = (lineHeight - cursorHeight) / 2;
    cursorEl.style.top = `${cursorTopPx + verticalOffset}px`;
    cursorEl.style.left = `${caretCoords.left}px`;
    cursorEl.style.height = `${cursorHeight}px`;
}

// ===== Theme =====
let currentTheme = localStorage.getItem('mink-theme') || 'auto';

function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
    currentTheme = theme;
    const effectiveTheme = theme === 'auto' ? getSystemTheme() : theme;
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    const icons = { light: '🌙', dark: '☀️', auto: '💻' };
    document.getElementById('btn-theme').textContent = icons[theme] || '💻';
    localStorage.setItem('mink-theme', theme);
}

// Listen for system theme changes when in auto mode
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentTheme === 'auto') applyTheme('auto');
});

document.getElementById('btn-theme').addEventListener('click', () => {
    const order = ['light', 'dark', 'auto'];
    const next = order[(order.indexOf(currentTheme) + 1) % order.length];
    applyTheme(next);
});

document.getElementById('btn-source').addEventListener('click', toggleSourceMode);

// ===== 表格插入弹窗 =====
function showTableInsertModal() {
    const overlay = document.createElement('div');
    overlay.className = 'table-insert-modal';
    overlay.innerHTML = `
        <div class="table-insert-box">
            <h3>插入表格</h3>
            <div class="table-insert-row">
                <input id="table-rows" type="number" value="3" min="1" max="20" />
                <span>行</span>
                <span style="margin: 0 4px">×</span>
                <input id="table-cols" type="number" value="3" min="1" max="10" />
                <span>列</span>
            </div>
            <div class="table-insert-actions">
                <button id="table-insert-cancel">取消</button>
                <button id="table-insert-ok" class="primary">插入</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const rowsInput = document.getElementById('table-rows');
    const colsInput = document.getElementById('table-cols');

    // 自动聚焦
    rowsInput.focus();
    rowsInput.select();

    const doInsert = () => {
        const rows = Math.max(1, Math.min(20, parseInt(rowsInput.value) || 3));
        const cols = Math.max(1, Math.min(10, parseInt(colsInput.value) || 3));
        overlay.remove();
        editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
    };

    document.getElementById('table-insert-ok').addEventListener('click', doInsert);
    document.getElementById('table-insert-cancel').addEventListener('click', () => {
        overlay.remove();
        editor.commands.focus();
    });
    // 点击遮罩关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            overlay.remove();
            editor.commands.focus();
        }
    });
    // 回车确认
    overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doInsert(); }
        if (e.key === 'Escape') { overlay.remove(); editor.commands.focus(); }
    });
}

// ===== 表格浮动工具栏 =====
let _tableToolbar = null;

function createTableToolbar() {
    if (_tableToolbar) return _tableToolbar;
    const bar = document.createElement('div');
    bar.className = 'table-toolbar';
    bar.style.display = 'none';
    bar.innerHTML = `
        <button data-action="alignLeft" title="左对齐">☰</button>
        <button data-action="alignCenter" title="居中">☷</button>
        <button data-action="alignRight" title="右对齐">☲</button>
        <div class="toolbar-sep"></div>
        <button data-action="addRowBefore" title="上方插入行">⬆</button>
        <button data-action="addRowAfter" title="下方插入行">⬇</button>
        <button data-action="addColBefore" title="左侧插入列">⬅</button>
        <button data-action="addColAfter" title="右侧插入列">➡</button>
        <div class="toolbar-sep"></div>
        <button data-action="deleteRow" title="删除行">✕行</button>
        <button data-action="deleteCol" title="删除列">✕列</button>
        <div class="toolbar-sep"></div>
        <button data-action="deleteTable" class="danger" title="删除表格">🗑</button>
    `;
    // 事件代理
    bar.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 防止编辑器失焦
        const btn = e.target.closest('button');
        if (!btn || !editor) return;
        const action = btn.dataset.action;
        switch (action) {
            case 'alignLeft':
                editor.chain().focus().setCellAttribute('textAlign', 'left').run();
                break;
            case 'alignCenter':
                editor.chain().focus().setCellAttribute('textAlign', 'center').run();
                break;
            case 'alignRight':
                editor.chain().focus().setCellAttribute('textAlign', 'right').run();
                break;
            case 'addRowBefore':
                editor.chain().focus().addRowBefore().run();
                break;
            case 'addRowAfter':
                editor.chain().focus().addRowAfter().run();
                break;
            case 'addColBefore':
                editor.chain().focus().addColumnBefore().run();
                break;
            case 'addColAfter':
                editor.chain().focus().addColumnAfter().run();
                break;
            case 'deleteRow':
                editor.chain().focus().deleteRow().run();
                break;
            case 'deleteCol':
                editor.chain().focus().deleteColumn().run();
                break;
            case 'deleteTable':
                editor.chain().focus().deleteTable().run();
                hideTableToolbar();
                break;
        }
        // 更新对齐按钮高亮
        updateToolbarAlignState();
    });
    document.getElementById('editor-wrap').appendChild(bar);
    _tableToolbar = bar;
    return bar;
}

function updateToolbarAlignState() {
    if (!_tableToolbar || !editor) return;
    const attrs = editor.getAttributes('tableCell');
    const align = attrs.textAlign || 'left';
    _tableToolbar.querySelectorAll('button').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.action === 'alignLeft' && align === 'left') btn.classList.add('active');
        if (btn.dataset.action === 'alignCenter' && align === 'center') btn.classList.add('active');
        if (btn.dataset.action === 'alignRight' && align === 'right') btn.classList.add('active');
    });
}

function showTableToolbar() {
    const bar = createTableToolbar();
    // 找到当前表格 DOM 元素
    const { $from } = editor.state.selection;
    let tableNode = null;
    for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === 'table') {
            tableNode = editor.view.nodeDOM($from.before(d));
            break;
        }
    }
    if (!tableNode) { hideTableToolbar(); return; }

    const editorWrap = document.getElementById('editor-wrap');
    const wrapRect = editorWrap.getBoundingClientRect();
    const tableRect = tableNode.getBoundingClientRect();

    bar.style.display = 'flex';
    bar.style.top = `${tableRect.top - wrapRect.top - 36 + editorWrap.scrollTop}px`;
    bar.style.left = `${tableRect.left - wrapRect.left}px`;
    updateToolbarAlignState();
}

function hideTableToolbar() {
    if (_tableToolbar) _tableToolbar.style.display = 'none';
}

// 在光标变化时检查是否在表格内
function checkTableToolbar() {
    if (!editor || isSourceMode) { hideTableToolbar(); return; }
    const { $from } = editor.state.selection;
    let inTable = false;
    for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === 'table') { inTable = true; break; }
    }
    if (inTable) showTableToolbar();
    else hideTableToolbar();
}

// 文件拖拽处理已移至 preload.js（capture 阶段），确保在 ProseMirror 之前拦截



// ===== IPC Handlers =====
const api = window.electronAPI;
if (api) {
    api.onFileNew(() => {
        if (isSourceMode) toggleSourceMode();
        suppressModified = true;
        editor.commands.setContent('<p></p>');
        suppressModified = false;
        editor.commands.focus();
    });

    api.onFileOpened((data) => {
        const html = markdownToHtml(data.content);
        if (isSourceMode) {
            document.getElementById('source-editor').value = data.content;
        } else {
            suppressModified = true;
            editor.commands.setContent(html);
            suppressModified = false;
            editor.commands.focus('start');
        }
        updateStats(editor);
        updateOutline(editor);
    });

    // 文件拖拽：在编辑器光标处插入 [文件名](文件路径) 链接
    api.onFileDropped((data) => {
        if (isSourceMode) {
            // 源码模式：直接插入 Markdown 链接文本 + 空格
            const sourceEl = document.getElementById('source-editor');
            const pos = sourceEl.selectionStart;
            const text = sourceEl.value;
            const link = `[${data.name}](${data.path}) `;
            sourceEl.value = text.substring(0, pos) + link + text.substring(pos);
            sourceEl.selectionStart = sourceEl.selectionEnd = pos + link.length;
            sourceEl.focus();
            if (window.electronAPI) window.electronAPI.contentModified();
            updateLineNumbers();
        } else if (editor) {
            // WYSIWYG 模式：插入带链接的文本节点 + 空格
            editor.chain().focus().insertContent([
                {
                    type: 'text',
                    text: data.name,
                    marks: [{ type: 'link', attrs: { href: data.path } }],
                },
                { type: 'text', text: ' ' },
            ]).run();
        }
    });

    api.onFileSaved(() => {
        // Could show a subtle save indicator
    });

    api.onFolderOpened((data) => {
        const sidebar = document.getElementById('sidebar');
        if (sidebar.classList.contains('hidden')) {
            sidebar.classList.remove('hidden');
        }
        // Switch to files tab and show folder name
        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
        const filesTab = document.querySelector('[data-tab="files"]');
        filesTab.classList.add('active');
        if (data.path) {
            const folderName = data.path.split('/').pop() || data.path;
            filesTab.textContent = '📁 ' + folderName;
        }
        document.getElementById('file-tree').classList.add('active');

        renderFileTree(data.tree, document.getElementById('file-tree'));
    });

    // 保存当前文件路径供标题栏重命名使用
    let _currentFilePath = null;

    api.onTitleChanged((data) => {
        _currentFilePath = data.path || null;
        const titleEl = document.getElementById('titlebar-text');
        const editIcon = _currentFilePath ? ' <span class="titlebar-edit-icon">✎</span>' : '';
        titleEl.innerHTML = `${data.name}${data.isModified ? ' •' : ''}${editIcon}`;
    });

    // 点击标题栏触发重命名
    document.getElementById('titlebar-text').addEventListener('click', () => {
        if (!_currentFilePath) return;
        const name = _currentFilePath.split('/').pop();
        showRenameDialog({ name, path: _currentFilePath });
    });

    // ===== Menu Commands =====
    api.onMenuCommand((data) => {
        const { command } = data;

        switch (command) {
            case 'heading':
                editor.chain().focus().toggleHeading({ level: data.level }).run();
                break;
            case 'heading-increase': {
                const currentLevel = editor.getAttributes('heading').level || 0;
                if (currentLevel === 0) editor.chain().focus().toggleHeading({ level: 1 }).run();
                else if (currentLevel > 1) editor.chain().focus().toggleHeading({ level: currentLevel - 1 }).run();
                break;
            }
            case 'heading-decrease': {
                const level = editor.getAttributes('heading').level || 0;
                if (level > 0 && level < 6) editor.chain().focus().toggleHeading({ level: level + 1 }).run();
                else if (level === 6) editor.chain().focus().toggleHeading({ level: 6 }).run(); // Remove heading
                break;
            }
            case 'bold': editor.chain().focus().toggleBold().run(); break;
            case 'italic': editor.chain().focus().toggleItalic().run(); break;
            case 'strike': editor.chain().focus().toggleStrike().run(); break;
            case 'code': editor.chain().focus().toggleCode().run(); break;
            case 'bulletList': editor.chain().focus().toggleBulletList().run(); break;
            case 'orderedList': editor.chain().focus().toggleOrderedList().run(); break;
            case 'taskList': editor.chain().focus().toggleTaskList().run(); break;
            case 'blockquote': editor.chain().focus().toggleBlockquote().run(); break;
            case 'codeBlock': editor.chain().focus().toggleCodeBlock().run(); break;
            case 'horizontalRule': editor.chain().focus().setHorizontalRule().run(); break;
            case 'table':
                showTableInsertModal();
                break;
            case 'link': {
                const url = prompt('输入链接地址:');
                if (url) editor.chain().focus().setLink({ href: url }).run();
                break;
            }
            case 'toggle-sidebar': toggleSidebar(); break;
            case 'toggle-outline':
                if (document.getElementById('sidebar').classList.contains('hidden')) {
                    document.getElementById('sidebar').classList.remove('hidden');
                }
                document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.sidebar-panel').forEach(p => p.classList.remove('active'));
                document.querySelector('[data-tab="outline"]').classList.add('active');
                document.getElementById('outline-panel').classList.add('active');
                break;
            case 'toggle-source': toggleSourceMode(); break;
            case 'toggle-theme': { const o = ['light', 'dark', 'auto']; applyTheme(o[(o.indexOf(currentTheme) + 1) % o.length]); } break;
            case 'find': openSearchBar(); break;
            case 'ai-chat': toggleChat(); break;
            case 'ai-settings': createAISettingsModal(); break;
        }
    });

} // end if (api)

// ===== Language Change Handler =====
let _currentUILang = 'zh'; // Track current UI language for AI features
if (api && api.onLanguageChanged) {
    api.onLanguageChanged((lang) => {
        _currentUILang = lang;
        // Update sidebar tab labels
        const filesTab = document.querySelector('[data-tab="files"]');
        const outlineTab = document.querySelector('[data-tab="outline"]');
        if (filesTab) filesTab.textContent = lang === 'zh' ? '文件' : 'Files';
        if (outlineTab) outlineTab.textContent = lang === 'zh' ? '大纲' : 'Outline';
        // Update status bar labels
        const wordsEl = document.getElementById('status-words');
        const charsEl = document.getElementById('status-chars');
        const linesEl = document.getElementById('status-lines');
        if (editor) updateStats(editor);
    });
}

// ===== Search & Replace =====
let searchMarks = [];   // Array of { from, to } in PM positions
let searchIndex = -1;
let currentSearchQuery = '';

// Helper: find all matches in PM doc, returns array of { from, to }
function findAllMatches(doc, query) {
    if (!query) return [];
    const results = [];
    const lowerQuery = query.toLowerCase();
    doc.descendants((node, pos) => {
        if (!node.isText) return;
        const text = node.text.toLowerCase();
        let idx = text.indexOf(lowerQuery);
        while (idx !== -1) {
            results.push({ from: pos + idx, to: pos + idx + query.length });
            idx = text.indexOf(lowerQuery, idx + 1);
        }
    });
    results.sort((a, b) => a.from - b.from);
    return results;
}

// Update search decorations in the editor
function updateSearchDecorations() {
    if (!editor) return;
    editor.view.dispatch(editor.view.state.tr.setMeta(searchPluginKey, {
        matches: searchMarks,
        activeIndex: searchIndex,
    }));
}

function openSearchBar() {
    const bar = document.getElementById('search-bar');
    bar.classList.remove('hidden');
    const input = document.getElementById('search-input');
    // If text is selected, use it as search term
    if (editor && !isSourceMode) {
        const { from, to } = editor.state.selection;
        if (from !== to) {
            const selected = editor.state.doc.textBetween(from, to);
            if (selected) input.value = selected;
        }
    }
    input.focus();
    input.select();
    doSearch();
}

function closeSearchBar() {
    document.getElementById('search-bar').classList.add('hidden');
    clearSearchHighlights();
    document.getElementById('search-input').value = '';
    document.getElementById('replace-input').value = '';
    document.getElementById('search-count').textContent = '';
    if (editor && !isSourceMode) editor.commands.focus();
}

function clearSearchHighlights() {
    searchMarks = [];
    searchIndex = -1;
    currentSearchQuery = '';
    updateSearchDecorations();
}


function doSearch() {
    const query = document.getElementById('search-input').value;
    const countEl = document.getElementById('search-count');
    currentSearchQuery = query;

    if (!query) {
        searchMarks = [];
        searchIndex = -1;
        updateSearchDecorations();
        countEl.textContent = '';
        return;
    }

    if (isSourceMode) {
        // Search in source textarea — no PM decorations needed
        searchMarks = [];
        searchIndex = -1;
        updateSearchDecorations();

        const sourceEl = document.getElementById('source-editor');
        const text = sourceEl.value;
        const lowerText = text.toLowerCase();
        const lowerQuery = query.toLowerCase();
        const positions = [];
        let pos = lowerText.indexOf(lowerQuery);
        while (pos !== -1) {
            positions.push(pos);
            pos = lowerText.indexOf(lowerQuery, pos + 1);
        }
        // Store as simple text positions for source mode
        searchMarks = positions.map(p => ({ from: p, to: p + query.length }));
        countEl.textContent = positions.length > 0 ? `1/${positions.length}` : '0';
        if (positions.length > 0) {
            searchIndex = 0;
            sourceEl.selectionStart = positions[0];
            sourceEl.selectionEnd = positions[0] + query.length;
            sourceEl.focus();
        }
    } else if (editor) {
        // Search in WYSIWYG editor using PM positions directly
        searchMarks = findAllMatches(editor.state.doc, query);
        countEl.textContent = searchMarks.length > 0 ? `1/${searchMarks.length}` : '0';
        if (searchMarks.length > 0) {
            searchIndex = 0;
            updateSearchDecorations();
            navigateSearchResult(0);
        } else {
            searchIndex = -1;
            updateSearchDecorations();
        }
    }
}

function navigateSearchResult(index) {
    if (searchMarks.length === 0) return;
    searchIndex = ((index % searchMarks.length) + searchMarks.length) % searchMarks.length;
    const countEl = document.getElementById('search-count');
    countEl.textContent = `${searchIndex + 1}/${searchMarks.length}`;

    if (isSourceMode) {
        const sourceEl = document.getElementById('source-editor');
        const m = searchMarks[searchIndex];
        sourceEl.selectionStart = m.from;
        sourceEl.selectionEnd = m.to;
        sourceEl.focus();
        // Scroll into view
        const lineHeight = parseInt(getComputedStyle(sourceEl).lineHeight) || 28;
        const textBefore = sourceEl.value.substring(0, m.from);
        const lineNum = textBefore.split('\n').length;
        sourceEl.scrollTop = Math.max(0, (lineNum - 3) * lineHeight);
    } else if (editor) {
        const m = searchMarks[searchIndex];
        updateSearchDecorations();
        editor.commands.setTextSelection({ from: m.from, to: m.to });
        // Scroll to selection
        const domAtPos = editor.view.domAtPos(m.from);
        if (domAtPos && domAtPos.node) {
            const el = domAtPos.node.nodeType === 3 ? domAtPos.node.parentElement : domAtPos.node;
            if (el && el.scrollIntoView) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }
}

function doReplace() {
    const query = document.getElementById('search-input').value;
    const replacement = document.getElementById('replace-input').value;
    if (!query || searchMarks.length === 0 || searchIndex < 0) return;

    if (isSourceMode) {
        const sourceEl = document.getElementById('source-editor');
        const m = searchMarks[searchIndex];
        const text = sourceEl.value;
        sourceEl.value = text.substring(0, m.from) + replacement + text.substring(m.to);
        if (window.electronAPI) window.electronAPI.contentModified();
        doSearch();
    } else if (editor) {
        const m = searchMarks[searchIndex];
        // Select and replace the current match
        editor.chain()
            .focus()
            .setTextSelection({ from: m.from, to: m.to })
            .deleteSelection()
            .insertContent(replacement)
            .run();
        if (window.electronAPI) window.electronAPI.contentModified();
        // Re-search to update positions
        doSearch();
    }
}

function doReplaceAll() {
    const query = document.getElementById('search-input').value;
    const replacement = document.getElementById('replace-input').value;
    if (!query || searchMarks.length === 0) return;

    if (isSourceMode) {
        const sourceEl = document.getElementById('source-editor');
        const lowerQuery = query.toLowerCase();
        let text = sourceEl.value;
        let result = '';
        let lastEnd = 0;
        const lowerText = text.toLowerCase();
        let pos = lowerText.indexOf(lowerQuery);
        while (pos !== -1) {
            result += text.substring(lastEnd, pos) + replacement;
            lastEnd = pos + query.length;
            pos = lowerText.indexOf(lowerQuery, lastEnd);
        }
        result += text.substring(lastEnd);
        sourceEl.value = result;
        if (window.electronAPI) window.electronAPI.contentModified();
    } else if (editor) {
        // Replace all in PM: iterate matches from end to start to preserve positions
        const reversed = [...searchMarks].reverse();
        const chain = editor.chain().focus();
        for (const m of reversed) {
            chain.setTextSelection({ from: m.from, to: m.to }).deleteSelection().insertContent(replacement);
        }
        chain.run();
        if (window.electronAPI) window.electronAPI.contentModified();
    }
    doSearch();
}

// Search bar event listeners
document.getElementById('search-input').addEventListener('input', doSearch);
document.getElementById('btn-search-next').addEventListener('click', () => navigateSearchResult(searchIndex + 1));
document.getElementById('btn-search-prev').addEventListener('click', () => navigateSearchResult(searchIndex - 1));
document.getElementById('btn-replace').addEventListener('click', doReplace);
document.getElementById('btn-replace-all').addEventListener('click', doReplaceAll);
document.getElementById('btn-search-close').addEventListener('click', closeSearchBar);

// Cmd+F / Escape keyboard shortcuts
document.addEventListener('keydown', (e) => {
    _inlineRevealLastKeyEvent = { key: e.key, at: Date.now() };
    if (editor && !isSourceMode && handleInlineRevealKeyDown(editor, e)) {
        return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        openSearchBar();
    }
    if (e.key === 'Escape') {
        const bar = document.getElementById('search-bar');
        if (!bar.classList.contains('hidden')) {
            closeSearchBar();
        }
    }
    // Enter to go to next result in search
    if (e.key === 'Enter' && document.activeElement === document.getElementById('search-input')) {
        e.preventDefault();
        navigateSearchResult(searchIndex + (e.shiftKey ? -1 : 1));
    }
});

// ===== Init =====
applyTheme(currentTheme);
initEditor();
initSidebar();

// Update WYSIWYG cursor on scroll
document.getElementById('editor-wrap').addEventListener('scroll', () => {
    requestAnimationFrame(updateEditorCursor);
});

// =====================================================
// ===== AI Features =====
// =====================================================

// ===== AI i18n =====
const aiI18n = {
    en: {
        ai_settings: 'AI Settings', provider: 'Provider', api_key: 'API Key', model: 'Model',
        base_url: 'Base URL (optional)', test_conn: 'Test Connection', save: 'Save', cancel: 'Cancel',
        testing: 'Testing...', connected: '✓ Connected!', conn_failed: '✗ Failed: ',
        ai_chat: 'AI Chat', ai_chat_placeholder: 'Ask AI anything...', ai_chat_send: 'Send',
        ai_no_config: 'Please configure AI in Help → AI Settings first.',
    },
    zh: {
        ai_settings: 'AI 设置', provider: '提供商', api_key: 'API 密钥', model: '模型',
        base_url: '自定义 URL（可选）', test_conn: '测试连接', save: '保存', cancel: '取消',
        testing: '测试中...', connected: '✓ 连接成功！', conn_failed: '✗ 失败：',
        ai_chat: 'AI 对话', ai_chat_placeholder: '问 AI 任何问题...', ai_chat_send: '发送',
        ai_no_config: '请先在 帮助 → AI 设置 中配置 API 密钥。',
    },
};
function aiT(key) {
    const lang = typeof _currentUILang !== 'undefined' ? _currentUILang : 'zh';
    return aiI18n[lang]?.[key] || aiI18n.en[key] || key;
}

// ===== 1. AI Settings Modal =====
function createAISettingsModal() {
    let existing = document.getElementById('ai-settings-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ai-settings-modal';
    modal.className = 'ai-modal-overlay';
    modal.innerHTML = `
        <div class="ai-modal">
            <h2>${aiT('ai_settings')}</h2>
            <div class="ai-form-group">
                <label>${aiT('provider')}</label>
                <select id="ai-provider">
                    <option value="openai">OpenAI</option>
                    <option value="claude">Claude (Anthropic)</option>
                    <option value="ollama">Ollama (Local)</option>
                </select>
            </div>
            <div class="ai-form-group">
                <label>${aiT('api_key')}</label>
                <input type="password" id="ai-api-key" placeholder="sk-..." autocomplete="off">
            </div>
            <div class="ai-form-group">
                <label>${aiT('model')}</label>
                <input type="text" id="ai-model" placeholder="gpt-4o-mini">
            </div>
            <div class="ai-form-group">
                <label>${aiT('base_url')}</label>
                <input type="text" id="ai-base-url" placeholder="https://api.openai.com/v1/chat/completions">
            </div>
            <div class="ai-form-actions">
                <button id="ai-test-btn" class="ai-btn ai-btn-outline">${aiT('test_conn')}</button>
                <div style="flex:1"></div>
                <button id="ai-cancel-btn" class="ai-btn ai-btn-outline">${aiT('cancel')}</button>
                <button id="ai-save-btn" class="ai-btn ai-btn-primary">${aiT('save')}</button>
                <div id="ai-test-result"></div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Load existing config
    window.electronAPI.getAIConfig().then(config => {
        document.getElementById('ai-provider').value = config.provider || 'openai';
        document.getElementById('ai-api-key').value = config.apiKey || '';
        document.getElementById('ai-model').value = config.model || '';
        document.getElementById('ai-base-url').value = config.baseUrl || '';
    });

    // Provider change → update placeholder
    document.getElementById('ai-provider').addEventListener('change', (e) => {
        const modelInput = document.getElementById('ai-model');
        const urlInput = document.getElementById('ai-base-url');
        const keyInput = document.getElementById('ai-api-key');
        if (e.target.value === 'openai') {
            modelInput.placeholder = 'gpt-4o-mini';
            urlInput.placeholder = 'https://api.openai.com/v1/chat/completions';
            keyInput.style.display = '';
        } else if (e.target.value === 'claude') {
            modelInput.placeholder = 'claude-3-5-sonnet-20241022';
            urlInput.placeholder = 'https://api.anthropic.com/v1/messages';
            keyInput.style.display = '';
        } else {
            modelInput.placeholder = 'llama3';
            urlInput.placeholder = 'http://localhost:11434/api/chat';
            keyInput.style.display = 'none';
        }
    });

    // Test connection
    document.getElementById('ai-test-btn').addEventListener('click', async () => {
        const resultEl = document.getElementById('ai-test-result');
        resultEl.textContent = aiT('testing');
        resultEl.className = '';
        const formConfig = {
            provider: document.getElementById('ai-provider').value,
            apiKey: document.getElementById('ai-api-key').value,
            model: document.getElementById('ai-model').value,
            baseUrl: document.getElementById('ai-base-url').value,
        };
        try {
            const res = await window.electronAPI.aiChat({
                ...formConfig,
                messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
            });
            if (res.error) throw new Error(res.error);
            // Auto-save on success
            await window.electronAPI.setAIConfig(formConfig);
            resultEl.textContent = aiT('connected');
            resultEl.className = 'ai-test-ok';
        } catch (e) {
            resultEl.textContent = aiT('conn_failed') + e.message;
            resultEl.className = 'ai-test-fail';
        }
    });

    // Save
    document.getElementById('ai-save-btn').addEventListener('click', async () => {
        await window.electronAPI.setAIConfig({
            provider: document.getElementById('ai-provider').value,
            apiKey: document.getElementById('ai-api-key').value,
            model: document.getElementById('ai-model').value,
            baseUrl: document.getElementById('ai-base-url').value,
        });
        modal.remove();
    });

    // Cancel
    document.getElementById('ai-cancel-btn').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

// ===== 2. Inline AI Toolbar (已移除) =====
function hideAIToolbar() { }



// ===== 3. AI Chat Sidebar =====
let _chatMessages = [];
let _chatOpen = false;
let _chatSessionId = null; // 当前会话 ID
let _chatView = 'chat'; // 'chat' | 'history'

function createChatPanel() {
    if (document.getElementById('ai-chat-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'ai-chat-panel';
    panel.className = 'ai-chat-panel';
    panel.innerHTML = `
        <div class="ai-chat-header">
            <button id="ai-chat-new-btn" class="ai-chat-header-btn" title="新建对话">＋ 新对话</button>
            <span id="ai-chat-title" class="ai-chat-header-title">${aiT('ai_chat')}</span>
            <div class="ai-chat-header-right">
                <button id="ai-chat-history-btn" class="ai-chat-header-btn" title="历史记录">📋 历史</button>
                <button id="ai-chat-close" class="ai-chat-close-btn">✕</button>
            </div>
        </div>
        <div class="ai-chat-messages" id="ai-chat-messages"></div>
        <div class="ai-chat-history-view hidden" id="ai-chat-history-view"></div>
        <div class="ai-chat-input-wrap" id="ai-chat-input-wrap">
            <textarea id="ai-chat-input" placeholder="${aiT('ai_chat_placeholder')}" rows="1"></textarea>
            <button id="ai-chat-send" class="ai-chat-send-btn" title="发送">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
        </div>
    `;
    document.body.appendChild(panel);

    document.getElementById('ai-chat-close').addEventListener('click', toggleChat);
    document.getElementById('ai-chat-send').addEventListener('click', sendChatMessage);
    document.getElementById('ai-chat-new-btn').addEventListener('click', startNewChat);
    document.getElementById('ai-chat-history-btn').addEventListener('click', toggleHistoryView);
    document.getElementById('ai-chat-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });
    // 输入框自动调整高度
    document.getElementById('ai-chat-input').addEventListener('input', (e) => {
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    });

    startNewChat();
}

function startNewChat() {
    // 保存当前会话（如果有消息）
    saveChatSession();
    _chatMessages = [];
    _chatSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const messagesEl = document.getElementById('ai-chat-messages');
    if (messagesEl) messagesEl.innerHTML = '';
    // 切回聊天视图
    showChatView();
}

async function saveChatSession() {
    if (_chatMessages.length < 2 || !_chatSessionId) return;
    const firstUserMsg = _chatMessages.find(m => m.role === 'user');
    const session = {
        id: _chatSessionId,
        title: firstUserMsg?.content?.slice(0, 50) || 'Chat',
        messages: _chatMessages,
        timestamp: new Date().toISOString(),
    };
    try {
        await window.electronAPI.saveChatSession(session);
    } catch (e) {
        console.error('保存聊天记录失败:', e);
    }
}

function showChatView() {
    _chatView = 'chat';
    document.getElementById('ai-chat-messages')?.classList.remove('hidden');
    document.getElementById('ai-chat-input-wrap')?.classList.remove('hidden');
    document.getElementById('ai-chat-history-view')?.classList.add('hidden');
    document.getElementById('ai-chat-title').textContent = aiT('ai_chat');
}

async function toggleHistoryView() {
    if (_chatView === 'history') {
        showChatView();
        return;
    }
    _chatView = 'history';
    document.getElementById('ai-chat-messages')?.classList.add('hidden');
    document.getElementById('ai-chat-input-wrap')?.classList.add('hidden');
    const historyView = document.getElementById('ai-chat-history-view');
    historyView?.classList.remove('hidden');
    document.getElementById('ai-chat-title').textContent = '历史记录';

    // 加载历史
    try {
        const sessions = await window.electronAPI.getChatHistory();
        if (!sessions.length) {
            historyView.innerHTML = '<div class="ai-history-empty">暂无历史记录</div>';
            return;
        }
        historyView.innerHTML = sessions.map(s => {
            const time = s.timestamp ? new Date(s.timestamp).toLocaleString('zh-CN', {
                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            }) : '';
            const msgCount = s.messages?.filter(m => m.role === 'user').length || 0;
            return `
            <div class="ai-history-item" data-id="${s.id}">
                <div class="ai-history-item-main">
                    <div class="ai-history-item-title">${(s.title || '').replace(/</g, '&lt;')}</div>
                    <div class="ai-history-item-meta">${time} · ${msgCount} 条提问</div>
                </div>
                <button class="ai-history-del-btn" data-id="${s.id}" title="删除">✕</button>
            </div>`;
        }).join('');

        // 点击加载历史对话
        historyView.querySelectorAll('.ai-history-item-main').forEach(el => {
            el.addEventListener('click', () => {
                const id = el.parentElement.dataset.id;
                const session = sessions.find(s => s.id === id);
                if (session) loadHistorySession(session);
            });
        });
        // 删除按钮
        historyView.querySelectorAll('.ai-history-del-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                await window.electronAPI.deleteChatSession(id);
                // 直接移除 DOM 元素
                const item = btn.closest('.ai-history-item');
                if (item) item.remove();
                // 如果列表空了显示提示
                if (!historyView.querySelector('.ai-history-item')) {
                    historyView.innerHTML = '<div class="ai-history-empty">暂无历史记录</div>';
                }
            });
        });
    } catch (e) {
        historyView.innerHTML = '<div class="ai-history-empty">加载失败</div>';
    }
}

function loadHistorySession(session) {
    _chatMessages = [...session.messages];
    _chatSessionId = session.id;
    const messagesEl = document.getElementById('ai-chat-messages');
    if (messagesEl) messagesEl.innerHTML = '';
    // 重新渲染所有消息
    for (const msg of session.messages) {
        const bubble = addChatBubble(msg.role, msg.content);
        if (msg.role === 'assistant') addBubbleActions(bubble, msg.content);
    }
    showChatView();
}

function toggleChat() {
    _chatOpen = !_chatOpen;
    let panel = document.getElementById('ai-chat-panel');
    if (!panel) {
        createChatPanel();
        panel = document.getElementById('ai-chat-panel');
    }
    panel.classList.toggle('open', _chatOpen);
    if (_chatOpen) {
        showChatView();
        document.getElementById('ai-chat-input').focus();
    }
}

function addChatBubble(role, text) {
    const messagesEl = document.getElementById('ai-chat-messages');
    if (!messagesEl) return null;
    const bubble = document.createElement('div');
    bubble.className = `ai-chat-bubble ai-chat-${role}`;
    if (role === 'user') {
        bubble.textContent = text;
    } else {
        // AI 回复用 Markdown 渲染
        const contentDiv = document.createElement('div');
        contentDiv.className = 'ai-chat-content';
        contentDiv.innerHTML = text ? markdownToHtml(text) : '';
        bubble.appendChild(contentDiv);
    }
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
}

// 为 AI 气泡添加操作按钮（复制 + 插入）
function addBubbleActions(bubble, rawText) {
    if (!bubble || !rawText) return;
    const actions = document.createElement('div');
    actions.className = 'ai-chat-actions';
    actions.innerHTML = `
        <button class="ai-chat-action-btn" data-action="copy" title="复制">📋 复制</button>
        <button class="ai-chat-action-btn" data-action="insert" title="插入到文档">📥 插入</button>
    `;
    actions.querySelector('[data-action="copy"]').addEventListener('click', () => {
        navigator.clipboard.writeText(rawText).then(() => {
            const btn = actions.querySelector('[data-action="copy"]');
            btn.textContent = '✓ 已复制';
            setTimeout(() => { btn.textContent = '📋 复制'; }, 1500);
        });
    });
    actions.querySelector('[data-action="insert"]').addEventListener('click', () => {
        if (editor) {
            const html = markdownToHtml(rawText);
            editor.chain().focus().insertContent(html).run();
            const btn = actions.querySelector('[data-action="insert"]');
            btn.textContent = '✓ 已插入';
            setTimeout(() => { btn.textContent = '📥 插入'; }, 1500);
        }
    });
    bubble.appendChild(actions);
}

// Loading 动画
function showTypingIndicator() {
    const messagesEl = document.getElementById('ai-chat-messages');
    if (!messagesEl) return null;
    const indicator = document.createElement('div');
    indicator.className = 'ai-chat-bubble ai-chat-assistant ai-typing-indicator';
    indicator.innerHTML = '<span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span>';
    messagesEl.appendChild(indicator);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return indicator;
}

async function sendChatMessage() {
    const input = document.getElementById('ai-chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';

    // Check config
    const config = await window.electronAPI.getAIConfig();
    if (!config.apiKey && config.provider !== 'ollama') {
        addChatBubble('assistant', aiT('ai_no_config'));
        return;
    }

    _chatMessages.push({ role: 'user', content: text });
    addChatBubble('user', text);

    // 显示 loading 动画
    const typingEl = showTypingIndicator();

    // Add context from current document
    let docContext = '';
    if (editor) {
        docContext = editor.state.doc.textContent.slice(0, 2000);
    }

    const systemMsg = {
        role: 'system',
        content: `You are a helpful writing assistant. The user is working on a Markdown document. Here is the current document context (first 2000 chars):\n\n${docContext}\n\nRespond helpfully and concisely.`
    };

    // 移除 loading，创建 AI 气泡
    let bubble = null;
    let contentDiv = null;
    let responseText = '';
    let firstChunk = true;

    window.electronAPI.onAIStreamChunk((chunk) => {
        if (firstChunk) {
            firstChunk = false;
            if (typingEl) typingEl.remove();
            bubble = addChatBubble('assistant', '');
            contentDiv = bubble?.querySelector('.ai-chat-content');
        }
        responseText += chunk;
        if (contentDiv) contentDiv.innerHTML = markdownToHtml(responseText);
        const messagesEl = document.getElementById('ai-chat-messages');
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    });

    window.electronAPI.onAIStreamDone(() => {
        if (firstChunk && typingEl) typingEl.remove();
        if (!bubble && responseText) {
            bubble = addChatBubble('assistant', responseText);
        }
        _chatMessages.push({ role: 'assistant', content: responseText });
        // 最终渲染 + 添加操作按钮
        if (contentDiv) contentDiv.innerHTML = markdownToHtml(responseText);
        addBubbleActions(bubble, responseText);
        // 自动保存会话
        saveChatSession();
    });

    window.electronAPI.onAIStreamError((err) => {
        if (typingEl) typingEl.remove();
        if (!bubble) bubble = addChatBubble('assistant', '');
        const cd = bubble?.querySelector('.ai-chat-content');
        if (cd) cd.innerHTML = '<span style="color:#f87171">⚠ ' + err + '</span>';
    });

    window.electronAPI.aiStreamStart({
        messages: [systemMsg, ..._chatMessages],
    });
}



// ===== AI Keyboard Shortcuts =====
document.addEventListener('keydown', (e) => {
    // Cmd+Shift+L — toggle chat
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'l') {
        e.preventDefault();
        toggleChat();
        return;
    }
    // Escape — close chat
    if (e.key === 'Escape') {
        if (_chatOpen) { toggleChat(); return; }
    }
});

// ===== Menu Command for AI Settings =====
if (window.electronAPI?.onMenuCommand) {
    window.electronAPI.onMenuCommand((data) => {
        if (data.command === 'ai-settings') {
            createAISettingsModal();
            return;
        }
    });
}

// ===== Create chat panel on load =====
createChatPanel();

// ===== Floating AI Chat Button =====
const _aiFab = document.createElement('button');
_aiFab.id = 'ai-fab';
_aiFab.className = 'ai-fab';
_aiFab.innerHTML = '💬';
_aiFab.title = 'AI Chat (⌘⇧L)';
_aiFab.addEventListener('click', () => toggleChat());
document.body.appendChild(_aiFab);

// ===== Init =====
applyTheme(currentTheme);

