// ai-service.js — Unified AI provider abstraction
// Supports OpenAI, Claude (Anthropic), and Ollama

const https = require('https');
const http = require('http');

/**
 * Call an AI provider with messages.
 * @param {object} opts
 * @param {string} opts.provider - 'openai' | 'claude' | 'ollama'
 * @param {string} opts.apiKey - API key (not needed for Ollama)
 * @param {string} opts.model - Model name
 * @param {string} opts.baseUrl - Optional custom base URL
 * @param {Array} opts.messages - [{role: 'user'|'assistant'|'system', content: '...'}]
 * @param {boolean} opts.stream - Whether to stream response
 * @param {function} opts.onChunk - Callback for each chunk when streaming: (text) => void
 * @returns {Promise<string>} Full response text
 */
async function callAI(opts) {
    const { provider, apiKey, model, baseUrl, messages, stream = false, onChunk } = opts;

    switch (provider) {
        case 'openai':
            return callOpenAI({ apiKey, model, baseUrl, messages, stream, onChunk });
        case 'claude':
            return callClaude({ apiKey, model, baseUrl, messages, stream, onChunk });
        case 'ollama':
            return callOllama({ model, baseUrl, messages, stream, onChunk });
        default:
            throw new Error(`Unknown AI provider: ${provider}`);
    }
}

// ===== OpenAI =====
async function callOpenAI({ apiKey, model, baseUrl, messages, stream, onChunk }) {
    // 自动补全 baseUrl：支持 /v1、/v1/completions、完整 endpoint 等多种写法
    let endpoint = baseUrl || 'https://api.openai.com/v1/chat/completions';
    if (endpoint && !endpoint.endsWith('/chat/completions')) {
        if (endpoint.endsWith('/completions')) {
            endpoint = endpoint.replace(/\/completions$/, '/chat/completions');
        } else {
            endpoint = endpoint.replace(/\/$/, '') + '/chat/completions';
        }
    }
    const url = new URL(endpoint);
    const body = JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages,
        stream,
    });

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    if (stream) {
        return streamRequest(url, headers, body, (line) => {
            if (line === 'data: [DONE]') return null;
            if (!line.startsWith('data: ')) return '';
            try {
                const json = JSON.parse(line.slice(6));
                return json.choices?.[0]?.delta?.content || '';
            } catch { return ''; }
        }, onChunk);
    } else {
        const data = await jsonRequest(url, headers, body);
        return data.choices?.[0]?.message?.content || '';
    }
}

// ===== Claude (Anthropic) =====
async function callClaude({ apiKey, model, baseUrl, messages, stream, onChunk }) {
    const url = new URL(baseUrl || 'https://api.anthropic.com/v1/messages');

    // Convert messages: extract system prompt, keep user/assistant
    let system = '';
    const filtered = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            system += (system ? '\n' : '') + msg.content;
        } else {
            filtered.push(msg);
        }
    }

    const bodyObj = {
        model: model || 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        messages: filtered,
        stream,
    };
    if (system) bodyObj.system = system;

    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
    };

    if (stream) {
        return streamRequest(url, headers, JSON.stringify(bodyObj), (line) => {
            if (!line.startsWith('data: ')) return '';
            try {
                const json = JSON.parse(line.slice(6));
                if (json.type === 'content_block_delta') {
                    return json.delta?.text || '';
                }
                return '';
            } catch { return ''; }
        }, onChunk);
    } else {
        const data = await jsonRequest(url, headers, JSON.stringify(bodyObj));
        return data.content?.[0]?.text || '';
    }
}

// ===== Ollama =====
async function callOllama({ model, baseUrl, messages, stream, onChunk }) {
    const url = new URL(baseUrl || 'http://localhost:11434/api/chat');
    const body = JSON.stringify({
        model: model || 'llama3',
        messages,
        stream,
    });

    const headers = { 'Content-Type': 'application/json' };

    if (stream) {
        return streamRequest(url, headers, body, (line) => {
            try {
                const json = JSON.parse(line);
                return json.message?.content || '';
            } catch { return ''; }
        }, onChunk);
    } else {
        const data = await jsonRequest(url, headers, body);
        return data.message?.content || '';
    }
}

// ===== HTTP helpers =====
function jsonRequest(url, headers, body) {
    return new Promise((resolve, reject) => {
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(url, { method: 'POST', headers }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Request timeout')); });
        req.write(body);
        req.end();
    });
}

function streamRequest(url, headers, body, parseLine, onChunk) {
    return new Promise((resolve, reject) => {
        const lib = url.protocol === 'https:' ? https : http;
        let fullText = '';
        let buffer = '';

        const req = lib.request(url, { method: 'POST', headers }, (res) => {
            if (res.statusCode >= 400) {
                let errData = '';
                res.on('data', c => errData += c);
                res.on('end', () => reject(new Error(`API error ${res.statusCode}: ${errData.slice(0, 300)}`)));
                return;
            }

            res.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep incomplete line in buffer

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    const text = parseLine(trimmed);
                    if (text === null) continue; // End signal
                    if (text) {
                        fullText += text;
                        if (onChunk) onChunk(text);
                    }
                }
            });

            res.on('end', () => {
                // Process remaining buffer
                if (buffer.trim()) {
                    const text = parseLine(buffer.trim());
                    if (text && text !== null) {
                        fullText += text;
                        if (onChunk) onChunk(text);
                    }
                }
                resolve(fullText);
            });
        });

        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('Stream timeout')); });
        req.write(body);
        req.end();
    });
}

module.exports = { callAI };
