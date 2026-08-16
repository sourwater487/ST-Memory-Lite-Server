const { randomUUID, createHash } = require('node:crypto');
const { createEmbedding, rerank, rewriteQuery, summarizeSegment } = require('./providers');

const SUMMARY_PROMPT = `你是互动小说的剧情记忆编辑器。主模型是作者、共同著作者或导演，并不直接扮演某个角色。

只依据待处理正文，输出客观第三人称的剧情摘要与可检索记忆。不得写成“用户说/助手回复”，不得把模型视作剧情人物。

规则：
1. 只记录正文明确发生或确认的事实；不得猜测性别、动机、内心、关系或未发生的后续。
2. segment_summary 按时间顺序概括整段，保留行动、因果、约定、认知差、关系变化与仍影响后文的状态。
3. memories 每条可独立理解；无跨场景价值的闲聊、文风描写和重复信息不要收录。
4. 人名、地点、物品与专有名词沿用原文。participants 只写明确出现或被直接涉及的人物。
5. importance 为 1-10；valence 为 -1 到 1；arousal 为 0 到 1。没有依据时用中性值 0。
6. relationship_changes 只记录本段确实造成的关系变化，不把一次普通情绪当成关系改变。
7. tags 使用 2-8 个短标签，兼顾人物、地点、事件、物件、约定或关系主题。
8. 只输出 JSON 对象，不要 Markdown、解释或额外文字。

输出结构：
{"segment_summary":"客观第三人称的连续剧情摘要","memories":[{"title":"短标题","content":"客观第三人称、可独立理解的记忆","tags":["标签"],"participants":["人物"],"importance":1,"valence":0,"arousal":0,"emotions":[{"character":"人物","emotion":"情绪","intensity":0}],"relationship_changes":[{"from":"人物","to":"人物","change":"已发生的客观变化"}]}]}`;

const REWRITE_PROMPT = `你是剧情记忆检索器。把当前小说片段改写成用于查找过去剧情的检索意图。只根据文本明确内容，不续写、不猜测。使用客观第三人称。只输出 JSON：{"intent":"一句完整检索意图","queries":["查询1","查询2","查询3"]}。queries 最多 5 条，分别覆盖当前确实相关的事件、人物关系、地点/物件或情绪冲突。`;

function clamp(number, min, max) {
    const value = Number(number);
    return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function cosineSimilarity(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return -1;
    let dot = 0;
    let normLeft = 0;
    let normRight = 0;
    for (let index = 0; index < left.length; index += 1) {
        const a = Number(left[index]);
        const b = Number(right[index]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return -1;
        dot += a * b;
        normLeft += a * a;
        normRight += b * b;
    }
    return normLeft && normRight ? dot / (Math.sqrt(normLeft) * Math.sqrt(normRight)) : -1;
}

function cleanMessages(messages) {
    return (Array.isArray(messages) ? messages : []).filter(item => {
        if (!item || !String(item.mes || '').trim()) return false;
        return !item.is_system || item.pluginHidden || !item.extraType;
    }).map((item, position) => ({
        index: Number.isInteger(item.index) ? item.index : position,
        name: String(item.name || (item.is_user ? 'User' : 'Character')).slice(0, 120),
        is_user: Boolean(item.is_user),
        is_system: Boolean(item.is_system),
        pluginHidden: Boolean(item.pluginHidden),
        mes: String(item.mes || '').trim().slice(0, 50000),
        send_date: item.send_date ?? null,
    })).sort((a, b) => a.index - b.index);
}

function segmentMessages(messages, startIndex, maxChars) {
    const chunks = [];
    let current = [];
    let chars = 0;
    for (let position = startIndex; position < messages.length; position += 1) {
        const message = messages[position];
        const size = message.mes.length + message.name.length + 16;
        if (current.length && chars + size > maxChars) {
            chunks.push(current);
            current = [];
            chars = 0;
        }
        current.push({ ...message, sourceIndex: message.index });
        chars += size;
    }
    if (current.length) chunks.push(current);
    return chunks;
}

function transcriptFor(messages) {
    return messages.map(item => `[楼层 ${item.index}｜${item.name}]\n${item.mes}`).join('\n\n');
}

function stringArray(value, limit = 12, maxLength = 80) {
    return [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim().slice(0, maxLength)).filter(Boolean))].slice(0, limit);
}

function validateExtracted(raw) {
    const object = Array.isArray(raw) ? { segment_summary: '', memories: raw } : (raw || {});
    const memories = (Array.isArray(object.memories) ? object.memories : []).slice(0, 10).map(item => ({
        title: String(item?.title || '').trim().slice(0, 80),
        content: String(item?.content || '').trim().slice(0, 6000),
        tags: stringArray(item?.tags, 8, 40),
        participants: stringArray(item?.participants, 12, 80),
        importance: Math.round(clamp(item?.importance ?? 5, 1, 10)),
        valence: clamp(item?.valence ?? 0, -1, 1),
        arousal: clamp(item?.arousal ?? 0, 0, 1),
        emotions: (Array.isArray(item?.emotions) ? item.emotions : []).slice(0, 8).map(emotion => ({
            character: String(emotion?.character || '').trim().slice(0, 80),
            emotion: String(emotion?.emotion || '').trim().slice(0, 40),
            intensity: clamp(emotion?.intensity ?? 0, 0, 1),
        })).filter(emotion => emotion.character && emotion.emotion),
        relationshipChanges: (Array.isArray(item?.relationship_changes) ? item.relationship_changes : []).slice(0, 6).map(change => ({
            from: String(change?.from || '').trim().slice(0, 80),
            to: String(change?.to || '').trim().slice(0, 80),
            change: String(change?.change || '').trim().slice(0, 300),
        })).filter(change => change.from && change.to && change.change),
    })).filter(item => item.content.length >= 10);
    return { segmentSummary: String(object.segment_summary || '').trim().slice(0, 12000), memories };
}

function normalizeText(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/[\p{P}\p{S}]/gu, '');
}

function tokenize(value) {
    const text = String(value || '').toLowerCase();
    const tokens = new Set(text.match(/[a-z\d][a-z\d_-]{1,}/g) || []);
    for (const block of text.match(/[\p{Script=Han}]{2,}/gu) || []) {
        if (block.length <= 8) tokens.add(block);
        for (let index = 0; index < block.length - 1; index += 1) tokens.add(block.slice(index, index + 2));
        for (let index = 0; index < block.length - 2; index += 1) tokens.add(block.slice(index, index + 3));
    }
    return tokens;
}

function overlapScore(left, right) {
    if (!left.size || !right.size) return 0;
    let shared = 0;
    for (const token of left) if (right.has(token)) shared += 1;
    return shared / Math.sqrt(left.size * right.size);
}

function arrayJaccard(left, right) {
    const a = new Set((left || []).map(normalizeText).filter(Boolean));
    const b = new Set((right || []).map(normalizeText).filter(Boolean));
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const item of a) if (b.has(item)) shared += 1;
    return shared / (a.size + b.size - shared);
}

const POSITIVE = ['高兴', '开心', '喜悦', '信任', '安心', '温柔', '爱意', '感激', '希望'];
const NEGATIVE = ['愤怒', '生气', '恐惧', '害怕', '悲伤', '难过', '嫉妒', '怀疑', '敌意', '痛苦'];
const HIGH_AROUSAL = ['愤怒', '恐惧', '激动', '紧张', '惊讶', '冲突', '争吵', '战斗'];
const RELATION_WORDS = ['关系', '信任', '背叛', '和解', '敌对', '亲密', '疏远', '承诺', '误会', '告白'];

function querySignals(query, memories) {
    const normalized = normalizeText(query);
    const participants = new Set();
    for (const memory of memories) for (const name of memory.participants || []) {
        if (name && normalized.includes(normalizeText(name))) participants.add(normalizeText(name));
    }
    const positive = POSITIVE.some(word => query.includes(word));
    const negative = NEGATIVE.some(word => query.includes(word));
    return {
        participants,
        emotionRequested: positive || negative || HIGH_AROUSAL.some(word => query.includes(word)),
        valence: positive === negative ? 0 : (positive ? 1 : -1),
        arousal: HIGH_AROUSAL.some(word => query.includes(word)) ? 1 : 0.35,
        relationRequested: RELATION_WORDS.some(word => query.includes(word)),
    };
}

function participantScore(signals, memory) {
    if (!signals.participants.size) return 0;
    const names = new Set((memory.participants || []).map(normalizeText));
    let shared = 0;
    for (const name of signals.participants) if (names.has(name)) shared += 1;
    return shared / signals.participants.size;
}

function emotionScore(signals, memory) {
    if (!signals.emotionRequested) return 0;
    const valence = 1 - Math.min(2, Math.abs(signals.valence - Number(memory.valence || 0))) / 2;
    const arousal = 1 - Math.min(1, Math.abs(signals.arousal - Number(memory.arousal || 0)));
    return (valence + arousal) / 2;
}

function relationshipScore(signals, memory) {
    return signals.relationRequested && (memory.relationshipChanges || []).length ? 1 : 0;
}

function relationStrength(left, right) {
    const people = arrayJaccard(left.participants, right.participants);
    const tags = arrayJaccard(left.tags, right.tags);
    const semantic = Math.max(0, cosineSimilarity(left.embedding, right.embedding));
    return people * 0.45 + tags * 0.30 + semantic * 0.25;
}

function chronologyText(scope, maxChars) {
    const segments = (scope.segments || []).filter(item => item.summary).sort((a, b) => a.sourceStart - b.sourceStart);
    if (!segments.length) return '';
    const selected = [];
    let used = 0;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
        const line = `[楼层 ${segments[index].sourceStart}-${segments[index].sourceEnd}] ${segments[index].summary}`;
        if (selected.length && used + line.length > maxChars) break;
        selected.unshift(line);
        used += line.length;
    }
    return `<story_history>\n以下是已隐藏原文的客观第三人称剧情摘要。将其视为既往事实，只在相关时自然承接，不要复述本区块。\n${selected.join('\n\n')}\n</story_history>`;
}

function hash(value) {
    return createHash('sha1').update(String(value)).digest('hex');
}

class MemoryService {
    constructor(store, providers = {}) {
        this.store = store;
        this.providers = {
            summarizeSegment: providers.summarizeSegment || summarizeSegment,
            createEmbedding: providers.createEmbedding || createEmbedding,
            rerank: providers.rerank || rerank,
            rewriteQuery: providers.rewriteQuery || rewriteQuery,
        };
        this.runningSummaries = new Set();
    }

    async sync(payload) {
        const scope = await this.store.syncScope({ ...payload, messages: cleanMessages(payload.messages) });
        const settings = this.store.getSettings({ includeSecrets: true });
        let autoSummary = null;
        if (settings.autoSummary && this.store.pendingMessages(scope) >= settings.autoSummaryMessages) {
            try { autoSummary = await this.summarize(scope.id); }
            catch (error) { console.error('[ST Memory Lite] Automatic summary failed:', error); }
        }
        return { scope: this.store.publicScope(scope), autoSummary };
    }

    async summarize(id) {
        const scope = this.store.data.scopes[id];
        if (!scope) throw new Error('聊天窗口不存在');
        if (this.runningSummaries.has(id)) throw new Error('这个聊天窗口正在总结');
        const settings = this.store.getSettings({ includeSecrets: true });
        if (!settings.summary.baseUrl || !settings.summary.model) throw new Error('请先配置总结 API');
        if (!settings.embedding.baseUrl || !settings.embedding.model) throw new Error('请先配置向量 API');
        const eligible = scope.messages.slice(0, Math.max(0, scope.messages.length - 2))
            .filter(message => message.index >= (scope.summaryCursor || 0));
        const chunks = segmentMessages(eligible, 0, settings.summaryChunkChars);
        if (!chunks.length) return { created: 0, segmentsCreated: 0, scope: this.store.publicScope(scope) };

        this.runningSummaries.add(id);
        let created = 0;
        let segmentsCreated = 0;
        try {
            for (const chunk of chunks) {
                const result = validateExtracted(await this.providers.summarizeSegment(settings.summary, SUMMARY_PROMPT, transcriptFor(chunk)));
                if (!result.segmentSummary && !result.memories.length) throw new Error('总结 API 没有返回可用摘要');
                const prepared = [];
                for (const memory of result.memories) {
                    const embedding = await this.providers.createEmbedding(settings.embedding, memory.content, 'document');
                    prepared.push({ ...memory, embedding });
                }
                const now = new Date().toISOString();
                const sourceIndices = chunk.map(item => item.index);
                scope.segments.push({
                    id: randomUUID(),
                    summary: result.segmentSummary || result.memories.map(item => item.content).join('；'),
                    sourceStart: sourceIndices[0], sourceEnd: sourceIndices.at(-1), sourceIndices, createdAt: now,
                });
                segmentsCreated += 1;
                const existing = new Set(scope.memories.map(memory => normalizeText(memory.content)));
                for (const memory of prepared) {
                    const normalized = normalizeText(memory.content);
                    if (!normalized || existing.has(normalized)) continue;
                    scope.memories.push({
                        id: randomUUID(), ...memory, embeddingModel: settings.embedding.model,
                        sourceStart: sourceIndices[0], sourceEnd: sourceIndices.at(-1), sourceIndices,
                        createdAt: now, updatedAt: now,
                    });
                    existing.add(normalized);
                    created += 1;
                }
                scope.summaryCursor = sourceIndices.at(-1) + 1;
                scope.updatedAt = now;
                scope.recallCache = null;
                await this.store.persist();
            }
            return { created, segmentsCreated, scope: this.store.publicScope(scope) };
        } finally {
            this.runningSummaries.delete(id);
        }
    }

    async recall({ characterKey, chatId, query, visibleMessageIndices = [], turnKey = '' }) {
        const scope = this.store.getScope(characterKey, chatId, false);
        const settings = this.store.getSettings({ includeSecrets: true });
        if (!scope) return { memories: [], text: '', chronologyText: '' };
        const chronology = chronologyText(scope, settings.summaryInjectionMaxChars);
        if (!String(query || '').trim() || !scope.memories.length) return { memories: [], text: '', chronologyText: chronology };
        const cacheKey = hash(`${turnKey}\n${query}\n${scope.updatedAt}`);
        if (scope.recallCache?.key === cacheKey) return scope.recallCache.value;

        let searchQueries = [String(query)];
        let rerankQuery = String(query);
        if (settings.queryRewriteEnabled) {
            try {
                const rewritten = await this.providers.rewriteQuery(settings.summary, REWRITE_PROMPT, String(query));
                const queries = stringArray(rewritten?.queries, 5, 1000);
                if (queries.length) searchQueries = queries;
                if (String(rewritten?.intent || '').trim()) rerankQuery = String(rewritten.intent).trim();
            } catch (error) {
                console.warn('[ST Memory Lite] Query rewrite degraded:', error.message);
            }
        }

        const queryVectors = [];
        for (const item of searchQueries) {
            try { queryVectors.push(await this.providers.createEmbedding(settings.embedding, item, 'query')); }
            catch (error) { console.warn('[ST Memory Lite] Embedding recall degraded to keywords:', error.message); }
        }
        const visible = new Set((visibleMessageIndices || []).map(Number));
        const available = scope.memories.filter(memory => !(memory.sourceIndices || []).some(index => visible.has(index)));
        const queryTokens = tokenize([query, ...searchQueries].join('\n'));
        const signals = querySignals(String(query), available);
        if (scope.lastRecallTurnKey !== turnKey) {
            scope.recallSerial = (Number(scope.recallSerial) || 0) + 1;
            scope.lastRecallTurnKey = turnKey;
        }
        const turn = Number(scope.recallSerial) || 1;
        const direct = [];
        for (const memory of available) {
            const semanticScore = queryVectors.length ? Math.max(...queryVectors.map(vector => cosineSimilarity(vector, memory.embedding))) : -1;
            const keywordScore = overlapScore(queryTokens, tokenize(`${memory.title}\n${memory.content}\n${(memory.tags || []).join(' ')}`));
            const peopleScore = participantScore(signals, memory);
            const emotion = emotionScore(signals, memory);
            const relationship = relationshipScore(signals, memory);
            const admitted = semanticScore >= settings.recallMinScore || keywordScore >= settings.keywordMinScore || (peopleScore > 0 && keywordScore > 0.04);
            if (!admitted) continue;
            const lastTurn = Number(scope.recallHistory[memory.id] || -999);
            const inCooldown = turn - lastTurn <= settings.cooldownTurns;
            const strongHit = semanticScore >= settings.recallMinScore + 0.18 || keywordScore >= settings.keywordMinScore + 0.18;
            const cooldown = inCooldown && !strongHit ? settings.cooldownPenalty : 0;
            const importance = ((memory.importance || 5) - 1) / 9;
            const baseScore = Math.max(0, semanticScore) * 0.58 + keywordScore * 0.28 + peopleScore * 0.08
                + emotion * 0.04 + relationship * 0.02 + importance * settings.importanceWeight - cooldown;
            direct.push({ memory, semanticScore, keywordScore, peopleScore, emotionScore: emotion, relationshipScore: relationship, baseScore, expanded: false });
        }
        direct.sort((a, b) => b.baseScore - a.baseScore);
        const candidates = direct.slice(0, settings.recallCandidateLimit);

        const candidateIds = new Set(candidates.map(item => item.memory.id));
        const seeds = candidates.slice(0, Math.min(4, candidates.length));
        const expanded = [];
        for (const memory of available) {
            if (candidateIds.has(memory.id)) continue;
            let best = null;
            for (const seed of seeds) {
                const relation = relationStrength(seed.memory, memory);
                if (!best || relation > best.relation) best = { seed, relation };
            }
            if (!best || best.relation < settings.relationMinScore) continue;
            const importance = ((memory.importance || 5) - 1) / 9;
            expanded.push({
                memory, semanticScore: -1, keywordScore: 0, peopleScore: 0, emotionScore: 0,
                relationshipScore: best.relation,
                baseScore: best.seed.baseScore * 0.55 + best.relation * 0.35 + importance * settings.importanceWeight,
                expanded: true,
            });
        }
        expanded.sort((a, b) => b.baseScore - a.baseScore);
        candidates.push(...expanded.slice(0, settings.relationExpansionLimit));

        if (settings.rerankerEnabled && candidates.length) {
            try {
                const ranked = await this.providers.rerank(settings.reranker, rerankQuery, candidates.map(item => item.memory.content));
                const scores = new Map(ranked.map(item => [item.index, item.score]));
                const weight = clamp(settings.rerankerWeight, 0, 1);
                for (let index = 0; index < candidates.length; index += 1) {
                    const score = scores.get(index);
                    candidates[index].rerankerScore = score ?? null;
                    candidates[index].finalScore = score == null ? candidates[index].baseScore : candidates[index].baseScore * (1 - weight) + score * weight;
                }
            } catch (error) {
                console.warn('[ST Memory Lite] Reranker degraded:', error.message);
            }
        }
        for (const candidate of candidates) {
            if (!Number.isFinite(candidate.finalScore)) candidate.finalScore = candidate.baseScore;
            if (!Object.hasOwn(candidate, 'rerankerScore')) candidate.rerankerScore = null;
        }
        candidates.sort((a, b) => b.finalScore - a.finalScore);

        const selected = [];
        let usedChars = 0;
        for (const item of candidates) {
            if (selected.length >= settings.recallLimit) break;
            const line = `- ${item.memory.content}`;
            if (selected.length && usedChars + line.length > settings.recallMaxChars) break;
            selected.push(item);
            usedChars += line.length;
        }
        for (const item of selected) scope.recallHistory[item.memory.id] = turn;
        const text = selected.length ? `<recalled_story_memories>\n以下是与当前剧情直接相关或由直接命中记忆有限关联出的既往事实。只在有帮助时自然使用，不要复述或提及本区块。\n${selected.map(item => `- ${item.memory.content}`).join('\n')}\n</recalled_story_memories>` : '';
        const value = {
            memories: selected.map(item => ({
                id: item.memory.id, title: item.memory.title, content: item.memory.content,
                semanticScore: item.semanticScore, keywordScore: item.keywordScore,
                rerankerScore: item.rerankerScore, finalScore: item.finalScore, expanded: item.expanded,
            })),
            text, chronologyText: chronology,
        };
        scope.recallCache = { key: cacheKey, value };
        await this.store.persist();
        return value;
    }

    async updateMemory(scopeId, memoryId, patch) {
        const scope = this.store.data.scopes[scopeId];
        const memory = scope?.memories.find(item => item.id === memoryId);
        if (!memory) throw new Error('记忆不存在');
        const settings = this.store.getSettings({ includeSecrets: true });
        const nextContent = String(patch.content ?? memory.content).trim().slice(0, 6000);
        if (!nextContent) throw new Error('记忆正文不能为空');
        memory.title = String(patch.title ?? memory.title).trim().slice(0, 80) || nextContent.slice(0, 28);
        memory.tags = stringArray(patch.tags ?? memory.tags, 8, 40);
        memory.participants = stringArray(patch.participants ?? memory.participants, 12, 80);
        memory.importance = Math.round(clamp(patch.importance ?? memory.importance ?? 5, 1, 10));
        memory.valence = clamp(patch.valence ?? memory.valence ?? 0, -1, 1);
        memory.arousal = clamp(patch.arousal ?? memory.arousal ?? 0, 0, 1);
        if (nextContent !== memory.content) {
            memory.content = nextContent;
            memory.embedding = await this.providers.createEmbedding(settings.embedding, nextContent, 'document');
            memory.embeddingModel = settings.embedding.model;
        }
        memory.updatedAt = new Date().toISOString();
        scope.updatedAt = memory.updatedAt;
        scope.recallCache = null;
        await this.store.persist();
        return this.store.publicScope(scope);
    }

    async deleteMemory(scopeId, memoryId) {
        const scope = this.store.data.scopes[scopeId];
        if (!scope) throw new Error('聊天窗口不存在');
        const before = scope.memories.length;
        scope.memories = scope.memories.filter(item => item.id !== memoryId);
        if (scope.memories.length === before) throw new Error('记忆不存在');
        delete scope.recallHistory[memoryId];
        scope.recallCache = null;
        scope.updatedAt = new Date().toISOString();
        await this.store.persist();
        return this.store.publicScope(scope);
    }
}

module.exports = {
    MemoryService, REWRITE_PROMPT, SUMMARY_PROMPT, cleanMessages, cosineSimilarity,
    chronologyText, relationStrength, segmentMessages, tokenize, validateExtracted,
};
