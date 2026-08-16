const path = require('node:path');

const { JsonStore } = require('./lib/store');
const { MemoryService } = require('./lib/memory-service');

const DATA_DIR = process.env.ST_MEMORY_LITE_DATA_DIR
    ? path.resolve(process.env.ST_MEMORY_LITE_DATA_DIR)
    : path.join(process.cwd(), 'data', 'default-user', 'st-memory-lite');

const DATABASE_PATH = path.join(DATA_DIR, 'memory.json');
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');

let store;
let service;

function integer(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

function decimal(value, fallback, min, max) {
    const parsed = Number(value);
    return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
}

function cleanProvider(value = {}) {
    const output = {
        baseUrl: String(value.baseUrl || '').trim(),
        model: String(value.model || '').trim(),
    };
    if (typeof value.apiKey === 'string' && value.apiKey.trim()) {
        output.apiKey = value.apiKey.trim();
    }
    return output;
}

function cleanSettings(body = {}) {
    const patch = {
        autoSummary: body.autoSummary === true,
        autoSummaryMessages: integer(body.autoSummaryMessages, 12, 1, 200),
        keepRecentMessages: 2,
        summaryChunkChars: integer(body.summaryChunkChars, 12000, 2000, 50000),
        summaryInjectionMaxChars: integer(body.summaryInjectionMaxChars, 7000, 500, 30000),
        queryRewriteEnabled: body.queryRewriteEnabled === true,
        recallCandidateLimit: integer(body.recallCandidateLimit, 24, 1, 100),
        recallLimit: integer(body.recallLimit, 6, 1, 20),
        recallMinScore: decimal(body.recallMinScore, 0.42, -1, 1),
        keywordMinScore: decimal(body.keywordMinScore, 0.16, 0, 1),
        recallMaxChars: integer(body.recallMaxChars, 3200, 200, 20000),
        relationExpansionLimit: integer(body.relationExpansionLimit, 3, 0, 12),
        relationMinScore: decimal(body.relationMinScore, 0.34, 0, 1),
        cooldownTurns: integer(body.cooldownTurns, 3, 0, 20),
        cooldownPenalty: decimal(body.cooldownPenalty, 0.14, 0, 1),
        importanceWeight: decimal(body.importanceWeight, 0.08, 0, 0.5),
        rerankerEnabled: body.rerankerEnabled === true,
        rerankerWeight: decimal(body.rerankerWeight, 0.65, 0, 1),
        summary: {
            ...cleanProvider(body.summary),
            maxTokens: integer(body.summary?.maxTokens, 2200, 200, 8000),
        },
        embedding: {
            ...cleanProvider(body.embedding),
            queryInstruction: String(body.embedding?.queryInstruction || '').trim().slice(0, 1000),
            documentInstruction: String(body.embedding?.documentInstruction || '').trim().slice(0, 1000),
        },
        reranker: cleanProvider(body.reranker),
    };
    return patch;
}

function errorResponse(res, error, status = 400) {
    console.error('[ST Memory Lite]', error);
    res.status(status).json({ ok: false, error: error?.message || String(error) });
}

async function init(router) {
    store = new JsonStore(DATABASE_PATH);
    service = new MemoryService(store);

    router.get('/health', (req, res) => {
        res.json({
            ok: true,
            plugin: 'st-memory-lite',
            version: '0.2.0',
            scopes: store.listScopes().length,
            memories: store.listScopes().reduce((sum, item) => sum + item.memoryCount, 0),
        });
    });

    router.get('/dashboard', (req, res) => {
        res.sendFile(path.join(DASHBOARD_DIR, 'index.html'));
    });
    router.get('/dashboard/app.js', (req, res) => {
        res.type('application/javascript').sendFile(path.join(DASHBOARD_DIR, 'app.js'));
    });
    router.get('/dashboard/style.css', (req, res) => {
        res.type('text/css').sendFile(path.join(DASHBOARD_DIR, 'style.css'));
    });

    router.get('/settings', (req, res) => {
        res.json({ ok: true, settings: store.getSettings() });
    });

    router.post('/settings', async (req, res) => {
        try {
            const settings = await store.updateSettings(cleanSettings(req.body));
            res.json({ ok: true, settings });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    router.get('/scopes', (req, res) => {
        res.json({ ok: true, scopes: store.listScopes() });
    });

    router.get('/scopes/:scopeId', (req, res) => {
        const scope = store.data.scopes[req.params.scopeId];
        if (!scope) return errorResponse(res, new Error('聊天窗口不存在'), 404);
        res.json({ ok: true, scope: store.publicScope(scope) });
    });

    router.post('/sync', async (req, res) => {
        try {
            const { characterKey, characterName, chatId, messages } = req.body || {};
            if (!characterKey || !chatId || !Array.isArray(messages)) {
                throw new Error('缺少角色、聊天窗口或消息');
            }
            const result = await service.sync({ characterKey, characterName, chatId, messages });
            res.json({ ok: true, ...result });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    router.post('/scopes/:scopeId/summarize', async (req, res) => {
        try {
            const result = await service.summarize(req.params.scopeId);
            res.json({ ok: true, ...result });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    router.post('/recall', async (req, res) => {
        try {
            const { characterKey, chatId, query, visibleMessageIndices, turnKey } = req.body || {};
            if (!characterKey || !chatId || !String(query || '').trim()) {
                return res.json({ ok: true, memories: [], text: '' });
            }
            const result = await service.recall({ characterKey, chatId, query, visibleMessageIndices, turnKey });
            res.json({ ok: true, ...result });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    router.put('/scopes/:scopeId/memories/:memoryId', async (req, res) => {
        try {
            const scope = await service.updateMemory(req.params.scopeId, req.params.memoryId, req.body || {});
            res.json({ ok: true, scope });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    router.delete('/scopes/:scopeId/memories/:memoryId', async (req, res) => {
        try {
            const scope = await service.deleteMemory(req.params.scopeId, req.params.memoryId);
            res.json({ ok: true, scope });
        } catch (error) {
            errorResponse(res, error);
        }
    });

    console.log(`[ST Memory Lite] Server plugin loaded; data: ${DATABASE_PATH}`);
}

async function exit() {
    if (store) await store.persist();
    console.log('[ST Memory Lite] Server plugin stopped');
}

module.exports = {
    init,
    exit,
    info: {
        id: 'st-memory-lite',
        name: 'ST Memory Lite',
        description: 'Lightweight plot memory with isolated summaries, hybrid recall and reranking.',
    },
};
