/**
 * Verify Flow — handles the QA workflow: deploy, validate.
 * @module verify-flow
 */

import { store } from './store.js';
import { escapeHtml } from './utils.js';
import { showToast } from './toast.js';
import {
    updateLoopState, setStatus, setQAStep, appendLog, setActivePhase, showPanel
} from './stage-controller.js';
import { getGaps } from './analyze-flow.js';
import { getDispatchedGapIds } from './build-flow.js';

// ─── State ──────────────────────────────────────────────────────
let validationResults = [];
let qaWorkflowRunning = false;
let qaMode = false;
let deployedUrl = '';

/** @returns {string} The current deployed URL. */
export function getDeployedUrl() { return deployedUrl; }

/** @returns {Array} The validation results array. */
export function getValidationResults() { return validationResults; }

/** @returns {boolean} Whether QA mode is active. */
export function isQAMode() { return qaMode; }

// ─── Contextual QA button state ─────────────────────────────────
/**
 * Update the primary QA button to reflect the current state:
 * - If there are failed validations → "Fix & Rebuild" (red, calls redispatch)
 * - Otherwise → "Re-deploy & Validate" (blue, calls launchQAWorkflow)
 */
function updateQAButtonState() {
    const btn = document.getElementById('btnLaunchQA');
    if (!btn) return;
    const failed = validationResults.filter(v => !v.passed).length;
    if (failed > 0) {
        btn.className = 'btn btn-fix btn-lg';
        btn.onclick = () => { if (window.redispatchFromVerify) window.redispatchFromVerify(); };
        btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
            Fix &amp; Rebuild
        `;
    } else {
        btn.className = 'btn btn-primary btn-lg';
        btn.onclick = () => { launchQAWorkflow(); };
        btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
            Re-deploy &amp; Validate
        `;
    }
}

// ─── Extract failed validations as gap-like objects ─────────────
/**
 * Convert failed validation results into gap-like objects that the Build
 * flow can dispatch. Each object mirrors the shape produced by analyze-flow
 * so the dispatch table, issue creation, and coding agents all work unchanged.
 *
 * @returns {Array} Gap-like objects for each failed validation.
 */
export function getFailedValidationGaps() {
    const requirements = store.get('requirements') || [];
    return validationResults
        .filter(v => !v.passed)
        .map((v, i) => {
            const reqIndex = requirements.findIndex(r => r.trim() === v.requirement.trim());
            return {
                id: 9000 + i,  // High-range IDs to avoid collisions with analyze gaps
                requirement: v.requirement,
                gap: `Verification failed: ${v.details || 'Did not pass validation'}`,
                details: v.details || '',
                currentState: 'Deployed but failing validation',
                complexity: 'Medium',
                estimatedEffort: 'Fix required',
                hasGap: true,
                selected: true,
                source: 'verify',               // Tag so we know this came from verify
                requirementIndex: reqIndex >= 0 ? reqIndex : v.requirementIndex,
            };
        });
}

// ─── Build QA Gap Table ─────────────────────────────────────────
/**
 * Render the QA requirements table with gap and validation status.
 */
export function buildQAGapTable() {
    const gaps = getGaps();
    const requirements = store.get('requirements') || [];
    const createdIssues = store.get('createdIssues') || [];
    const dispatchedIds = getDispatchedGapIds();
    const tbody = document.getElementById('qaGapTableBody');
    tbody.innerHTML = '';

    const totalReqs = requirements.length;
    const gapCount = gaps.filter(g => g.hasGap).length;
    const metCount = gaps.filter(g => !g.hasGap).length;
    const dispatchedCount = dispatchedIds.size;

    let summaryParts = [`${totalReqs} requirements`];
    if (gaps.length > 0) summaryParts.push(`${gapCount} gaps`);
    if (metCount > 0) summaryParts.push(`${metCount} met`);
    if (dispatchedCount > 0) summaryParts.push(`${dispatchedCount} dispatched`);
    document.getElementById('qaGapSummary').textContent = summaryParts.join(' \u00b7 ');

    const validationMap = {};
    validationResults.forEach(v => {
        validationMap[v.requirement.trim()] = v;
    });

    // Build issue lookup: gapId → issue
    const issueByGapId = {};
    createdIssues.forEach(iss => {
        if (iss.gapId) issueByGapId[iss.gapId] = iss;
    });

    requirements.forEach((req, i) => {
        const tr = document.createElement('tr');
        tr.id = `qa-row-${i}`;
        tr.dataset.index = i;

        const gap = gaps.find(g => g.id === i + 1);
        const vr = validationMap[req.trim()];
        const isDispatched = gap && dispatchedIds.has(gap.id);
        const issue = gap ? issueByGapId[gap.id] : null;

        // ── Resolution column: how was this requirement handled? ──
        let resolutionHtml = '';
        if (gap && !gap.hasGap) {
            resolutionHtml = '<span class="status-chip no-gap"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Met</span>';
        } else if (isDispatched) {
            // Try to determine agent type from dispatch table DOM (if available)
            const dispatchRow = document.getElementById(`dispatch-row-${gap.id}`);
            const modeBadge = dispatchRow ? dispatchRow.querySelector('.dispatch-mode-badge') : null;
            if (modeBadge && modeBadge.classList.contains('local')) {
                resolutionHtml = '<span class="status-chip implemented"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Local Agent</span>';
            } else if (modeBadge && modeBadge.classList.contains('developer')) {
                resolutionHtml = '<span class="status-chip assigned"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> Developer</span>';
            } else {
                resolutionHtml = '<span class="status-chip assigned"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg> Cloud Agent</span>';
            }
        } else if (gap && gap.hasGap) {
            resolutionHtml = '<span class="status-chip skipped">Not Dispatched</span>';
        } else {
            resolutionHtml = '<span class="status-chip pending">\u2014</span>';
        }

        // ── Validation column ──
        let validationHtml = '';
        if (vr) {
            if (vr.passed) {
                validationHtml = '<span class="status-chip no-gap"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Pass</span>';
            } else {
                validationHtml = '<span class="status-chip gap-found"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg> Fail</span>';
            }
        } else {
            validationHtml = '<span class="status-chip pending">Pending</span>';
        }

        if (gap && !gap.hasGap && !vr) tr.classList.add('no-gap-row');

        tr.innerHTML = `
            <td class="col-req"><div class="td-requirement">${escapeHtml(req)}</div></td>
            <td class="col-verify-resolution">${resolutionHtml}</td>
            <td class="col-verify-validation">${validationHtml}</td>
        `;
        tbody.appendChild(tr);

        // ── Expandable detail: full requirement journey ──
        const detailTr = document.createElement('tr');
        detailTr.id = `qa-detail-${i}`;
        detailTr.className = 'build-detail-expandable';

        // Section 1: Analyze findings
        const gapSummary = gap && gap.gap ? escapeHtml(gap.gap) : '\u2014';
        const complexity = gap && gap.complexity ? `<span class="complexity-badge ${gap.complexity.toLowerCase()}">${escapeHtml(gap.complexity)}</span>` : '\u2014';
        const effort = gap && gap.estimatedEffort ? escapeHtml(gap.estimatedEffort) : '\u2014';

        // Section 2: Build/dispatch info
        let resolvedBy = '\u2014';
        let issueLink = '\u2014';
        if (isDispatched) {
            const dispatchRow = document.getElementById(`dispatch-row-${gap.id}`);
            const modeBadge = dispatchRow ? dispatchRow.querySelector('.dispatch-mode-badge') : null;
            if (modeBadge && modeBadge.classList.contains('local')) resolvedBy = '\ud83d\udcbb Local Agent';
            else if (modeBadge && modeBadge.classList.contains('developer')) resolvedBy = '\ud83d\udc64 Developer';
            else resolvedBy = '\u2601\ufe0f Cloud Agent';
        } else if (gap && !gap.hasGap) {
            resolvedBy = 'Already met';
        }
        if (issue && issue.number > 0) {
            issueLink = `<a href="${issue.url}" target="_blank" class="dispatch-issue-link">#${issue.number}</a>`;
        }

        // Section 3: Validation evidence
        const evidence = vr
            ? escapeHtml(vr.details || vr.evidence || vr.message || (vr.passed ? 'Passed' : 'Failed'))
            : '<span class="text-muted">Not yet validated</span>';

        detailTr.innerHTML = `
            <td colspan="3">
                <div class="verify-detail-grid">
                    <div class="verify-detail-section">
                        <div class="verify-detail-section-label">Analysis</div>
                        <div class="verify-detail-row">
                            <div class="build-detail-item">
                                <span class="detail-label">Gap Summary</span>
                                <span class="detail-value">${gapSummary}</span>
                            </div>
                            <div class="build-detail-item">
                                <span class="detail-label">Complexity</span>
                                <span class="detail-value">${complexity}</span>
                            </div>
                            <div class="build-detail-item">
                                <span class="detail-label">Estimated Effort</span>
                                <span class="detail-value">${effort}</span>
                            </div>
                        </div>
                    </div>
                    <div class="verify-detail-section">
                        <div class="verify-detail-section-label">Resolution</div>
                        <div class="verify-detail-row">
                            <div class="build-detail-item">
                                <span class="detail-label">Resolved By</span>
                                <span class="detail-value">${resolvedBy}</span>
                            </div>
                            <div class="build-detail-item">
                                <span class="detail-label">Issue</span>
                                <span class="detail-value">${issueLink}</span>
                            </div>
                        </div>
                    </div>
                    <div class="verify-detail-section" data-section="validation">
                        <div class="verify-detail-section-label">Validation</div>
                        <div class="verify-detail-row">
                            <div class="build-detail-item build-detail-full">
                                <span class="detail-label">Evidence</span>
                                <span class="detail-value" data-field="evidence">${evidence}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </td>
        `;
        tbody.appendChild(detailTr);

        // Make requirement text clickable
        const reqDiv = tr.querySelector('.td-requirement');
        if (reqDiv) {
            reqDiv.onclick = () => {
                detailTr.classList.toggle('show');
                reqDiv.classList.toggle('expanded');
            };
        }
    });

    const btn = document.getElementById('btnLaunchQA');
    if (deployedUrl && validationResults.length > 0) {
        updateQAButtonState();
    }
}

// ─── Launch QA Workflow (full deploy + validate) ─────────────────
/**
 * Run the full deploy + validate workflow.
 */
export async function launchQAWorkflow() {
    const btn = document.getElementById('btnLaunchQA');
    btn.disabled = true;
    btn.innerHTML = `<div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div> Deployer running...`;

    setStatus('Deployer running...', 'processing');
    setQAStep('deploy');
    validationResults = [];
    qaWorkflowRunning = true;
    updateLoopState({
        activeStage: 'verify',
        stages: { verify: { status: 'active', startTime: Date.now(), metrics: { primary: 'Deploying...', statusText: 'Deployer Running' } } }
    });

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
    const siteLink = document.getElementById('qaWorkflowSiteLink');
    if (siteLink) siteLink.style.display = 'none';
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
            stages: { verify: { status: failed > 0 ? 'error' : 'complete', endTime: Date.now(), metrics: { primary: `${passed} pass / ${failed} fail`, statusText: failed > 0 ? 'Issues Found' : 'All Passed ✓' } } }
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
        updateQAButtonState();
    }
}

// ─── Deploy Only ────────────────────────────────────────────────
/**
 * Run deployment only (no validation).
 */
export async function runDeployOnly() {
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
        updateQAButtonState();
    }
}

// ─── Validate Only ──────────────────────────────────────────────
/**
 * Run validation only against the existing deployed URL.
 */
export async function runValidateOnly() {
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
        updateQAButtonState();
    }
}

// ─── Run Deploy (SSE stream) ────────────────────────────────────
/**
 * Execute the deploy SSE stream and return the deployed URL.
 * @returns {Promise<string|null>} The deployed URL.
 */
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

// ─── Run Validation (SSE stream) ────────────────────────────────
/**
 * Execute the validation SSE stream against a deployed URL.
 * @param {string} url - The deployed URL to validate against.
 * @returns {Promise<void>}
 */
async function runValidation(url) {
    const requirements = store.get('requirements') || [];
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

// ─── Shared UI Helpers ──────────────────────────────────────────
/**
 * Show the deployed URL in the QA UI bar.
 * @param {string} url
 */
export function showDeployUrl(url) {
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

/**
 * Reset the validate step UI (label + icon) to initial state.
 * @param {HTMLElement} wfValidate
 */
export function resetValidateStepUI(wfValidate) {
    const label = wfValidate.querySelector('.qa-wf-step-label');
    if (label) label.textContent = 'Validating';
    const icon = wfValidate.querySelector('.qa-wf-step-icon--validate');
    if (icon) icon.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/></svg>';
}

/**
 * Finalise the validation UI with pass/fail summary.
 * @param {HTMLElement} wfValidate
 */
export function finishValidationUI(wfValidate) {
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

// ─── QA Table Row Helpers ───────────────────────────────────────
/**
 * Mark a QA table row as "Validating" with spinner.
 * @param {number} reqIndex - Requirement index.
 * @param {string} requirement - Requirement text (fallback matching).
 */
export function setQATableRowValidating(reqIndex, requirement) {
    const requirements = store.get('requirements') || [];
    let row = document.getElementById(`qa-row-${reqIndex}`);
    if (!row && requirement) {
        const trimmed = requirement.trim();
        const idx = requirements.findIndex(r => r.trim() === trimmed);
        if (idx !== -1) row = document.getElementById(`qa-row-${idx}`);
    }
    if (!row) return;

    // Update the Validation column (3rd column, index 2)
    const validationTd = row.querySelectorAll('td')[2];
    if (!validationTd) return;

    validationTd.innerHTML = '<span class="status-chip validating"><span class="validating-spinner"></span> Validating</span>';
    row.classList.add('validating-row');
}

/**
 * Update a QA table row with validation result (pass/fail + evidence).
 * @param {Object} result - Validation result with requirement, passed, details, etc.
 */
export function updateQATableRowWithValidation(result) {
    const requirements = store.get('requirements') || [];
    const gaps = getGaps();
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

    // Update the Validation column (3rd column, index 2)
    const validationTd = row.querySelectorAll('td')[2];
    if (result.passed) {
        validationTd.innerHTML = '<span class="status-chip no-gap"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Pass</span>';
        row.classList.remove('no-gap-row');
        row.classList.add('validation-pass-row');
    } else {
        validationTd.innerHTML = '<span class="status-chip gap-found"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg> Fail</span>';
        row.classList.remove('no-gap-row');
        row.classList.add('validation-fail-row');
    }

    // Update the expandable detail row's validation evidence section
    const detailRow = document.getElementById(`qa-detail-${rowIdx}`);
    const evidence = result.details || result.evidence || result.message || (result.passed ? 'Passed' : 'Failed');
    if (detailRow) {
        const evidenceEl = detailRow.querySelector('[data-field="evidence"]');
        if (evidenceEl) {
            evidenceEl.textContent = evidence;
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

// ─── Toggle QA Mode ─────────────────────────────────────────────
/**
 * Toggle QA mode on/off — switches between verify and build panels.
 */
export function toggleQAMode() {
    qaMode = !qaMode;
    if (qaMode) {
        try { buildQAGapTable(); } catch (e) { console.warn('buildQAGapTable error:', e); }
        setActivePhase('verify');
        showPanel('panel-qa');
    } else {
        setActivePhase('build');
        showPanel('panel-issues');
    }
}
