function normalizedBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

async function requestJson(url, options, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const text = await response.text();
        let body = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = { raw: text };
        }
        if (!response.ok) {
            const detail = body?.error?.message || body?.message || text || `HTTP ${response.status}`;
            throw new Error(detail);
        }
        return body;
    } finally {
        clearTimeout(timer);
    }
}

function providerHeaders(apiKey) {
    return {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
}

function stripCodeFence(value) {
    const text = String(value || '').trim();
    if (!text.startsWith('```')) return text;
    return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

async function summarizeSegment(config, systemPrompt, transcript) {
    if (!config.baseUrl || !config.model) {
        throw new Error('总结 API 尚未配置');
    }
    const body = await requestJson(`${normalizedBaseUrl(config.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: providerHeaders(config.apiKey),
        body: JSON.stringify({
            model: config.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: transcript },
            ],
            temperature: 0,
            max_tokens: Number(config.maxTokens) || 1800,
        }),
    }, 90000);
    const raw = body?.choices?.[0]?.message?.content;
    if (!raw) return { segment_summary: '', memories: [] };
    const parsed = JSON.parse(stripCodeFence(raw));
    if (!parsed || typeof parsed !== 'object') throw new Error('总结 API 返回的不是 JSON 对象');
    return parsed;
}

async function rewriteQuery(config, systemPrompt, transcript) {
    if (!config.baseUrl || !config.model) return null;
    const body = await requestJson(`${normalizedBaseUrl(config.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: providerHeaders(config.apiKey),
        body: JSON.stringify({
            model: config.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: transcript },
            ],
            temperature: 0,
            max_tokens: 500,
        }),
    }, 60000);
    const raw = body?.choices?.[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(stripCodeFence(raw));
    return parsed && typeof parsed === 'object' ? parsed : null;
}

async function createEmbedding(config, text, kind = 'document') {
    if (!config.baseUrl || !config.model) {
        throw new Error('向量 API 尚未配置');
    }
    const instruction = kind === 'query'
        ? String(config.queryInstruction || '').trim()
        : String(config.documentInstruction || '').trim();
    const prepared = instruction
        ? `Instruct: ${instruction}\n${kind === 'query' ? 'Query' : 'Document'}: ${text}`
        : text;
    const body = await requestJson(`${normalizedBaseUrl(config.baseUrl)}/embeddings`, {
        method: 'POST',
        headers: providerHeaders(config.apiKey),
        body: JSON.stringify({ model: config.model, input: prepared.slice(0, 32000) }),
    });
    const vector = body?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error('向量 API 没有返回 embedding');
    }
    return vector.map(Number);
}

async function rerank(config, query, documents) {
    if (!config.baseUrl || !config.model || documents.length === 0) return [];
    const body = await requestJson(`${normalizedBaseUrl(config.baseUrl)}/rerank`, {
        method: 'POST',
        headers: providerHeaders(config.apiKey),
        body: JSON.stringify({
            model: config.model,
            query,
            documents,
            top_n: documents.length,
            return_documents: false,
        }),
    }, 30000);
    const results = Array.isArray(body?.results) ? body.results : [];
    return results
        .map(item => ({
            index: Number(item.index),
            score: Number(item.relevance_score ?? item.score ?? 0),
        }))
        .filter(item => Number.isInteger(item.index) && item.index >= 0 && item.index < documents.length)
        .sort((a, b) => b.score - a.score);
}

module.exports = {
    createEmbedding,
    normalizedBaseUrl,
    rerank,
    requestJson,
    rewriteQuery,
    stripCodeFence,
    summarizeSegment,
};
