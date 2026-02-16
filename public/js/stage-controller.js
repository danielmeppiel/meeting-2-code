/**
 * Stage controller — manages loop state, panel routing, slide-over,
 * stage node rendering, activity feed, and header navigation.
 *
 * FIX: Meet and Analyze share `panel-loading`. When opening the slide-over
 * we apply `stage-mode-meet` or `stage-mode-analyze` so CSS can show/hide
 * the correct content sections for each stage.
 *
 * @module stage-controller
 */

import { store } from './store.js';
import { eventBus, Events } from './event-bus.js';
import { showToast } from './toast.js';
import { AGENTS } from './agents.js';
import { escapeHtml } from './utils.js';

// ─── Stage → Panel mapping ───────────────────────────────────────────────
// FIXED: separate meet and analyze behavior via CSS class (see openStageDetail)
const STAGE_PANEL_MAP = {
    meet:    'panel-loading',
    analyze: 'panel-loading',
    build:   'panel-issues',
    verify:  'panel-qa',
};

// Track which panel is currently re-parented into the slide-over
let _slideOverSourcePanelId = null;
let _currentSlideOverStage = null;

// ─── LoopParticles reference ──────────────────────────────────────────────
let _loopParticles = null;

/**
 * Inject a LoopParticleSystem instance (avoids circular dependency).
 * Called from app init.
 * @param {import('./loop-particles.js').LoopParticleSystem} ps
 */
export function setParticleSystem(ps) {
    _loopParticles = ps;
}

// ─── Loop state management ────────────────────────────────────────────────

/**
 * Update the centralized loop state in the store and re-render nodes.
 * @param {Object} patch - Partial state to merge into the store.
 */
export function updateLoopState(patch) {
    if (patch.meetingName !== undefined) store.set('meeting.name', patch.meetingName);
    if (patch.iteration !== undefined) store.set('meeting.iteration', patch.iteration);
    if (patch.activeStage !== undefined) store.set('activeStage', patch.activeStage);
    if (patch.detailPanelOpen !== undefined) store.set('detailPanelOpen', patch.detailPanelOpen);
    if (patch.stages) {
        const currentStages = store.get('stages');
        for (const [stageName, data] of Object.entries(patch.stages)) {
            if (currentStages[stageName]) {
                const current = currentStages[stageName];
                const updated = { ...current };
                if (data.status !== undefined) updated.status = data.status;
                if (data.startTime !== undefined) updated.startTime = data.startTime;
                if (data.endTime !== undefined) updated.endTime = data.endTime;
                if (data.metrics) updated.metrics = { ...updated.metrics, ...data.metrics };
                store.set(`stages.${stageName}`, updated);
            }
        }
    }
    renderLoopNodes();
    // Refresh header if meeting info changed
    if (patch.meetingName !== undefined || patch.iteration !== undefined) {
        const loopInfo = document.getElementById('loopHeaderInfo');
        if (loopInfo && loopInfo.style.display !== 'none') {
            document.getElementById('loopMeetingName').textContent = store.get('meeting.name') || 'Meeting';
            document.getElementById('iterationBadge').textContent = `⟳ Iteration #${store.get('meeting.iteration') || 1}`;
        }
    }
}

/**
 * Render loop node cards based on current store state.
 */
export function renderLoopNodes() {
    const stages = store.get('stages');
    const stageNames = ['meet', 'analyze', 'build', 'verify'];

    stageNames.forEach(stage => {
        const card = document.querySelector(`.stage-node--${stage}`);
        if (!card) return;

        const stageData = stages[stage];

        card.classList.remove('stage-node--idle', 'stage-node--waiting', 'stage-node--active', 'stage-node--complete', 'stage-node--error');
        card.classList.add(`stage-node--${stageData.status}`);

        const primaryMetric = card.querySelector('[data-metric="primary"]');
        const secondaryMetric = card.querySelector('[data-metric="secondary"]');
        if (primaryMetric) primaryMetric.textContent = stageData.metrics.primary || '—';
        if (secondaryMetric) secondaryMetric.textContent = stageData.metrics.secondary || '—';

        const statusText = card.querySelector('.stage-node-status-text');
        if (statusText) {
            const statusLabels = { idle: 'Idle', waiting: 'Waiting...', active: 'In Progress', complete: 'Complete ✓', error: 'Error' };
            statusText.textContent = stageData.metrics.statusText || statusLabels[stageData.status] || 'Idle';
        }

        const icon = card.querySelector('.stage-node-icon');
        if (icon) {
            const icons = { idle: '◉', waiting: '◉', active: '⟳', complete: '✓', error: '✗' };
            icon.textContent = icons[stageData.status] || '◉';
        }

        // Action buttons are wired by the flow modules via renderStageAction
        const actionArea = card.querySelector('.stage-node-action');
        if (actionArea) {
            eventBus.emit('stage:render-action', { stage, stageData, actionArea });
        }
    });

    // Sync particle system
    if (_loopParticles) {
        _loopParticles.setActiveStage(store.get('activeStage'));
    }
}

/**
 * Advance from one stage to the next, marking the previous complete.
 * @param {string|null} from - Stage to mark complete (null if first stage).
 * @param {string|null} to   - Stage to activate.
 */
export function advanceStage(from, to) {
    const now = Date.now();
    const patch = { activeStage: to, stages: {} };
    if (from) {
        patch.stages[from] = { status: 'complete', endTime: now };
    }
    if (to) {
        patch.stages[to] = { status: 'active', startTime: now };
    }
    updateLoopState(patch);
    if (_loopParticles) {
        _loopParticles.triggerBurst(from, to);
    }
}

// ─── Panel Management ─────────────────────────────────────────────────────

/**
 * Show a panel by ID. Hides all other panels.
 * @param {string} panelId
 */
export function showPanel(panelId) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(panelId);
    if (panel) {
        panel.classList.add('active');
        panel.style.animation = 'none';
        panel.offsetHeight;
        panel.style.animation = '';
    }
    eventBus.emit(Events.PANEL_CHANGED, { panelId });
}

// ─── Slide-Over ───────────────────────────────────────────────────────────

/**
 * Open the slide-over detail panel for a specific stage.
 * Applies `stage-mode-meet` / `stage-mode-analyze` to the shared
 * `panel-loading` element so CSS can show the correct content.
 * @param {string} stage
 */
export function openStageDetail(stage) {
    const stages = store.get('stages');
    const stageData = stages[stage];
    if (!stageData || stageData.status === 'idle') {
        showToast("This stage hasn't started yet", 'info');
        return;
    }

    // Close existing
    if (_slideOverSourcePanelId) {
        _returnPanelToMain();
    }

    _currentSlideOverStage = stage;
    store.set('detailPanelOpen', stage);

    // Set title
    const titles = { meet: 'Meet', analyze: 'Analyze', build: 'Build', verify: 'Verify' };
    const titleEl = document.getElementById('slideOverTitle');
    if (titleEl) titleEl.textContent = titles[stage] || stage;

    // Determine source panel
    const sourcePanelId = STAGE_PANEL_MAP[stage];
    const sourcePanel = document.getElementById(sourcePanelId);
    if (!sourcePanel) return;

    _slideOverSourcePanelId = sourcePanelId;

    // ── FIX: When opening Meet vs Analyze in the slide-over, add a CSS class ──
    // Meet: show everything (progress, brand, table)
    // Analyze: hide meet-specific elements (progress strip, meeting card, brand)
    sourcePanel.classList.remove('stage-mode-meet', 'stage-mode-analyze');
    if (sourcePanelId === 'panel-loading') {
        sourcePanel.classList.add(stage === 'meet' ? 'stage-mode-meet' : 'stage-mode-analyze');
    }

    // Ensure the meeting brand banner is visible when re-opening the meet slide-over
    if (stage === 'meet') {
        const meetingInfo = store.get('meeting.info');
        if (meetingInfo) {
            const brand = document.getElementById('meetingSourceBrand');
            if (brand) {
                brand.style.display = 'flex';
                brand.classList.add('expanded');
            }
        }
    }

    // Re-parent into slide-over
    const slideOverContent = document.getElementById('slideOverContent');
    slideOverContent.innerHTML = '';
    slideOverContent.appendChild(sourcePanel);

    sourcePanel.classList.add('in-slideover');
    sourcePanel.style.display = 'flex';
    sourcePanel.style.animation = 'none';
    sourcePanel.style.position = 'relative';
    sourcePanel.style.opacity = '1';
    sourcePanel.style.pointerEvents = 'auto';

    // Show backdrop + slide-over
    document.getElementById('slideOverBackdrop').classList.add('active');
    document.getElementById('slideOver').classList.add('active');

    // Dim loop
    const loopContainer = document.querySelector('.loop-container');
    if (loopContainer) loopContainer.classList.add('dimmed');

    // Mark selected node
    document.querySelectorAll('.stage-node').forEach(n => n.classList.remove('stage-node--selected'));
    const selectedNode = document.querySelector(`.stage-node--${stage}`);
    if (selectedNode) selectedNode.classList.add('stage-node--selected');

    // Focus management
    const slideOver = document.getElementById('slideOver');
    const focusableEls = slideOver.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusableEls.length > 0) focusableEls[0].focus();

    renderLoopNodes();
    eventBus.emit(Events.STAGE_DETAIL_OPENED, { stage });
}

/**
 * Close the slide-over and return the panel to main.
 */
export function closeStageDetail() {
    _returnPanelToMain();

    document.getElementById('slideOverBackdrop').classList.remove('active');
    document.getElementById('slideOver').classList.remove('active');

    const loopContainer = document.querySelector('.loop-container');
    if (loopContainer) loopContainer.classList.remove('dimmed');

    document.querySelectorAll('.stage-node').forEach(n => n.classList.remove('stage-node--selected'));

    _currentSlideOverStage = null;
    store.set('detailPanelOpen', null);

    renderLoopNodes();
    eventBus.emit(Events.STAGE_DETAIL_CLOSED);
}

/** @private Return the re-parented panel back to <main>. */
function _returnPanelToMain() {
    if (!_slideOverSourcePanelId) return;

    const panel = document.getElementById(_slideOverSourcePanelId);
    if (!panel) { _slideOverSourcePanelId = null; return; }

    const main = document.querySelector('main.main-content');
    if (!main) { _slideOverSourcePanelId = null; return; }

    // Remove overrides
    panel.classList.remove('in-slideover', 'stage-mode-meet', 'stage-mode-analyze');
    panel.style.display = '';
    panel.style.animation = '';
    panel.style.position = '';
    panel.style.opacity = '';
    panel.style.pointerEvents = '';

    main.appendChild(panel);
    _slideOverSourcePanelId = null;
}

// ─── Status Bar ───────────────────────────────────────────────────────────

/**
 * Update the status badge text and style.
 * @param {string} text
 * @param {string} [type='']
 */
export function setStatus(text, type = '') {
    const badge = document.getElementById('statusBadge');
    if (!badge) return;
    const statusText = badge.querySelector('.status-text');
    badge.className = 'status-badge ' + type;
    if (statusText) statusText.textContent = text;
}

// ─── Active Agent Badge ───────────────────────────────────────────────────

/**
 * Display the active agent badge in the UI.
 * @param {string} agentKey - Key into the AGENTS map.
 */
export function setActiveAgent(agentKey) {
    const agent = AGENTS[agentKey];
    if (!agent) return;
    const badge = document.getElementById('activeAgentBadge');
    if (badge) {
        badge.className = `agent-badge agent-badge--${agent.class}`;
        const avatarContent = agent.logo
            ? `<img src="${agent.logo}" alt="${agent.name}" style="width:16px;height:16px;object-fit:contain;">`
            : agent.letter;
        badge.innerHTML = `
            <span class="agent-avatar">${avatarContent}</span>
            <span class="agent-name">${agent.name}</span>
            <span class="agent-role">${agent.role}</span>
        `;
    }
}

// ─── Activity Feed ────────────────────────────────────────────────────────

/**
 * Append a timestamped log entry to a container and the activity feed.
 * Auto-opens the parent <details> element and removes placeholders.
 * @param {string} containerId - DOM id of the log container.
 * @param {string} message
 */
export function appendLog(containerId, message) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Remove empty-state placeholder if present
    const placeholder = container.querySelector('.log-placeholder');
    if (placeholder) placeholder.remove();

    // Auto-open parent <details> on first real log entry
    const details = container.closest('details');
    if (details && !details.open) details.open = true;

    const entry = document.createElement('div');
    entry.className = 'agent-log-entry';
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.innerHTML = `<span class="log-time">${time}</span> ${escapeHtml(message)}`;
    container.appendChild(entry);
    const scrollable = container.closest('.agent-log') || container;
    scrollable.scrollTop = scrollable.scrollHeight;
    // Also append to activity feed
    appendToActivityFeed(null, message);
}

/**
 * Append a message to the global activity feed.
 * @param {string|null} agentName
 * @param {string} message
 */
export function appendToActivityFeed(agentName, message) {
    const feed = document.getElementById('activityFeedEntries');
    if (!feed) return;
    const placeholder = feed.querySelector('.activity-feed-entry');
    if (placeholder && placeholder.textContent === 'Waiting for activity...') {
        placeholder.remove();
    }
    const entry = document.createElement('div');
    entry.className = 'activity-feed-entry';
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const agentClass = agentName ? agentName.toLowerCase().replace(/\s+/g, '') : '';
    entry.innerHTML = `<span class="log-time">${time}</span>${agentName ? ` <span class="activity-agent ${agentClass}">${escapeHtml(agentName)}:</span>` : ''} ${escapeHtml(message)}`;
    feed.appendChild(entry);
    feed.scrollTop = feed.scrollHeight;
    while (feed.children.length > 50) feed.removeChild(feed.firstChild);
}

/**
 * Toggle the activity feed expanded/collapsed state.
 */
export function toggleActivityFeed() {
    const feed = document.getElementById('activityFeed');
    if (feed) feed.classList.toggle('expanded');
}

// ─── Loop Header & Navigation ─────────────────────────────────────────────

// Phase navigation (legacy header tabs)
let activePhase = 'meeting';
let completedPhases = new Set();

/**
 * Show or hide the loop header (iteration info vs phase tabs).
 * @param {boolean} show
 */
export function showLoopHeader(show) {
    const phaseNav = document.getElementById('phaseNav');
    const loopInfo = document.getElementById('loopHeaderInfo');
    const newMeetingBtn = document.getElementById('btnNewMeeting');
    const statusBadge = document.getElementById('statusBadge');
    if (show) {
        if (phaseNav) phaseNav.style.display = 'none';
        if (loopInfo) {
            loopInfo.style.display = 'flex';
            document.getElementById('loopMeetingName').textContent = store.get('meeting.name') || 'Meeting';
            document.getElementById('iterationBadge').textContent = `⟳ Iteration #${store.get('meeting.iteration') || 1}`;
        }
        if (newMeetingBtn) newMeetingBtn.style.display = '';
        if (statusBadge) statusBadge.style.display = 'none';
    } else {
        if (phaseNav) phaseNav.style.display = 'flex';
        if (loopInfo) loopInfo.style.display = 'none';
        if (newMeetingBtn) newMeetingBtn.style.display = 'none';
        if (statusBadge) statusBadge.style.display = '';
    }
}

/**
 * Set the active phase tab in the header navigation.
 * @param {string} phase
 */
export function setActivePhase(phase) {
    activePhase = phase;
    const phases = ['meeting', 'analyze', 'build', 'verify'];
    const tabs = document.querySelectorAll('.phase-tab');
    const connectors = document.querySelectorAll('.phase-connector');
    const activeIdx = phases.indexOf(phase);

    tabs.forEach(tab => {
        const p = tab.dataset.phase;
        const idx = phases.indexOf(p);
        tab.classList.remove('active', 'completed');
        if (idx < activeIdx || completedPhases.has(p)) tab.classList.add('completed');
        if (idx === activeIdx) tab.classList.add('active');
    });
    connectors.forEach((conn, i) => {
        conn.classList.toggle('completed', i < activeIdx);
    });
}

/**
 * Mark a phase as completed and refresh tabs.
 * @param {string} phase
 */
export function markPhaseCompleted(phase) {
    completedPhases.add(phase);
    setActivePhase(activePhase);
}

/**
 * Helper to map QA sub-phases to the verify phase tab.
 * @param {string} phase
 */
export function setQAStep(phase) {
    if (phase === 'deploy' || phase === 'validate') {
        setActivePhase('verify');
    } else if (phase === 'complete') {
        markPhaseCompleted('verify');
    }
}

/** @returns {string} The currently active phase. */
export function getActivePhase() { return activePhase; }

/** @returns {Set<string>} The set of completed phases. */
export function getCompletedPhases() { return completedPhases; }

// ─── Keyboard handler ─────────────────────────────────────────────────────

/**
 * Initialise global keyboard shortcuts (Escape to close slide-over).
 */
export function initStageController() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && store.get('detailPanelOpen')) {
            closeStageDetail();
        }
    });
}
