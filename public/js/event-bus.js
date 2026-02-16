/**
 * Lightweight pub/sub event bus. Singleton.
 * @module event-bus
 */

class EventBus {
    constructor() {
        /** @type {Map<string, Set<Function>>} */
        this._listeners = new Map();
    }

    /**
     * Subscribe to an event.
     * @param {string} event - Event name
     * @param {Function} callback - Handler function
     * @returns {Function} Unsubscribe function
     */
    on(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(callback);
        return () => this.off(event, callback);
    }

    /**
     * Unsubscribe from an event.
     * @param {string} event - Event name
     * @param {Function} callback - Handler to remove
     */
    off(event, callback) {
        const set = this._listeners.get(event);
        if (set) {
            set.delete(callback);
            if (set.size === 0) this._listeners.delete(event);
        }
    }

    /**
     * Emit an event to all subscribers.
     * @param {string} event - Event name
     * @param {*} data - Payload
     */
    emit(event, data) {
        const set = this._listeners.get(event);
        if (set) {
            for (const cb of set) {
                try { cb(data); } catch (e) { console.error(`[EventBus] Error in "${event}" handler:`, e); }
            }
        }
    }

    /**
     * Subscribe to an event once — auto-removes after first invocation.
     * @param {string} event - Event name
     * @param {Function} callback - Handler function
     * @returns {Function} Unsubscribe function
     */
    once(event, callback) {
        const wrapper = (data) => {
            this.off(event, wrapper);
            callback(data);
        };
        return this.on(event, wrapper);
    }
}

/** Singleton event bus instance */
export const eventBus = new EventBus();

/** Well-known event name constants */
export const Events = {
    // Meeting
    MEETING_STARTED: 'meeting:started',
    MEETING_INFO_RECEIVED: 'meeting:info-received',
    REQUIREMENTS_RECEIVED: 'requirements:received',
    EPIC_CREATED: 'epic:created',
    MEETING_COMPLETE: 'meeting:complete',

    // Analysis
    ANALYSIS_STARTED: 'analysis:started',
    GAP_STARTED: 'gap:started',
    GAP_RESULT: 'gap:result',
    ANALYSIS_COMPLETE: 'analysis:complete',

    // Build / Dispatch
    DISPATCH_STARTED: 'dispatch:started',
    DISPATCH_ISSUE_CREATED: 'dispatch:issue-created',
    DISPATCH_ITEM_STATUS: 'dispatch:item-status',
    DISPATCH_COMPLETE: 'dispatch:complete',

    // Verify
    DEPLOY_STARTED: 'deploy:started',
    DEPLOY_COMPLETE: 'deploy:complete',
    VALIDATION_STARTED: 'validation:started',
    VALIDATION_ITEM_START: 'validation:item-start',
    VALIDATION_RESULT: 'validation:result',
    VALIDATION_COMPLETE: 'validation:complete',

    // Stage / UI
    STAGE_CHANGED: 'stage:changed',
    STAGE_DETAIL_OPENED: 'stage:detail-opened',
    STAGE_DETAIL_CLOSED: 'stage:detail-closed',
    PANEL_CHANGED: 'panel:changed',
    LOG_MESSAGE: 'log:message',
    TOAST: 'toast:show',

    // App
    APP_RESET: 'app:reset',
};
