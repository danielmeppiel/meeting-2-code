/**
 * Meeting Flow — handles the "Meet" stage: connecting to M365, extracting requirements.
 * @module meeting-flow
 */

import { store } from './store.js';
import { eventBus, Events } from './event-bus.js';
import { escapeHtml } from './utils.js';
import { showToast } from './toast.js';
import {
    updateLoopState, showPanel, showLoopHeader, openStageDetail,
    setStatus, setActiveAgent, appendLog, setActivePhase
} from './stage-controller.js';

// ─── State ──────────────────────────────────────────────────────
let analysisPhase = 'idle'; // 'idle' | 'extracting' | 'selecting' | 'analyzing' | 'reviewed'
let meetingInfoCache = null;

/** @returns {string} Current analysis phase. */
export function getAnalysisPhase() { return analysisPhase; }

/**
 * Set the current analysis phase.
 * @param {string} phase
 */
export function setAnalysisPhase(phase) { analysisPhase = phase; }

// ─── Loading Steps ──────────────────────────────────────────────
const stepIds = ['ls-fetch', 'ls-extract', 'ls-requirements', 'ls-analyze'];

/**
 * Mark a specific loading step as active and all prior steps as done.
 * @param {number} stepNum - Zero-based step index.
 */
function markStep(stepNum) {
    stepIds.forEach((id, i) => {
        const el = document.getElementById(id);
        if (!el) return;
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

/**
 * Mark all loading steps as done (no spinners).
 */
function markAllStepsDone() {
    stepIds.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('active');
        el.classList.add('done');
        el.querySelector('.loading-step-icon').classList.remove('spinner');
    });
}

// ─── Meeting Banner ─────────────────────────────────────────────
/**
 * Toggle the meeting source brand banner expanded/collapsed.
 */
export function toggleMeetingBanner() {
    const brand = document.getElementById('meetingSourceBrand');
    if (brand) brand.classList.toggle('expanded');
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

// ─── Start Analysis ─────────────────────────────────────────────
/**
 * Start meeting analysis: connects to M365 via SSE, extracts requirements,
 * renders them for selection. Entry point for the Meet stage.
 */
export async function startAnalysis() {
    const input = document.getElementById('meetingNameInput');
    const meetingName = input ? input.value.trim() : '';
    if (!meetingName) return;

    const btn = document.getElementById('btnAnalyze');
    btn.disabled = true;
    analysisPhase = 'extracting';

    setStatus('Analyzing...', 'processing');
    updateLoopState({
        meetingName,
        activeStage: 'meet',
        stages: { meet: { status: 'active', startTime: Date.now(), metrics: { primary: 'Extracting...', secondary: '', statusText: 'WorkIQ Running' } } }
    });
    showPanel('panel-loop');
    showLoopHeader(true);

    setTimeout(() => openStageDetail('meet'), 400);

    // Reset progress steps
    stepIds.forEach(s => {
        const el = document.getElementById(s);
        if (!el) return;
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
    document.getElementById('btnDispatchNav').style.display = 'none';
    document.getElementById('btnAnalyzeSkipped').style.display = 'none';
    document.getElementById('epicLink').style.display = 'none';
    store.set('epicIssue', { number: 0, url: '' });

    // Show meeting card
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
    document.getElementById('agentLogEntries').innerHTML = '';

    store.set('requirements', []);
    store.set('createdIssues', []);

    markStep(0);

    try {
        const result = await new Promise((resolve, reject) => {
            const eventSource = new EventSource('/api/analyze?meeting=' + encodeURIComponent(meetingName));

            eventSource.addEventListener('progress', (e) => {
                const { step, message } = JSON.parse(e.data);
                markStep(step);
                const msgs = ['Connecting...', 'Fetching data...', 'Extracting requirements...', 'Creating epic...'];
                updateLoopState({ stages: { meet: { metrics: { statusText: msgs[step] || 'Processing...' } } } });

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
                const meetingBrand = document.getElementById('meetingSourceBrand');
                if (meetingBrand) {
                    meetingBrand.style.display = 'flex';
                    meetingBrand.classList.add('expanded');
                }
                populateMeetingBanner(info);
                const iconEl = document.getElementById('meetingCardIcon');
                iconEl.className = 'meeting-card-icon found';
                iconEl.innerHTML = `<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Microsoft_Office_logo_%282013%E2%80%932019%29.svg/120px-Microsoft_Office_logo_%282013%E2%80%932019%29.svg.png" alt="Microsoft Office" width="48" height="48" style="object-fit: contain;" class="office-logo-img">`;
                document.getElementById('meetingCardTitle').textContent = 'Meeting Found by WorkIQ';
                if (info.date) document.getElementById('meetingCardDate').textContent = info.date;
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
                const agentAttr = document.getElementById('meetingCardAgent');
                if (agentAttr) agentAttr.style.display = 'flex';
                document.getElementById('meetingCardStatus').textContent = info.requirementCount
                    ? `WorkIQ processing ${info.requirementCount} requirements...`
                    : 'WorkIQ processing requirements...';
                store.set('meeting.info', info);
            });

            eventSource.addEventListener('requirements', (e) => {
                const data = JSON.parse(e.data);
                store.set('requirements', data.requirements);
                const reqs = data.requirements;
                updateLoopState({ stages: { meet: { metrics: { primary: `${reqs.length} requirements` } } } });
                document.getElementById('meetingCard').style.display = 'none';
                renderRequirementsForSelection(reqs);
            });

            eventSource.addEventListener('epic-created', (e) => {
                const { number, url } = JSON.parse(e.data);
                store.set('epicIssue', { number, url });
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
                [0, 1, 2, 3].forEach(i => {
                    const el = document.getElementById(stepIds[i]);
                    if (!el) return;
                    el.classList.remove('active');
                    el.classList.add('done');
                    el.querySelector('.loading-step-icon').classList.remove('spinner');
                });
                const reqs = store.get('requirements');
                updateLoopState({ stages: { meet: { status: 'complete', endTime: Date.now(), metrics: { statusText: 'Complete ✓', primary: `${reqs.length} requirements` } } } });
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

        analysisPhase = 'selecting';
        const reqs = store.get('requirements');
        setStatus(`${reqs.length} Requirements`, '');
        setActivePhase('analyze');
        updateLoopState({ stages: { analyze: { status: 'waiting', metrics: { primary: 'Select & Analyze', statusText: 'Waiting...' } } } });

    } catch (error) {
        showToast(error.message);
        setStatus('Error', 'error');
        showPanel('panel-analyze');
        btn.disabled = false;
        analysisPhase = 'idle';
    }
}

// ─── Render requirements for selection ────────────────────────

/**
 * Render the requirements list with checkboxes for user selection (before gap analysis).
 * @param {string[]} reqs - Array of requirement text strings.
 */
export function renderRequirementsForSelection(reqs) {
    const container = document.getElementById('unifiedTableContainer');
    const count = document.getElementById('reqCount');
    container.style.display = '';
    count.textContent = reqs.length;

    const tableEl = document.getElementById('unifiedTable');
    if (tableEl) tableEl.style.display = '';
    const tableContainer = container.querySelector('.table-container');
    if (tableContainer) tableContainer.style.display = '';

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

    document.getElementById('colCheckHeader').style.display = '';
    document.getElementById('tableActions').style.display = 'flex';
    document.getElementById('tableActions').style.animation = 'fadeSlideIn 0.4s var(--ease-out)';
    document.getElementById('selectAll').checked = true;
    updateAnalyzeCount();
}

/**
 * Count checked requirement checkboxes and update the analyze button badge.
 */
export function updateAnalyzeCount() {
    let count = 0;
    document.querySelectorAll('.unified-row input[type="checkbox"]').forEach(cb => {
        if (cb.checked) count++;
    });
    const el = document.getElementById('analyzeCount');
    if (el) el.textContent = count;
    const btn = document.getElementById('btnAnalyzeGaps');
    if (btn) btn.disabled = count === 0;
}

// ─── Wire meeting input on init ─────────────────────────────────
/**
 * Initialise meeting input event listeners (input validation + Enter key).
 */
export function initMeetingFlow() {
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
}
