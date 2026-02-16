/**
 * Analyze Flow — handles gap analysis of selected requirements.
 * @module analyze-flow
 */

import { store } from './store.js';
import { escapeHtml, isNoGap } from './utils.js';
import { showToast } from './toast.js';
import {
    updateLoopState, setStatus, setActiveAgent, appendLog, markPhaseCompleted, setActivePhase
} from './stage-controller.js';
import { getAnalysisPhase, setAnalysisPhase, updateAnalyzeCount } from './meeting-flow.js';

// ─── Gap data ──────────────────────────────────────────────────
let gaps = [];

/** @returns {Array} The current gaps array. */
export function getGaps() { return gaps; }

/**
 * Replace the entire gaps array.
 * @param {Array} g
 */
export function setGaps(g) { gaps = g; }

/** Reset gaps to empty. */
export function resetGaps() { gaps = []; }

// ─── Start Gap Analysis ─────────────────────────────────────────
/**
 * Analyse selected requirements for gaps via SSE stream.
 * Reads checked rows from the DOM, streams gap results, and updates the UI.
 */
export async function startGapAnalysis() {
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

    setAnalysisPhase('analyzing');
    const btn = document.getElementById('btnAnalyzeGaps');
    btn.disabled = true;
    btn.innerHTML = `<div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div> Analyzer processing ${selectedIndices.length}...`;
    setStatus('Analyzer Running...', 'processing');
    setActiveAgent('analyzer');
    updateLoopState({
        activeStage: 'analyze',
        stages: { analyze: { status: 'active', startTime: Date.now(), metrics: { primary: `0/${selectedIndices.length} analyzed`, secondary: '', statusText: 'Analyzer Running' } } }
    });

    // Mark rows
    document.querySelectorAll('.unified-row').forEach((row, i) => {
        const statusCell = row.querySelector('.col-status');
        const cb = row.querySelector('input[type="checkbox"]');
        cb.disabled = true;
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

                if (eventType === 'gap-started') {
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
                } else if (eventType === 'log') {
                    const { message } = JSON.parse(eventData);
                    appendLog('agentLogEntries', message);
                } else if (eventType === 'complete') {
                    // done
                } else if (eventType === 'error') {
                    const { error } = JSON.parse(eventData);
                    throw new Error(error);
                }
            }
        }

        setAnalysisPhase('reviewed');
        const actionableGaps = gaps.filter(g => g.hasGap).length;
        const noGapCount = gaps.length - actionableGaps;
        setActivePhase('analyze');
        setStatus(`${actionableGaps} Gaps / ${noGapCount} Met`, '');

        updateLoopState({
            stages: {
                analyze: { status: 'complete', endTime: Date.now(), metrics: { primary: `${actionableGaps} gaps / ${noGapCount} met`, statusText: 'Complete ✓' } },
                build: { status: 'waiting', metrics: { primary: 'Select & Dispatch', statusText: 'Waiting...' } },
            }
        });

        document.getElementById('btnAnalyzeGaps').style.display = 'none';
        document.getElementById('btnCreateIssues').style.display = '';
        revealCheckboxesForIssues();
        showAnalyzeSkippedButton();

    } catch (error) {
        showToast(error.message);
        setStatus('Error', 'error');
        setAnalysisPhase('selecting');
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            Analyze Gaps for Selected
            <span class="btn-badge" id="analyzeCount">${selectedIndices.length}</span>
        `;
        document.querySelectorAll('.unified-row input[type="checkbox"]').forEach(cb => { cb.disabled = false; });
    }
}

// ─── Analyze Skipped ─────────────────────────────────────────────
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

function showAnalyzeSkippedButton() {
    const skippedIndices = getSkippedIndices();
    const btn = document.getElementById('btnAnalyzeSkipped');
    if (!btn) return;
    if (skippedIndices.length > 0) {
        btn.style.display = '';
        document.getElementById('skippedCount').textContent = skippedIndices.length;
    } else {
        btn.style.display = 'none';
    }
}

/**
 * Analyse requirements that were previously skipped.
 */
export async function analyzeSkipped() {
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
                } else if (eventType === 'log') {
                    const { message } = JSON.parse(eventData);
                    appendLog('agentLogEntries', message);
                } else if (eventType === 'error') {
                    const { error } = JSON.parse(eventData);
                    throw new Error(error);
                }
            }
        }

        const actionableGaps = gaps.filter(g => g.hasGap).length;
        const noGapCount = gaps.length - actionableGaps;
        setStatus(`${actionableGaps} Gaps / ${noGapCount} Met`, '');
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
        if (getSkippedIndices().length === 0) btn.style.display = 'none';
    }
}

// ─── Row helpers ─────────────────────────────────────────────────
function markRowAnalyzing(gapId) {
    const idx = gapId - 1;
    const row = document.getElementById(`unified-row-${idx}`);
    if (row) {
        const statusCell = row.querySelector('.col-status');
        if (statusCell) {
            statusCell.innerHTML = `<span class="status-chip analyzing active"><span class="status-chip-dot"></span> Analyzing</span>`;
        }
    }
}

/**
 * Enrich a table row with gap analysis results (status chip, complexity, detail grid).
 * @param {Object} gap - Gap analysis result object.
 */
export function enrichRowWithGap(gap) {
    const idx = gap.id - 1;
    const noGap = !gap.hasGap;

    const tbody = document.getElementById('unifiedTableBody');
    const rows = tbody.querySelectorAll('.unified-row');
    let targetRow = null;

    if (idx >= 0 && idx < rows.length) targetRow = rows[idx];
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

    targetRow.classList.add('row-flash');
    setTimeout(() => targetRow.classList.remove('row-flash'), 1200);
}

// ─── Reveal checkboxes for issue dispatch ────────────────────────
function revealCheckboxesForIssues() {
    document.getElementById('colAgentHeader').style.display = '';

    document.querySelectorAll('.unified-row').forEach(row => {
        const checkTd = row.querySelector('.col-check');
        const checkbox = checkTd.querySelector('input[type="checkbox"]');
        checkbox.disabled = false;

        const agentTd = row.querySelector('.col-agent-type');
        agentTd.style.display = '';

        const isNoGapRow = row.dataset.hasGap === '0';
        if (isNoGapRow) {
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

    gaps.forEach(g => { g.selected = g.hasGap; });

    const selectAll = document.getElementById('selectAll');
    selectAll.checked = gaps.filter(g => g.hasGap).length > 0;
    updateSelectedCount();
}

// ─── Checkbox handling ──────────────────────────────────────────

/**
 * Handle a single requirement checkbox change (dual-phase: selecting vs reviewed).
 * @param {number} index - Row index.
 */
export function handleCheckboxChange(index) {
    const phase = getAnalysisPhase();
    if (phase === 'selecting') {
        const row = document.getElementById(`unified-row-${index}`);
        const checkbox = row ? row.querySelector('input[type="checkbox"]') : null;
        if (row && checkbox) row.classList.toggle('selected', checkbox.checked);
        updateAnalyzeCount();
    } else if (phase === 'reviewed') {
        const gap = gaps.find(g => g.id === index + 1);
        if (gap && gap.hasGap) {
            const row = document.getElementById(`unified-row-${index}`);
            const checkbox = row ? row.querySelector('input[type="checkbox"]') : null;
            if (checkbox) gap.selected = checkbox.checked;
            if (row && checkbox) row.classList.toggle('selected', checkbox.checked);
        }
        updateSelectedCount();
    }
}

/**
 * Handle the "select all" checkbox toggle.
 */
export function handleSelectAll() {
    const selectAll = document.getElementById('selectAll');
    const checked = selectAll.checked;
    const phase = getAnalysisPhase();

    if (phase === 'selecting') {
        document.querySelectorAll('.unified-row').forEach(row => {
            const cb = row.querySelector('input[type="checkbox"]');
            if (cb && !cb.disabled) {
                cb.checked = checked;
                row.classList.toggle('selected', checked);
            }
        });
        updateAnalyzeCount();
    } else {
        gaps.forEach(g => { if (g.hasGap) g.selected = checked; });
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

/**
 * Toggle all checkboxes (invert current selection state).
 */
export function toggleAllCheckboxes() {
    const phase = getAnalysisPhase();
    if (phase === 'selecting') {
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
        gaps.forEach(g => { if (g.hasGap) g.selected = newState; });
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

/**
 * Update the count of selected actionable gaps and the dispatch button state.
 */
export function updateSelectedCount() {
    const actionable = gaps.filter(g => g.hasGap);
    const count = actionable.filter(g => g.selected).length;
    const el = document.getElementById('selectedCount');
    if (el) el.textContent = count;
    const btn = document.getElementById('btnCreateIssues');
    if (btn) btn.disabled = count === 0;

    const selectAll = document.getElementById('selectAll');
    if (selectAll) {
        selectAll.checked = count === actionable.length && actionable.length > 0;
        selectAll.indeterminate = count > 0 && count < actionable.length;
    }
}

/**
 * Toggle the expandable detail row for a requirement.
 * @param {number} index - Row index.
 */
export function toggleReqExpand(index) {
    const detailRow = document.getElementById(`unified-detail-${index}`);
    const row = document.getElementById(`unified-row-${index}`);
    if (!detailRow) return;
    detailRow.classList.toggle('show');
    if (row) {
        const reqDiv = row.querySelector('.td-requirement');
        if (reqDiv) reqDiv.classList.toggle('expanded');
    }
}
