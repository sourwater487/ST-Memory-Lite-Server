const API = '/api/plugins/st-memory-lite';
const app = document.querySelector('#app');
const dialog = document.querySelector('#settings-dialog');
const settingsForm = document.querySelector('#settings-form');
const backButton = document.querySelector('#back-button');
const saveState = document.querySelector('#save-state');
const toast = document.querySelector('#toast');

let csrfToken = '';
let scopes = [];
let currentScope = null;
let currentCharacterKey = null;
let settings = null;
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('st-memory-lite') : null;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
}

async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
            ...(options.headers || {}),
        },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
}

function notify(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => { toast.hidden = true; }, 2400);
}

function setBusy(message = '') {
    saveState.textContent = message;
}

function characterGroups() {
    const groups = new Map();
    for (const scope of scopes) {
        const existing = groups.get(scope.characterKey) || {
            key: scope.characterKey,
            name: scope.characterName,
            scopes: [],
            memoryCount: 0,
        };
        existing.scopes.push(scope);
        existing.memoryCount += scope.memoryCount;
        groups.set(scope.characterKey, existing);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function setRoute(route) {
    history.pushState(route, '', route.url || location.pathname + location.search);
    renderRoute(route);
}

function homeRoute() {
    return { page: 'home', url: location.pathname };
}

function renderHome() {
    currentScope = null;
    currentCharacterKey = null;
    backButton.hidden = true;
    const characters = characterGroups();
    app.innerHTML = `
        <div class="page-head">
            <div class="eyebrow">严格按角色与聊天窗口隔离</div>
            <h1>角色</h1>
            <div class="subtitle">${characters.length} 个角色 · ${scopes.reduce((sum, item) => sum + item.memoryCount, 0)} 条记忆</div>
        </div>
        <div class="list">
            ${characters.length ? characters.map(character => `
                <button class="row-card" data-character="${escapeHtml(character.key)}" type="button">
                    <div>
                        <div class="row-title">${escapeHtml(character.name)}</div>
                        <div class="row-meta">${character.scopes.length} 个聊天窗口 · ${character.memoryCount} 条记忆</div>
                    </div>
                    <span class="row-arrow">›</span>
                </button>
            `).join('') : '<div class="empty">还没有同步过聊天。先从 ST 扩展面板打开一次控制台。</div>'}
        </div>`;
    app.querySelectorAll('[data-character]').forEach(button => {
        button.addEventListener('click', () => setRoute({
            page: 'character',
            characterKey: button.dataset.character,
            url: `${location.pathname}#character=${encodeURIComponent(button.dataset.character)}`,
        }));
    });
}

function renderCharacter(characterKey) {
    currentScope = null;
    currentCharacterKey = characterKey;
    backButton.hidden = false;
    const character = characterGroups().find(item => item.key === characterKey);
    if (!character) return renderHome();
    app.innerHTML = `
        <div class="page-head">
            <div class="eyebrow">角色</div>
            <h1>${escapeHtml(character.name)}</h1>
            <div class="subtitle">选择一个独立剧情窗口</div>
        </div>
        <div class="list">
            ${character.scopes.map(scope => `
                <button class="row-card" data-scope="${escapeHtml(scope.id)}" type="button">
                    <div>
                        <div class="row-title">${escapeHtml(scope.chatId)}</div>
                        <div class="row-meta">${scope.memoryCount} 条记忆 · ${scope.pendingMessages} 条待总结</div>
                    </div>
                    <span class="row-arrow">›</span>
                </button>
            `).join('')}
        </div>`;
    app.querySelectorAll('[data-scope]').forEach(button => {
        button.addEventListener('click', () => openScope(button.dataset.scope));
    });
}

async function openScope(scopeId, replace = false) {
    try {
        setBusy('读取中…');
        const body = await api(`/scopes/${encodeURIComponent(scopeId)}`);
        currentScope = body.scope;
        currentCharacterKey = currentScope.characterKey;
        const route = {
            page: 'scope', scopeId,
            url: `${location.pathname}#scope=${encodeURIComponent(scopeId)}`,
        };
        if (replace) history.replaceState(route, '', route.url);
        else history.pushState(route, '', route.url);
        renderScope();
    } catch (error) {
        notify(error.message);
    } finally {
        setBusy('');
    }
}

function renderScope() {
    if (!currentScope) return renderHome();
    backButton.hidden = false;
    app.innerHTML = `
        <div class="page-head">
            <div class="eyebrow">${escapeHtml(currentScope.characterName)}</div>
            <h1>${escapeHtml(currentScope.chatId)}</h1>
            <div class="subtitle">这个窗口的记忆不会与其他剧情互通。</div>
        </div>
        <div class="toolbar">
            <span class="meta">${currentScope.segmentCount} 段摘要 · ${currentScope.memoryCount} 条记忆 · ${currentScope.pendingMessages} 层待总结</span>
            <button id="summarize-button" class="primary-button" type="button" ${currentScope.pendingMessages ? '' : 'disabled'}>总结未处理内容</button>
        </div>
        <div class="memory-list">
            ${currentScope.memories.length ? currentScope.memories.map(memory => `
                <article class="memory-card" data-memory="${escapeHtml(memory.id)}">
                    <input class="memory-title" value="${escapeHtml(memory.title)}" aria-label="记忆标题">
                    <textarea class="memory-content" aria-label="记忆正文">${escapeHtml(memory.content)}</textarea>
                    <div class="memory-fields">
                        <label>人物<input class="memory-participants" value="${escapeHtml((memory.participants || []).join('、'))}" placeholder="用、分隔"></label>
                        <label>标签<input class="memory-tags" value="${escapeHtml((memory.tags || []).join('、'))}" placeholder="用、分隔"></label>
                        <label>重要性<input class="memory-importance" type="number" min="1" max="10" value="${escapeHtml(memory.importance ?? 5)}"></label>
                        <label>情绪效价<input class="memory-valence" type="number" min="-1" max="1" step="0.1" value="${escapeHtml(memory.valence ?? 0)}"></label>
                        <label>唤醒度<input class="memory-arousal" type="number" min="0" max="1" step="0.1" value="${escapeHtml(memory.arousal ?? 0)}"></label>
                    </div>
                    <div class="memory-source">来源消息 ${memory.sourceStart + 1}–${memory.sourceEnd + 1}</div>
                    <div class="memory-actions">
                        <button class="danger-button delete-memory" type="button">删除</button>
                        <button class="secondary-button save-memory" type="button">保存</button>
                    </div>
                </article>
            `).join('') : '<div class="empty">这里还没有记忆。点击上方按钮整理当前未处理的对话。</div>'}
        </div>`;

    document.querySelector('#summarize-button')?.addEventListener('click', summarizeCurrent);
    app.querySelectorAll('.save-memory').forEach(button => button.addEventListener('click', saveMemory));
    app.querySelectorAll('.delete-memory').forEach(button => button.addEventListener('click', deleteMemory));
}

async function summarizeCurrent(event) {
    event.currentTarget.disabled = true;
    try {
        setBusy('正在总结…');
        const body = await api(`/scopes/${encodeURIComponent(currentScope.id)}/summarize`, { method: 'POST', body: '{}' });
        currentScope = body.scope;
        await reloadScopes();
        renderScope();
        channel?.postMessage({ type: 'summary-complete', characterKey: currentScope.characterKey, chatId: currentScope.chatId });
        notify(`完成 ${body.segmentsCreated || 0} 段摘要，新增 ${body.created || 0} 条记忆；旧楼层将在 ST 中隐藏`);
    } catch (error) {
        notify(error.message);
        event.currentTarget.disabled = false;
    } finally {
        setBusy('');
    }
}

async function saveMemory(event) {
    const card = event.currentTarget.closest('[data-memory]');
    event.currentTarget.disabled = true;
    try {
        setBusy('保存中…');
        const body = await api(`/scopes/${encodeURIComponent(currentScope.id)}/memories/${encodeURIComponent(card.dataset.memory)}`, {
            method: 'PUT',
            body: JSON.stringify({
                title: card.querySelector('.memory-title').value,
                content: card.querySelector('.memory-content').value,
                participants: card.querySelector('.memory-participants').value.split(/[、,，]/).map(item => item.trim()).filter(Boolean),
                tags: card.querySelector('.memory-tags').value.split(/[、,，]/).map(item => item.trim()).filter(Boolean),
                importance: Number(card.querySelector('.memory-importance').value),
                valence: Number(card.querySelector('.memory-valence').value),
                arousal: Number(card.querySelector('.memory-arousal').value),
            }),
        });
        currentScope = body.scope;
        renderScope();
        notify('已保存');
    } catch (error) {
        notify(error.message);
        event.currentTarget.disabled = false;
    } finally {
        setBusy('');
    }
}

async function deleteMemory(event) {
    const card = event.currentTarget.closest('[data-memory]');
    if (!confirm('删除这条记忆？')) return;
    try {
        setBusy('删除中…');
        const body = await api(`/scopes/${encodeURIComponent(currentScope.id)}/memories/${encodeURIComponent(card.dataset.memory)}`, { method: 'DELETE' });
        currentScope = body.scope;
        await reloadScopes();
        renderScope();
        notify('已删除');
    } catch (error) {
        notify(error.message);
    } finally {
        setBusy('');
    }
}

function field(name) {
    return settingsForm.elements.namedItem(name);
}

function fillSettings() {
    const values = {
        'summary.baseUrl': settings.summary.baseUrl,
        'summary.model': settings.summary.model,
        'embedding.baseUrl': settings.embedding.baseUrl,
        'embedding.model': settings.embedding.model,
        'reranker.baseUrl': settings.reranker.baseUrl,
        'reranker.model': settings.reranker.model,
        autoSummaryMessages: settings.autoSummaryMessages,
        summaryChunkChars: settings.summaryChunkChars,
        summaryInjectionMaxChars: settings.summaryInjectionMaxChars,
        recallCandidateLimit: settings.recallCandidateLimit,
        recallLimit: settings.recallLimit,
        recallMinScore: settings.recallMinScore,
        keywordMinScore: settings.keywordMinScore,
        recallMaxChars: settings.recallMaxChars,
        relationExpansionLimit: settings.relationExpansionLimit,
        relationMinScore: settings.relationMinScore,
        cooldownTurns: settings.cooldownTurns,
        cooldownPenalty: settings.cooldownPenalty,
        importanceWeight: settings.importanceWeight,
    };
    for (const [name, value] of Object.entries(values)) field(name).value = value ?? '';
    field('autoSummary').checked = settings.autoSummary;
    field('queryRewriteEnabled').checked = settings.queryRewriteEnabled;
    field('rerankerEnabled').checked = settings.rerankerEnabled;
    for (const name of ['summary.apiKey', 'embedding.apiKey', 'reranker.apiKey']) field(name).value = '';
}

async function openSettings() {
    try {
        const body = await api('/settings');
        settings = body.settings;
        fillSettings();
        dialog.showModal();
    } catch (error) {
        notify(error.message);
    }
}

settingsForm.addEventListener('submit', async event => {
    event.preventDefault();
    const provider = name => ({
        baseUrl: field(`${name}.baseUrl`).value.trim(),
        model: field(`${name}.model`).value.trim(),
        apiKey: field(`${name}.apiKey`).value.trim(),
    });
    const payload = {
        summary: { ...provider('summary'), maxTokens: settings.summary.maxTokens },
        embedding: {
            ...provider('embedding'),
            queryInstruction: settings.embedding.queryInstruction,
            documentInstruction: settings.embedding.documentInstruction,
        },
        reranker: provider('reranker'),
        autoSummary: field('autoSummary').checked,
        queryRewriteEnabled: field('queryRewriteEnabled').checked,
        rerankerEnabled: field('rerankerEnabled').checked,
        rerankerWeight: settings.rerankerWeight,
        autoSummaryMessages: Number(field('autoSummaryMessages').value),
        summaryChunkChars: Number(field('summaryChunkChars').value),
        summaryInjectionMaxChars: Number(field('summaryInjectionMaxChars').value),
        recallCandidateLimit: Number(field('recallCandidateLimit').value),
        recallLimit: Number(field('recallLimit').value),
        recallMinScore: Number(field('recallMinScore').value),
        keywordMinScore: Number(field('keywordMinScore').value),
        recallMaxChars: Number(field('recallMaxChars').value),
        relationExpansionLimit: Number(field('relationExpansionLimit').value),
        relationMinScore: Number(field('relationMinScore').value),
        cooldownTurns: Number(field('cooldownTurns').value),
        cooldownPenalty: Number(field('cooldownPenalty').value),
        importanceWeight: Number(field('importanceWeight').value),
    };
    try {
        setBusy('保存中…');
        const body = await api('/settings', { method: 'POST', body: JSON.stringify(payload) });
        settings = body.settings;
        dialog.close();
        notify('设置已保存');
    } catch (error) {
        notify(error.message);
    } finally {
        setBusy('');
    }
});

function renderRoute(route) {
    if (route?.page === 'scope' && route.scopeId) return openScope(route.scopeId, true);
    if (route?.page === 'character' && route.characterKey) return renderCharacter(route.characterKey);
    renderHome();
}

async function reloadScopes() {
    const body = await api('/scopes');
    scopes = body.scopes;
}

backButton.addEventListener('click', () => {
    if (currentScope) {
        setRoute({ page: 'character', characterKey: currentScope.characterKey, url: `${location.pathname}#character=${encodeURIComponent(currentScope.characterKey)}` });
    } else {
        setRoute(homeRoute());
    }
});
document.querySelector('#home-button').addEventListener('click', () => setRoute(homeRoute()));
document.querySelector('#settings-button').addEventListener('click', openSettings);
document.querySelector('#close-settings').addEventListener('click', () => dialog.close());
window.addEventListener('popstate', event => renderRoute(event.state || homeRoute()));

async function boot() {
    try {
        const tokenResponse = await fetch('/csrf-token', { credentials: 'same-origin' });
        csrfToken = (await tokenResponse.json()).token || '';
        await reloadScopes();

        const requestedScope = new URLSearchParams(location.search).get('scope');
        if (requestedScope && scopes.some(item => item.id === requestedScope)) {
            return openScope(requestedScope, true);
        }
        const hash = location.hash.slice(1);
        if (hash.startsWith('scope=')) return openScope(decodeURIComponent(hash.slice(6)), true);
        if (hash.startsWith('character=')) {
            const characterKey = decodeURIComponent(hash.slice(10));
            history.replaceState({ page: 'character', characterKey }, '', location.href);
            return renderCharacter(characterKey);
        }
        history.replaceState(homeRoute(), '', location.pathname);
        renderHome();
    } catch (error) {
        app.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    }
}

boot();
