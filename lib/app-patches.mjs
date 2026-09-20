export const RP_HUB_APP_PATH = 'assets/js/app.js';
export const RP_HUB_APP_PATCH_REVISION = 'r2-character-split-e2b-v3';

export const APP_PATCH_MODES = Object.freeze({
    characterSave: Object.freeze({
        source: String.raw`(?:await\s+)?setStoredValue\(\s*'characters'\s*,\s*([A-Za-z0-9_.$]+(?:\.value)?|[A-Za-z0-9_.$]+\(\s*[A-Za-z0-9_.$]+(?:\.value)?\s*\))\s*(?:,\s*\{[^{}]*\})?\s*\)`,
        flags: 'g'
    }),
    characterLoad: Object.freeze({
        source: String.raw`await\s+getStoredValue\(\s*'characters'\s*\)`,
        flags: 'g'
    }),
    persistenceBridge: Object.freeze({
        source: String.raw`^([ \t]*)const manualSave = \(\) => \{\r?\n\1    saveData\(\);\r?\n\1    showToast\('设置已保存', 'success'\);\r?\n\1\};$`,
        flags: 'gm',
        modernAnchor: Object.freeze({
            source: String.raw`^([ \t]*)const saveConversationMutationNow = async`,
            flags: 'gm'
        }),
        dbSetToGate: Object.freeze({
            source: String.raw`^([ \t]*)const dbSetTo = \(targetDb, key, value, options = \{\}\) => \{$`,
            flags: 'gm'
        }),
        dbDeleteFromGate: Object.freeze({
            source: String.raw`^([ \t]*)const dbDeleteFrom = \(targetDb, key\) => \{$`,
            flags: 'gm'
        })
    })
});

const EXECUTABLE_CHARACTER_SAVE = 'await window.RPHubCharStore.saveAll(';
const EXECUTABLE_CHARACTER_LOAD = 'await window.RPHubCharStore.loadAll()';
const EXECUTABLE_PERSISTENCE_BRIDGE = 'globalThis.RPH_R2_FLUSH_PERSISTENCE = flushPersistenceForRpSync;';
const DB_SET_TO_DEFER_MARKER = 'return deferWrite(() => dbSetTo(targetDb, key, deferredValue, { clone: false }));';
const DB_DELETE_FROM_DEFER_MARKER = 'return deferWrite(() => dbDeleteFrom(targetDb, key));';
const DB_SET_TO_SECTION_START = '        const dbSetTo =';
const EXTERNALIZED_STORAGE_SIGNATURE = '} = window.RPHubStorage;';
const EXISTING_PATCH_MARKER_PATTERN = new RegExp([
    'RPH_R2_FLUSH_PERSISTENCE',
    DB_SET_TO_DEFER_MARKER,
    DB_DELETE_FROM_DEFER_MARKER
].map(escapeRegExpText).join('|'), 'g');
const CHARACTER_STORAGE_PATTERN = new RegExp(
    `(?:${APP_PATCH_MODES.characterSave.source})|(${APP_PATCH_MODES.characterLoad.source})`,
    'g'
);
const RESIDUAL_CHARACTER_STORAGE = /(?:\b(setStoredValue)\(\s*['"]characters['"]\s*,)|(?:\b(getStoredValue)\(\s*['"]characters['"]\s*\))/g;
const CODE_EVENT = /['"`/]/g;
const TEMPLATE_EXPRESSION_EVENT = /['"`/{}]/g;

export class RpHubAppPatchError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'RpHubAppPatchError';
        this.code = 'RP_HUB_APP_PATCH_REJECTED';
        this.details = details;
    }
}

function createPattern(mode) {
    return new RegExp(mode.source, mode.flags);
}

function escapeRegExpText(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countMatches(text, pattern) {
    const expression = new RegExp(pattern.source, pattern.flags);
    const value = String(text);
    if (!expression.global) return expression.test(value) ? 1 : 0;
    let count = 0;
    let match;
    while ((match = expression.exec(value)) !== null) {
        count += 1;
        if (match[0] === '') expression.lastIndex += 1;
    }
    return count;
}

function countSubstring(text, needle) {
    let count = 0;
    let offset = 0;
    while ((offset = text.indexOf(needle, offset)) !== -1) {
        count += 1;
        offset += needle.length;
    }
    return count;
}

function isExternalizedStorageMode(text) {
    return countSubstring(text, DB_SET_TO_SECTION_START) === 0
        && countSubstring(text, EXTERNALIZED_STORAGE_SIGNATURE) === 1;
}

function countExistingPatchMarkers(text) {
    const counts = { flushBridge: 0, dbSetTo: 0, dbDeleteFrom: 0 };
    EXISTING_PATCH_MARKER_PATTERN.lastIndex = 0;
    let match;
    while ((match = EXISTING_PATCH_MARKER_PATTERN.exec(text)) !== null) {
        if (match[0] === 'RPH_R2_FLUSH_PERSISTENCE') counts.flushBridge += 1;
        else if (match[0] === DB_SET_TO_DEFER_MARKER) counts.dbSetTo += 1;
        else counts.dbDeleteFrom += 1;
    }
    return counts;
}

function collectCharacterHookTargets(text) {
    const targets = [];
    let saveOffset = text.indexOf(EXECUTABLE_CHARACTER_SAVE);
    let loadOffset = text.indexOf(EXECUTABLE_CHARACTER_LOAD);
    let bridgeOffset = text.indexOf(EXECUTABLE_PERSISTENCE_BRIDGE);
    while (saveOffset !== -1 || loadOffset !== -1 || bridgeOffset !== -1) {
        if (saveOffset !== -1
            && (loadOffset === -1 || saveOffset < loadOffset)
            && (bridgeOffset === -1 || saveOffset < bridgeOffset)) {
            targets.push({ offset: saveOffset, type: 'save', length: EXECUTABLE_CHARACTER_SAVE.length });
            saveOffset = text.indexOf(EXECUTABLE_CHARACTER_SAVE, saveOffset + EXECUTABLE_CHARACTER_SAVE.length);
        } else if (loadOffset !== -1 && (bridgeOffset === -1 || loadOffset < bridgeOffset)) {
            targets.push({ offset: loadOffset, type: 'load', length: EXECUTABLE_CHARACTER_LOAD.length });
            loadOffset = text.indexOf(EXECUTABLE_CHARACTER_LOAD, loadOffset + EXECUTABLE_CHARACTER_LOAD.length);
        } else {
            targets.push({ offset: bridgeOffset, type: 'bridge', length: EXECUTABLE_PERSISTENCE_BRIDGE.length });
            bridgeOffset = text.indexOf(EXECUTABLE_PERSISTENCE_BRIDGE, bridgeOffset + EXECUTABLE_PERSISTENCE_BRIDGE.length);
        }
    }
    return targets;
}

function countExecutableCharacterHooks(source) {
    const text = String(source || '');
    const targets = collectCharacterHookTargets(text);
    if (targets.length === 0) return { characterSave: 0, characterLoad: 0, persistenceBridge: 0 };

    const regexPrefixCharacters = '([{:;,=!&|?+-*%^~<>';
    const regexPrefixWords = new Set(['return', 'case', 'throw', 'else', 'do', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await']);
    const templateExpressionDepths = [];
    let inTemplate = false;
    let targetIndex = 0;
    let index = 0;
    let characterSave = 0;
    let characterLoad = 0;
    let persistenceBridge = 0;

    const isWhitespace = (code) => code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
    const isIdentifier = (code) => (code >= 48 && code <= 57)
        || (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || code === 36 || code === 95;
    const isRegexStart = (offset) => {
        let cursor = offset - 1;
        while (cursor >= 0 && isWhitespace(text.charCodeAt(cursor))) cursor -= 1;
        if (cursor < 0 || regexPrefixCharacters.includes(text[cursor])) return true;
        if (!isIdentifier(text.charCodeAt(cursor))) return false;
        const end = cursor + 1;
        while (cursor >= 0 && isIdentifier(text.charCodeAt(cursor))) cursor -= 1;
        return regexPrefixWords.has(text.slice(cursor + 1, end));
    };
    const isEscapedAt = (offset) => {
        let slashes = 0;
        for (let cursor = offset - 1; cursor >= 0 && text.charCodeAt(cursor) === 92; cursor -= 1) slashes += 1;
        return (slashes & 1) === 1;
    };
    const skipTargetsBefore = (end) => {
        while (targetIndex < targets.length && targets[targetIndex].offset < end) targetIndex += 1;
    };
    const skipQuoted = (start, quote) => {
        let cursor = start + 1;
        while ((cursor = text.indexOf(quote, cursor)) !== -1) {
            if (!isEscapedAt(cursor)) return cursor + 1;
            cursor += 1;
        }
        return text.length;
    };
    const skipRegex = (start) => {
        let cursor = start + 1;
        let escaped = false;
        let characterClass = false;
        for (; cursor < text.length; cursor += 1) {
            const code = text.charCodeAt(cursor);
            if (escaped) {
                escaped = false;
            } else if (code === 92) {
                escaped = true;
            } else if (code === 91) {
                characterClass = true;
            } else if (code === 93) {
                characterClass = false;
            } else if (code === 47 && !characterClass) {
                cursor += 1;
                while (cursor < text.length && isIdentifier(text.charCodeAt(cursor))) cursor += 1;
                return cursor;
            }
        }
        return text.length;
    };
    const nextTemplateEvent = (start) => {
        let cursor = start;
        while (cursor < text.length) {
            const close = text.indexOf('`', cursor);
            const expression = text.indexOf('${', cursor);
            if (close === -1 && expression === -1) return null;
            const offset = close === -1 ? expression : expression === -1 ? close : Math.min(close, expression);
            if (!isEscapedAt(offset)) return { offset, expression: offset === expression };
            cursor = offset + 1;
        }
        return null;
    };

    while (targetIndex < targets.length) {
        if (inTemplate) {
            const event = nextTemplateEvent(index);
            if (!event) break;
            if (event.expression) {
                skipTargetsBefore(event.offset + 2);
                templateExpressionDepths.push(1);
                index = event.offset + 2;
                inTemplate = false;
            } else {
                skipTargetsBefore(event.offset + 1);
                index = event.offset + 1;
                inTemplate = false;
            }
            continue;
        }

        const expression = templateExpressionDepths.length > 0 ? TEMPLATE_EXPRESSION_EVENT : CODE_EVENT;
        expression.lastIndex = index;
        const event = expression.exec(text);
        const eventOffset = event ? event.index : text.length;
        const target = targets[targetIndex];
        if (target.offset < eventOffset) {
            if (target.type === 'save') characterSave += 1;
            else if (target.type === 'load') characterLoad += 1;
            else persistenceBridge += 1;
            targetIndex += 1;
            index = target.offset + target.length;
            continue;
        }

        const code = text.charCodeAt(eventOffset);
        const nextCode = text.charCodeAt(eventOffset + 1);
        if (code === 39 || code === 34) {
            index = skipQuoted(eventOffset, text[eventOffset]);
            skipTargetsBefore(index);
        } else if (code === 96) {
            index = eventOffset + 1;
            inTemplate = true;
        } else if (code === 47 && nextCode === 47) {
            const lf = text.indexOf('\n', eventOffset + 2);
            const cr = text.indexOf('\r', eventOffset + 2);
            index = lf === -1 ? (cr === -1 ? text.length : cr) : (cr === -1 ? lf : Math.min(lf, cr));
            skipTargetsBefore(index);
        } else if (code === 47 && nextCode === 42) {
            const close = text.indexOf('*/', eventOffset + 2);
            index = close === -1 ? text.length : close + 2;
            skipTargetsBefore(index);
        } else if (code === 47 && isRegexStart(eventOffset)) {
            index = skipRegex(eventOffset);
            skipTargetsBefore(index);
        } else if (code === 123 && templateExpressionDepths.length > 0) {
            templateExpressionDepths[templateExpressionDepths.length - 1] += 1;
            index = eventOffset + 1;
        } else if (code === 125 && templateExpressionDepths.length > 0) {
            const last = templateExpressionDepths.length - 1;
            templateExpressionDepths[last] -= 1;
            index = eventOffset + 1;
            if (templateExpressionDepths[last] === 0) {
                templateExpressionDepths.pop();
                inTemplate = true;
            }
        } else {
            index = eventOffset + 1;
        }
    }
    return { characterSave, characterLoad, persistenceBridge };
}

function buildPersistenceBridge(indent, eol) {
    const inner = `${indent}    `;
    return [
        `${indent}const flushPersistenceForRpSync = async () => {`,
        `${inner}if (!_initComplete) throw new Error('RP-Hub 数据仍在初始化，请稍后再同步或切换版本');`,
        `${inner}if (isConversationBusy?.value) throw new Error('对话仍在生成，请等待生成结束后再同步或切换版本');`,
        `${inner}const saved = await saveData();`,
        `${inner}const chatSaved = await flushPendingChatHistorySave();`,
        `${inner}if (saved === false) throw new Error('RP-Hub 数据保存失败，已取消同步或版本切换');`,
        `${inner}if (chatSaved === false) throw new Error('聊天记录保存失败，已取消同步或版本切换');`,
        `${inner}return true;`,
        `${indent}};`,
        `${indent}globalThis.RPH_R2_FLUSH_PERSISTENCE = flushPersistenceForRpSync;`
    ].join(eol);
}

function buildPullRestoreWriteGate(kind, indent, eol) {
    const inner = `${indent}    `;
    const operation = kind === 'set'
        ? `${inner}    ${DB_SET_TO_DEFER_MARKER}`
        : `${inner}    ${DB_DELETE_FROM_DEFER_MARKER}`;
    const lines = [
        `${inner}if (globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true) {`,
        `${inner}    const deferWrite = globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE;`,
        `${inner}    if (typeof deferWrite !== 'function') {`,
        `${inner}        return Promise.reject(new Error('RP Sync 恢复写入队列不可用，已停止持久化。'));`,
        `${inner}    }`
    ];
    if (kind === 'set') {
        lines.push(`${inner}    const deferredValue = options.clone === false ? value : cloneForStorage(value);`);
    }
    lines.push(operation, `${inner}}`);
    return lines.join(eol);
}

function rejectionMessage(version) {
    const label = String(version || '').trim() || '目标版本';
    return `上游 ${label} 改动了角色卡存储接口，需人工适配后再更新。`;
}

function rejectPatch(version, stage, details) {
    throw new RpHubAppPatchError(rejectionMessage(version), {
        stage,
        version: String(version || ''),
        ...details
    });
}

function sectionBetween(source, startText, endText, version, label, stage = 'persistence-return-semantics') {
    const start = source.indexOf(startText);
    const secondStart = source.indexOf(startText, start + startText.length);
    if (start < 0 || secondStart >= 0) {
        rejectPatch(version, stage, { label, reason: 'section-start', matches: start < 0 ? 0 : 2 });
    }
    const end = source.indexOf(endText, start + startText.length);
    if (end < 0) {
        rejectPatch(version, stage, { label, reason: 'section-end' });
    }
    return { start, end, text: source.slice(start, end) };
}

function replaceOnce(text, pattern, replacement, version, label, stage = 'persistence-return-semantics') {
    const matches = countMatches(text, pattern);
    if (matches !== 1) {
        rejectPatch(version, stage, { label, matches });
    }
    return text.replace(pattern, replacement);
}

function applyPullRestoreWriteGates(source, version) {
    if (!source.includes(DB_SET_TO_SECTION_START)) {
        if (!isExternalizedStorageMode(source)) {
            rejectPatch(version, 'pull-restore-write-gates', {
                label: 'dbSetTo-pull-restore-section',
                reason: 'section-start',
                matches: 0
            });
        }
        return {
            edits: [],
            report: { dbSetTo: 0, dbDeleteFrom: 0 },
            invariants: { dbSetTo: 0, dbDeleteFrom: 0 },
            storageExternalized: true
        };
    }

    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const mode = APP_PATCH_MODES.persistenceBridge;
    const setSection = sectionBetween(
        source,
        '        const dbSetTo =',
        '        const dbSet = async',
        version,
        'dbSetTo-pull-restore-section',
        'pull-restore-write-gates'
    );
    const setCode = replaceOnce(
        setSection.text,
        createPattern(mode.dbSetToGate),
        (anchor, indent) => `${anchor}${eol}${buildPullRestoreWriteGate('set', indent, eol)}`,
        version,
        'dbSetTo-pull-restore-gate',
        'pull-restore-write-gates'
    );
    const deleteSection = sectionBetween(
        source,
        '        const dbDeleteFrom =',
        '        const dbDelete =',
        version,
        'dbDeleteFrom-pull-restore-section',
        'pull-restore-write-gates'
    );
    const deleteCode = replaceOnce(
        deleteSection.text,
        createPattern(mode.dbDeleteFromGate),
        (anchor, indent) => `${anchor}${eol}${buildPullRestoreWriteGate('delete', indent, eol)}`,
        version,
        'dbDeleteFrom-pull-restore-gate',
        'pull-restore-write-gates'
    );
    return {
        edits: [
            { ...setSection, replacement: setCode },
            { ...deleteSection, replacement: deleteCode }
        ],
        report: { dbSetTo: 1, dbDeleteFrom: 1 },
        invariants: {
            dbSetTo: verifyPullRestoreWriteGateSection(setCode, DB_SET_TO_DEFER_MARKER),
            dbDeleteFrom: verifyPullRestoreWriteGateSection(deleteCode, DB_DELETE_FROM_DEFER_MARKER)
        },
        storageExternalized: false
    };
}

function applySectionEdits(source, edits) {
    const ordered = [...edits].sort((left, right) => left.start - right.start);
    const parts = [];
    let cursor = 0;
    for (const edit of ordered) {
        parts.push(source.slice(cursor, edit.start), edit.replacement);
        cursor = edit.end;
    }
    parts.push(source.slice(cursor));
    return parts.join('');
}

function hardenPersistenceReturnSemantics(source, version, initialEdits = []) {
    const edits = [...initialEdits];
    let chatSave = 0;
    let flush = 0;
    let saveData = 0;

    const chatSection = sectionBetween(
        source,
        '        const saveChatHistoryNow',
        '        const scheduleChatHistorySave',
        version,
        'saveChatHistoryNow'
    );
    let chatCode = chatSection.text;
    if (chatCode.includes('const saveChatHistoryNow = async () => {')) {
        chatCode = replaceOnce(
            chatCode,
            /if \(currentCharacterIndex\.value < 0 \|\| !currentCharacter\.value \|\| !currentCharacter\.value\.uuid\) return;/g,
            'if (currentCharacterIndex.value < 0 || !currentCharacter.value || !currentCharacter.value.uuid) return true;',
            version,
            'legacy-chat-empty-return'
        );
        chatCode = replaceOnce(
            chatCode,
            /(await setScopedStoredValue\('chat', currentCharacter\.value\.uuid, historyToSave, \{ clone: false \}\);)(\r?\n)([ \t]*)\} catch \(e\) \{/g,
            (_match, write, eol, indent) => `${write}${eol}${indent}return true;${eol}${indent}} catch (e) {`,
            version,
            'legacy-chat-success-return'
        );
        chatCode = replaceOnce(
            chatCode,
            /(console\.error\('Failed to save chat history:', e\);)(\r?\n)([ \t]*)\}/g,
            (_match, log, eol, indent) => `${log}${eol}${indent}return false;${eol}${indent}}`,
            version,
            'legacy-chat-failure-return'
        );
        chatSave = 1;
        edits.push({ ...chatSection, replacement: chatCode });
    } else if (!chatCode.includes('return true;') || !chatCode.includes('return false;')) {
        rejectPatch(version, 'persistence-return-semantics', { label: 'modern-chat-return-contract' });
    }

    const flushSection = sectionBetween(
        source,
        '        const flushPendingChatHistorySave',
        '        const saveMemorySettingsNow',
        version,
        'flushPendingChatHistorySave'
    );
    const eol = flushSection.text.includes('\r\n') ? '\r\n' : '\n';
    const hasQueue = flushSection.text.includes('chatHistorySaveQueue');
    const flushCode = hasQueue
        ? [
            '        const flushPendingChatHistorySave = async () => {',
            '            if (chatHistorySaveTimer) {',
            '                return await saveChatHistoryNow();',
            '            }',
            '            return await chatHistorySaveQueue;',
            '        };',
            '',
            ''
        ].join(eol)
        : [
            '        const flushPendingChatHistorySave = async () => {',
            '            if (!chatHistorySaveTimer) return true;',
            '            return await saveChatHistoryNow();',
            '        };',
            '',
            ''
        ].join(eol);
    edits.push({ ...flushSection, replacement: flushCode });
    flush = 1;

    const saveSection = sectionBetween(
        source,
        '        const saveData = async',
        '        const saveConversationMutationNow',
        version,
        'saveData'
    );
    let saveCode = saveSection.text;
    saveCode = replaceOnce(
        saveCode,
        /(await setStoredValue\('last_active_char', currentCharacterIndex\.value\);)(\r?\n)([ \t]*)await saveChatHistoryNow\(\);/g,
        (_match, lastActive, lineEnding, indent) => [
            lastActive,
            `${indent}const chatSaved = await saveChatHistoryNow();`,
            `${indent}if (chatSaved === false) throw new Error('聊天记录未能完成持久化');`
        ].join(lineEnding),
        version,
        'save-data-chat-result'
    );
    saveCode = replaceOnce(
        saveCode,
        /^([ \t]*)\} catch \(e\) \{(\r?\n)([ \t]*console\.error\('Save failed:', e\);)/gm,
        (_match, indent, lineEnding, log) => `${indent}    return true;${lineEnding}${indent}} catch (e) {${lineEnding}${log}`,
        version,
        'save-data-success-return'
    );
    saveCode = replaceOnce(
        saveCode,
        /(console\.error\('Save failed:', e\);[\s\S]*?showToast\('存储空间不足，无法保存', 'error'\);\r?\n([ \t]*)\})(\r?\n)([ \t]*)\}/g,
        (_match, catchBody, _ifIndent, lineEnding, catchIndent) => `${catchBody}${lineEnding}${catchIndent}    return false;${lineEnding}${catchIndent}}`,
        version,
        'save-data-failure-return'
    );
    saveData = 1;
    edits.push({ ...saveSection, replacement: saveCode });

    return {
        code: applySectionEdits(source, edits),
        report: { chatSave, flush, saveData },
        invariants: {
            persistenceReturnSemantics: verifyPersistenceReturnSemanticSections(saveCode, flushCode)
        }
    };
}

function verifyPersistenceReturnSemanticSections(saveSection, flushSection) {
    const chatGuard = /const chatSaved = await saveChatHistoryNow\(\);\s*if \(chatSaved === false\) throw new Error\('聊天记录未能完成持久化'\);/.test(saveSection);
    const saveSuccess = /return true;\s*\} catch \(e\) \{\s*console\.error\('Save failed:', e\);/.test(saveSection);
    const saveFailure = /console\.error\('Save failed:', e\);[\s\S]*?return false;\s*\}\s*\}\s*;/.test(saveSection);
    const flush = /return await (?:saveChatHistoryNow\(\)|chatHistorySaveQueue);/.test(flushSection);
    return chatGuard && saveSuccess && saveFailure && flush ? 1 : 0;
}

function verifyPersistenceReturnSemantics(text) {
    const saveStart = text.indexOf('        const saveData = async');
    const saveEnd = saveStart < 0 ? -1 : text.indexOf('        const saveConversationMutationNow', saveStart);
    const flushStart = text.indexOf('        const flushPendingChatHistorySave');
    const flushEnd = flushStart < 0 ? -1 : text.indexOf('        const saveMemorySettingsNow', flushStart);
    if (saveStart < 0 || saveEnd < 0 || flushStart < 0 || flushEnd < 0) return 0;
    return verifyPersistenceReturnSemanticSections(
        text.slice(saveStart, saveEnd),
        text.slice(flushStart, flushEnd)
    );
}

function verifyPullRestoreWriteGateSection(section, marker) {
    const flagChecks = countSubstring(section, 'globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true');
    const deferCalls = countSubstring(section, marker);
    return flagChecks === 1 && deferCalls === 1 ? 1 : 0;
}

function countPullRestoreGateInSection(text, startText, endText, marker) {
    const start = text.indexOf(startText);
    if (start < 0 || text.indexOf(startText, start + startText.length) >= 0) return 0;
    const end = text.indexOf(endText, start + startText.length);
    if (end < 0) return 0;
    return verifyPullRestoreWriteGateSection(text.slice(start, end), marker);
}

function verifyPullRestoreWriteGates(text) {
    return {
        dbSetTo: countPullRestoreGateInSection(
            text,
            '        const dbSetTo =',
            '        const dbSet = async',
            DB_SET_TO_DEFER_MARKER
        ),
        dbDeleteFrom: countPullRestoreGateInSection(
            text,
            '        const dbDeleteFrom =',
            '        const dbDelete =',
            DB_DELETE_FROM_DEFER_MARKER
        )
    };
}

function countResidualCharacterStorage(text) {
    let characterSave = 0;
    let characterLoad = 0;
    RESIDUAL_CHARACTER_STORAGE.lastIndex = 0;
    let match;
    while ((match = RESIDUAL_CHARACTER_STORAGE.exec(text)) !== null) {
        if (match[1]) characterSave += 1;
        else if (match[2]) characterLoad += 1;
    }
    return { characterSave, characterLoad };
}

function verifyRpHubAppJsInternal(code, replacements = {}, evidence = {}) {
    const text = String(code || '');
    const storageExternalized = isExternalizedStorageMode(text);
    const executableHooks = countExecutableCharacterHooks(text);
    const residualHooks = countResidualCharacterStorage(text);
    const pullRestoreWriteGates = evidence.pullRestoreWriteGates || verifyPullRestoreWriteGates(text);
    const invariants = {
        residualCharacterSave: residualHooks.characterSave,
        residualCharacterLoad: residualHooks.characterLoad,
        flushBridgeMarker: countSubstring(text, 'RPH_R2_FLUSH_PERSISTENCE'),
        executableCharacterSave: executableHooks.characterSave,
        executableCharacterLoad: executableHooks.characterLoad,
        executablePersistenceBridge: executableHooks.persistenceBridge,
        persistenceReturnSemantics: evidence.persistenceReturnSemantics ?? verifyPersistenceReturnSemantics(text),
        pullRestoreDbSetGate: pullRestoreWriteGates.dbSetTo,
        pullRestoreDbDeleteGate: pullRestoreWriteGates.dbDeleteFrom
    };
    const expectedPullRestoreGate = storageExternalized ? 0 : 1;
    const valid = Number(replacements.characterSave || 0) >= 1
        && Number(replacements.characterLoad || 0) >= 1
        && Number(replacements.persistenceBridge || 0) === 1
        && invariants.residualCharacterSave === 0
        && invariants.residualCharacterLoad === 0
        && invariants.flushBridgeMarker === 1
        && invariants.executableCharacterSave >= 1
        && invariants.executableCharacterLoad >= 1
        && invariants.executablePersistenceBridge === 1
        && invariants.persistenceReturnSemantics === 1
        && invariants.pullRestoreDbSetGate === expectedPullRestoreGate
        && invariants.pullRestoreDbDeleteGate === expectedPullRestoreGate;
    return { valid, invariants };
}

export function verifyRpHubAppJs(code, replacements = {}) {
    return verifyRpHubAppJsInternal(code, replacements);
}

export function patchRpHubAppJs(source, options = {}) {
    if (typeof source !== 'string') {
        rejectPatch(options.version, 'input', { reason: 'app.js 内容不是字符串。' });
    }

    const bridgePattern = createPattern(APP_PATCH_MODES.persistenceBridge);

    let characterSave = 0;
    let characterLoad = 0;
    let persistenceBridge = 0;

    let code = source.replace(CHARACTER_STORAGE_PATTERN, (_match, expression, loadMatch) => {
        if (loadMatch !== undefined) {
            characterLoad += 1;
            return 'await window.RPHubCharStore.loadAll()';
        }
        characterSave += 1;
        return `await window.RPHubCharStore.saveAll(${expression})`;
    });
    code = code.replace(bridgePattern, (anchor, indent) => {
        persistenceBridge += 1;
        const eol = anchor.includes('\r\n') ? '\r\n' : '\n';
        return `${anchor}${eol}${eol}${buildPersistenceBridge(indent, eol)}`;
    });
    if (persistenceBridge === 0 && countSubstring(source, 'manualSave') === 0) {
        const modernBridgePattern = createPattern(APP_PATCH_MODES.persistenceBridge.modernAnchor);
        const modernEol = source.includes('\r\n') ? '\r\n' : '\n';
        code = code.replace(modernBridgePattern, (anchorLine, indent) => {
            persistenceBridge += 1;
            return `${buildPersistenceBridge(indent, modernEol)}${modernEol}${modernEol}${anchorLine}`;
        });
    }

    const existingMarkers = countExistingPatchMarkers(source);
    const detected = {
        characterSave,
        characterLoad,
        persistenceBridge,
        existingFlushBridgeMarker: existingMarkers.flushBridge,
        existingDbSetToDeferMarker: existingMarkers.dbSetTo,
        existingDbDeleteFromDeferMarker: existingMarkers.dbDeleteFrom
    };
    if (detected.characterSave < 1 || detected.characterLoad < 1
        || detected.persistenceBridge !== 1 || detected.existingFlushBridgeMarker !== 0
        || detected.existingDbSetToDeferMarker !== 0 || detected.existingDbDeleteFromDeferMarker !== 0) {
        rejectPatch(options.version, 'pattern-match', { detected });
    }

    const pullRestoreWriteGates = applyPullRestoreWriteGates(code, options.version);
    const hardened = hardenPersistenceReturnSemantics(code, options.version, pullRestoreWriteGates.edits);
    code = hardened.code;
    const replacements = { characterSave, characterLoad, persistenceBridge };
    const verification = verifyRpHubAppJsInternal(code, replacements, {
        persistenceReturnSemantics: hardened.invariants.persistenceReturnSemantics,
        pullRestoreWriteGates: pullRestoreWriteGates.invariants
    });
    if (!verification.valid) {
        rejectPatch(options.version, 'invariant-check', {
            detected,
            replacements,
            persistenceHardening: hardened.report,
            pullRestoreWriteGates: pullRestoreWriteGates.report,
            invariants: verification.invariants
        });
    }

    return {
        code,
        report: {
            revision: RP_HUB_APP_PATCH_REVISION,
            storageExternalized: pullRestoreWriteGates.storageExternalized,
            detected,
            replacements,
            persistenceHardening: hardened.report,
            pullRestoreWriteGates: pullRestoreWriteGates.report,
            invariants: verification.invariants
        }
    };
}
