/**
 * Build Flow — handles dispatching: creating issues, assigning agents.
 * @module build-flow
 */

import { store } from './store.js';
import { escapeHtml } from './utils.js';
import { showToast } from './toast.js';
import {
    updateLoopState, showPanel, closeStageDetail, setStatus, setActiveAgent, appendLog, setActivePhase
} from './stage-controller.js';
import { getGaps, setGaps } from './analyze-flow.js';

// ─── Build row expand ───────────────────────────────────────────
/**
 * Toggle the expandable detail row for a dispatch/build queue row.
 * @param {number} gapId - Gap ID.
 */
export function toggleBuildRowExpand(gapId) {
    const detailRow = document.getElementById(`dispatch-detail-${gapId}`);
    const mainRow = document.getElementById(`dispatch-row-${gapId}`);
    if (!detailRow) return;
    detailRow.classList.toggle('show');
    if (mainRow) {
        const reqDiv = mainRow.querySelector('.td-requirement');
        if (reqDiv) reqDiv.classList.toggle('expanded');
    }
}

// ─── Dispatch state ─────────────────────────────────────────────
let dispatchedGapIds = new Set();
let dispatchInProgress = false;
let dispatchTotalItems = 0;
let dispatchCompletedItems = 0;

/** @returns {Set} Set of dispatched gap IDs. */
export function getDispatchedGapIds() { return dispatchedGapIds; }

/** @returns {boolean} Whether a dispatch is currently in progress. */
export function isDispatchInProgress() { return dispatchInProgress; }

/** Reset all build flow state (called on app reset). */
export function resetBuildFlow() {
    dispatchedGapIds = new Set();
    dispatchInProgress = false;
    dispatchTotalItems = 0;
    dispatchCompletedItems = 0;
}

// ─── Inject verify failures as dispatchable gaps ─────────────────
/**
 * Merge failed verification results (shaped as gap objects) into the
 * existing gaps array so they appear in the Build queue.
 *
 * Already-existing analyze gaps are preserved (including gaps from
 * additional "Analyze Skipped" runs). Only verification failures that
 * don't duplicate an existing gap requirement are added.
 *
 * Resets dispatch tracking for re-dispatched items so the queue
 * treats them as fresh work.
 *
 * @param {Array} verifyGaps - Gap-like objects from getFailedValidationGaps().
 */
export function injectVerifyFailuresAsGaps(verifyGaps) {
    const gaps = getGaps();

    // Remove any previous verify-sourced gaps (from an earlier iteration)
    const filtered = gaps.filter(g => g.source !== 'verify');

    // Track which requirements already have a gap from analysis
    const existingReqs = new Set(filtered.filter(g => g.hasGap).map(g => g.requirement.trim()));

    // Only add verify failures for requirements that aren't already an active gap
    const newGaps = verifyGaps.filter(vg => !existingReqs.has(vg.requirement.trim()));

    // Append verify failures
    const merged = [...filtered, ...newGaps];

    // Replace the gaps array
    setGaps(merged);

    // Clear dispatch tracking for the verify-failure IDs so they show as "Ready"
    newGaps.forEach(g => dispatchedGapIds.delete(g.id));

    return newGaps;
}

// ─── Build Queue (interactive pre-dispatch table) ───────────────
/**
 * Populate the dispatch table with an interactive queue:
 * checkboxes, agent dropdowns, and a Dispatch button.
 * This is the BUILD panel's primary view before dispatch starts.
 */
export function renderBuildPreview() {
    const gaps = getGaps();
    const allActionable = gaps.filter(g => g.hasGap);

    // Don't override if dispatch already happened or is running
    if (dispatchInProgress || dispatchedGapIds.size > 0) return;
    if (allActionable.length === 0) return;

    const tbody = document.getElementById('dispatchTableBody');
    if (!tbody) return;
    // Don't override if already populated by queue
    if (tbody.children.length > 0) return;

    tbody.innerHTML = '';

    // Show queue mode UI
    const checkHeader = document.getElementById('buildColCheckHeader');
    if (checkHeader) checkHeader.style.display = '';
    const queueActions = document.getElementById('dispatchQueueActions');
    if (queueActions) queueActions.style.display = 'flex';
    const postActions = document.getElementById('dispatchActions');
    if (postActions) postActions.style.display = 'none';

    // Pre-select all actionable gaps
    allActionable.forEach(g => { g.selected = true; });

    allActionable.forEach((gap, i) => {
        const tr = document.createElement('tr');
        tr.id = `dispatch-row-${gap.id}`;
        tr.className = 'dispatch-row remaining selected';
        tr.dataset.gapId = gap.id;
        tr.style.animationDelay = `${i * 0.04}s`;

        tr.innerHTML = `
            <td class="col-check">
                <label class="checkbox-wrapper">
                    <input type="checkbox" data-gap-id="${gap.id}" checked onchange="handleBuildCheckboxChange(${gap.id})">
                    <span class="checkmark"></span>
                </label>
            </td>
            <td class="col-req"><div class="td-requirement" onclick="toggleBuildRowExpand(${gap.id})">${escapeHtml(gap.requirement)}</div></td>
            <td class="col-dispatch-mode">
                <select class="agent-type-select" data-gap-id="${gap.id}">
                    <option value="local" selected>💻 Local Agent</option>
                    <option value="cloud">☁️ Cloud Agent</option>
                    <option value="developer">👤 Developer</option>
                </select>
            </td>
            <td class="col-dispatch-issue" id="dispatch-issue-${gap.id}"><span class="text-muted">—</span></td>
            <td class="col-dispatch-status" id="dispatch-status-${gap.id}"><span class="status-chip pending">Ready</span></td>
        `;

        // Expandable detail row (pre-dispatch: gap summary, complexity, effort)
        const detailTr = document.createElement('tr');
        detailTr.id = `dispatch-detail-${gap.id}`;
        detailTr.className = 'build-detail-expandable';
        const gapSummary = gap.gap || '—';
        const complexity = gap.complexity || '—';
        const effort = gap.estimatedEffort || '—';
        const details = gap.details || '';
        detailTr.innerHTML = `
            <td colspan="6">
                <div class="build-detail-grid">
                    <div class="build-detail-item">
                        <span class="detail-label">Gap Summary</span>
                        <span class="detail-value">${escapeHtml(gapSummary)}</span>
                    </div>
                    <div class="build-detail-item">
                        <span class="detail-label">Complexity</span>
                        <span class="detail-value"><span class="complexity-badge ${complexity.toLowerCase()}">${escapeHtml(complexity)}</span></span>
                    </div>
                    <div class="build-detail-item">
                        <span class="detail-label">Estimated Effort</span>
                        <span class="detail-value">${escapeHtml(effort)}</span>
                    </div>
                    ${details ? `<div class="build-detail-item build-detail-full">
                        <span class="detail-label">Implementation Details</span>
                        <span class="detail-value">${escapeHtml(details)}</span>
                    </div>` : ''}
                </div>
            </td>
        `;

        tbody.appendChild(tr);
        tbody.appendChild(detailTr);
    });

    // Update header counts
    document.getElementById('dispatchedCount').textContent = '0';
    document.getElementById('dispatchPendingCount').textContent = allActionable.length;

    // Show epic link if available
    const epicIssue = store.get('epicIssue');
    if (epicIssue && epicIssue.number > 0 && epicIssue.url) {
        const epicLink = document.getElementById('dispatchEpicLink');
        if (epicLink) {
            epicLink.href = epicIssue.url;
            epicLink.style.display = 'inline-flex';
            document.getElementById('dispatchEpicNumber').textContent = epicIssue.number;
        }
    }

    // Update select all and count
    const selectAll = document.getElementById('buildSelectAll');
    if (selectAll) selectAll.checked = true;
    updateBuildSelectedCount();
}

// ─── Build Queue Selection Handlers ─────────────────────────────

/**
 * Handle a single checkbox change in the build dispatch queue.
 * @param {number} gapId - Gap ID.
 */
export function handleBuildCheckboxChange(gapId) {
    const gaps = getGaps();
    const gap = gaps.find(g => g.id === gapId);
    if (!gap) return;

    const row = document.getElementById(`dispatch-row-${gapId}`);
    const cb = row ? row.querySelector('input[type="checkbox"]') : null;
    if (cb) {
        gap.selected = cb.checked;
        row.classList.toggle('selected', cb.checked);
    }
    updateBuildSelectedCount();
}

/**
 * Handle the select-all checkbox in the build dispatch queue.
 */
export function handleBuildSelectAll() {
    const selectAll = document.getElementById('buildSelectAll');
    const checked = selectAll ? selectAll.checked : false;
    const gaps = getGaps();

    gaps.forEach(g => { if (g.hasGap) g.selected = checked; });

    document.querySelectorAll('#dispatchTableBody .dispatch-row').forEach(row => {
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb) {
            cb.checked = checked;
            row.classList.toggle('selected', checked);
        }
    });

    updateBuildSelectedCount();
}

/**
 * Toggle all checkboxes in the build dispatch queue (invert selection).
 */
export function toggleBuildSelectAll() {
    const gaps = getGaps();
    const actionable = gaps.filter(g => g.hasGap);
    const anySelected = actionable.some(g => g.selected);
    const newState = !anySelected;

    actionable.forEach(g => { g.selected = newState; });

    document.querySelectorAll('#dispatchTableBody .dispatch-row').forEach(row => {
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb) {
            cb.checked = newState;
            row.classList.toggle('selected', newState);
        }
    });

    const selectAll = document.getElementById('buildSelectAll');
    if (selectAll) selectAll.checked = newState;

    updateBuildSelectedCount();
}

/**
 * Update the count of selected gaps and the build dispatch button state.
 */
export function updateBuildSelectedCount() {
    const gaps = getGaps();
    const actionable = gaps.filter(g => g.hasGap);
    const count = actionable.filter(g => g.selected).length;

    const el = document.getElementById('buildSelectedCount');
    if (el) el.textContent = count;

    const btn = document.getElementById('btnDispatch');
    if (btn) btn.disabled = count === 0;

    const selectAll = document.getElementById('buildSelectAll');
    if (selectAll) {
        selectAll.checked = count === actionable.length && actionable.length > 0;
        selectAll.indeterminate = count > 0 && count < actionable.length;
    }
}

function incrementDispatchProgress() {
    dispatchCompletedItems++;
    if (dispatchTotalItems > 0) {
        const percent = Math.min((dispatchCompletedItems / dispatchTotalItems) * 100, 100);
        const el = document.getElementById('dispatchProgressFill');
        if (el) el.style.width = `${percent}%`;
    }
}

// ─── Dispatch Selected ──────────────────────────────────────────
/**
 * Entry point: partition selected gaps by agent type, create issues, assign agents.
 */
export async function dispatchSelected() {
    const gaps = getGaps();
    const selectedGaps = gaps.filter(g => g.selected && g.hasGap);
    if (selectedGaps.length === 0) {
        showToast('Please select at least one gap to dispatch.');
        return;
    }

    // Partition by agent type from build queue dropdowns
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

    // Transition from queue mode to dispatch mode
    const checkHeader = document.getElementById('buildColCheckHeader');
    if (checkHeader) checkHeader.style.display = 'none';
    const queueActions = document.getElementById('dispatchQueueActions');
    if (queueActions) queueActions.style.display = 'none';

    const btn = document.getElementById('btnDispatch');
    if (btn) btn.disabled = true;
    const cloudLabel = cloudGaps.length > 0 ? `${cloudGaps.length} cloud` : '';
    const localLabel = localGaps.length > 0 ? `${localGaps.length} local` : '';
    const devLabel = developerGaps.length > 0 ? `${developerGaps.length} developer` : '';
    const dispatchLabel = [cloudLabel, localLabel, devLabel].filter(Boolean).join(' + ');
    if (btn) btn.innerHTML = `<div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div> Dispatching ${dispatchLabel}...`;

    setStatus('Builder Dispatching...', 'processing');
    setActivePhase('build');
    setActiveAgent('builder');
    updateLoopState({
        activeStage: 'build',
        stages: { build: { status: 'active', startTime: Date.now(), metrics: { primary: `0/${selectedGaps.length} dispatched`, statusText: 'Dispatching...' } } }
    });
    dispatchInProgress = true;
    dispatchTotalItems = selectedGaps.length;
    dispatchCompletedItems = 0;
    const fillEl = document.getElementById('dispatchProgressFill');
    fillEl.style.width = '3%';
    fillEl.classList.remove('done');

    // Build and show the dispatch table on first dispatch
    // Only switch main panel if NOT already inside the build slide-over,
    // otherwise showPanel removes .active from panel-loop and kills the loop.
    const detailOpen = store.get('detailPanelOpen');
    if (detailOpen !== 'build') {
        showPanel('panel-issues');
    }
    renderDispatchTable(selectedGaps, cloudGaps, localGaps, developerGaps);
    document.getElementById('issueLogEntries').innerHTML = '';

    // Show epic link if available
    const epicIssue = store.get('epicIssue');
    if (epicIssue.number > 0 && epicIssue.url) {
        const epicLink = document.getElementById('dispatchEpicLink');
        epicLink.href = epicIssue.url;
        epicLink.style.display = 'inline-flex';
        document.getElementById('dispatchEpicNumber').textContent = epicIssue.number;
    }

    let allResults = [];
    store.set('createdIssues', []);

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

        // Update dispatch progress to 100%
        const fill1 = document.getElementById('dispatchProgressFill');
        fill1.style.width = '100%';
        fill1.classList.add('done');

        setActivePhase('build');
        setStatus('Agents Dispatched', '');
        dispatchInProgress = false;

        updateDispatchCounts();
        updateLoopState({
            stages: {
                build: { status: 'complete', endTime: Date.now(), metrics: { primary: `${allResults.length} dispatched`, statusText: 'Complete ✓' } },
                verify: { status: 'waiting', metrics: { primary: 'Ship & Validate', statusText: 'Waiting...' } },
            }
        });
        document.getElementById('dispatchActions').style.display = 'flex';

        // Show "Deploy & Verify" button when all items dispatched
        const btnVerify = document.getElementById('btnNavigateVerify');
        if (btnVerify) btnVerify.style.display = '';

    } catch (error) {
        showToast(error.message);
        setStatus('Error', 'error');
        dispatchInProgress = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>
                </svg>
                Dispatch
                <span class="btn-badge" id="buildSelectedCount">${selectedGaps.length}</span>
            `;
        }
        // Restore queue mode on error
        const checkHeader2 = document.getElementById('buildColCheckHeader');
        if (checkHeader2) checkHeader2.style.display = '';
        const queueActions2 = document.getElementById('dispatchQueueActions');
        if (queueActions2) queueActions2.style.display = 'flex';
    }
}

// ─── Render Dispatch Table ──────────────────────────────────────
/**
 * Build the dispatch table showing all actionable gaps with their dispatch status.
 * @param {Array} selectedGaps - Gaps being dispatched now.
 * @param {Array} cloudGaps - Gaps assigned to cloud agent.
 * @param {Array} localGaps - Gaps assigned to local agent.
 * @param {Array} [developerGaps=[]] - Gaps assigned to developers.
 */
export function renderDispatchTable(selectedGaps, cloudGaps, localGaps, developerGaps = []) {
    const gaps = getGaps();
    const tbody = document.getElementById('dispatchTableBody');

    const allActionable = gaps.filter(g => g.hasGap);
    const selectedIds = new Set(selectedGaps.map(g => g.id));

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
            <td class="col-req"><div class="td-requirement" onclick="toggleBuildRowExpand(${gap.id})">${escapeHtml(gap.requirement)}</div></td>
            <td class="col-dispatch-mode">${modeBadge}</td>
            <td class="col-dispatch-issue" id="dispatch-issue-${gap.id}">${issueCell}</td>
            <td class="col-dispatch-status" id="dispatch-status-${gap.id}">${statusCell}</td>
        `;

        // Expandable detail row (post-dispatch: dispatch-relevant details)
        const detailTr = document.createElement('tr');
        detailTr.id = `dispatch-detail-${gap.id}`;
        detailTr.className = 'build-detail-expandable';

        const agentLabel = isCloud ? '☁️ Cloud Agent' : isLocal ? '💻 Local Agent' : isDeveloper ? '👤 Developer' : '—';
        const gapSummary = gap.gap || '—';
        const effort = gap.estimatedEffort || '—';
        const statusLabel = wasDispatched ? 'Dispatched' : isDispatching ? 'In Progress' : 'Queued';

        detailTr.innerHTML = `
            <td colspan="5">
                <div class="build-detail-grid build-detail-grid--dispatch">
                    <div class="build-detail-item">
                        <span class="detail-label">Agent</span>
                        <span class="detail-value">${agentLabel}</span>
                    </div>
                    <div class="build-detail-item">
                        <span class="detail-label">Estimated Effort</span>
                        <span class="detail-value">${escapeHtml(effort)}</span>
                    </div>
                    <div class="build-detail-item">
                        <span class="detail-label">Dispatch Status</span>
                        <span class="detail-value">${statusLabel}</span>
                    </div>
                    <div class="build-detail-item build-detail-full">
                        <span class="detail-label">Gap Summary</span>
                        <span class="detail-value">${escapeHtml(gapSummary)}</span>
                    </div>
                </div>
            </td>
        `;

        tbody.appendChild(tr);
        tbody.appendChild(detailTr);
    });

    updateDispatchCounts();
}

// ─── Update dispatch table row when issue is created ─────────────
/**
 * Update the issue cell in the dispatch table when a cloud/developer issue is created.
 * @param {number} gapId
 * @param {Object} issue - { number, url }
 */
export function updateDispatchRowIssue(gapId, issue) {
    const issueCell = document.getElementById(`dispatch-issue-${gapId}`);
    if (issueCell) {
        issueCell.innerHTML = `<a href="${issue.url}" target="_blank" class="dispatch-issue-link">#${issue.number}</a>`;
    }
    // Also update issue link in detail row if it exists
    const detailRow = document.getElementById(`dispatch-detail-${gapId}`);
    if (detailRow) {
        const issueItem = detailRow.querySelector('[data-field="issue"]');
        if (issueItem) {
            const val = issueItem.querySelector('.detail-value');
            if (val) val.innerHTML = `<a href="${issue.url}" target="_blank" class="dispatch-issue-link">#${issue.number}</a>`;
        }
    }
}

/**
 * Update the status chip in the dispatch table for a given gap.
 * @param {number} gapId
 * @param {string} status - 'assigning'|'assigned'|'completed'|'implemented'|'working'|'failed'
 * @param {*} [extra]
 */
export function updateDispatchRowStatus(gapId, status, extra) {
    const statusCell = document.getElementById(`dispatch-status-${gapId}`);
    const row = document.getElementById(`dispatch-row-${gapId}`);
    if (!statusCell) return;

    // Update detail row dispatch status if it exists
    const detailRow = document.getElementById(`dispatch-detail-${gapId}`);
    if (detailRow) {
        const statusItem = detailRow.querySelector('.build-detail-grid .build-detail-item:nth-child(3) .detail-value');
        if (statusItem) {
            const labelMap = { assigning: 'Assigning…', assigned: 'Assigned ✓', completed: 'Completed ✓', implemented: 'Implemented ✓', working: 'Working…', failed: 'Failed ✗' };
            statusItem.textContent = labelMap[status] || status;
        }
    }

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

// ─── Update dispatch summary counts ─────────────────────────────
/**
 * Update dispatched/remaining counts and progress bar in the dispatch panel.
 */
export function updateDispatchCounts() {
    const gaps = getGaps();
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

    const percent = allActionable.length > 0 ? (dispatched / allActionable.length) * 100 : 0;
    const fillUpd = document.getElementById('dispatchProgressFill');
    // Don't reset to 0% during active dispatch — keep shimmer visible
    if (percent > 0 || !dispatchInProgress) {
        fillUpd.style.width = `${percent}%`;
    } else if (dispatchInProgress && parseFloat(fillUpd.style.width) === 0) {
        fillUpd.style.width = '3%';
    }
    if (percent >= 100) fillUpd.classList.add('done');
}

// ─── Dispatch Remaining ─────────────────────────────────────────
/**
 * Dispatch all undispatched actionable gaps (defaults to cloud agent).
 */
export async function dispatchRemaining() {
    const gaps = getGaps();
    const remaining = gaps.filter(g => g.hasGap && !dispatchedGapIds.has(g.id));
    if (remaining.length === 0) {
        showToast('All requirements have been dispatched.');
        return;
    }

    remaining.forEach(g => g.selected = true);

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

// ─── Finish Dispatch ────────────────────────────────────────────
/**
 * Show completion panel with dispatch summary stats.
 */
export function finishDispatch() {
    const gaps = getGaps();
    const allActionable = gaps.filter(g => g.hasGap);
    const dispatched = allActionable.filter(g => dispatchedGapIds.has(g.id));
    const results = dispatched.map(g => ({
        gapId: g.id,
        assigned: true,
    }));
    renderCompletion(results);

    // Close the slide-over first so panel-loop stays visible during transition
    const detailOpen = store.get('detailPanelOpen');
    if (detailOpen) {
        closeStageDetail();
    }
    showPanel('panel-complete');
}

// ─── Cloud dispatch: create issues → assign coding agent ────────
/**
 * Create GitHub issues for cloud gaps and assign GitHub Copilot Coding Agent.
 * @param {Array} cloudGaps
 * @returns {Promise<Array>} Results with gapId, issueNumber, assigned, message.
 */
async function dispatchCloudFromGaps(cloudGaps) {
    const selectedIds = cloudGaps.map(g => g.id);
    appendLog('issueLogEntries', `☁️ Creating ${selectedIds.length} issue(s) on GitHub...`);

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
                const createdIssues = store.get('createdIssues') || [];
                createdIssues.push(issue);
                store.set('createdIssues', createdIssues);
                appendLog('issueLogEntries', `  ✅ Issue #${issue.number}: ${issue.title}`);

                let matchedGapId = issue.gapId || null;
                if (!matchedGapId) {
                    for (const g of cloudGaps) {
                        if (issue.title && issue.title.includes(g.requirement.substring(0, 40))) {
                            matchedGapId = g.id;
                            break;
                        }
                    }
                }
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

                updateDispatchRowStatus(gapId, result.assigned ? 'assigned' : 'failed');
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

// ─── Local dispatch: direct Copilot SDK ─────────────────────────
/**
 * Execute local Copilot SDK agent for the given gaps.
 * @param {Array} localGaps
 * @returns {Promise<Array>} Results.
 */
async function dispatchLocalFromGaps(localGaps) {
    const gapIds = localGaps.map(g => g.id);
    appendLog('issueLogEntries', `💻 Dispatching ${gapIds.length} gap(s) to local Copilot SDK agent...`);

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

                updateDispatchRowStatus(data.id, data.success ? 'implemented' : 'failed');
                incrementDispatchProgress();

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

// ─── Developer dispatch: create issues without agent assignment ──
/**
 * Create GitHub issues for developer-assigned gaps (no Copilot assignment).
 * @param {Array} devGaps
 * @returns {Promise<Array>} Results.
 */
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
                const createdIssues = store.get('createdIssues') || [];
                createdIssues.push(issue);
                store.set('createdIssues', createdIssues);
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

// ─── Render Completion ──────────────────────────────────────────
/**
 * Render completion stats panel after dispatch finishes.
 * @param {Array} results - Array of { gapId, assigned } objects.
 */
export function renderCompletion(results) {
    const gaps = getGaps();
    const createdIssues = store.get('createdIssues') || [];
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
