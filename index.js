// Lore Theater — lets the model browse, fetch, pin and purge World Info entries
// through function tools, so it can assemble its own context before replying.

import { getSortedEntries, loadWorldInfo, world_names } from '../../../world-info.js';

const MODULE = 'lore_theater';
const DISPLAY_NAME = 'Lore Theater';
const LOG_PREFIX = `[${DISPLAY_NAME}]`;
const PIN_PROMPT_KEY = 'lore_theater_pins';
const RULES_PROMPT_KEY = 'lore_theater_rules';

// Every tool result starts with "[Lore call #N]" so it can be purged later.
// A purged result keeps the label but not the closing bracket, so CALL_RE no longer matches it.
const CALL_LABEL = 'Lore call';
const callTag = n => `[${CALL_LABEL} #${n}]`;
const CALL_RE = new RegExp(`^\\[${CALL_LABEL} #(\\d+)\\]`);

// extension_prompt_types / extension_prompt_roles values from script.js
const POSITION = { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
const ROLE = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

/** Generation types that start a fresh attempt at the current turn (tool-loop rounds arrive as 'normal'). */
const TURN_RESTART_TYPES = ['swipe', 'regenerate'];

// ------------------------------------------------------------------ tunables

/** Budget/limit value that means "no limit". */
const NO_LIMIT = 0;
const isLimited = value => value > NO_LIMIT;

/** Rough characters-per-token ratio used for the token estimates shown to the model. */
const CHARS_PER_TOKEN = 3.5;

/** Default number of entries lore_index lists when the model gives no limit. */
const DEFAULT_INDEX_LIMIT = 60;
/** Hard bounds on lore_index's limit (also used by the settings input). */
const INDEX_LIMIT_MIN = 1;
const INDEX_LIMIT_MAX = 500;
/** How many trigger keys lore_index shows per entry. */
const INDEX_KEYS_SHOWN = 6;

/** Default chat depth for the pinned block when it's placed "In chat @ depth". */
const DEFAULT_PIN_DEPTH = 4;
/** Max depth allowed in the settings input. */
const PIN_DEPTH_MAX = 1000;

/** Where the usage-instructions note is injected. */
const RULES_POSITION = POSITION.IN_PROMPT;
const RULES_DEPTH = 0;
const RULES_ROLE = ROLE.SYSTEM;

/** Number given to the first tool call in a chat. */
const FIRST_CALL_NUMBER = 1;

/** Indentation of the JSON shown in rerendered tool-call messages (matches SillyTavern). */
const TOOL_MESSAGE_JSON_INDENT = 2;

/** Text a purged result is replaced with; PURGED_MARKER must appear in it. */
const PURGED_MARKER = 'content purged';
const purgedText = (callNo, reason) => `[${CALL_LABEL} #${callNo} — ${PURGED_MARKER} ${reason}]`;
/** Reasons shown in purge notes. */
const PURGE_REASON = Object.freeze({
    MANUAL: 'manually',
    AUTO: 'automatically after reply',
    viaCall: n => `via call #${n}`,
});

/** Header of the pinned lore block. */
const PIN_BLOCK_HEADER = '[Pinned lore — selected by you for the current scene]';

/** Default research calls (lore_index / lore_fetch) allowed per turn; NO_LIMIT turns the budget off. */
const DEFAULT_RESEARCH_BUDGET = 10;
/** Default token budget for the pinned lore block; NO_LIMIT turns the budget off. */
const DEFAULT_PIN_TOKEN_BUDGET = 4000;

const defaultSettings = Object.freeze({
    enabled: true,
    includeActiveBooks: true,
    extraBooks: [],
    indexLimit: DEFAULT_INDEX_LIMIT,
    autoPurgeOnReply: true,
    injectRules: true,
    pinPosition: POSITION.IN_PROMPT,
    pinDepth: DEFAULT_PIN_DEPTH,
    pinRole: ROLE.SYSTEM,
    researchBudget: DEFAULT_RESEARCH_BUDGET,
    pinTokenBudget: DEFAULT_PIN_TOKEN_BUDGET,
});

const DEFAULT_RULES = `[Lore Theater]
You can manage your own lore context with tools before writing your reply:
- lore_index: browse/search available lore entries (returns refs like "Book#12").
- lore_fetch: read entries by ref. Each tool result is stamped "${callTag('N')}".
- lore_pin / lore_unpin: keep entries permanently in context (pinned lore block), or drop them.
- lore_purge: remove earlier tool results (by call number) from context once you've decided on them.
- lore_theater: show what is pinned and which tool results are still occupying context.
Workflow: index → fetch candidates → pin what matters for the scene → purge the rest → write the reply.
Do not mention these tools in your in-character reply.`;

function buildRules() {
    const s = settings();
    const limits = [
        isLimited(s.researchBudget) ? `- At most ${s.researchBudget} lore_index/lore_fetch calls per turn.` : '',
        isLimited(s.pinTokenBudget) ? `- Pinned lore is capped at ~${s.pinTokenBudget} tokens; unpin to make room.` : '',
    ].filter(Boolean);
    return limits.length ? `${DEFAULT_RULES}\nLimits:\n${limits.join('\n')}` : DEFAULT_RULES;
}

/** Calls queued for purging because they were made in the same tool batch and are not saved to chat yet. */
const pendingPurges = new Map();

/** lore_index / lore_fetch calls made since the user's last message (or the last swipe/regenerate). */
let researchCalls = 0;

function ctx() {
    return SillyTavern.getContext();
}

function settings() {
    const store = ctx().extensionSettings;
    store[MODULE] = Object.assign({}, defaultSettings, store[MODULE]);
    return store[MODULE];
}

/** Per-chat state: call counter and pinned entries. */
function state() {
    const meta = ctx().chatMetadata;
    meta[MODULE] ??= { nextCall: FIRST_CALL_NUMBER, pins: {} };
    meta[MODULE].pins ??= {};
    return meta[MODULE];
}

function nextCallNumber() {
    const s = state();
    const n = s.nextCall++;
    ctx().saveMetadataDebounced();
    return n;
}

function stamp(n, body) {
    return `${callTag(n)}\n${body}`;
}

function estimateTokens(text) {
    return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);
}

function entryTitle(entry) {
    return entry.comment || (Array.isArray(entry.key) ? entry.key.join(', ') : '') || `Entry ${entry.uid}`;
}

function refOf(entry) {
    return `${entry.world}#${entry.uid}`;
}

function parseRef(ref) {
    const str = String(ref ?? '').trim();
    const at = str.lastIndexOf('#');
    if (at <= 0) return null;
    const uid = Number(str.slice(at + 1));
    return Number.isFinite(uid) ? { book: str.slice(0, at), uid } : null;
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === '') return [];
    return String(value).split(/[,\n]/).map(x => x.trim()).filter(Boolean);
}

// ---------------------------------------------------------------- lore access

/**
 * All entries reachable by the tools: entries from books active in this chat
 * (unless disabled) plus every entry of the extra "tool-only" books.
 */
async function getAvailableEntries() {
    const s = settings();
    const byRef = new Map();

    if (s.includeActiveBooks) {
        try {
            for (const entry of await getSortedEntries()) {
                if (!entry.disable) byRef.set(refOf(entry), entry);
            }
        } catch (e) {
            console.error(LOG_PREFIX, 'Failed to read active lore', e);
        }
    }

    for (const book of s.extraBooks) {
        const data = await loadWorldInfo(book);
        if (!data?.entries) continue;
        for (const entry of Object.values(data.entries)) {
            const full = { ...entry, world: book };
            byRef.set(refOf(full), full);
        }
    }

    return [...byRef.values()];
}

/** Map of ref -> entry for everything getAvailableEntries returns. */
async function getEntryMap() {
    return new Map((await getAvailableEntries()).map(e => [refOf(e), e]));
}

/** Finds an entry by a model-supplied ref, tolerating whitespace and leading zeros in the uid. */
function lookupEntry(entryMap, ref) {
    const parsed = parseRef(ref);
    return parsed ? entryMap.get(`${parsed.book}#${parsed.uid}`) ?? null : null;
}

// ------------------------------------------------------------- chat scanning

/** Yields every Lore Theater tool invocation still stored in the chat. */
function* loreInvocations() {
    const chat = ctx().chat;
    for (let mesId = 0; mesId < chat.length; mesId++) {
        const invocations = chat[mesId]?.extra?.tool_invocations;
        if (!Array.isArray(invocations)) continue;
        for (const inv of invocations) {
            const match = typeof inv.result === 'string' ? inv.result.match(CALL_RE) : null;
            if (match) yield { mesId, inv, callNo: Number(match[1]) };
        }
    }
}

function tryParse(value) {
    try { return JSON.parse(value); } catch { return value; }
}

/** Mirrors ToolManager's tool message rendering so the chat UI reflects purges. */
function rerenderToolMessage(mesId) {
    const message = ctx().chat[mesId];
    const data = structuredClone(message.extra.tool_invocations);
    data.forEach(i => {
        i.parameters = tryParse(i.parameters);
        i.result = tryParse(i.result);
    });
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.classList.add('language-json');
    code.textContent = JSON.stringify(data, null, TOOL_MESSAGE_JSON_INDENT);
    summary.textContent = `Tool calls: ${data.map(i => i.displayName || i.name).join(', ')}`;
    pre.append(code);
    details.append(summary, pre);
    message.mes = details.outerHTML;
    try {
        ctx().updateMessageBlock(mesId, message);
    } catch (e) {
        console.warn(LOG_PREFIX, 'Could not rerender message', mesId, e);
    }
}

/**
 * Replaces the stored results of the given calls with a short tombstone.
 * @param {Map<number, string>} targets call number -> purge reason
 * @returns {Promise<number[]>} call numbers that were purged
 */
async function purgeCalls(targets) {
    const purged = [];
    const touched = new Set();
    for (const { mesId, inv, callNo } of loreInvocations()) {
        if (!targets.has(callNo)) continue;
        inv.result = purgedText(callNo, targets.get(callNo));
        purged.push(callNo);
        touched.add(mesId);
    }
    touched.forEach(rerenderToolMessage);
    if (touched.size) await ctx().saveChat();
    return purged;
}

async function flushPendingPurges() {
    if (!pendingPurges.size) return;
    const targets = new Map(pendingPurges);
    pendingPurges.clear();
    await purgeCalls(targets);
}

// ------------------------------------------------------------------- pinning

/**
 * Pins store only a reference; content is read from the lorebook every time the
 * prompt is built, so edits to an entry show up in the pinned block.
 * @returns {Promise<{found: {pin: object, entry: object, tokens: number}[], missing: object[], tokens: number}>}
 *   `missing` holds pins whose entry was deleted, disabled or is no longer exposed to the tools.
 */
async function resolvePins(entryMap = null) {
    const pins = Object.values(state().pins);
    const found = [];
    const missing = [];
    if (pins.length) {
        entryMap ??= await getEntryMap();
        for (const pin of pins) {
            const entry = entryMap.get(pin.ref);
            if (entry) found.push({ pin, entry, tokens: estimateTokens(entry.content) });
            else missing.push(pin);
        }
    }
    return { found, missing, tokens: found.reduce((sum, p) => sum + p.tokens, 0) };
}

function buildPinBlock(found) {
    if (!found.length) return '';
    const body = found.map(({ entry }) => `### ${entryTitle(entry)} (${refOf(entry)})\n${entry.content}`).join('\n\n');
    return `${PIN_BLOCK_HEADER}\n${body}`;
}

async function refreshInjections() {
    const s = settings();
    const { setExtensionPrompt } = ctx();
    const active = s.enabled && ctx().isToolCallingSupported();
    const pins = await resolvePins();
    setExtensionPrompt(PIN_PROMPT_KEY, active ? buildPinBlock(pins.found) : '', Number(s.pinPosition), Number(s.pinDepth), false, Number(s.pinRole));
    setExtensionPrompt(RULES_PROMPT_KEY, active && s.injectRules ? buildRules() : '', RULES_POSITION, RULES_DEPTH, false, RULES_ROLE);
    renderPinsSummary(pins);
}

/** Counts a research call against this turn's budget; returns an error message if the budget is spent. */
function useResearchBudget() {
    const budget = settings().researchBudget;
    if (isLimited(budget) && researchCalls >= budget) {
        return `Research budget for this turn is used up (${budget} of ${budget} lore_index/lore_fetch calls). `
            + 'Work with what you have: pin what you need, purge the rest, and write your reply.';
    }
    researchCalls++;
    return null;
}

// --------------------------------------------------------------------- tools

async function toolIndex({ query, book, limit } = {}) {
    const n = nextCallNumber();
    const overBudget = useResearchBudget();
    if (overBudget) return stamp(n, overBudget);
    const s = settings();
    const pins = state().pins;
    const q = String(query ?? '').toLowerCase().trim();
    const terms = q ? q.split(/\s+/) : [];

    let entries = await getAvailableEntries();
    if (book) entries = entries.filter(e => e.world.toLowerCase() === String(book).toLowerCase());
    if (terms.length) {
        entries = entries.filter(e => {
            const hay = [e.comment, ...(e.key ?? []), ...(e.keysecondary ?? []), e.content].join(' ').toLowerCase();
            return terms.every(t => hay.includes(t));
        });
    }

    const max = Math.max(INDEX_LIMIT_MIN, Math.min(Number(limit) || s.indexLimit, INDEX_LIMIT_MAX));
    const shown = entries.slice(0, max);
    if (!shown.length) return stamp(n, 'No matching lore entries.');

    const lines = shown.map(e => {
        const keys = (e.key ?? []).slice(0, INDEX_KEYS_SHOWN).join(', ');
        const pinned = pins[refOf(e)] ? ' [PINNED]' : '';
        return `- ${refOf(e)} | ${entryTitle(e)} | keys: ${keys || '—'} | ~${estimateTokens(e.content)}t${pinned}`;
    });
    const more = entries.length > shown.length ? `\n(${entries.length - shown.length} more — narrow with query/book)` : '';
    return stamp(n, `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} found:\n${lines.join('\n')}${more}`);
}

async function toolFetch({ refs } = {}) {
    const n = nextCallNumber();
    const overBudget = useResearchBudget();
    if (overBudget) return stamp(n, overBudget);
    const entryMap = await getEntryMap();
    const parts = [];
    for (const ref of asArray(refs)) {
        const entry = lookupEntry(entryMap, ref);
        parts.push(entry
            ? `### ${entryTitle(entry)} (${refOf(entry)})\n${entry.content}`
            : `### ${ref}\n(not found — check the ref with lore_index)`);
    }
    return stamp(n, parts.join('\n\n') || 'No refs given.');
}

async function toolPin({ refs } = {}) {
    const n = nextCallNumber();
    const budget = settings().pinTokenBudget;
    const pins = state().pins;
    const entryMap = await getEntryMap();
    let pinnedTokens = (await resolvePins(entryMap)).tokens;
    const done = [];
    const missing = [];
    const overBudget = [];
    for (const ref of asArray(refs)) {
        const entry = lookupEntry(entryMap, ref);
        if (!entry) { missing.push(ref); continue; }
        const key = refOf(entry);
        if (pins[key]) { done.push(key); continue; }
        const tokens = estimateTokens(entry.content);
        if (isLimited(budget) && pinnedTokens + tokens > budget) { overBudget.push(`${key} (~${tokens}t)`); continue; }
        pins[key] = { ref: key, title: entryTitle(entry), pinnedAt: Date.now() };
        pinnedTokens += tokens;
        done.push(key);
    }
    ctx().saveMetadataDebounced();
    await refreshInjections();
    return stamp(n, [
        done.length ? `Pinned: ${done.join(', ')}` : '',
        missing.length ? `Not found: ${missing.join(', ')}` : '',
        overBudget.length ? `Not pinned, over the ~${budget}t pin budget (~${pinnedTokens}t used): ${overBudget.join(', ')}. Unpin something first.` : '',
    ].filter(Boolean).join('\n') || 'Nothing pinned.');
}

async function toolUnpin({ refs, all } = {}) {
    const n = nextCallNumber();
    const s = state();
    let removed;
    if (all) {
        removed = Object.keys(s.pins);
        s.pins = {};
    } else {
        removed = asArray(refs).filter(ref => ref in s.pins);
        removed.forEach(ref => delete s.pins[ref]);
    }
    ctx().saveMetadataDebounced();
    await refreshInjections();
    return stamp(n, removed.length ? `Unpinned: ${removed.join(', ')}` : 'Nothing unpinned.');
}

async function toolPurge({ calls, all } = {}) {
    const n = nextCallNumber();
    const reason = PURGE_REASON.viaCall(n);
    const live = new Set([...loreInvocations()].map(x => x.callNo));

    const requested = all
        ? [...live]
        : asArray(calls).map(c => Number(String(c).replace(/^#/, ''))).filter(Number.isFinite);

    const now = new Map();
    const queued = [];
    for (const callNo of requested) {
        if (callNo === n) continue;
        if (live.has(callNo)) {
            now.set(callNo, reason);
        } else if (callNo < n) {
            // Made earlier in this same batch: not in chat yet, purge once it's saved.
            pendingPurges.set(callNo, reason);
            queued.push(callNo);
        }
    }
    const purged = await purgeCalls(now);
    return stamp(n, [
        purged.length ? `Purged: ${purged.map(c => `#${c}`).join(', ')}` : '',
        queued.length ? `Queued (same batch): ${queued.map(c => `#${c}`).join(', ')}` : '',
    ].filter(Boolean).join('\n') || 'Nothing to purge.');
}

async function toolTheater() {
    const n = nextCallNumber();
    const s = settings();
    const pins = await resolvePins();
    const pinLines = [
        ...pins.found.map(({ pin, entry, tokens }) => `- ${pin.ref} | ${entryTitle(entry)} | ~${tokens}t`),
        ...pins.missing.map(pin => `- ${pin.ref} | ${pin.title} | MISSING (deleted, disabled or not exposed; not injected)`),
    ];
    const live = [...loreInvocations()]
        .filter(x => !x.inv.result.includes(PURGED_MARKER))
        .map(x => `- #${x.callNo} ${x.inv.name} | ~${estimateTokens(x.inv.result)}t`);
    const pinBudget = isLimited(s.pinTokenBudget) ? ` of ~${s.pinTokenBudget}t budget` : '';
    const research = isLimited(s.researchBudget) ? `${researchCalls} of ${s.researchBudget}` : `${researchCalls} (no limit)`;
    return stamp(n, [
        `Pinned (${pinLines.length}, ~${pins.tokens}t${pinBudget}):`,
        pinLines.join('\n') || '- none',
        `Unpurged tool results in context (${live.length}):`,
        live.join('\n') || '- none',
        `Research calls this turn: ${research}`,
    ].join('\n'));
}

const REFS_PARAM = {
    type: 'array',
    items: { type: 'string' },
    description: 'Entry refs in the form "Book Name#uid", as shown by lore_index.',
};

function registerTools() {
    const { registerFunctionTool } = ctx();
    const shouldRegister = () => settings().enabled;
    const tools = [
        {
            name: 'lore_index',
            displayName: 'Lore: Index',
            description: 'List or search available world-info lore entries. Returns refs, titles, keys and token sizes, not content.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Optional space-separated search terms (matched against title, keys and content).' },
                    book: { type: 'string', description: 'Optional lorebook name to restrict to.' },
                    limit: { type: 'integer', description: 'Max entries to list.' },
                },
            },
            action: toolIndex,
            formatMessage: () => 'Browsing lore...',
        },
        {
            name: 'lore_fetch',
            displayName: 'Lore: Fetch',
            description: 'Read the full content of lore entries. The result occupies context until purged with lore_purge.',
            parameters: { type: 'object', properties: { refs: REFS_PARAM }, required: ['refs'] },
            action: toolFetch,
            formatMessage: () => 'Fetching lore...',
        },
        {
            name: 'lore_pin',
            displayName: 'Lore: Pin',
            description: 'Pin lore entries so their content stays in a persistent "Pinned lore" block in context (survives purges).',
            parameters: { type: 'object', properties: { refs: REFS_PARAM }, required: ['refs'] },
            action: toolPin,
            formatMessage: () => 'Pinning lore...',
        },
        {
            name: 'lore_unpin',
            displayName: 'Lore: Unpin',
            description: 'Remove lore entries from the pinned block.',
            parameters: {
                type: 'object',
                properties: { refs: REFS_PARAM, all: { type: 'boolean', description: 'Unpin everything.' } },
            },
            action: toolUnpin,
            formatMessage: () => 'Unpinning lore...',
        },
        {
            name: 'lore_purge',
            displayName: 'Lore: Purge',
            description: `Remove earlier Lore Theater tool results from context by their call number ("${callTag('N')}"). Their content is replaced with a short "purged" note.`,
            parameters: {
                type: 'object',
                properties: {
                    calls: { type: 'array', items: { type: 'integer' }, description: 'Call numbers to purge.' },
                    all: { type: 'boolean', description: 'Purge every unpurged Lore Theater result.' },
                },
            },
            action: toolPurge,
            formatMessage: () => 'Purging lore results...',
        },
        {
            name: 'lore_theater',
            displayName: 'Lore: Theater Status',
            description: 'Show pinned entries and which Lore Theater tool results are still occupying context, with token estimates.',
            parameters: { type: 'object', properties: {} },
            action: toolTheater,
            formatMessage: () => 'Checking lore theater...',
        },
    ];
    for (const tool of tools) registerFunctionTool({ ...tool, shouldRegister });
}

// ------------------------------------------------------------------ settings UI

async function renderPinsSummary(pins = null) {
    const el = document.getElementById('lore_theater_pins');
    if (!el) return;
    try { pins ??= await resolvePins(); } catch { /* no chat loaded */ }
    const lines = [
        ...(pins?.found ?? []).map(({ entry, tokens }) => `• ${entryTitle(entry)} (${refOf(entry)}) ~${tokens}t`),
        ...(pins?.missing ?? []).map(pin => `• ${pin.title} (${pin.ref}) — missing from available lore`),
    ];
    el.textContent = lines.length ? lines.join('\n') : 'No pinned entries in this chat.';
}

function renderBookList() {
    const s = settings();
    const container = $('#lore_theater_books').empty();
    for (const name of world_names ?? []) {
        const id = `lore_theater_book_${name.replace(/\W/g, '_')}`;
        const box = $('<input type="checkbox">').attr('id', id).prop('checked', s.extraBooks.includes(name));
        box.on('change', function () {
            s.extraBooks = this.checked ? [...new Set([...s.extraBooks, name])] : s.extraBooks.filter(b => b !== name);
            ctx().saveSettingsDebounced();
        });
        container.append($('<label class="checkbox_label">').attr('for', id).append(box, $('<span>').text(name)));
    }
    if (!world_names?.length) container.text('No lorebooks found.');
}

function addSettingsUI() {
    const html = `
    <div id="lore_theater_settings" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${DISPLAY_NAME}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <small>Requires Chat Completion with "Enable function calling" turned on.</small>
            <label class="checkbox_label"><input id="lore_theater_enabled" type="checkbox"><span>Enable lore tools</span></label>
            <label class="checkbox_label"><input id="lore_theater_active" type="checkbox"><span>Expose lorebooks active in this chat</span></label>
            <label class="checkbox_label"><input id="lore_theater_autopurge" type="checkbox"><span>Auto-purge last turn's lore tool results when you send a new message (pins stay)</span></label>
            <label class="checkbox_label"><input id="lore_theater_rules" type="checkbox"><span>Inject usage instructions for the model</span></label>
            <div class="lt-row"><span>Index result limit</span><input id="lore_theater_limit" class="text_pole" type="number" min="${INDEX_LIMIT_MIN}" max="${INDEX_LIMIT_MAX}"></div>
            <div class="lt-row"><span>Research calls per turn <small>(${NO_LIMIT} = no limit)</small></span><input id="lore_theater_research_budget" class="text_pole" type="number" min="${NO_LIMIT}"></div>
            <div class="lt-row"><span>Pinned token budget <small>(${NO_LIMIT} = no limit)</small></span><input id="lore_theater_pin_budget" class="text_pole" type="number" min="${NO_LIMIT}"></div>
            <div>Tool-only lorebooks <small>(all entries exposed, even disabled ones; keep these books inactive so they never auto-trigger)</small></div>
            <div id="lore_theater_books" class="lt-books"></div>
            <div class="lt-row">
                <span>Pinned block position</span>
                <select id="lore_theater_pos" class="text_pole">
                    <option value="${POSITION.BEFORE_PROMPT}">Before main prompt</option>
                    <option value="${POSITION.IN_PROMPT}">After main prompt / story string</option>
                    <option value="${POSITION.IN_CHAT}">In chat @ depth</option>
                </select>
                <span>Depth</span><input id="lore_theater_depth" class="text_pole" type="number" min="0" max="${PIN_DEPTH_MAX}">
                <span>Role</span>
                <select id="lore_theater_role" class="text_pole">
                    <option value="${ROLE.SYSTEM}">System</option>
                    <option value="${ROLE.USER}">User</option>
                    <option value="${ROLE.ASSISTANT}">Assistant</option>
                </select>
            </div>
            <div><b>Pinned in this chat</b></div>
            <div id="lore_theater_pins" class="lt-pins"></div>
            <div class="lt-row">
                <div id="lore_theater_clear_pins" class="menu_button">Clear pins</div>
                <div id="lore_theater_purge_all" class="menu_button">Purge all lore results</div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    const s = settings();
    const save = () => { ctx().saveSettingsDebounced(); refreshInjections(); };
    const bindCheck = (id, key) => $(id).prop('checked', s[key]).on('change', function () { s[key] = this.checked; save(); });
    const bindValue = (id, key) => $(id).val(s[key]).on('change', function () { s[key] = Number(this.value); save(); });

    bindCheck('#lore_theater_enabled', 'enabled');
    bindCheck('#lore_theater_active', 'includeActiveBooks');
    bindCheck('#lore_theater_autopurge', 'autoPurgeOnReply');
    bindCheck('#lore_theater_rules', 'injectRules');
    bindValue('#lore_theater_limit', 'indexLimit');
    bindValue('#lore_theater_research_budget', 'researchBudget');
    bindValue('#lore_theater_pin_budget', 'pinTokenBudget');
    bindValue('#lore_theater_pos', 'pinPosition');
    bindValue('#lore_theater_depth', 'pinDepth');
    bindValue('#lore_theater_role', 'pinRole');

    $('#lore_theater_settings .inline-drawer-toggle').on('click', () => { renderBookList(); renderPinsSummary(); });
    $('#lore_theater_clear_pins').on('click', () => {
        state().pins = {};
        ctx().saveMetadataDebounced();
        refreshInjections();
    });
    $('#lore_theater_purge_all').on('click', async () => {
        const targets = new Map([...loreInvocations()].map(x => [x.callNo, PURGE_REASON.MANUAL]));
        const purged = await purgeCalls(targets);
        toastr.info(`Purged ${purged.length} lore result(s).`, DISPLAY_NAME);
    });

    renderBookList();
}

// ---------------------------------------------------------------------- wiring

globalThis.loreTheaterInterceptor = async function (_chat, _contextSize, _abort, type) {
    // A new user message resets the budget in onUserMessageSent.
    if (TURN_RESTART_TYPES.includes(type)) researchCalls = 0;
    await flushPendingPurges();
    await refreshInjections();
};

// Runs when the user sends a new message: the previous turn's theater work is done,
// so its tool results are cleared (pins stay). Swipes/regens of the last reply keep them.
async function onUserMessageSent() {
    researchCalls = 0;
    if (!settings().autoPurgeOnReply) return;
    const targets = new Map();
    for (const { inv, callNo } of loreInvocations()) {
        if (!inv.result.includes(PURGED_MARKER)) targets.set(callNo, PURGE_REASON.AUTO);
    }
    await purgeCalls(targets);
}

jQuery(() => {
    const { eventSource, eventTypes } = ctx();
    settings();
    addSettingsUI();
    registerTools();

    eventSource.on(eventTypes.TOOL_CALLS_PERFORMED, flushPendingPurges);
    eventSource.on(eventTypes.MESSAGE_SENT, onUserMessageSent);
    eventSource.on(eventTypes.CHAT_CHANGED, () => { pendingPurges.clear(); researchCalls = 0; refreshInjections(); });
    eventSource.on(eventTypes.WORLDINFO_UPDATED, renderBookList);
    refreshInjections();
});
