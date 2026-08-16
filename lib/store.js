const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = Object.freeze({
    autoSummary: false,
    autoSummaryMessages: 12,
    keepRecentMessages: 2,
    summaryChunkChars: 12000,
    summaryInjectionMaxChars: 7000,
    queryRewriteEnabled: false,
    recallCandidateLimit: 24,
    recallLimit: 6,
    recallMinScore: 0.42,
    keywordMinScore: 0.16,
    recallMaxChars: 3200,
    relationExpansionLimit: 3,
    relationMinScore: 0.34,
    cooldownTurns: 3,
    cooldownPenalty: 0.14,
    importanceWeight: 0.08,
    rerankerEnabled: false,
    rerankerWeight: 0.65,
    summary: { baseUrl: '', apiKey: '', model: '', maxTokens: 2200 },
    embedding: {
        baseUrl: '', apiKey: '', model: '',
        queryInstruction: 'Retrieve objectively stated past plot events and facts relevant to the current story scene.',
        documentInstruction: 'Represent this objective third-person story memory for retrieval.',
    },
    reranker: { baseUrl: '', apiKey: '', model: '' },
});

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function mergeSettings(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    return {
        ...clone(DEFAULT_SETTINGS),
        ...source,
        summary: { ...DEFAULT_SETTINGS.summary, ...(source.summary || {}) },
        embedding: { ...DEFAULT_SETTINGS.embedding, ...(source.embedding || {}) },
        reranker: { ...DEFAULT_SETTINGS.reranker, ...(source.reranker || {}) },
    };
}

function emptyDatabase() {
    return { version: 2, settings: clone(DEFAULT_SETTINGS), scopes: {} };
}

function scopeId(characterKey, chatId) {
    return `${encodeURIComponent(String(characterKey))}::${encodeURIComponent(String(chatId))}`;
}

function migrateScope(scope = {}) {
    return {
        ...scope,
        summaryCursor: Number(scope.summaryCursor) || 0,
        messages: Array.isArray(scope.messages) ? scope.messages : [],
        segments: Array.isArray(scope.segments) ? scope.segments : [],
        memories: Array.isArray(scope.memories) ? scope.memories : [],
        recallHistory: scope.recallHistory && typeof scope.recallHistory === 'object' ? scope.recallHistory : {},
    };
}

class JsonStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = emptyDatabase();
        this.writeQueue = Promise.resolve();
        this.load();
    }

    load() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        if (!fs.existsSync(this.filePath)) {
            this.persistSync();
            return;
        }
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.data = {
            ...emptyDatabase(), ...parsed, version: 2,
            settings: mergeSettings(parsed.settings),
            scopes: Object.fromEntries(Object.entries(parsed.scopes || {}).map(([id, scope]) => [id, migrateScope(scope)])),
        };
        this.persistSync();
    }

    persistSync() {
        const temporaryPath = `${this.filePath}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporaryPath, this.filePath);
        fs.chmodSync(this.filePath, 0o600);
    }

    persist() {
        this.writeQueue = this.writeQueue.then(() => this.persistSync());
        return this.writeQueue;
    }

    getSettings({ includeSecrets = false } = {}) {
        const settings = clone(this.data.settings);
        for (const provider of ['summary', 'embedding', 'reranker']) {
            const configured = Boolean(settings[provider].apiKey);
            if (!includeSecrets) {
                delete settings[provider].apiKey;
                settings[provider].apiKeyConfigured = configured;
            }
        }
        return settings;
    }

    async updateSettings(patch = {}) {
        const next = mergeSettings({ ...this.data.settings, ...patch });
        for (const provider of ['summary', 'embedding', 'reranker']) {
            next[provider] = { ...this.data.settings[provider], ...(patch[provider] || {}) };
            if (!Object.hasOwn(patch[provider] || {}, 'apiKey')) next[provider].apiKey = this.data.settings[provider].apiKey;
        }
        next.keepRecentMessages = 2;
        this.data.settings = next;
        await this.persist();
        return this.getSettings();
    }

    getScope(characterKey, chatId, create = false, metadata = {}) {
        const id = scopeId(characterKey, chatId);
        let scope = this.data.scopes[id];
        if (!scope && create) {
            scope = migrateScope({
                id, characterKey: String(characterKey),
                characterName: String(metadata.characterName || characterKey),
                chatId: String(chatId), updatedAt: new Date().toISOString(),
            });
            this.data.scopes[id] = scope;
        }
        return scope || null;
    }

    async syncScope(payload) {
        const scope = this.getScope(payload.characterKey, payload.chatId, true, payload);
        scope.characterName = String(payload.characterName || scope.characterName);
        scope.messages = Array.isArray(payload.messages) ? payload.messages : [];
        const lastIndex = scope.messages.length ? Math.max(...scope.messages.map(item => item.index)) + 1 : 0;
        scope.summaryCursor = Math.min(Number(scope.summaryCursor) || 0, lastIndex);
        scope.updatedAt = new Date().toISOString();
        await this.persist();
        return scope;
    }

    hideIndices(scope) {
        const covered = new Set();
        for (const segment of scope.segments || []) {
            for (const index of segment.sourceIndices || []) covered.add(index);
        }
        return [...covered].sort((a, b) => a - b);
    }

    pendingMessages(scope) {
        const eligible = scope.messages.slice(0, Math.max(0, scope.messages.length - 2));
        return eligible.filter(item => item.index >= (scope.summaryCursor || 0)).length;
    }

    listScopes() {
        return Object.values(this.data.scopes).map(scope => ({
            id: scope.id, characterKey: scope.characterKey, characterName: scope.characterName,
            chatId: scope.chatId, messageCount: scope.messages.length,
            pendingMessages: this.pendingMessages(scope), memoryCount: scope.memories.length,
            segmentCount: scope.segments.length, updatedAt: scope.updatedAt,
        })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }

    publicScope(scope) {
        return {
            id: scope.id, characterKey: scope.characterKey, characterName: scope.characterName,
            chatId: scope.chatId, messageCount: scope.messages.length,
            pendingMessages: this.pendingMessages(scope), memoryCount: scope.memories.length,
            segmentCount: scope.segments.length, hideIndices: this.hideIndices(scope),
            updatedAt: scope.updatedAt, segments: scope.segments,
            memories: scope.memories.map(({ embedding, ...memory }) => memory),
        };
    }
}

module.exports = { DEFAULT_SETTINGS, JsonStore, mergeSettings, scopeId };
