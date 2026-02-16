/**
 * Simple observable state store with path-based subscriptions. Singleton.
 * @module store
 */

import { eventBus, Events } from './event-bus.js';

/**
 * Resolve a dot-path to a value in an object.
 * @param {Object} obj
 * @param {string} path - e.g. 'stages.meet.status'
 * @returns {*}
 */
function getByPath(obj, path) {
    const keys = path.split('.');
    let current = obj;
    for (const key of keys) {
        if (current == null) return undefined;
        current = current[key];
    }
    return current;
}

/**
 * Set a value at a dot-path, returning a shallow-cloned object at every level touched.
 * @param {Object} obj
 * @param {string} path
 * @param {*} value
 * @returns {Object} New root object
 */
function setByPath(obj, path, value) {
    const keys = path.split('.');
    const root = { ...obj };
    let current = root;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        current[key] = current[key] != null ? { ...current[key] } : {};
        current = current[key];
    }
    current[keys[keys.length - 1]] = value;
    return root;
}

/**
 * Collect all path prefixes for notification.
 * e.g. 'stages.meet.status' → ['stages', 'stages.meet', 'stages.meet.status']
 * @param {string} path
 * @returns {string[]}
 */
function pathPrefixes(path) {
    const parts = path.split('.');
    const prefixes = [];
    for (let i = 1; i <= parts.length; i++) {
        prefixes.push(parts.slice(0, i).join('.'));
    }
    return prefixes;
}

/**
 * Create an observable state store.
 * @param {Object} initialState
 * @returns {Object} Store API
 */
function createStore(initialState) {
    let state = structuredClone(initialState);

    /** @type {Map<string, Set<Function>>} path → Set<callback> */
    const subscribers = new Map();

    /**
     * Notify subscribers for a set of paths plus the wildcard.
     * @param {string[]} paths
     * @param {Object} oldState
     */
    function notify(paths, oldState) {
        const notified = new Set();

        for (const p of paths) {
            // Notify exact path and all prefixes
            for (const prefix of pathPrefixes(p)) {
                if (notified.has(prefix)) continue;
                notified.add(prefix);
                const cbs = subscribers.get(prefix);
                if (cbs) {
                    const newVal = getByPath(state, prefix);
                    const oldVal = getByPath(oldState, prefix);
                    for (const cb of cbs) {
                        try { cb(newVal, oldVal, prefix); } catch (e) { console.error(`[Store] subscriber error on "${prefix}":`, e); }
                    }
                }
            }
        }

        // Wildcard subscribers
        const wildcardCbs = subscribers.get('*');
        if (wildcardCbs) {
            for (const cb of wildcardCbs) {
                try { cb(state, oldState, '*'); } catch (e) { console.error('[Store] wildcard subscriber error:', e); }
            }
        }
    }

    return {
        /**
         * Get the full state object (read-only by convention).
         * @returns {Object}
         */
        getState() {
            return state;
        },

        /**
         * Get a nested value by dot-path.
         * @param {string} path - e.g. 'meeting.name'
         * @returns {*}
         */
        get(path) {
            return getByPath(state, path);
        },

        /**
         * Update state and notify subscribers.
         * - `set('key.nested', value)` sets a dot-path
         * - `set({ key: value, ... })` merges top-level keys
         * @param {string|Object} pathOrPatch
         * @param {*} [value]
         */
        set(pathOrPatch, value) {
            const oldState = state;

            if (typeof pathOrPatch === 'string') {
                state = setByPath(state, pathOrPatch, value);
                notify([pathOrPatch], oldState);
            } else if (typeof pathOrPatch === 'object' && pathOrPatch !== null) {
                const changedKeys = [];
                const merged = { ...state };
                for (const key of Object.keys(pathOrPatch)) {
                    if (merged[key] !== pathOrPatch[key]) {
                        merged[key] = pathOrPatch[key];
                        changedKeys.push(key);
                    }
                }
                state = merged;
                if (changedKeys.length > 0) {
                    notify(changedKeys, oldState);
                }
            }
        },

        /**
         * Subscribe to changes on a specific path, or '*' for all changes.
         * Callback receives (newValue, oldValue, path).
         * @param {string} path - Dot-path or '*'
         * @param {Function} callback
         * @returns {Function} Unsubscribe function
         */
        subscribe(path, callback) {
            if (!subscribers.has(path)) {
                subscribers.set(path, new Set());
            }
            subscribers.get(path).add(callback);
            return () => {
                const set = subscribers.get(path);
                if (set) {
                    set.delete(callback);
                    if (set.size === 0) subscribers.delete(path);
                }
            };
        },

        /**
         * Replace entire state (used for reset). Notifies wildcard subscribers.
         * @param {Object} [newState] - Defaults to a fresh clone of initialState
         */
        reset(newState) {
            const oldState = state;
            state = structuredClone(newState || initialState);
            // Notify all existing path subscribers
            const allPaths = [...subscribers.keys()];
            const wildcardCbs = subscribers.get('*');
            if (wildcardCbs) {
                for (const cb of wildcardCbs) {
                    try { cb(state, oldState, '*'); } catch (e) { console.error('[Store] wildcard subscriber error on reset:', e); }
                }
            }
            for (const p of allPaths) {
                if (p === '*') continue;
                const cbs = subscribers.get(p);
                if (cbs) {
                    const newVal = getByPath(state, p);
                    const oldVal = getByPath(oldState, p);
                    for (const cb of cbs) {
                        try { cb(newVal, oldVal, p); } catch (e) { console.error(`[Store] subscriber error on reset "${p}":`, e); }
                    }
                }
            }
        },
    };
}

/** @type {Object} Default initial application state */
const initialState = {
    meeting: {
        name: '',
        iteration: 1,
        info: null, // { title, date, participants, summary }
    },
    stages: {
        meet:    { status: 'idle', metrics: {}, startTime: null, endTime: null },
        analyze: { status: 'idle', metrics: {}, startTime: null, endTime: null },
        build:   { status: 'idle', metrics: {}, startTime: null, endTime: null },
        verify:  { status: 'idle', metrics: {}, startTime: null, endTime: null },
    },
    activeStage: null,
    detailPanelOpen: null,

    // Unified requirements data — THE single source of truth
    // Each item: { id, text, selected, gapResult, dispatch, validation }
    //   gapResult:  null | { hasGap, gap, currentState, complexity, estimatedEffort, details }
    //   dispatch:   null | { mode: 'cloud'|'local'|'developer', issueNumber, issueUrl, status: 'pending'|'creating'|'assigned'|'working'|'implemented'|'failed' }
    //   validation: null | { status: 'pending'|'validating'|'pass'|'fail', details, screenshot }
    requirements: [],

    epicIssue: { number: 0, url: '' },
    deployedUrl: '',
    analysisPhase: 'idle', // 'idle' | 'extracting' | 'selecting' | 'analyzing' | 'reviewed'

    createdIssues: [], // { number, url, title, gapId }

    dispatch: {
        inProgress: false,
        totalItems: 0,
        completedItems: 0,
    },
};

export const store = createStore(initialState);
export { initialState };
