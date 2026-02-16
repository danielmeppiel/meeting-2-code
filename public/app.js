/* ═══════════════════════════════════════════════════════════════════════════
   Meeting → Ship | Application Logic
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── State ────────────────────────────────────────────────────────────────────
let gaps = [];
let requirements = [];
let createdIssues = [];
let currentStep = 1;
let analysisComplete = false;
let analysisPhase = 'idle'; // 'idle' | 'extracting' | 'selecting' | 'analyzing' | 'reviewed'
let epicIssueNumber = 0;
let epicIssueUrl = '';
let deployedUrl = '';
let validationResults = [];
let qaMode = false;
let previousPanel = 'panel-analyze';
let activePhase = 'meeting'; // 'meeting' | 'analyze' | 'build' | 'verify'
let completedPhases = new Set();

// ─── Loop State ───────────────────────────────────────────────────────────────
const loopState = {
    meetingName: '',
    iteration: 1,
    activeStage: null, // 'meet' | 'analyze' | 'build' | 'verify' | null
    stages: {
        meet:    { status: 'idle', metrics: {}, startTime: null, endTime: null },
        analyze: { status: 'idle', metrics: {}, startTime: null, endTime: null },
        build:   { status: 'idle', metrics: {}, startTime: null, endTime: null },
        verify:  { status: 'idle', metrics: {}, startTime: null, endTime: null },
    },
    detailPanelOpen: null, // 'meet' | 'analyze' | 'build' | 'verify' | null
};

function updateLoopState(patch) {
    // Deep merge patch into loopState
    if (patch.meetingName !== undefined) loopState.meetingName = patch.meetingName;
    if (patch.iteration !== undefined) loopState.iteration = patch.iteration;
    if (patch.activeStage !== undefined) loopState.activeStage = patch.activeStage;
    if (patch.detailPanelOpen !== undefined) loopState.detailPanelOpen = patch.detailPanelOpen;
    if (patch.stages) {
        for (const [stage, data] of Object.entries(patch.stages)) {
            if (loopState.stages[stage]) {
                if (data.status !== undefined) loopState.stages[stage].status = data.status;
                if (data.startTime !== undefined) loopState.stages[stage].startTime = data.startTime;
                if (data.endTime !== undefined) loopState.stages[stage].endTime = data.endTime;
                if (data.metrics) {
                    loopState.stages[stage].metrics = { ...loopState.stages[stage].metrics, ...data.metrics };
                }
            }
        }
    }
    renderLoopNodes();
    // Refresh header if meetingName or iteration changed and header is visible
    if (patch.meetingName !== undefined || patch.iteration !== undefined) {
        const loopInfo = document.getElementById('loopHeaderInfo');
        if (loopInfo && loopInfo.style.display !== 'none') {
            document.getElementById('loopMeetingName').textContent = loopState.meetingName || 'Meeting';
            document.getElementById('iterationBadge').textContent = `⟳ Iteration #${loopState.iteration || 1}`;
        }
    }
}

function renderLoopNodes() {
    const stageNames = ['meet', 'analyze', 'build', 'verify'];
    stageNames.forEach(stage => {
        const card = document.querySelector(`.stage-node--${stage}`);
        if (!card) return;

        const stageData = loopState.stages[stage];

        // Remove all state classes, then add the current one
        card.classList.remove('stage-node--idle', 'stage-node--waiting', 'stage-node--active', 'stage-node--complete', 'stage-node--error');
        card.classList.add(`stage-node--${stageData.status}`);

        // Update metrics
        const primaryMetric = card.querySelector('[data-metric="primary"]');
        const secondaryMetric = card.querySelector('[data-metric="secondary"]');
        if (primaryMetric) {
            primaryMetric.textContent = stageData.metrics.primary || '—';
        }
        if (secondaryMetric) {
            secondaryMetric.textContent = stageData.metrics.secondary || '—';
        }

        // Update status text
        const statusText = card.querySelector('.stage-node-status-text');
        if (statusText) {
            const statusLabels = {
                idle: 'Idle',
                waiting: 'Waiting...',
                active: 'In Progress',
                complete: 'Complete ✓',
                error: 'Error',
            };
            statusText.textContent = stageData.metrics.statusText || statusLabels[stageData.status] || 'Idle';
        }

        // Update icon
        const icon = card.querySelector('.stage-node-icon');
        if (icon) {
            const icons = {
                idle: '◉',
                waiting: '◉',
                active: '⟳',
                complete: '✓',
                error: '✗',
            };
            icon.textContent = icons[stageData.status] || '◉';
        }

        // Update action button area
        const actionArea = card.querySelector('.stage-node-action');
        if (actionArea) {
            renderStageAction(stage, stageData, actionArea);
        }
    });

    // Sync particle system with active stage
    if (loopParticles) {
        loopParticles.setActiveStage(loopState.activeStage);
    }
}

/**
 * Render context-aware action buttons on stage node cards.
 * These let users control the flow directly from the loop without opening the slide-over.
 */
function renderStageAction(stage, stageData, actionArea) {
    // Clear previous
    actionArea.innerHTML = '';

    if (stage === 'analyze' && stageData.status === 'waiting') {
        // Meet completed → user can analyze all requirements from the loop
        const count = requirements.length;
        if (count > 0) {
            const btn = document.createElement('button');
            btn.className = 'stage-node-action-btn pulse';
            btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg> Analyze ${count}`;
            btn.onclick = (e) => {
                e.stopPropagation();
                // Select all requirements then start gap analysis
                document.querySelectorAll('.unified-row input[type="checkbox"]').forEach(cb => { cb.checked = true; });
                if (typeof updateAnalyzeCount === 'function') updateAnalyzeCount();
                startGapAnalysis();
            };
            actionArea.appendChild(btn);
        }
    } else if (stage === 'build' && stageData.status === 'waiting') {
        // Analyze completed → user can dispatch from the loop
        const actionableGaps = gaps.filter(g => g.hasGap);
        const count = actionableGaps.length;
        if (count > 0) {
            const btn = document.createElement('button');
            btn.className = 'stage-node-action-btn pulse';
            btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg> Dispatch ${count}`;
            btn.onclick = (e) => {
                e.stopPropagation();
                // Select all gap-found items then dispatch
                gaps.forEach(g => { if (g.hasGap) g.selected = true; });
                dispatchSelected();
            };
            actionArea.appendChild(btn);
        }
    } else if (stage === 'verify' && stageData.status === 'waiting') {
        // Build completed → user can ship & validate from the loop
        const btn = document.createElement('button');
        btn.className = 'stage-node-action-btn pulse';
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg> Ship & Validate`;
        btn.onclick = (e) => {
            e.stopPropagation();
            qaMode = true;
            try { buildQAGapTable(); } catch(_) {}
            showPanel('panel-qa');
            launchQAWorkflow();
        };
        actionArea.appendChild(btn);
    }
}

function advanceStage(from, to) {
    const now = Date.now();
    const patch = { activeStage: to, stages: {} };
    if (from && loopState.stages[from]) {
        patch.stages[from] = { status: 'complete', endTime: now };
    }
    if (to && loopState.stages[to]) {
        patch.stages[to] = { status: 'active', startTime: now };
    }
    updateLoopState(patch);
    // Placeholder for particle burst (Task 8 will implement)
    if (typeof triggerParticleBurst === 'function') {
        triggerParticleBurst(from, to);
    }
}

// ─── Particle Animation System (TASK 8 + TASK 9) ─────────────────────────────

class LoopParticleSystem {
    constructor() {
        this.pathEl = document.getElementById('loop-path');
        this.container = document.getElementById('loopParticles');
        this.particles = [];
        this.animationId = null;
        this.lastTimestamp = 0;
        this.running = false;
        this.activeStage = null;
        this.totalLength = 0;

        // Stage color mapping
        this.stageColors = {
            meet: '#3b82f6',
            analyze: '#f59e0b',
            build: '#10b981',
            verify: '#8b5cf6',
        };

        // Segment boundaries (fraction of total path length)
        // The figure-8 path goes: Meet(top-left) → Analyze(bottom-left) → center → Build(top-right) → Verify(bottom-right) → center → back
        // Approximate 4 equal quarters
        this.segments = {
            meet:    { start: 0.00, end: 0.25 },
            analyze: { start: 0.25, end: 0.50 },
            build:   { start: 0.50, end: 0.75 },
            verify:  { start: 0.75, end: 1.00 },
        };
    }

    init() {
        if (!this.pathEl || !this.container) return;
        this.totalLength = this.pathEl.getTotalLength();
        this._createParticles(14);
    }

    _createParticles(count) {
        for (let i = 0; i < count; i++) {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('r', '4');
            circle.setAttribute('fill', '#ffffff');
            circle.setAttribute('opacity', '0');
            circle.classList.add('loop-particle');
            this.container.appendChild(circle);

            this.particles.push({
                element: circle,
                offset: (i / count) * this.totalLength,
                speed: 50 + Math.random() * 25, // px per second
                baseSpeed: 50 + Math.random() * 25,
                radius: 3 + Math.random() * 2.5,
                opacity: 0.7 + Math.random() * 0.3,
            });
        }
    }

    start(activeStage) {
        if (!this.pathEl || this.running) return;
        this.activeStage = activeStage;
        this.running = true;
        this.lastTimestamp = performance.now();

        // Make particles visible
        this.particles.forEach(p => {
            p.element.setAttribute('opacity', String(p.opacity));
            p.element.setAttribute('r', String(p.radius));
        });

        this.animationId = requestAnimationFrame((t) => this._animate(t));
    }

    stop() {
        this.running = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        // Fade particles out
        this.particles.forEach(p => {
            p.element.setAttribute('opacity', '0');
        });
    }

    setActiveStage(stage) {
        this.activeStage = stage;
        if (stage && !this.running) {
            this.start(stage);
        } else if (!stage) {
            this.stop();
        }
    }

    _getSegmentForOffset(normalizedOffset) {
        for (const [name, seg] of Object.entries(this.segments)) {
            if (normalizedOffset >= seg.start && normalizedOffset < seg.end) {
                return name;
            }
        }
        return 'meet'; // wrap-around
    }

    _getColorForOffset(normalizedOffset) {
        const segment = this._getSegmentForOffset(normalizedOffset);
        return this.stageColors[segment] || '#ffffff';
    }

    _isInActiveSegment(normalizedOffset) {
        if (!this.activeStage) return false;
        const seg = this.segments[this.activeStage];
        return normalizedOffset >= seg.start && normalizedOffset < seg.end;
    }

    _animate(timestamp) {
        if (!this.running) return;

        const delta = Math.min(timestamp - this.lastTimestamp, 50); // Cap delta to prevent jumps
        this.lastTimestamp = timestamp;

        this.particles.forEach(p => {
            const normalizedOffset = p.offset / this.totalLength;
            const inActive = this._isInActiveSegment(normalizedOffset);

            // Speed modulation: 2x in active segment
            const currentSpeed = inActive ? p.baseSpeed * 2 : p.baseSpeed;
            p.offset = (p.offset + currentSpeed * delta * 0.001) % this.totalLength;

            // Position
            const point = this.pathEl.getPointAtLength(p.offset);
            p.element.setAttribute('cx', point.x);
            p.element.setAttribute('cy', point.y);

            // Color based on segment
            const color = this._getColorForOffset(p.offset / this.totalLength);
            p.element.setAttribute('fill', color);

            // Size modulation: larger in active segment
            const size = inActive ? p.radius * 1.8 : p.radius;
            p.element.setAttribute('r', String(size));

            // Opacity modulation
            const opacity = inActive ? Math.min(p.opacity * 1.4, 1) : p.opacity * 0.6;
            p.element.setAttribute('opacity', String(opacity));
        });

        this.animationId = requestAnimationFrame((t) => this._animate(t));
    }

    // ── TASK 9: Handoff burst ──
    triggerBurst(fromStage, toStage) {
        if (!this.pathEl || !this.container) return;

        const fromSeg = this.segments[fromStage];
        const toSeg = this.segments[toStage];
        if (!fromSeg || !toSeg) return;

        // Create 4 burst particles at the fromStage position
        const startOffset = fromSeg.end * this.totalLength;
        const burstParticles = [];

        for (let i = 0; i < 4; i++) {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            const r = i === 0 ? 7 : 4; // lead particle is bigger
            circle.setAttribute('r', String(r));
            circle.setAttribute('fill', this.stageColors[fromStage] || '#fff');
            circle.setAttribute('opacity', i === 0 ? '1' : '0.7');
            circle.classList.add('loop-particle', 'loop-particle--burst');
            this.container.appendChild(circle);
            burstParticles.push({
                element: circle,
                offset: startOffset + (i * -8), // staggered start
                speed: 120 + i * 15, // lead is fastest
                targetOffset: toSeg.start * this.totalLength,
            });
        }

        // Animate burst particles along path toward target
        let burstStart = performance.now();
        const animateBurst = (timestamp) => {
            const elapsed = timestamp - burstStart;
            let allArrived = true;

            burstParticles.forEach(bp => {
                bp.offset = (bp.offset + bp.speed * 16 * 0.001) % this.totalLength;
                const point = this.pathEl.getPointAtLength(bp.offset);
                bp.element.setAttribute('cx', point.x);
                bp.element.setAttribute('cy', point.y);

                // Fade out as they approach target
                const fadeProgress = Math.min(elapsed / 800, 1);
                bp.element.setAttribute('opacity', String(Math.max(1 - fadeProgress, 0)));

                if (elapsed < 800) allArrived = false;
            });

            if (!allArrived) {
                requestAnimationFrame(animateBurst);
            } else {
                // Clean up burst particles
                burstParticles.forEach(bp => bp.element.remove());
                // Trigger crossover flash at center if crossing lobes
                this._triggerCrossoverFlash();
            }
        };
        requestAnimationFrame(animateBurst);

        // Ensure the particle system is running for the new stage
        if (toStage) this.setActiveStage(toStage);
    }

    // ── TASK 9: Crossover flash ──
    _triggerCrossoverFlash() {
        const loopContainer = document.querySelector('.loop-container');
        if (!loopContainer) return;

        const flash = document.createElement('div');
        flash.className = 'loop-crossover-burst';
        loopContainer.appendChild(flash);

        // Remove after animation completes
        flash.addEventListener('animationend', () => flash.remove());
    }

    // Celebratory full-loop sweep
    celebratoryLoop() {
        if (!this.pathEl) return;
        const sweep = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        sweep.setAttribute('r', '8');
        sweep.setAttribute('fill', '#ffffff');
        sweep.setAttribute('opacity', '1');
        sweep.classList.add('loop-particle', 'loop-particle--celebration');
        this.container.appendChild(sweep);

        let offset = 0;
        const totalLen = this.totalLength;
        const speed = 200; // fast sweep

        const animateSweep = (timestamp) => {
            offset += speed * 16 * 0.001;
            if (offset >= totalLen) {
                sweep.remove();
                return;
            }
            const point = this.pathEl.getPointAtLength(offset);
            sweep.setAttribute('cx', point.x);
            sweep.setAttribute('cy', point.y);
            sweep.setAttribute('fill', this._getColorForOffset(offset / totalLen));
            const fadeOut = Math.max(1 - (offset / totalLen) * 0.3, 0.5);
            sweep.setAttribute('opacity', String(fadeOut));
            requestAnimationFrame(animateSweep);
        };
        requestAnimationFrame(animateSweep);
    }
}

// Global particle system instance
let loopParticles = null;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    loopParticles = new LoopParticleSystem();
    loopParticles.init();
});

// Global function called by advanceStage()
function triggerParticleBurst(fromStage, toStage) {
    if (loopParticles) {
        loopParticles.triggerBurst(fromStage, toStage);
    }
}

// ─── Meeting Input Wiring ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('meetingNameInput');
    const btn = document.getElementById('btnAnalyze');
    if (input && btn) {
        input.addEventListener('input', () => {
            btn.disabled = !input.value.trim();
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && input.value.trim()) {
                startAnalysis();
            }
        });
    }
});

// ─── Panel Management ─────────────────────────────────────────────────────────
function showPanel(panelId) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(panelId);
    if (panel) {
        panel.classList.add('active');
        panel.style.animation = 'none';
        panel.offsetHeight;
        panel.style.animation = '';
    }
    previousPanel = panelId;
}

function setStep(step) {
    currentStep = step;
    // Map old step numbers to phases
    const stepToPhase = { 1: 'meeting', 2: 'analyze', 3: 'build' };
    const phase = stepToPhase[step];
    if (phase) {
        setActivePhase(phase);
    }
}

function setActivePhase(phase) {
    activePhase = phase;
    const phases = ['meeting', 'analyze', 'build', 'verify'];
    const tabs = document.querySelectorAll('.phase-tab');
    const connectors = document.querySelectorAll('.phase-connector');
    const activeIdx = phases.indexOf(phase);

    tabs.forEach(tab => {
        const p = tab.dataset.phase;
        const idx = phases.indexOf(p);
        tab.classList.remove('active', 'completed');
        if (idx < activeIdx || completedPhases.has(p)) {
            tab.classList.add('completed');
        }
        if (idx === activeIdx) {
            tab.classList.add('active');
        }
    });
    connectors.forEach((conn, i) => {
        conn.classList.toggle('completed', i < activeIdx);
    });
}

function markPhaseCompleted(phase) {
    completedPhases.add(phase);
    setActivePhase(activePhase); // refresh display
}

// Legacy QA step indicator — keeps verify phase active during deploy/validate sub-steps
function setQAStep(phase) {
    // phase: null | 'deploy' | 'validate' | 'complete'
    if (phase === 'deploy' || phase === 'validate') {
        setActivePhase('verify');
    } else if (phase === 'complete') {
        markPhaseCompleted('verify');
    }
}

function setStatus(text, type = '') {
    const badge = document.getElementById('statusBadge');
    const statusText = badge.querySelector('.status-text');
    badge.className = 'status-badge ' + type;
    statusText.textContent = text;
}

// ─── Streaming Log ────────────────────────────────────────────────────────────
function appendLog(containerId, message) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const entry = document.createElement('div');
    entry.className = 'agent-log-entry';
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.innerHTML = `<span class="log-time">${time}</span> ${escapeHtml(message)}`;
    container.appendChild(entry);
    // Scroll the parent .agent-log container (which has overflow-y: auto)
    const scrollable = container.closest('.agent-log') || container;
    scrollable.scrollTop = scrollable.scrollHeight;
    // Also append to the activity feed on the loop view
    appendToActivityFeed(null, message);
}

function appendToActivityFeed(agentName, message) {
    const feed = document.getElementById('activityFeedEntries');
    if (!feed) return;
    // Remove placeholder
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
    // Keep only last 50 entries
    while (feed.children.length > 50) feed.removeChild(feed.firstChild);
}

function toggleActivityFeed() {
    const feed = document.getElementById('activityFeed');
    if (feed) feed.classList.toggle('expanded');
}

// ─── Agent Identity ─────────────────────────────────────────────────────────────
const AGENTS = {
    extractor: { name: 'WorkIQ', role: 'Requirements Agent', letter: 'W', class: 'extractor', logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Microsoft_Office_logo_%282013%E2%80%932019%29.svg/120px-Microsoft_Office_logo_%282013%E2%80%932019%29.svg.png' },
    analyzer:  { name: 'Analyzer',  role: 'Gap Analysis Agent', letter: 'A', class: 'analyzer' },
    builder:   { name: 'Builder',   role: 'Build Agent',        letter: 'B', class: 'builder' },
    deployer:  { name: 'Deployer',  role: 'Deploy Agent',       letter: 'D', class: 'deployer', logo: 'https://cdn.worldvectorlogo.com/logos/azure-1.svg' },
    validator: { name: 'Validator', role: 'QA Agent',           letter: 'V', class: 'validator' },
};

function setActiveAgent(agentKey) {
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

// ─── Toast Notifications ──────────────────────────────────────────────────────
function showToast(message, type = 'error') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-message';
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => toast.remove();
    toast.appendChild(closeBtn);

    document.body.appendChild(toast);

    // Errors stay until dismissed; others auto-dismiss
    if (type !== 'error') {
        setTimeout(() => toast.remove(), 6000);
    }
}

// ─── No-Gap Detection ─────────────────────────────────────────────────────────
function isNoGap(gap) {
    const text = (gap.gap || '').toLowerCase();
    const patterns = [
        'no gap', 'none', 'no changes needed', 'already implemented',
        'fully implemented', 'no action', 'requirement met', 'requirement is met',
        'no modification', 'no work needed', 'n/a', 'not applicable',
        'already exists', 'already in place', 'no additional', 'fully met',
        'compliant', 'complete as-is', 'nothing to', 'no missing',
    ];
    return patterns.some(p => text.includes(p));
}

// ─── Meeting Banner Toggle ──────────────────────────────────────────────────
let meetingInfoCache = null;
function toggleMeetingBanner() {
    const brand = document.getElementById('meetingSourceBrand');
    if (!brand) return;
    brand.classList.toggle('expanded');
}

function populateMeetingBanner(info) {
    meetingInfoCache = info;
    const titleEl = document.getElementById('meetingDetailTitle');
    const dateEl = document.getElementById('meetingDetailDate');
    const participantsEl = document.getElementById('meetingDetailParticipants');
    const summaryEl = document.getElementById('meetingDetailSummary');
    if (titleEl) titleEl.innerHTML = info.title ? `<strong>Title:</strong> ${escapeHtml(info.title)}` : '';
    if (dateEl) dateEl.innerHTML = info.date ? `<strong>Date:</strong> ${escapeHtml(info.date)}` : '';
    if (participantsEl && info.participants && info.participants.length > 0) {
        participantsEl.innerHTML = `<strong>Participants:</strong> ${info.participants.map(p => escapeHtml(p)).join(', ')}`;
    }
    if (summaryEl && info.summary) {
        summaryEl.innerHTML = `<strong>Summary:</strong> ${escapeHtml(info.summary)}`;
    }
}

// ─── Step 1: Analyze Meeting ──────────────────────────────────────────────────
const stepIds = ['ls-fetch', 'ls-extract', 'ls-requirements', 'ls-analyze'];

function markStep(stepNum) {
    stepIds.forEach((id, i) => {
        const el = document.getElementById(id);
        el.classList.remove('active');
        el.querySelector('.loading-step-icon').classList.remove('spinner');
        if (i < stepNum) {
            el.classList.add('done');
        } else if (i === stepNum) {
            el.classList.add('active');
            el.querySelector('.loading-step-icon').classList.add('spinner');
        }
    });
}

function markAllStepsDone() {
    stepIds.forEach(id => {
        const el = document.getElementById(id);
        el.classList.remove('active');
        el.classList.add('done');
        el.querySelector('.loading-step-icon').classList.remove('spinner');
    });
}

async function startAnalysis() {
    const input = document.getElementById('meetingNameInput');
    const meetingName = input ? input.value.trim() : '';
    if (!meetingName) return;

    const btn = document.getElementById('btnAnalyze');
    btn.disabled = true;
    analysisComplete = false;
    analysisPhase = 'extracting';

    setStatus('Analyzing...', 'processing');
    // Update loop state — Meet stage starting
    updateLoopState({
        meetingName: meetingName,
        activeStage: 'meet',
        stages: { meet: { status: 'active', startTime: Date.now(), metrics: { primary: 'Extracting...', secondary: '', statusText: 'WorkIQ Running' } } }
    });
    showPanel('panel-loop');
    showLoopHeader(true);

    // Auto-open the Meet stage slide-over so user sees progress immediately
    setTimeout(() => openStageDetail('meet'), 400);

    // Reset progress steps
    stepIds.forEach(s => {
        const el = document.getElementById(s);
        el.classList.remove('active', 'done');
        el.querySelector('.loading-step-icon').classList.remove('spinner');
    });

    // Reset unified table
    document.getElementById('unifiedTableContainer').style.display = 'none';
    document.getElementById('unifiedTableBody').innerHTML = '';
    document.getElementById('reqCount').textContent = '0';
    document.getElementById('gapAnalyzedCount').textContent = '0';
    document.getElementById('tableActions').style.display = 'none';
    document.getElementById('colCheckHeader').style.display = 'none';
    document.getElementById('btnAnalyzeGaps').style.display = '';
    document.getElementById('btnCreateIssues').style.display = 'none';
    document.getElementById('btnAnalyzeSkipped').style.display = 'none';

    // Reset epic link
    document.getElementById('epicLink').style.display = 'none';
    epicIssueNumber = 0;
    epicIssueUrl = '';

    // Show meeting card with initial state
    const liveRight = document.getElementById('liveRightPanel');
    if (liveRight) liveRight.style.display = '';
    const meetingSourceBrand = document.getElementById('meetingSourceBrand');
    if (meetingSourceBrand) {
        meetingSourceBrand.style.display = 'none';
        meetingSourceBrand.classList.remove('expanded');
    }
    const meetingCard = document.getElementById('meetingCard');
    meetingCard.style.display = 'flex';
    meetingCard.classList.remove('found');
    document.getElementById('meetingCardIcon').className = 'meeting-card-icon';
    document.getElementById('meetingCardTitle').textContent = 'WorkIQ is connecting to M365...';
    document.getElementById('meetingCardDate').textContent = '';
    document.getElementById('meetingCardParticipants').style.display = 'none';
    document.getElementById('meetingCardAgent').style.display = 'none';
    document.getElementById('meetingCardStatusRow').style.display = 'flex';
    document.getElementById('meetingCardStatus').textContent = 'WorkIQ is initializing...';

    // Reset agent log
    document.getElementById('agentLogEntries').innerHTML = '';

    requirements = [];
    gaps = [];

    markStep(0);

    try {
        const result = await new Promise((resolve, reject) => {
            const eventSource = new EventSource('/api/analyze?meeting=' + encodeURIComponent(meetingName));

            eventSource.addEventListener('progress', (e) => {
                const { step, message } = JSON.parse(e.data);
                console.log(`[Progress] Step ${step}: ${message}`);
                markStep(step);
                const progressMessages = ['Connecting...', 'Fetching data...', 'Extracting requirements...', 'Creating epic...'];
                updateLoopState({ stages: { meet: { metrics: { statusText: progressMessages[step] || 'Processing...' } } } });

                // Keep meeting card in sync with progress steps
                const cardTitle = document.getElementById('meetingCardTitle');
                const cardStatus = document.getElementById('meetingCardStatus');
                if (step === 0) {
                    cardTitle.textContent = 'WorkIQ is searching for meeting...';
                    cardStatus.textContent = 'Connected to WorkIQ';
                    setActiveAgent('extractor');
                } else if (step === 1) {
                    cardTitle.textContent = 'Meeting Found by WorkIQ';
                    cardStatus.textContent = 'Fetching meeting data...';
                } else if (step === 2) {
                    cardStatus.textContent = 'WorkIQ is extracting requirements...';
                } else if (step === 3) {
                    cardStatus.textContent = 'WorkIQ is creating epic issue...';
                }
            });

            eventSource.addEventListener('meeting-info', (e) => {
                const info = JSON.parse(e.data);
                const card = document.getElementById('meetingCard');
                card.style.display = 'flex';
                card.classList.add('found');
                // Show Office branding
                const meetingBrand = document.getElementById('meetingSourceBrand');
                if (meetingBrand) meetingBrand.style.display = 'flex';
                // Populate expandable meeting banner details
                populateMeetingBanner(info);
                const iconEl = document.getElementById('meetingCardIcon');
                iconEl.className = 'meeting-card-icon found';
                iconEl.innerHTML = `<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Microsoft_Office_logo_%282013%E2%80%932019%29.svg/120px-Microsoft_Office_logo_%282013%E2%80%932019%29.svg.png" alt="Microsoft Office" width="48" height="48" style="object-fit: contain;" class="office-logo-img">`;
                document.getElementById('meetingCardTitle').textContent = 'Meeting Found by WorkIQ';
                if (info.date) {
                    document.getElementById('meetingCardDate').textContent = info.date;
                }
                if (info.title) {
                    const dateEl = document.getElementById('meetingCardDate');
                    dateEl.textContent = (info.date ? info.date + '  ·  ' : '') + info.title;
                }
                if (info.participants && info.participants.length > 0) {
                    const el = document.getElementById('meetingCardParticipants');
                    el.style.display = 'flex';
                    el.innerHTML = info.participants.map(p => `<span class="participant-chip">${escapeHtml(p)}</span>`).join('');
                }
                updateLoopState({ stages: { meet: { metrics: { secondary: info.date || '' } } } });
                // Show agent attribution
                const agentAttr = document.getElementById('meetingCardAgent');
                if (agentAttr) agentAttr.style.display = 'flex';
                document.getElementById('meetingCardStatus').textContent = info.requirementCount
                    ? `WorkIQ processing ${info.requirementCount} requirements...`
                    : 'WorkIQ processing requirements...';
            });

            eventSource.addEventListener('requirements', (e) => {
                const data = JSON.parse(e.data);
                requirements = data.requirements;
                updateLoopState({ stages: { meet: { metrics: { primary: `${requirements.length} requirements` } } } });
                console.log(`[Requirements] ${requirements.length} items`);
                updateQAFabVisibility();
                // Hide meeting card, show table with checkboxes
                document.getElementById('meetingCard').style.display = 'none';
                renderRequirementsForSelection(requirements);
            });

            eventSource.addEventListener('epic-created', (e) => {
                const { number, url } = JSON.parse(e.data);
                epicIssueNumber = number;
                epicIssueUrl = url;
                if (number > 0) {
                    const link = document.getElementById('epicLink');
                    link.href = url;
                    link.style.display = 'inline-flex';
                    document.getElementById('epicNumber').textContent = number;
                }
            });

            eventSource.addEventListener('log', (e) => {
                const { message } = JSON.parse(e.data);
                appendLog('agentLogEntries', message);
            });

            eventSource.addEventListener('complete', (e) => {
                eventSource.close();
                const data = JSON.parse(e.data);
                // Mark steps 0-3 done (extraction + epic), leave step 4 for user-triggered gap analysis
                [0, 1, 2, 3].forEach(i => {
                    const el = document.getElementById(stepIds[i]);
                    el.classList.remove('active');
                    el.classList.add('done');
                    el.querySelector('.loading-step-icon').classList.remove('spinner');
                });
                // Advance loop state: Meet complete
                updateLoopState({ stages: { meet: { status: 'complete', endTime: Date.now(), metrics: { statusText: 'Complete ✓', primary: `${requirements.length} requirements` } } } });
                resolve(data);
            });

            eventSource.addEventListener('error', (e) => {
                if (e.data) {
                    eventSource.close();
                    const data = JSON.parse(e.data);
                    reject(new Error(data.error || 'Analysis failed'));
                    return;
                }
                eventSource.close();
                reject(new Error('Connection to server lost during analysis'));
            });
        });

        if (!result.success) throw new Error('Extraction failed');

        // Extraction done — enter selection phase
        analysisPhase = 'selecting';
        setStatus(`${requirements.length} Requirements`, '');
        setStep(2);
    // Set Analyze as waiting since user needs to select and click "Analyze Gaps"
    updateLoopState({ stages: { analyze: { status: 'waiting', metrics: { primary: 'Select & Analyze', statusText: 'Waiting...' } } } });

    } catch (error) {
        showToast(error.message);
        setStatus('Error', 'error');
        showPanel('panel-analyze');
        btn.disabled = false;
        analysisPhase = 'idle';
    }
}

// ─── Render requirements for user selection (before gap analysis) ─────────────

function renderRequirementsForSelection(reqs) {
    const container = document.getElementById('unifiedTableContainer');
    const count = document.getElementById('reqCount');

    container.style.display = '';
    count.textContent = reqs.length;

    // Show the table directly (no cards)
    const tableEl = document.getElementById('unifiedTable');
    if (tableEl) tableEl.style.display = '';
    const tableContainer = container.querySelector('.table-container');
    if (tableContainer) tableContainer.style.display = '';

    // Remove any existing card container from previous render
    const oldCardContainer = document.getElementById('reqCardContainer');
    if (oldCardContainer) oldCardContainer.remove();

    const tbody = document.getElementById('unifiedTableBody');
    tbody.innerHTML = '';

    reqs.forEach((req, i) => {
        const tr = document.createElement('tr');
        tr.id = `unified-row-${i}`;
        tr.dataset.index = i;
        tr.classList.add('unified-row', 'selected');
        tr.style.animationDelay = `${i * 0.04}s`;

        tr.innerHTML = `
            <td class="col-check">
                <label class="checkbox-wrapper">
                    <input type="checkbox" data-gap-index="${i}" checked onchange="handleCheckboxChange(${i})">
                    <span class="checkmark"></span>
                </label>
            </td>
            <td class="col-req"><div class="td-requirement" onclick="toggleReqExpand(${i})">${escapeHtml(req)}</div></td>
            <td class="col-status"><span class="status-chip pending">Pending</span></td>
            <td class="col-complexity"><span class="cell-pending">\u2014</span></td>
            <td class="col-agent-type" style="display:none;"><span class="cell-pending">\u2014</span></td>
        `;

        const detailTr = document.createElement('tr');
        detailTr.id = `unified-detail-${i}`;
        detailTr.className = 'row-details-expandable';
        detailTr.innerHTML = `
            <td colspan="5">
                <div class="detail-grid">
                    <div class="detail-item" data-field="currentState">
                        <span class="detail-label">Current State</span>
                        <span class="detail-value">\u2014</span>
                    </div>
                    <div class="detail-item" data-field="gap">
                        <span class="detail-label">Gap Analysis</span>
                        <span class="detail-value">\u2014</span>
                    </div>
                    <div class="detail-item" data-field="effort">
                        <span class="detail-label">Estimated Effort</span>
                        <span class="detail-value">\u2014</span>
                    </div>
                    <div class="detail-item detail-item-full" data-field="details" style="display:none;">
                        <span class="detail-label">Implementation Details</span>
                        <span class="detail-value"></span>
                    </div>
                </div>
            </td>
        `;

        tbody.appendChild(tr);
        tbody.appendChild(detailTr);
    });

    // Show checkboxes + analyze button immediately
    document.getElementById('colCheckHeader').style.display = '';
    document.getElementById('tableActions').style.display = 'flex';
    document.getElementById('tableActions').style.animation = 'fadeSlideIn 0.4s var(--ease-out)';
    document.getElementById('selectAll').checked = true;
    updateAnalyzeCount();
}

function toggleReqExpand(index) {
    const detailRow = document.getElementById(`unified-detail-${index}`);
    const row = document.getElementById(`unified-row-${index}`);
    if (!detailRow) return;
    detailRow.classList.toggle('show');
    if (row) {
        const reqDiv = row.querySelector('.td-requirement');
        if (reqDiv) reqDiv.classList.toggle('expanded');
    }
}

function updateAnalyzeCount() {
    let count = 0;
    document.querySelectorAll('.unified-row input[type="checkbox"]').forEach(cb => {
        if (cb.checked) count++;
    });
    document.getElementById('analyzeCount').textContent = count;
    document.getElementById('btnAnalyzeGaps').disabled = count === 0;
}

// ─── Step 1b: Gap Analysis for Selected Requirements ──────────────────────────

async function startGapAnalysis() {
    // Gather selected requirement indices
    const selectedIndices = [];
    document.querySelectorAll('.unified-row').forEach((row, i) => {
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb && cb.checked) selectedIndices.push(i);
    });

    if (selectedIndices.length === 0) {
        showToast('Please select at least one requirement to analyze.');
        return;
    }

    analysisPhase = 'analyzing';
    const btn = document.getElementById('btnAnalyzeGaps');
    btn.disabled = true;
    btn.innerHTML = `<div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div> Analyzer processing ${selectedIndices.length}...`;
    setStatus('Analyzer Running...', 'processing');
    setActiveAgent('analyzer');
    // Update loop state — Analyze stage starting
    updateLoopState({
        activeStage: 'analyze',
        stages: { analyze: { status: 'active', startTime: Date.now(), metrics: { primary: `0/${selectedIndices.length} analyzed`, secondary: '', statusText: 'Analyzer Running' } } }
    });

    // Mark selected rows as "Queued", non-selected as "Skipped"
    document.querySelectorAll('.unified-row').forEach((row, i) => {
        const statusCell = row.querySelector('.col-status');
        const cb = row.querySelector('input[type="checkbox"]');
        cb.disabled = true; // Lock checkboxes during analysis
        if (selectedIndices.includes(i)) {
            statusCell.innerHTML = `<span class="status-chip analyzing"><span class="status-chip-dot"></span> Queued</span>`;
        } else {
            statusCell.innerHTML = `<span class="status-chip skipped">Skipped</span>`;
            row.classList.add('no-gap-row');
        }
    });

    let gapAnalyzedCount = 0;

    try {
        const response = await fetch('/api/analyze-gaps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedIndices }),
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Gap analysis failed');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const chunks = buffer.split('\n\n');
            buffer = chunks.pop();

            for (const chunk of chunks) {
                if (!chunk.trim()) continue;
                const lines = chunk.split('\n');
                let eventType = '';
                let eventData = '';
                for (const line of lines) {
                    if (line.startsWith('event: ')) eventType = line.slice(7);
                    if (line.startsWith('data: ')) eventData = line.slice(6);
                }
                if (!eventType || !eventData) continue;

                if (eventType === 'progress') {
                    const { step, message } = JSON.parse(eventData);
                    markStep(step);
                } else if (eventType === 'gap-started') {
                    const { id } = JSON.parse(eventData);
                    markRowAnalyzing(id);
                } else if (eventType === 'gap') {
                    const { gap } = JSON.parse(eventData);
                    gap.hasGap = !isNoGap(gap);
                    gaps.push(gap);
                    gapAnalyzedCount++;
                    updateLoopState({ stages: { analyze: { metrics: { primary: `${gapAnalyzedCount}/${selectedIndices.length} analyzed` } } } });
                    enrichRowWithGap(gap);
                    document.getElementById('gapAnalyzedCount').textContent = gapAnalyzedCount;
                    // Update QA table in real-time if QA panel is open
                    if (qaMode) { try { buildQAGapTable(); } catch(_){} }
                } else if (eventType === 'log') {
                    const { message } = JSON.parse(eventData);
                    appendLog('agentLogEntries', message);
                } else if (eventType === 'complete') {
                    markAllStepsDone();
                } else if (eventType === 'error') {
                    const { error } = JSON.parse(eventData);
                    throw new Error(error);
                }
            }
        }

        // Gap analysis complete
        analysisPhase = 'reviewed';
        analysisComplete = true;
        const actionableGaps = gaps.filter(g => g.hasGap).length;
        const noGapCount = gaps.length - actionableGaps;
        setStep(2);
        setStatus(`${actionableGaps} Gaps / ${noGapCount} Met`, '');

    // Advance loop state: Analyze complete, Build waiting
    updateLoopState({
        stages: {
            analyze: { status: 'complete', endTime: Date.now(), metrics: { primary: `${actionableGaps} gaps / ${noGapCount} met`, statusText: 'Complete ✓' } },
            build: { status: 'waiting', metrics: { primary: 'Select & Dispatch', statusText: 'Waiting...' } },
        }
    });

        // Switch from "Analyze Gaps" to "Create Issues" button
        document.getElementById('btnAnalyzeGaps').style.display = 'none';
        document.getElementById('btnCreateIssues').style.display = '';
        revealCheckboxesForIssues();
        showAnalyzeSkippedButton();

    } catch (error) {
        showToast(error.message);
        setStatus('Error', 'error');
        analysisPhase = 'selecting';
        // Re-enable the analyze button
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            Analyze Gaps for Selected
            <span class="btn-badge" id="analyzeCount">${selectedIndices.length}</span>
        `;
        // Re-enable checkboxes
        document.querySelectorAll('.unified-row input[type="checkbox"]').forEach(cb => { cb.disabled = false; });
    }
}

// ─── Show "Analyze Skipped" button if there are unanlayzed requirements ──────

function showAnalyzeSkippedButton() {
    const skippedIndices = getSkippedIndices();
    const btn = document.getElementById('btnAnalyzeSkipped');
    if (skippedIndices.length > 0) {
        btn.style.display = '';
        document.getElementById('skippedCount').textContent = skippedIndices.length;
    } else {
        btn.style.display = 'none';
    }
}

function getSkippedIndices() {
    const indices = [];
    document.querySelectorAll('.unified-row').forEach((row, i) => {
        const statusChip = row.querySelector('.col-status .status-chip');
        if (statusChip && statusChip.textContent.trim() === 'Skipped') {
            indices.push(i);
        }
    });
    return indices;
}

async function analyzeSkipped() {
    const skippedIndices = getSkippedIndices();
    if (skippedIndices.length === 0) {
        showToast('No skipped requirements to analyze.');
        return;
    }

    const btn = document.getElementById('btnAnalyzeSkipped');
    btn.disabled = true;
    btn.innerHTML = `<div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div> Analyzer processing ${skippedIndices.length}...`;
    setStatus('Analyzer processing skipped...', 'processing');
    setActiveAgent('analyzer');

    // Mark skipped rows as queued
    skippedIndices.forEach(i => {
        const row = document.getElementById(`unified-row-${i}`);
        if (row) {
            const statusCell = row.querySelector('.col-status');
            statusCell.innerHTML = `<span class="status-chip analyzing"><span class="status-chip-dot"></span> Queued</span>`;
            row.classList.remove('no-gap-row');
        }
    });

    try {
        const response = await fetch('/api/analyze-gaps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedIndices: skippedIndices }),
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Gap analysis failed');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const chunks = buffer.split('\n\n');
            buffer = chunks.pop();

            for (const chunk of chunks) {
                if (!chunk.trim()) continue;
                const lines = chunk.split('\n');
                let eventType = '';
                let eventData = '';
                for (const line of lines) {
                    if (line.startsWith('event: ')) eventType = line.slice(7);
                    if (line.startsWith('data: ')) eventData = line.slice(6);
                }
                if (!eventType || !eventData) continue;

                if (eventType === 'gap-started') {
                    const { id } = JSON.parse(eventData);
                    markRowAnalyzing(id);
                } else if (eventType === 'gap') {
                    const { gap } = JSON.parse(eventData);
                    gap.hasGap = !isNoGap(gap);
                    gaps.push(gap);
                    enrichRowWithGap(gap);
                    document.getElementById('gapAnalyzedCount').textContent = gaps.length;
                    if (qaMode) { try { buildQAGapTable(); } catch(_){} }
                } else if (eventType === 'log') {
                    const { message } = JSON.parse(eventData);
                    appendLog('agentLogEntries', message);
                } else if (eventType === 'error') {
                    const { error } = JSON.parse(eventData);
                    throw new Error(error);
                }
            }
        }

        // Update summary
        const actionableGaps = gaps.filter(g => g.hasGap).length;
        const noGapCount = gaps.length - actionableGaps;
        setStatus(`${actionableGaps} Gaps / ${noGapCount} Met`, '');

        // Re-run checkbox reveal for newly analyzed rows
        revealCheckboxesForIssues();
        showAnalyzeSkippedButton();

    } catch (error) {
        showToast(error.message);
        setStatus('Error analyzing skipped', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            Analyze Skipped
            <span class="btn-badge" id="skippedCount">${getSkippedIndices().length}</span>
        `;
        if (getSkippedIndices().length === 0) {
            btn.style.display = 'none';
        }
    }
}

// ─── Mark a row as "Analyzing..." when its parallel session starts ────────────

function markRowAnalyzing(gapId) {
    const idx = gapId - 1;
    const row = document.getElementById(`unified-row-${idx}`);
    if (row) {
        const statusCell = row.querySelector('.col-status');
        if (statusCell) {
            statusCell.innerHTML = `
                <span class="status-chip analyzing active">
                    <span class="status-chip-dot"></span>
                    Analyzing
                </span>
            `;
        }
    }
}

// ─── Enrich a row when gap data arrives ──────────────────────────────────────

function enrichRowWithGap(gap) {
    const idx = gap.id - 1;
    const noGap = !gap.hasGap;

    // ─── Update the table row ─────────────────────────────────────────────
    const tbody = document.getElementById('unifiedTableBody');
    const rows = tbody.querySelectorAll('.unified-row');
    let targetRow = null;

    if (idx >= 0 && idx < rows.length) {
        targetRow = rows[idx];
    }

    if (!targetRow) {
        for (const row of rows) {
            const reqCell = row.querySelector('.td-requirement');
            if (reqCell && reqCell.textContent.trim() === gap.requirement.trim()) {
                targetRow = row;
                break;
            }
        }
    }

    if (!targetRow) return;

    const cells = targetRow.querySelectorAll('td');
    const rowIdx = targetRow.dataset.index;
    const detailRow = document.getElementById(`unified-detail-${rowIdx}`);

    if (noGap) {
        cells[2].innerHTML = `<span class="status-chip no-gap"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> No Gap</span>`;
        cells[3].innerHTML = `<span class="text-muted">\u2014</span>`;
        cells[3].style.textAlign = 'center';
        cells[4].style.display = 'none';
        targetRow.classList.add('no-gap-row');
        // Disable checkbox for no-gap rows
        const cb = targetRow.querySelector('input[type="checkbox"]');
        if (cb) { cb.checked = false; cb.disabled = true; }
    } else {
        cells[2].innerHTML = `<span class="status-chip analyzed"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg> Gap Found</span>`;
        cells[3].innerHTML = `<span class="complexity-badge ${gap.complexity.toLowerCase()}">${gap.complexity}</span>`;
        cells[3].style.textAlign = 'center';
    }

    targetRow.dataset.details = gap.details || '';
    targetRow.dataset.gapId = gap.id;
    targetRow.dataset.hasGap = gap.hasGap ? '1' : '0';
    targetRow.classList.add('row-enriched');

    // ─── Populate the detail expansion row ────────────────────────────────
    if (detailRow) {
        const grid = detailRow.querySelector('.detail-grid');
        if (grid) {
            const csVal = grid.querySelector('[data-field="currentState"] .detail-value');
            const gapVal = grid.querySelector('[data-field="gap"] .detail-value');
            const effVal = grid.querySelector('[data-field="effort"] .detail-value');
            const detItem = grid.querySelector('[data-field="details"]');
            const detVal = detItem ? detItem.querySelector('.detail-value') : null;
            if (csVal) csVal.textContent = gap.currentState || '\u2014';
            if (gapVal) gapVal.textContent = gap.gap || '\u2014';
            if (effVal) effVal.textContent = gap.estimatedEffort || '\u2014';
            if (detVal && gap.details) {
                detVal.textContent = gap.details;
                if (detItem) detItem.style.display = '';
            }
        }
    }

    // Flash animation on the row
    targetRow.classList.add('row-flash');
    setTimeout(() => targetRow.classList.remove('row-flash'), 1200);
}


// ─── Reveal checkboxes after analysis completes ──────────────────────────────

function revealCheckboxesForIssues() {
    // After gap analysis, re-show checkboxes only for gap-found rows
    // Also show agent dropdown column
    document.getElementById('colAgentHeader').style.display = '';

    document.querySelectorAll('.unified-row').forEach(row => {
        const checkTd = row.querySelector('.col-check');
        const checkbox = checkTd.querySelector('input[type="checkbox"]');
        checkbox.disabled = false;

        const agentTd = row.querySelector('.col-agent-type');
        agentTd.style.display = '';

        const isNoGap = row.dataset.hasGap === '0';
        if (isNoGap) {
            checkbox.disabled = true;
            checkbox.checked = false;
            checkTd.querySelector('.checkmark').classList.add('checkmark-disabled');
            row.classList.remove('selected');
            agentTd.innerHTML = `<span class="text-muted">—</span>`;
        } else {
            checkbox.checked = true;
            row.classList.add('selected');
            const gapId = row.dataset.gapId || '0';
            agentTd.innerHTML = `
                <select class="agent-type-select" data-gap-id="${gapId}" data-row-index="${row.dataset.index}">
                    <option value="local" selected>💻 Local Agent</option>
                    <option value="cloud">☁️ Cloud Agent</option>
                    <option value="developer">👤 Developer</option>
                </select>
            `;
        }
    });

    // Set selected state on gap objects
    gaps.forEach(g => { g.selected = g.hasGap; });

    const selectAll = document.getElementById('selectAll');
    selectAll.checked = gaps.filter(g => g.hasGap).length > 0;
    updateSelectedCount();
}

// ─── Details toggle ──────────────────────────────────────────────────────────

function toggleDetails(row) {
    const details = row.dataset.details;
    if (!details) return;
    toggleExpandableDetail(row);
}

function toggleExpandableDetail(row) {
    const idx = row.dataset.index;
    const detailRow = document.getElementById(`unified-detail-${idx}`);
    if (!detailRow) return;

    detailRow.classList.toggle('show');
    row.querySelector('.td-requirement')?.classList.toggle('expanded');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

// ─── Checkbox Handling (dual-phase) ───────────────────────────────────────────
function handleCheckboxChange(index) {
    if (analysisPhase === 'selecting') {
        const row = document.getElementById(`unified-row-${index}`);
        const checkbox = row ? row.querySelector('input[type="checkbox"]') : document.querySelector(`input[data-gap-index="${index}"]`);
        if (row) row.classList.toggle('selected', checkbox.checked);
        updateAnalyzeCount();
    } else if (analysisPhase === 'reviewed') {
        const gap = gaps.find(g => g.id === index + 1);
        if (gap && gap.hasGap) {
            const row = document.getElementById(`unified-row-${index}`);
            const checkbox = row ? row.querySelector('input[type="checkbox"]') : document.querySelector(`input[data-gap-index="${index}"]`);
            gap.selected = checkbox.checked;
            if (row) row.classList.toggle('selected', checkbox.checked);
        }
        updateSelectedCount();
    }
}

function handleSelectAll() {
    const selectAll = document.getElementById('selectAll');
    const checked = selectAll.checked;

    if (analysisPhase === 'selecting') {
        document.querySelectorAll('.unified-row').forEach(row => {
            const cb = row.querySelector('input[type="checkbox"]');
            if (cb && !cb.disabled) {
                cb.checked = checked;
                row.classList.toggle('selected', checked);
            }
        });
        updateAnalyzeCount();
    } else {
        gaps.forEach(g => {
            if (g.hasGap) g.selected = checked;
        });
        document.querySelectorAll('.unified-row').forEach(row => {
            if (row.dataset.hasGap === '0') return;
            const cb = row.querySelector('input[type="checkbox"]');
            if (cb) {
                cb.checked = checked;
                row.classList.toggle('selected', checked);
            }
        });
        updateSelectedCount();
    }
}

function toggleAllCheckboxes() {
    if (analysisPhase === 'selecting') {
        const all = document.querySelectorAll('.unified-row input[type="checkbox"]:not(:disabled)');
        const anyChecked = Array.from(all).some(cb => cb.checked);
        const newState = !anyChecked;
        all.forEach(cb => {
            cb.checked = newState;
            const row = cb.closest('tr');
            if (row) row.classList.toggle('selected', newState);
        });
        document.getElementById('selectAll').checked = newState;
        updateAnalyzeCount();
    } else {
        const actionable = gaps.filter(g => g.hasGap);
        const anySelected = actionable.some(g => g.selected);
        const newState = !anySelected;
        gaps.forEach(g => {
            if (g.hasGap) g.selected = newState;
        });
        document.querySelectorAll('.unified-row').forEach(row => {
            if (row.dataset.hasGap === '0') return;
            const cb = row.querySelector('input[type="checkbox"]');
            if (cb) {
                cb.checked = newState;
                row.classList.toggle('selected', newState);
            }
        });
        document.getElementById('selectAll').checked = newState;
        updateSelectedCount();
    }
}

function updateSelectedCount() {
    const actionable = gaps.filter(g => g.hasGap);
    const count = actionable.filter(g => g.selected).length;
    document.getElementById('selectedCount').textContent = count;
    document.getElementById('btnCreateIssues').disabled = count === 0;

    const selectAll = document.getElementById('selectAll');
    selectAll.checked = count === actionable.length && actionable.length > 0;
    selectAll.indeterminate = count > 0 && count < actionable.length;
}

// ─── Dispatch state ───────────────────────────────────────────────────────────
let dispatchedGapIds = new Set(); // track which gap IDs have been dispatched
let dispatchInProgress = false;
let dispatchTotalItems = 0;
let dispatchCompletedItems = 0;

function incrementDispatchProgress() {
    dispatchCompletedItems++;
    if (dispatchTotalItems > 0) {
        const percent = Math.min((dispatchCompletedItems / dispatchTotalItems) * 100, 100);
        document.getElementById('dispatchProgressFill').style.width = `${percent}%`;
    }
}

// ─── Step 2: Dispatch Selected (unified: issue creation + agent dispatch) ─────
async function dispatchSelected() {
    const selectedGaps = gaps.filter(g => g.selected && g.hasGap);
    if (selectedGaps.length === 0) {
        showToast('Please select at least one gap to dispatch.');
        return;
    }

    // Partition by agent type from unified table dropdowns
    const cloudGaps = [];
    const localGaps = [];
    const developerGaps = [];
    selectedGaps.forEach(gap => {
        const select = document.querySelector(`.agent-type-select[data-gap-id="${gap.id}"]`);
        const agentType = select ? select.value : 'cloud';
        if (agentType === 'local') {
            localGaps.push(gap);
        } else if (agentType === 'developer') {
            developerGaps.push(gap);
        } else {
            cloudGaps.push(gap);
        }
    });

    const btn = document.getElementById('btnCreateIssues');
    btn.disabled = true;
    const cloudLabel = cloudGaps.length > 0 ? `${cloudGaps.length} cloud` : '';
    const localLabel = localGaps.length > 0 ? `${localGaps.length} local` : '';
    const devLabel = developerGaps.length > 0 ? `${developerGaps.length} developer` : '';
    const dispatchLabel = [cloudLabel, localLabel, devLabel].filter(Boolean).join(' + ');
    btn.innerHTML = `<div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div> Dispatching ${dispatchLabel}...`;

    setStatus('Builder Dispatching...', 'processing');
    setStep(3);
    setActiveAgent('builder');
    // Update loop state — Build stage starting
    updateLoopState({
        activeStage: 'build',
        stages: { build: { status: 'active', startTime: Date.now(), metrics: { primary: `0/${selectedGaps.length} dispatched`, statusText: 'Dispatching...' } } }
    });
    dispatchInProgress = true;
    dispatchTotalItems = selectedGaps.length;
    dispatchCompletedItems = 0;
    const fillEl = document.getElementById('dispatchProgressFill');
    fillEl.style.width = '0%';
    fillEl.classList.remove('done');

    // Build and show the dispatch table on first dispatch
    showPanel('panel-issues');
    renderDispatchTable(selectedGaps, cloudGaps, localGaps, developerGaps);
    document.getElementById('issueLogEntries').innerHTML = '';

    // Show epic link if available
    if (epicIssueNumber > 0 && epicIssueUrl) {
        const epicLink = document.getElementById('dispatchEpicLink');
        epicLink.href = epicIssueUrl;
        epicLink.style.display = 'inline-flex';
        document.getElementById('dispatchEpicNumber').textContent = epicIssueNumber;
    }

    let allResults = [];
    createdIssues = [];

    try {
        const promises = [];
        const promiseLabels = [];

        if (cloudGaps.length > 0) {
            promises.push(dispatchCloudFromGaps(cloudGaps));
            promiseLabels.push('cloud');
        }

        if (localGaps.length > 0) {
            promises.push(dispatchLocalFromGaps(localGaps));
            promiseLabels.push('local');
        }

        if (developerGaps.length > 0) {
            promises.push(dispatchDeveloperFromGaps(developerGaps));
            promiseLabels.push('developer');
        }

        const settled = await Promise.allSettled(promises);
        const errors = [];
        settled.forEach((result, i) => {
            if (result.status === 'fulfilled') {
                allResults.push(...result.value);
            } else {
                const label = promiseLabels[i] || 'unknown';
                const errMsg = result.reason?.message || 'Unknown error';
                errors.push(`${label}: ${errMsg}`);
                appendLog('issueLogEntries', `❌ ${label} dispatch failed: ${errMsg}`);
            }
        });

        if (allResults.length === 0 && errors.length > 0) {
            throw new Error(errors.join('; '));
        }
        if (errors.length > 0) {
            showToast(`Partial failure: ${errors.join('; ')}`, 'warning');
        }

        // Mark dispatched items
        selectedGaps.forEach(g => dispatchedGapIds.add(g.id));

        // Update unified table rows with results
        allResults.forEach(result => {
            const gapId = result.gapId || result.issueNumber;
            const row = document.getElementById(`unified-row-${gapId - 1}`);
            if (row) {
                const statusCell = row.querySelector('.col-status');
                if (statusCell) {
                    statusCell.innerHTML = result.assigned
                        ? '<span class="status-chip assigned"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Dispatched</span>'
                        : '<span class="status-chip error"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg> Failed</span>';
                }
            }
        });

        // Update dispatch progress to 100% (ensure final state)
        const fill1 = document.getElementById('dispatchProgressFill');
        fill1.style.width = '100%';
        fill1.classList.add('done');

        setStep(4);
        setStatus('Agents Dispatched', '');
        dispatchInProgress = false;

        // Show actions bar with remaining count
        updateDispatchCounts();
        // Advance loop state: Build complete, Verify waiting
        updateLoopState({
            stages: {
                build: { status: 'complete', endTime: Date.now(), metrics: { primary: `${allResults.length} dispatched`, statusText: 'Complete ✓' } },
                verify: { status: 'waiting', metrics: { primary: 'Ship & Validate', statusText: 'Waiting...' } },
            }
        });
        document.getElementById('dispatchActions').style.display = 'flex';

    } catch (error) {
        showToast(error.message);
        setStatus('Error', 'error');
        dispatchInProgress = false;
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/>
                <circle cx="12" cy="15" r="2"/>
            </svg>
            Dispatch Selected
            <span class="btn-badge" id="selectedCount">${selectedGaps.length}</span>
        `;
    }
}

// ─── Render Dispatch Table ────────────────────────────────────────────────────
function renderDispatchTable(selectedGaps, cloudGaps, localGaps, developerGaps = []) {
    const tbody = document.getElementById('dispatchTableBody');

    // If first dispatch, render all gaps (dispatching ones first, then remaining)
    const allActionable = gaps.filter(g => g.hasGap);
    const selectedIds = new Set(selectedGaps.map(g => g.id));

    // Clear existing rows
    tbody.innerHTML = '';

    // Sort: dispatching items first, then remaining
    const sorted = [...allActionable].sort((a, b) => {
        const aDispatching = selectedIds.has(a.id) || dispatchedGapIds.has(a.id);
        const bDispatching = selectedIds.has(b.id) || dispatchedGapIds.has(b.id);
        if (aDispatching && !bDispatching) return -1;
        if (!aDispatching && bDispatching) return 1;
        return a.id - b.id;
    });

    const cloudIds = new Set(cloudGaps.map(g => g.id));
    const localIds = new Set(localGaps.map(g => g.id));
    const developerIds = new Set(developerGaps.map(g => g.id));

    sorted.forEach((gap, i) => {
        const isDispatching = selectedIds.has(gap.id);
        const wasDispatched = dispatchedGapIds.has(gap.id);
        const isCloud = cloudIds.has(gap.id);
        const isLocal = localIds.has(gap.id);
        const isDeveloper = developerIds.has(gap.id);

        const tr = document.createElement('tr');
        tr.id = `dispatch-row-${gap.id}`;
        tr.className = 'dispatch-row';
        tr.style.animationDelay = `${i * 0.04}s`;

        if (isDispatching) {
            tr.classList.add('dispatching');
        } else if (wasDispatched) {
            tr.classList.add('dispatched');
        } else {
            tr.classList.add('remaining');
        }

        // Mode badge
        let modeBadge = '';
        if (isCloud || (wasDispatched && !isLocal && !isDeveloper)) {
            modeBadge = `<span class="dispatch-mode-badge cloud"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg> Cloud</span>`;
        } else if (isLocal) {
            modeBadge = `<span class="dispatch-mode-badge local"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg> Local</span>`;
        } else if (isDeveloper) {
            modeBadge = `<span class="dispatch-mode-badge developer"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> Developer</span>`;
        } else {
            modeBadge = `<span class="dispatch-mode-badge pending">—</span>`;
        }

        // Issue column
        let issueCell = '';
        if (isDispatching && (isCloud || isDeveloper)) {
            issueCell = `<span class="dispatch-issue-pending"><span class="status-chip-dot"></span> Creating...</span>`;
        } else if (wasDispatched) {
            issueCell = `<span class="text-muted">—</span>`;
        } else {
            issueCell = `<span class="text-muted">—</span>`;
        }

        // Status column
        let statusCell = '';
        if (isDispatching && isLocal) {
            statusCell = `<span class="status-chip working"><span class="status-chip-dot"></span> Working</span>`;
        } else if (isDispatching) {
            statusCell = `<span class="status-chip analyzing"><span class="status-chip-dot"></span> In Progress</span>`;
        } else if (wasDispatched) {
            statusCell = `<span class="status-chip assigned"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Dispatched</span>`;
        } else {
            statusCell = `<span class="status-chip pending">Queued</span>`;
        }

        tr.innerHTML = `
            <td class="col-req"><div class="td-requirement">${escapeHtml(gap.requirement)}</div></td>
            <td class="col-dispatch-mode">${modeBadge}</td>
            <td class="col-dispatch-issue" id="dispatch-issue-${gap.id}">${issueCell}</td>
            <td class="col-dispatch-status" id="dispatch-status-${gap.id}">${statusCell}</td>
        `;
        tbody.appendChild(tr);
    });

    updateDispatchCounts();
}

// ─── Update dispatch table row when a cloud issue is created ──────────────────
function updateDispatchRowIssue(gapId, issue) {
    const issueCell = document.getElementById(`dispatch-issue-${gapId}`);
    if (issueCell) {
        issueCell.innerHTML = `<a href="${issue.url}" target="_blank" class="dispatch-issue-link">#${issue.number}</a>`;
    }
}

function updateDispatchRowStatus(gapId, status, extra) {
    const statusCell = document.getElementById(`dispatch-status-${gapId}`);
    const row = document.getElementById(`dispatch-row-${gapId}`);
    if (!statusCell) return;

    if (status === 'assigning') {
        statusCell.innerHTML = `<span class="status-chip analyzing"><span class="status-chip-dot"></span> Assigning</span>`;
    } else if (status === 'assigned') {
        statusCell.innerHTML = `<span class="status-chip assigned"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Assigned</span>`;
        if (row) { row.classList.remove('dispatching'); row.classList.add('dispatched'); }
    } else if (status === 'completed') {
        statusCell.innerHTML = `<span class="status-chip completed"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Completed</span>`;
        if (row) { row.classList.remove('dispatching'); row.classList.add('dispatched'); }
    } else if (status === 'implemented') {
        statusCell.innerHTML = `<span class="status-chip implemented"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Implemented</span>`;
        if (row) { row.classList.remove('dispatching'); row.classList.add('dispatched'); }
    } else if (status === 'working') {
        statusCell.innerHTML = `<span class="status-chip working"><span class="status-chip-dot"></span> Working</span>`;
    } else if (status === 'failed') {
        statusCell.innerHTML = `<span class="status-chip error"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg> Failed</span>`;
        if (row) { row.classList.remove('dispatching'); row.classList.add('dispatch-failed'); }
    }
}

// ─── Update dispatch summary counts ───────────────────────────────────────────
function updateDispatchCounts() {
    const allActionable = gaps.filter(g => g.hasGap);
    const dispatched = allActionable.filter(g => dispatchedGapIds.has(g.id)).length;
    const remaining = allActionable.length - dispatched;

    document.getElementById('dispatchedCount').textContent = dispatched;
    document.getElementById('dispatchPendingCount').textContent = remaining;

    const remainBtn = document.getElementById('dispatchRemainingCount');
    if (remainBtn) remainBtn.textContent = remaining;

    const btnContainer = document.getElementById('dispatchActions');
    const btnMore = document.getElementById('btnDispatchMore');
    if (remaining === 0 && btnMore) {
        btnMore.style.display = 'none';
    } else if (btnMore) {
        btnMore.style.display = '';
    }

    // Progress bar
    const percent = allActionable.length > 0 ? (dispatched / allActionable.length) * 100 : 0;
    const fillUpd = document.getElementById('dispatchProgressFill');
    fillUpd.style.width = `${percent}%`;
    if (percent >= 100) fillUpd.classList.add('done');
}

// ─── Dispatch Remaining (from dispatch panel) ─────────────────────────────────
async function dispatchRemaining() {
    // Find undispatched actionable gaps and dispatch them
    const remaining = gaps.filter(g => g.hasGap && !dispatchedGapIds.has(g.id));
    if (remaining.length === 0) {
        showToast('All requirements have been dispatched.');
        return;
    }

    // Mark remaining as selected with cloud default
    remaining.forEach(g => g.selected = true);

    // Go back to analysis panel to let user pick agent type, or auto-dispatch as cloud
    const cloudGaps = remaining;
    const localGaps = [];

    const btn = document.getElementById('btnDispatchMore');
    btn.disabled = true;
    btn.innerHTML = `<div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div> Dispatching ${remaining.length}...`;

    setStatus('Builder Dispatching...', 'processing');
    dispatchInProgress = true;

    // Update table: mark remaining rows as dispatching
    remaining.forEach(g => {
        const row = document.getElementById(`dispatch-row-${g.id}`);
        if (row) {
            row.classList.remove('remaining');
            row.classList.add('dispatching');
        }
        const modeCell = row?.querySelector('.col-dispatch-mode');
        if (modeCell) modeCell.innerHTML = `<span class="dispatch-mode-badge cloud"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg> Cloud</span>`;
        const issueCell = document.getElementById(`dispatch-issue-${g.id}`);
        if (issueCell) issueCell.innerHTML = `<span class="dispatch-issue-pending"><span class="status-chip-dot"></span> Creating...</span>`;
        const statusCell = document.getElementById(`dispatch-status-${g.id}`);
        if (statusCell) statusCell.innerHTML = `<span class="status-chip analyzing"><span class="status-chip-dot"></span> In Progress</span>`;
    });

    try {
        const results = await dispatchCloudFromGaps(cloudGaps);
        remaining.forEach(g => dispatchedGapIds.add(g.id));

        results.forEach(result => {
            const gapId = result.gapId || result.issueNumber;
            const row = document.getElementById(`unified-row-${gapId - 1}`);
            if (row) {
                const statusCell = row.querySelector('.col-status');
                if (statusCell) {
                    statusCell.innerHTML = result.assigned
                        ? '<span class="status-chip assigned"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Dispatched</span>'
                        : '<span class="status-chip error"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg> Failed</span>';
                }
            }
        });

        document.getElementById('dispatchProgressFill').classList.add('done');
        setStatus('All Dispatched', '');
        dispatchInProgress = false;
        updateDispatchCounts();

    } catch (error) {
        showToast(error.message);
        setStatus('Error', 'error');
        dispatchInProgress = false;
    } finally {
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>
            </svg>
            Dispatch Remaining
            <span class="btn-badge" id="dispatchRemainingCount">0</span>
        `;
        updateDispatchCounts();
    }
}

// ─── Finish Dispatch: go to completion panel ──────────────────────────────────
function finishDispatch() {
    const allActionable = gaps.filter(g => g.hasGap);
    const dispatched = allActionable.filter(g => dispatchedGapIds.has(g.id));
    const results = dispatched.map(g => ({
        gapId: g.id,
        assigned: true,
    }));
    renderCompletion(results);
    showPanel('panel-complete');
}

// ─── Cloud dispatch from gaps: create issues → assign coding agent ────────────
async function dispatchCloudFromGaps(cloudGaps) {
    const selectedIds = cloudGaps.map(g => g.id);
    appendLog('issueLogEntries', `☁️ Creating ${selectedIds.length} issue(s) on GitHub...`);

    // Build a map from issue title → gap id for matching
    const gapByTitle = {};
    cloudGaps.forEach(g => { gapByTitle[g.requirement.trim()] = g.id; });

    // Step 1: Create issues
    const response = await fetch('/api/create-issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedIds }),
    });

    if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to create issues');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let newIssues = [];
    // Map issue number → gap id for assignment step
    const issueToGap = {};

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop();

        for (const chunk of chunks) {
            if (!chunk.trim()) continue;
            const lines = chunk.split('\n');
            let eventType = '', eventData = '';
            for (const line of lines) {
                if (line.startsWith('event: ')) eventType = line.slice(7);
                if (line.startsWith('data: ')) eventData = line.slice(6);
            }
            if (!eventType || !eventData) continue;

            if (eventType === 'issue') {
                const { issue } = JSON.parse(eventData);
                newIssues.push(issue);
                createdIssues.push(issue);
                appendLog('issueLogEntries', `  ✅ Issue #${issue.number}: ${issue.title}`);

                // Match issue to gap by id or title
                let matchedGapId = issue.gapId || null;
                if (!matchedGapId) {
                    // Try title matching
                    for (const g of cloudGaps) {
                        if (issue.title && issue.title.includes(g.requirement.substring(0, 40))) {
                            matchedGapId = g.id;
                            break;
                        }
                    }
                }
                // Fallback: assign by order
                if (!matchedGapId && newIssues.length <= cloudGaps.length) {
                    matchedGapId = cloudGaps[newIssues.length - 1].id;
                }

                if (matchedGapId) {
                    issueToGap[issue.number] = matchedGapId;
                    updateDispatchRowIssue(matchedGapId, issue);
                    updateDispatchRowStatus(matchedGapId, 'assigning');
                }
            } else if (eventType === 'log') {
                const { message } = JSON.parse(eventData);
                appendLog('issueLogEntries', message);
            } else if (eventType === 'error') {
                const { error } = JSON.parse(eventData);
                throw new Error(error);
            }
        }
    }

    if (newIssues.length === 0) return [];

    // Step 2: Assign coding agent
    const issueNumbers = newIssues.map(i => i.number).filter(n => n > 0);
    appendLog('issueLogEntries', `☁️ Assigning ${issueNumbers.length} issue(s) to GitHub Copilot Coding Agent...`);

    const assignResp = await fetch('/api/assign-coding-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueNumbers }),
    });

    if (!assignResp.ok) {
        const errData = await assignResp.json();
        throw new Error(errData.error || 'Failed to assign coding agent');
    }

    const assignReader = assignResp.body.getReader();
    let assignBuffer = '';
    let results = [];

    while (true) {
        const { done, value } = await assignReader.read();
        if (done) break;
        assignBuffer += decoder.decode(value, { stream: true });
        const chunks = assignBuffer.split('\n\n');
        assignBuffer = chunks.pop();

        for (const chunk of chunks) {
            if (!chunk.trim()) continue;
            const lines = chunk.split('\n');
            let eventType = '', eventData = '';
            for (const line of lines) {
                if (line.startsWith('event: ')) eventType = line.slice(7);
                if (line.startsWith('data: ')) eventData = line.slice(6);
            }
            if (!eventType || !eventData) continue;

            if (eventType === 'result' || eventType === 'assignment') {
                const parsed = JSON.parse(eventData);
                const result = parsed.result || parsed;
                const gapId = issueToGap[result.issueNumber] || result.issueNumber;
                results.push({ gapId, issueNumber: result.issueNumber, assigned: result.assigned, message: result.message });

                // Update dispatch table row
                updateDispatchRowStatus(gapId, result.assigned ? 'assigned' : 'failed');
                // Increment progress bar for this completed item
                incrementDispatchProgress();

                appendLog('issueLogEntries', result.assigned
                    ? `  ✅ #${result.issueNumber} → Copilot Coding Agent assigned`
                    : `  ❌ #${result.issueNumber} → Failed to assign`);
            } else if (eventType === 'log') {
                const { message } = JSON.parse(eventData);
                appendLog('issueLogEntries', message);
            } else if (eventType === 'complete') {
                const data = JSON.parse(eventData);
                if (data.results) {
                    results = data.results.map(r => {
                        const gapId = issueToGap[r.issueNumber] || r.issueNumber;
                        return { ...r, gapId };
                    });
                }
            }
        }
    }

    return results;
}

// ─── Local dispatch from gaps: direct Copilot SDK ─────────────────────────────
async function dispatchLocalFromGaps(localGaps) {
    const gapIds = localGaps.map(g => g.id);
    appendLog('issueLogEntries', `💻 Dispatching ${gapIds.length} gap(s) to local Copilot SDK agent...`);

    // Auto-expand activity log when local agent starts
    const logDetails = document.getElementById('dispatchLogDetails');
    if (logDetails && !logDetails.open) logDetails.open = true;

    const response = await fetch('/api/execute-local-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gapIds }),
    });

    if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to start local agent');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let results = [];

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop();

        for (const chunk of chunks) {
            if (!chunk.trim()) continue;
            const lines = chunk.split('\n');
            let eventType = '', eventData = '';
            for (const line of lines) {
                if (line.startsWith('event: ')) eventType = line.slice(7);
                if (line.startsWith('data: ')) eventData = line.slice(6);
            }
            if (!eventType || !eventData) continue;

            if (eventType === 'item-complete') {
                const data = JSON.parse(eventData);
                results.push({ gapId: data.id, assigned: data.success, message: data.summary });

                // Update dispatch table
                updateDispatchRowStatus(data.id, data.success ? 'implemented' : 'failed');
                // Increment progress bar for this completed item
                incrementDispatchProgress();

                // Update issue column with summary snippet
                const issueCell = document.getElementById(`dispatch-issue-${data.id}`);
                if (issueCell) {
                    issueCell.innerHTML = data.success
                        ? `<span class="dispatch-local-done">✓ Done</span>`
                        : `<span class="text-muted">—</span>`;
                }

                appendLog('issueLogEntries', data.success
                    ? `  ✅ Gap ${data.id}: ${(data.summary || '').substring(0, 60)}`
                    : `  ❌ Gap ${data.id}: Failed`);
            } else if (eventType === 'item-start') {
                const { id, requirement } = JSON.parse(eventData);
                updateDispatchRowStatus(id, 'working');
                // Auto-expand the activity log so local agent progress is visible
                const logDetails = document.getElementById('dispatchLogDetails');
                if (logDetails && !logDetails.open) logDetails.open = true;
                appendLog('issueLogEntries', `💻 Local agent working: ${requirement.substring(0, 60)}...`);
            } else if (eventType === 'item-progress') {
                const { id, message } = JSON.parse(eventData);
                appendLog('issueLogEntries', `  ⚙ [Gap ${id}] ${message}`);
            } else if (eventType === 'log') {
                const { message } = JSON.parse(eventData);
                appendLog('issueLogEntries', message);
            } else if (eventType === 'error') {
                const { error } = JSON.parse(eventData);
                throw new Error(error);
            }
        }
    }

    return results;
}

// ─── Developer dispatch: create issues but do NOT assign coding agent ─────────
async function dispatchDeveloperFromGaps(devGaps) {
    const selectedIds = devGaps.map(g => g.id);
    appendLog('issueLogEntries', `👤 Creating ${selectedIds.length} issue(s) for developers on GitHub...`);

    const gapByTitle = {};
    devGaps.forEach(g => { gapByTitle[g.requirement.trim()] = g.id; });

    const response = await fetch('/api/create-issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedIds }),
    });

    if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to create issues');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let newIssues = [];
    let results = [];

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop();

        for (const chunk of chunks) {
            if (!chunk.trim()) continue;
            const lines = chunk.split('\n');
            let eventType = '', eventData = '';
            for (const line of lines) {
                if (line.startsWith('event: ')) eventType = line.slice(7);
                if (line.startsWith('data: ')) eventData = line.slice(6);
            }
            if (!eventType || !eventData) continue;

            if (eventType === 'issue') {
                const { issue } = JSON.parse(eventData);
                newIssues.push(issue);
                createdIssues.push(issue);
                appendLog('issueLogEntries', `  ✅ Issue #${issue.number}: ${issue.title} (for developer)`);

                let matchedGapId = issue.gapId || null;
                if (!matchedGapId) {
                    for (const g of devGaps) {
                        if (issue.title && issue.title.includes(g.requirement.substring(0, 40))) {
                            matchedGapId = g.id;
                            break;
                        }
                    }
                }
                if (!matchedGapId && newIssues.length <= devGaps.length) {
                    matchedGapId = devGaps[newIssues.length - 1].id;
                }

                if (matchedGapId) {
                    updateDispatchRowIssue(matchedGapId, issue);
                    updateDispatchRowStatus(matchedGapId, 'assigned');
                    results.push({ gapId: matchedGapId, issueNumber: issue.number, assigned: true, message: 'Issue created for developer' });
                    // Increment progress bar for this completed item
                    incrementDispatchProgress();
                }
            } else if (eventType === 'log') {
                const { message } = JSON.parse(eventData);
                appendLog('issueLogEntries', message);
            } else if (eventType === 'error') {
                const { error } = JSON.parse(eventData);
                throw new Error(error);
            }
        }
    }

    return results;
}

// ─── Render Completion ────────────────────────────────────────────────────────
function renderCompletion(results) {
    const assigned = results.filter(r => r.assigned).length;
    const issueCount = createdIssues.length;

    document.getElementById('completeStats').innerHTML = `
        <div class="stat-item">
            <span class="stat-value">${gaps.filter(g => g.hasGap).length}</span>
            <span class="stat-label">Gaps Found</span>
        </div>
        ${issueCount > 0 ? `<div class="stat-item">
            <span class="stat-value">${issueCount}</span>
            <span class="stat-label">Issues Created</span>
        </div>` : ''}
        <div class="stat-item">
            <span class="stat-value">${assigned}</span>
            <span class="stat-label">Dispatched</span>
        </div>
    `;

    if (createdIssues.length > 0 && createdIssues[0].url) {
        const repoUrl = createdIssues[0].url.split('/issues/')[0] + '/issues';
        document.getElementById('btnViewRepo').href = repoUrl;
    }
}

// ─── Stage Detail — Slide-Over (TASK 5 + TASK 6 Content Migration + TASK 7 Dual-Render) ─────
// Track which panel is currently re-parented into the slide-over
let _slideOverSourcePanelId = null;

// Stage → source panel mapping
const STAGE_PANEL_MAP = {
    meet: 'panel-loading',
    analyze: 'panel-loading',
    build: 'panel-issues',
    verify: 'panel-qa',
};

function openStageDetail(stage) {
    // Only allow opening if the stage is not idle
    const stageData = loopState.stages[stage];
    if (!stageData || stageData.status === 'idle') {
        showToast("This stage hasn't started yet", 'info');
        return;
    }

    // If another detail is already open, close it first (moves content back)
    if (_slideOverSourcePanelId) {
        _returnPanelToMain();
    }

    // Update loop state
    loopState.detailPanelOpen = stage;

    // Set slide-over title
    const titles = { meet: 'Meet', analyze: 'Analyze', build: 'Build', verify: 'Verify' };
    const titleEl = document.getElementById('slideOverTitle');
    if (titleEl) titleEl.textContent = titles[stage] || stage;

    // Determine source panel
    const sourcePanelId = STAGE_PANEL_MAP[stage];
    const sourcePanel = document.getElementById(sourcePanelId);
    if (!sourcePanel) return;

    // ── Re-parent: move actual panel into slide-over ──
    const slideOverContent = document.getElementById('slideOverContent');
    slideOverContent.innerHTML = ''; // Clear any leftover content

    // Remember where to put it back
    _slideOverSourcePanelId = sourcePanelId;

    // Move the real panel element into the slide-over
    slideOverContent.appendChild(sourcePanel);

    // Make it visible inside the slide-over (override the panel system)
    sourcePanel.classList.add('in-slideover');
    sourcePanel.style.display = 'flex';
    sourcePanel.style.animation = 'none';
    sourcePanel.style.position = 'relative';
    sourcePanel.style.opacity = '1';
    sourcePanel.style.pointerEvents = 'auto';

    // Activate backdrop + slide-over
    document.getElementById('slideOverBackdrop').classList.add('active');
    document.getElementById('slideOver').classList.add('active');

    // Dim the loop container
    const loopContainer = document.querySelector('.loop-container');
    if (loopContainer) loopContainer.classList.add('dimmed');

    // Mark the clicked stage node as selected
    document.querySelectorAll('.stage-node').forEach(n => n.classList.remove('stage-node--selected'));
    const selectedNode = document.querySelector(`.stage-node--${stage}`);
    if (selectedNode) selectedNode.classList.add('stage-node--selected');

    // Focus management
    const slideOver = document.getElementById('slideOver');
    const focusableEls = slideOver.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusableEls.length > 0) {
        focusableEls[0].focus();
    }

    renderLoopNodes();
}

function closeStageDetail() {
    // Move panel content back to <main> first
    _returnPanelToMain();

    // Remove active classes
    document.getElementById('slideOverBackdrop').classList.remove('active');
    document.getElementById('slideOver').classList.remove('active');

    // Restore loop container opacity
    const loopContainer = document.querySelector('.loop-container');
    if (loopContainer) loopContainer.classList.remove('dimmed');

    // Deselect stage node
    document.querySelectorAll('.stage-node').forEach(n => n.classList.remove('stage-node--selected'));

    // Update loop state
    loopState.detailPanelOpen = null;

    renderLoopNodes();
}

/**
 * Move the re-parented panel back to <main class="main-content"> in its original position.
 * This is critical so that the panel system continues to work normally.
 */
function _returnPanelToMain() {
    if (!_slideOverSourcePanelId) return;

    const panel = document.getElementById(_slideOverSourcePanelId);
    if (!panel) { _slideOverSourcePanelId = null; return; }

    const main = document.querySelector('main.main-content');
    if (!main) { _slideOverSourcePanelId = null; return; }

    // Remove slide-over overrides
    panel.classList.remove('in-slideover');
    panel.style.display = '';
    panel.style.animation = '';
    panel.style.position = '';
    panel.style.opacity = '';
    panel.style.pointerEvents = '';

    // Append back to main (panels are found by ID so order doesn't technically matter,
    // but let's put it back in a reasonable position)
    main.appendChild(panel);

    _slideOverSourcePanelId = null;
}

// Escape key closes slide-over
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && loopState.detailPanelOpen) {
        closeStageDetail();
    }
});

// ─── Reset ────────────────────────────────────────────────────────────────────
function resetApp() {
    gaps = [];
    requirements = [];
    createdIssues = [];
    currentStep = 1;
    analysisComplete = false;
    analysisPhase = 'idle';
    deployedUrl = '';
    validationResults = [];
    qaMode = false;
    previousPanel = 'panel-analyze';
    activePhase = 'meeting';
    completedPhases = new Set();
    dispatchedGapIds = new Set();
    dispatchInProgress = false;
    dispatchTotalItems = 0;
    dispatchCompletedItems = 0;
    setStep(1);
    setStatus('Ready', '');
    showPanel('panel-analyze');
    showLoopHeader(false);
    const meetingInput = document.getElementById('meetingNameInput');
    document.getElementById('btnAnalyze').disabled = !(meetingInput && meetingInput.value.trim());
    // Reset agent column visibility
    const colAgentHeader = document.getElementById('colAgentHeader');
    if (colAgentHeader) colAgentHeader.style.display = 'none';

    const qaUrlBar = document.getElementById('qaDeployUrlBar');
    if (qaUrlBar) qaUrlBar.style.display = 'none';
    const qaProgress = document.getElementById('qaWorkflowProgress');
    if (qaProgress) qaProgress.style.display = 'none';
    // Reset loop state
    loopState.meetingName = '';
    loopState.iteration = 1;
    loopState.activeStage = null;
    loopState.detailPanelOpen = null;
    Object.keys(loopState.stages).forEach(s => {
        loopState.stages[s] = { status: 'idle', metrics: {}, startTime: null, endTime: null };
    });
    renderLoopNodes();
}

// ═══════════════════════════════════════════════════════════════════════════════
// QA MODE — Ship & Validate
// ═══════════════════════════════════════════════════════════════════════════════

function updateQAFabVisibility() {
    // No-op: toggle removed, phases handle navigation now
}

function toggleQAMode() {
    qaMode = !qaMode;
    if (qaMode) {
        try { buildQAGapTable(); } catch (e) { console.warn('buildQAGapTable error:', e); }
        setActivePhase('verify');
        showPanel('panel-qa');
    } else {
        setActivePhase('build');
        showPanel(previousPanel);
    }
}

function buildQAGapTable() {
    const tbody = document.getElementById('qaGapTableBody');
    tbody.innerHTML = '';

    const totalReqs = requirements.length;
    const gapCount = gaps.filter(g => g.hasGap).length;
    const metCount = gaps.filter(g => !g.hasGap).length;

    let summaryParts = [`${totalReqs} requirements`];
    if (gaps.length > 0) summaryParts.push(`${gapCount} gaps`);
    if (metCount > 0) summaryParts.push(`${metCount} met`);
    document.getElementById('qaGapSummary').textContent = summaryParts.join(' \u00b7 ');

    const validationMap = {};
    validationResults.forEach(v => {
        validationMap[v.requirement.trim()] = v;
    });

    requirements.forEach((req, i) => {
        const tr = document.createElement('tr');
        tr.id = `qa-row-${i}`;
        tr.dataset.index = i;

        const gap = gaps.find(g => g.id === i + 1);
        const vr = validationMap[req.trim()];

        let statusHtml = '';


        if (vr) {
            if (vr.passed) {
                statusHtml = '<span class="status-chip no-gap"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Pass</span>';
            } else {
                statusHtml = '<span class="status-chip gap-found"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg> Fail</span>';
            }
        } else if (gap) {
            if (gap.hasGap) {
                statusHtml = '<span class="status-chip analyzed">Gap</span>';
            } else {
                statusHtml = '<span class="status-chip no-gap"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Met</span>';
            }
        } else {
            statusHtml = '<span class="status-chip pending">Pending</span>';
        }



        if (gap && !gap.hasGap && !vr) tr.classList.add('no-gap-row');

        tr.innerHTML = `
            <td><div class="td-requirement">${escapeHtml(req)}</div></td>
            <td>${statusHtml}</td>
        `;
        tbody.appendChild(tr);

        // Build expandable detail row with gap/validation info
        const hasDetail = (gap && (gap.gap || gap.details)) || vr;
        if (hasDetail) {
            const detailTr = document.createElement('tr');
            detailTr.id = `qa-detail-${i}`;
            detailTr.className = 'row-details-expandable';

            let detailContent = '';
            if (gap && gap.gap) {
                detailContent += `
                    <div class="detail-item">
                        <span class="detail-label">Gap</span>
                        <span class="detail-value">${escapeHtml(gap.gap)}</span>
                    </div>`;
            }
            if (gap && gap.details) {
                detailContent += `
                    <div class="detail-item detail-item-full">
                        <span class="detail-label">Implementation Details</span>
                        <span class="detail-value">${escapeHtml(gap.details)}</span>
                    </div>`;
            }
            if (vr) {
                detailContent += `
                    <div class="detail-item detail-item-full">
                        <span class="detail-label">Validation Result</span>
                        <span class="detail-value">${escapeHtml(vr.details || vr.evidence || vr.message || (vr.passed ? 'Passed' : 'Failed'))}</span>
                    </div>`;
            }

            detailTr.innerHTML = `
                <td colspan="3">
                    <div class="detail-grid" style="grid-template-columns: 1fr;">
                        ${detailContent}
                    </div>
                </td>
            `;
            tbody.appendChild(detailTr);

            // Make requirement text clickable to toggle detail
            const reqDiv = tr.querySelector('.td-requirement');
            if (reqDiv) {
                reqDiv.classList.add('expandable-req');
                reqDiv.onclick = () => {
                    detailTr.classList.toggle('show');
                    reqDiv.classList.toggle('expanded');
                };
            }
        }
    });

    const btn = document.getElementById('btnLaunchQA');
    if (deployedUrl && validationResults.length > 0) {
        btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
            Re-deploy &amp; Validate
        `;
    }
}

// ─── Unified Ship & Validate Workflow ─────────────────────────────────────────

let qaWorkflowRunning = false;

async function launchQAWorkflow() {
    const btn = document.getElementById('btnLaunchQA');
    btn.disabled = true;
    btn.innerHTML = `<div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div> Deployer running...`;

    setStatus('Deployer running...', 'processing');
    setQAStep('deploy');
    validationResults = [];
    qaWorkflowRunning = true;
    // Update loop state — Verify stage starting
    updateLoopState({
        activeStage: 'verify',
        stages: { verify: { status: 'active', startTime: Date.now(), metrics: { primary: 'Deploying...', statusText: 'Deployer Running' } } }
    });

    const progressEl = document.getElementById('qaWorkflowProgress');
    progressEl.style.display = '';
    document.getElementById('qaWorkflowLogEntries').innerHTML = '';

    // Auto-open the agent activity log so users see live progress
    const logDetails = progressEl.querySelector('.qa-workflow-log-details');
    if (logDetails) logDetails.open = true;

    const wfDeploy = document.getElementById('qaWfDeploy');
    const wfValidate = document.getElementById('qaWfValidate');
    wfDeploy.classList.add('active');
    wfDeploy.classList.remove('done', 'failed');
    wfValidate.classList.remove('active', 'done', 'failed');
    // Hide QA site link from previous run
    const siteLink = document.getElementById('qaWorkflowSiteLink');
    if (siteLink) siteLink.style.display = 'none';
    // Reset label & icon in case previous run showed "Not Passed"
    resetValidateStepUI(wfValidate);

    buildQAGapTable();
    appendLog('qaWorkflowLogEntries', `🤖 Agent: Deployer starting...`);

    try {
        const deployUrl = await runDeploy();
        if (!deployUrl) throw new Error('Deployment did not return a URL');

        deployedUrl = deployUrl;
        updateLoopState({ stages: { verify: { metrics: { primary: 'Validating...', secondary: deployUrl, statusText: 'Validator Running' } } } });
        showDeployUrl(deployUrl);

        wfDeploy.classList.remove('active');
        wfDeploy.classList.add('done');
        wfValidate.classList.add('active');

        btn.innerHTML = `<div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div> Validator running...`;
        setStatus('Validator running...', 'processing');
        setQAStep('validate');
        appendLog('qaWorkflowLogEntries', `🤖 Handoff: Deployer → Validator`);

        await runValidation(deployUrl);

        wfValidate.classList.remove('active');
        finishValidationUI(wfValidate);
        setQAStep('complete');
        const passed = validationResults.filter(v => v.passed).length;
        const failed = validationResults.length - passed;
        updateLoopState({
            stages: { verify: { status: 'complete', endTime: Date.now(), metrics: { primary: `${passed} pass / ${failed} fail`, statusText: failed > 0 ? 'Issues Found' : 'All Passed ✓' } } }
        });
    } catch (error) {
        showToast(error.message);
        setStatus('Workflow Failed', 'error');
        updateLoopState({ stages: { verify: { status: 'error', metrics: { statusText: 'Failed' } } } });
        if (!wfDeploy.classList.contains('done')) {
            wfDeploy.classList.remove('active');
            wfDeploy.classList.add('failed');
        } else {
            wfValidate.classList.remove('active');
            wfValidate.classList.add('failed');
        }
    } finally {
        qaWorkflowRunning = false;
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
            Re-deploy &amp; Validate
        `;
    }
}

// ─── Individual Phase Runners ─────────────────────────────────────────────────

async function runDeployOnly() {
    if (qaWorkflowRunning) return;
    const btn = document.getElementById('btnLaunchQA');
    btn.disabled = true;
    qaWorkflowRunning = true;

    const progressEl = document.getElementById('qaWorkflowProgress');
    progressEl.style.display = '';
    document.getElementById('qaWorkflowLogEntries').innerHTML = '';
    const logDetails = progressEl.querySelector('.qa-workflow-log-details');
    if (logDetails) logDetails.open = true;

    const wfDeploy = document.getElementById('qaWfDeploy');
    const wfValidate = document.getElementById('qaWfValidate');
    wfDeploy.classList.add('active');
    wfDeploy.classList.remove('done', 'failed');
    wfValidate.classList.remove('active', 'done', 'failed');
    resetValidateStepUI(wfValidate);

    // Hide QA site link from previous run
    const siteLink = document.getElementById('qaWorkflowSiteLink');
    if (siteLink) siteLink.style.display = 'none';

    setStatus('Deployer running...', 'processing');
    setQAStep('deploy');
    appendLog('qaWorkflowLogEntries', `🤖 Agent: Deployer starting (deploy only)...`);

    try {
        const deployUrl = await runDeploy();
        if (!deployUrl) throw new Error('Deployment did not return a URL');

        deployedUrl = deployUrl;
        showDeployUrl(deployUrl);

        wfDeploy.classList.remove('active');
        wfDeploy.classList.add('done');

        setStatus('Deployed — ready for validation', '');
        appendLog('qaWorkflowLogEntries', `✅ Deploy complete: ${deployUrl}`);
        appendLog('qaWorkflowLogEntries', `💡 Click the Validator icon to validate, or use "Re-deploy & Validate" for both.`);
    } catch (error) {
        showToast(error.message);
        setStatus('Deploy Failed', 'error');
        wfDeploy.classList.remove('active');
        wfDeploy.classList.add('failed');
    } finally {
        qaWorkflowRunning = false;
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
            Re-deploy &amp; Validate
        `;
    }
}

async function runValidateOnly() {
    if (qaWorkflowRunning) return;
    if (!deployedUrl) {
        showToast('No deployed URL yet — deploy first or run the full workflow.');
        return;
    }
    const btn = document.getElementById('btnLaunchQA');
    btn.disabled = true;
    qaWorkflowRunning = true;
    validationResults = [];

    const progressEl = document.getElementById('qaWorkflowProgress');
    progressEl.style.display = '';
    document.getElementById('qaWorkflowLogEntries').innerHTML = '';
    const logDetails = progressEl.querySelector('.qa-workflow-log-details');
    if (logDetails) logDetails.open = true;

    const wfDeploy = document.getElementById('qaWfDeploy');
    const wfValidate = document.getElementById('qaWfValidate');
    // Keep deploy as done (we're re-using existing deployment)
    wfDeploy.classList.remove('active', 'failed');
    wfDeploy.classList.add('done');
    wfValidate.classList.add('active');
    wfValidate.classList.remove('done', 'failed');
    resetValidateStepUI(wfValidate);

    setStatus('Validator running...', 'processing');
    setQAStep('validate');
    buildQAGapTable();
    appendLog('qaWorkflowLogEntries', `🤖 Agent: Validator starting (validate only) against ${deployedUrl}`);

    try {
        await runValidation(deployedUrl);
        wfValidate.classList.remove('active');
        finishValidationUI(wfValidate);
        setQAStep('complete');
    } catch (error) {
        showToast(error.message);
        setStatus('Validation Failed', 'error');
        wfValidate.classList.remove('active');
        wfValidate.classList.add('failed');
    } finally {
        qaWorkflowRunning = false;
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
            Re-deploy &amp; Validate
        `;
    }
}

// ─── Shared UI Helpers ────────────────────────────────────────────────────────

function showDeployUrl(url) {
    const urlBar = document.getElementById('qaDeployUrlBar');
    urlBar.style.display = 'flex';
    const urlLink = document.getElementById('qaDeployUrlLink');
    urlLink.href = url;
    urlLink.textContent = url;
    const siteLink = document.getElementById('qaWorkflowSiteLink');
    if (siteLink) {
        siteLink.href = url;
        siteLink.style.display = 'flex';
    }
}

function resetValidateStepUI(wfValidate) {
    const label = wfValidate.querySelector('.qa-wf-step-label');
    if (label) label.textContent = 'Validating';
    const icon = wfValidate.querySelector('.qa-wf-step-icon--validate');
    if (icon) icon.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/></svg>';
}

function finishValidationUI(wfValidate) {
    const passed = validationResults.filter(v => v.passed).length;
    const total = validationResults.length;
    const failed = total - passed;
    const validateLabel = wfValidate.querySelector('.qa-wf-step-label');
    const validateIcon = wfValidate.querySelector('.qa-wf-step-icon--validate');
    if (passed === total && total > 0) {
        wfValidate.classList.add('done');
        setStatus(`Validator: All ${total} Passed — Ship it!`, '');
        appendLog('qaWorkflowLogEntries', `\u2705 Validator complete: ${passed}/${total} passed. All meeting requirements met.`);
    } else {
        wfValidate.classList.add('failed');
        if (validateLabel) validateLabel.textContent = 'Not Passed';
        if (validateIcon) validateIcon.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg>';
        setStatus(`Validator: ${failed} of ${total} Failed`, 'error');
        appendLog('qaWorkflowLogEntries', `\u274C Validator report: ${passed} passed, ${failed} failed out of ${total}. Not ready to ship.`);
    }
}

async function runDeploy() {
    return new Promise(async (resolve, reject) => {
        try {
            const response = await fetch('/api/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || 'Failed to start deployment');
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let url = null;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const chunks = buffer.split('\n\n');
                buffer = chunks.pop();
                for (const chunk of chunks) {
                    if (!chunk.trim()) continue;
                    const lines = chunk.split('\n');
                    let eventType = '', eventData = '';
                    for (const line of lines) {
                        if (line.startsWith('event: ')) eventType = line.slice(7);
                        if (line.startsWith('data: ')) eventData = line.slice(6);
                    }
                    if (!eventType || !eventData) continue;
                    if (eventType === 'log') {
                        const { message } = JSON.parse(eventData);
                        appendLog('qaWorkflowLogEntries', message);
                    } else if (eventType === 'deploy-url') {
                        url = JSON.parse(eventData).url;
                    } else if (eventType === 'complete') {
                        const data = JSON.parse(eventData);
                        url = data.url || url;
                    } else if (eventType === 'error') {
                        const { error } = JSON.parse(eventData);
                        throw new Error(error);
                    }
                }
            }
            resolve(url);
        } catch (err) { reject(err); }
    });
}

async function runValidation(url) {
    return new Promise(async (resolve, reject) => {
        try {
            const response = await fetch('/api/validate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, requirements }),
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || 'Failed to start validation');
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const chunks = buffer.split('\n\n');
                buffer = chunks.pop();
                for (const chunk of chunks) {
                    if (!chunk.trim()) continue;
                    const lines = chunk.split('\n');
                    let eventType = '', eventData = '';
                    for (const line of lines) {
                        if (line.startsWith('event: ')) eventType = line.slice(7);
                        if (line.startsWith('data: ')) eventData = line.slice(6);
                    }
                    if (!eventType || !eventData) continue;
                    if (eventType === 'validation-start') {
                        const { requirementIndex, requirement } = JSON.parse(eventData);
                        setQATableRowValidating(requirementIndex, requirement);
                    } else if (eventType === 'result') {
                        const { result } = JSON.parse(eventData);
                        validationResults.push(result);
                        updateQATableRowWithValidation(result);
                    } else if (eventType === 'log') {
                        const { message } = JSON.parse(eventData);
                        appendLog('qaWorkflowLogEntries', message);
                    } else if (eventType === 'error') {
                        const { error } = JSON.parse(eventData);
                        throw new Error(error);
                    }
                }
            }
            resolve();
        } catch (err) { reject(err); }
    });
}

function setQATableRowValidating(reqIndex, requirement) {
    // Try direct index first
    let row = document.getElementById(`qa-row-${reqIndex}`);
    // Fallback: match by requirement text
    if (!row && requirement) {
        const trimmed = requirement.trim();
        const idx = requirements.findIndex(r => r.trim() === trimmed);
        if (idx !== -1) row = document.getElementById(`qa-row-${idx}`);
    }
    if (!row) return;

    const statusTd = row.querySelectorAll('td')[1];
    if (!statusTd) return;

    statusTd.innerHTML = '<span class="status-chip validating"><span class="validating-spinner"></span> Validating</span>';
    row.classList.add('validating-row');
}

function updateQATableRowWithValidation(result) {
    const reqText = result.requirement.trim();
    let rowIdx = requirements.findIndex(r => r.trim() === reqText);
    if (rowIdx === -1) {
        rowIdx = requirements.findIndex(r =>
            r.trim().toLowerCase().includes(reqText.toLowerCase().substring(0, 40)) ||
            reqText.toLowerCase().includes(r.trim().toLowerCase().substring(0, 40))
        );
    }
    if (rowIdx === -1) return;

    const row = document.getElementById(`qa-row-${rowIdx}`);
    if (!row) return;

    row.classList.remove('validating-row');

    const statusTd = row.querySelectorAll('td')[1];
    if (result.passed) {
        statusTd.innerHTML = '<span class="status-chip no-gap"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Pass</span>';
        row.classList.remove('no-gap-row');
        row.classList.add('validation-pass-row');
    } else {
        statusTd.innerHTML = '<span class="status-chip gap-found"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg> Fail</span>';
        row.classList.remove('no-gap-row');
        row.classList.add('validation-fail-row');
    }

    // Update or create the expandable detail row with validation evidence
    let detailRow = document.getElementById(`qa-detail-${rowIdx}`);
    const evidence = result.details || result.evidence || result.message || (result.passed ? 'Passed' : 'Failed');
    if (detailRow) {
        // Append validation evidence to existing detail
        const grid = detailRow.querySelector('.detail-grid');
        if (grid) {
            // Remove any previous validation detail
            grid.querySelectorAll('.detail-item-validation').forEach(el => el.remove());
            const item = document.createElement('div');
            item.className = 'detail-item detail-item-full detail-item-validation';
            item.innerHTML = `
                <span class="detail-label">Validation Result</span>
                <span class="detail-value">${escapeHtml(evidence)}</span>
            `;
            grid.appendChild(item);
        }
    } else {
        // Create a new detail row for validation-only results
        detailRow = document.createElement('tr');
        detailRow.id = `qa-detail-${rowIdx}`;
        detailRow.className = 'row-details-expandable';
        detailRow.innerHTML = `
            <td colspan="3">
                <div class="detail-grid" style="grid-template-columns: 1fr;">
                    <div class="detail-item detail-item-full detail-item-validation">
                        <span class="detail-label">Validation Result</span>
                        <span class="detail-value">${escapeHtml(evidence)}</span>
                    </div>
                </div>
            </td>
        `;
        row.after(detailRow);

        // Make requirement text clickable
        const reqDiv = row.querySelector('.td-requirement');
        if (reqDiv && !reqDiv.classList.contains('expandable-req')) {
            reqDiv.classList.add('expandable-req');
            reqDiv.onclick = () => {
                detailRow.classList.toggle('show');
                reqDiv.classList.toggle('expanded');
            };
        }
    }

    row.classList.add('row-enriched');
    setTimeout(() => row.classList.remove('row-enriched'), 1200);

    const passed = validationResults.filter(v => v.passed).length;
    const failed = validationResults.filter(v => !v.passed).length;
    const gapCount = gaps.filter(g => g.hasGap).length;
    const metCount = gaps.filter(g => !g.hasGap).length;
    let summaryParts = [`${requirements.length} requirements`];
    if (gaps.length > 0) summaryParts.push(`${gapCount} gaps`);
    if (metCount > 0) summaryParts.push(`${metCount} met`);
    if (validationResults.length > 0) {
        summaryParts.push(`${passed} pass \u00b7 ${failed} fail`);
        if (failed > 0) {
            summaryParts.push('\u274C Not ready to ship');
        } else if (passed > 0 && passed === validationResults.length) {
            summaryParts.push('\u2705 Ready to ship');
        }
    }
    document.getElementById('qaGapSummary').textContent = summaryParts.join(' \u00b7 ');
}

// ─── Loop Navigation ──────────────────────────────────────────────────────────
function navigateToLanding() {
    // If a workflow is in progress, confirm before leaving
    if (loopState && loopState.activeStage && analysisPhase !== 'idle') {
        if (!confirm('A workflow is in progress. Return to landing?')) return;
    }
    showLoopHeader(false);
    resetApp();
}

function returnToLoop() {
    // If a slide-over is open, close it first
    if (typeof closeStageDetail === 'function') {
        closeStageDetail();
    }
    showPanel('panel-loop');
}

function showLoopHeader(show) {
    const phaseNav = document.getElementById('phaseNav');
    const loopInfo = document.getElementById('loopHeaderInfo');
    const newMeetingBtn = document.getElementById('btnNewMeeting');
    const statusBadge = document.getElementById('statusBadge');
    if (show) {
        if (phaseNav) phaseNav.style.display = 'none';
        if (loopInfo) {
            loopInfo.style.display = 'flex';
            document.getElementById('loopMeetingName').textContent = loopState.meetingName || 'Meeting';
            document.getElementById('iterationBadge').textContent = `⟳ Iteration #${loopState.iteration || 1}`;
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

// ─── Clickable Phase Navigation ────────────────────────────────────────────────
function navigateToPhase(phase) {
    setActivePhase(phase);

    if (phase === 'meeting') {
        if (analysisPhase !== 'idle') {
            showPanel('panel-loading');
        } else {
            showPanel('panel-analyze');
        }
    } else if (phase === 'analyze') {
        if (analysisPhase !== 'idle') {
            showPanel('panel-loading');
        }
    } else if (phase === 'build') {
        showPanel('panel-issues');
    } else if (phase === 'verify') {
        qaMode = true;
        try { buildQAGapTable(); } catch (e) { console.warn('buildQAGapTable error:', e); }
        showPanel('panel-qa');
    }
}

// Legacy: keep navigateToStep for any internal callers
function navigateToStep(stepKey) {
    if (stepKey === '1') {
        navigateToPhase('meeting');
    } else if (stepKey === '2') {
        navigateToPhase('analyze');
    } else if (stepKey === '3') {
        navigateToPhase('build');
    } else if (stepKey === 'qa-deploy' || stepKey === 'qa-validate') {
        navigateToPhase('verify');
    } else if (stepKey === '4') {
        showPanel('panel-complete');
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setStep(1);
    showPanel('panel-analyze');
});
