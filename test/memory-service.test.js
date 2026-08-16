const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MemoryService, cosineSimilarity, relationStrength, segmentMessages, tokenize } = require('../lib/memory-service');
const { JsonStore } = require('../lib/store');

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-memory-lite-'));
    const store = new JsonStore(path.join(directory, 'memory.json'));
    store.data.settings.summary = { baseUrl: 'https://summary.test/v1', apiKey: 's', model: 'cheap', maxTokens: 500 };
    store.data.settings.embedding = { baseUrl: 'https://embedding.test/v1', apiKey: 'e', model: 'embed-v1', queryInstruction: '', documentInstruction: '' };
    store.data.settings.recallMinScore = 0.4;
    store.data.settings.keywordMinScore = 0.1;
    const vectorFor = text => Promise.resolve(String(text).includes('港口') || String(text).includes('钥匙') ? [1, 0] : [0, 1]);
    const service = new MemoryService(store, {
        summarizeSegment: async () => ({
            segment_summary: '陆遥与岑回抵达港口，岑回随后把旧钥匙交给陆遥。',
            memories: [{
                title: '港口交钥匙', content: '岑回在港口把旧钥匙交给了陆遥。',
                tags: ['港口', '旧钥匙', '交付'], participants: ['岑回', '陆遥'],
                importance: 7, valence: 0.2, arousal: 0.3,
                emotions: [], relationship_changes: [{ from: '岑回', to: '陆遥', change: '岑回把旧钥匙交给陆遥。' }],
            }],
        }),
        createEmbedding: async (_config, text) => vectorFor(text),
        rerank: async () => [{ index: 0, score: 0.9 }],
        rewriteQuery: async () => ({ intent: '查找港口钥匙事件', queries: ['港口 旧钥匙'] }),
    });
    return { directory, store, service };
}

test('cosine, token and relation helpers are deterministic', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1], [1, 0]), -1);
    assert.equal(tokenize('港口旧钥匙').has('旧钥'), true);
    assert.ok(relationStrength(
        { participants: ['岑回'], tags: ['港口'], embedding: [1, 0] },
        { participants: ['岑回'], tags: ['钥匙'], embedding: [1, 0] },
    ) > 0.6);
});

test('message segmentation starts at the requested array position', () => {
    const messages = [{ index: 2, name: 'A', mes: 'one' }, { index: 4, name: 'B', mes: 'two' }, { index: 8, name: 'A', mes: 'three' }];
    const chunks = segmentMessages(messages, 1, 100);
    assert.deepEqual(chunks[0].map(item => item.sourceIndex), [4, 8]);
});

test('manual summary keeps the newest two floors raw and exposes an atomic hide plan', async t => {
    const { directory, store, service } = fixture();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const synced = await service.sync({
        characterKey: 'char-a.png', characterName: '岑回', chatId: 'route-a',
        messages: [
            { index: 0, name: '陆遥', is_user: true, mes: '他们到了港口。' },
            { index: 1, name: '岑回', is_user: false, mes: '岑回交出了旧钥匙。' },
            { index: 2, name: '陆遥', is_user: true, mes: '陆遥收好钥匙。' },
            { index: 3, name: '岑回', is_user: false, mes: '岑回望向仓库。' },
        ],
    });
    assert.equal(synced.scope.pendingMessages, 2);
    const summarized = await service.summarize(synced.scope.id);
    assert.equal(summarized.created, 1);
    assert.deepEqual(summarized.scope.hideIndices, [0, 1]);
    assert.equal(store.data.scopes[synced.scope.id].summaryCursor, 2);
    assert.equal(summarized.scope.segments[0].summary.includes('港口'), true);
});

test('hybrid recall is isolated and excludes memories whose source is still visible', async t => {
    const { directory, service } = fixture();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const first = await service.sync({
        characterKey: 'char-a.png', characterName: '岑回', chatId: 'route-a',
        messages: [
            { index: 0, name: '陆遥', is_user: true, mes: '他们到了港口。' },
            { index: 1, name: '岑回', is_user: false, mes: '岑回交出了旧钥匙。' },
            { index: 2, name: '陆遥', is_user: true, mes: '继续。' },
            { index: 3, name: '岑回', is_user: false, mes: '他们离开港口。' },
        ],
    });
    await service.summarize(first.scope.id);
    await service.sync({
        characterKey: 'char-a.png', characterName: '岑回', chatId: 'route-b',
        messages: [{ index: 0, name: '陆遥', is_user: true, mes: '平行剧情从山里开始。' }],
    });
    const hit = await service.recall({ characterKey: 'char-a.png', chatId: 'route-a', query: '港口的钥匙', visibleMessageIndices: [2, 3], turnKey: '4' });
    const excluded = await service.recall({ characterKey: 'char-a.png', chatId: 'route-a', query: '港口的钥匙', visibleMessageIndices: [0, 1], turnKey: '5' });
    const miss = await service.recall({ characterKey: 'char-a.png', chatId: 'route-b', query: '港口的钥匙', turnKey: '1' });
    assert.equal(hit.memories.length, 1);
    assert.equal(hit.memories[0].keywordScore > 0, true);
    assert.equal(hit.chronologyText.includes('客观第三人称'), true);
    assert.equal(excluded.memories.length, 0);
    assert.equal(miss.memories.length, 0);
});

test('settings view never exposes stored keys and fixes raw window at two floors', async t => {
    const { directory, store } = fixture();
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const settings = await store.updateSettings({ keepRecentMessages: 99 });
    assert.equal(settings.summary.apiKey, undefined);
    assert.equal(settings.summary.apiKeyConfigured, true);
    assert.equal(settings.keepRecentMessages, 2);
});
