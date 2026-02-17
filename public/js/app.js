/**
 * Application entry point — imports all modules, wires globals for HTML
 * onclick handlers, and initialises on DOMContentLoaded.
 *
 * This replaces the monolithic app.js with a thin wiring layer.
 * @module app
 */

// ─── Foundation ─────────────────────────────────────────────────
import { store }                       from './store.js';
import { eventBus, Events }            from './event-bus.js';

// ─── UI helpers ─────────────────────────────────────────────────
import { showToast }                   from './toast.js';
import { LoopParticleSystem }          from './loop-particles.js';
import {
    updateLoopState, renderLoopNodes, advanceStage,
    showPanel, openStageDetail, closeStageDetail,
    setStatus, setActiveAgent, appendLog, appendToActivityFeed,
    toggleActivityFeed, showLoopHeader, setActivePhase,
    markPhaseCompleted, setQAStep, initStageController,
    setParticleSystem, getActivePhase, getCompletedPhases,
} from './stage-controller.js';

// ─── Flow orchestrators ─────────────────────────────────────────
import {
    startAnalysis, renderRequirementsForSelection,
    updateAnalyzeCount, initMeetingFlow, toggleMeetingBanner,
    getAnalysisPhase, setAnalysisPhase,
} from './meeting-flow.js';

import {
    startGapAnalysis, analyzeSkipped, enrichRowWithGap,
    handleCheckboxChange, handleSelectAll, toggleAllCheckboxes,
    updateSelectedCount, toggleReqExpand, getGaps, setGaps, resetGaps,
} from './analyze-flow.js';

import {
    dispatchSelected, renderDispatchTable, renderBuildPreview, dispatchRemaining,
    finishDispatch, renderCompletion, getDispatchedGapIds, isDispatchInProgress,
    resetBuildFlow, handleBuildCheckboxChange, handleBuildSelectAll,
    toggleBuildSelectAll, updateBuildSelectedCount, toggleBuildRowExpand,
    injectVerifyFailuresAsGaps,
} from './build-flow.js';

import {
    buildQAGapTable, launchQAWorkflow, runDeployOnly,
    runValidateOnly, toggleQAMode, getDeployedUrl, getValidationResults, isQAMode,
    getFailedValidationGaps,
} from './verify-flow.js';

// ═════════════════════════════════════════════════════════════════
// Navigation functions (coordinate across modules)
// ═════════════════════════════════════════════════════════════════

/**
 * Navigate to a specific phase tab, showing the appropriate panel.
 * @param {string} phase - 'meeting' | 'analyze' | 'build' | 'verify'
 */
function navigateToPhase(phase) {
    setActivePhase(phase);

    if (phase === 'meeting') {
        if (getAnalysisPhase() !== 'idle') {
            showPanel('panel-loading');
        } else {
            showPanel('panel-analyze');
        }
    } else if (phase === 'analyze') {
        if (getAnalysisPhase() !== 'idle') {
            showPanel('panel-loading');
        }
    } else if (phase === 'build') {
        showPanel('panel-issues');
    } else if (phase === 'verify') {
        try { buildQAGapTable(); } catch (_) {}
        showPanel('panel-qa');
    }
}

/**
 * Navigate to the BUILD panel for dispatch.
 * Opens the slide-over if in loop view, or switches panel in tab view.
 */
function navigateToBuild() {
    const detailOpen = store.get('detailPanelOpen');
    if (detailOpen) {
        // In slide-over mode: switch to build detail
        openStageDetail('build');
    } else {
        // In tab mode: switch to build panel
        navigateToPhase('build');
    }
}

/**
 * Navigate to the VERIFY panel for deploy & validate.
 * Opens the slide-over if in loop view, or switches panel in tab view.
 */
function navigateToVerify() {
    try { buildQAGapTable(); } catch (_) {}
    const detailOpen = store.get('detailPanelOpen');
    if (detailOpen) {
        // In slide-over mode: switch to verify detail
        openStageDetail('verify');
    } else {
        // In tab mode: switch to verify panel
        navigateToPhase('verify');
    }
}

/**
 * Navigate back to the landing page. Confirms if a workflow is running.
 */
function navigateToLanding() {
    const activeStage = store.get('activeStage');
    if (activeStage && getAnalysisPhase() !== 'idle') {
        if (!confirm('A workflow is in progress. Return to landing?')) return;
    }
    showLoopHeader(false);
    resetApp();
}

/**
 * Return to the loop view. Closes any open slide-over first.
 */
function returnToLoop() {
    closeStageDetail();
    showPanel('panel-loop');
}

// ═════════════════════════════════════════════════════════════════
// Re-dispatch: Verify failures → Build
// ═════════════════════════════════════════════════════════════════

/**
 * Take failed verification results, convert them to gap-like objects,
 * inject them into the Build queue, bump the iteration counter,
 * and navigate to the Build panel so the user can dispatch fixes.
 */
function redispatchFromVerify() {
    const verifyGaps = getFailedValidationGaps();
    if (verifyGaps.length === 0) {
        showToast('No failed validations to re-dispatch.');
        return;
    }

    // Inject verify failures into gaps array (preserves existing analyze gaps)
    const injected = injectVerifyFailuresAsGaps(verifyGaps);

    // Bump iteration counter
    const currentIteration = store.get('meeting.iteration') || 1;
    updateLoopState({
        iteration: currentIteration + 1,
        activeStage: 'build',
        stages: {
            build: { status: 'waiting', startTime: null, endTime: null, metrics: { primary: `${injected.length} fixes`, statusText: 'Waiting...' } },
            verify: { status: 'error', metrics: { statusText: 'Re-dispatching...' } },
        }
    });

    // Reset the build flow dispatch state so the queue renders fresh
    resetBuildFlow();

    appendLog('qaWorkflowLogEntries', `🔄 Re-dispatching ${injected.length} failed verification(s) to Build (Iteration #${currentIteration + 1})`);

    // Navigate to build
    const detailOpen = store.get('detailPanelOpen');
    if (detailOpen) {
        openStageDetail('build');
    } else {
        navigateToPhase('build');
    }
}

/**
 * Full application reset — clears all module state, store, and DOM.
 */
function resetApp() {
    // Reset flow-specific state
    resetGaps();
    resetBuildFlow();
    setAnalysisPhase('idle');

    // Reset store to initial state
    store.reset();

    // UI resets
    setStatus('Ready', '');
    showPanel('panel-analyze');
    showLoopHeader(false);
    setActivePhase('meeting');

    const meetingInput = document.getElementById('meetingNameInput');
    const btnAnalyze = document.getElementById('btnAnalyze');
    if (btnAnalyze) btnAnalyze.disabled = !(meetingInput && meetingInput.value.trim());

    // Reset column visibility
    const colAgentHeader = document.getElementById('colAgentHeader');
    if (colAgentHeader) colAgentHeader.style.display = 'none';

    // Reset build panel state
    const buildColCheck = document.getElementById('buildColCheckHeader');
    if (buildColCheck) buildColCheck.style.display = 'none';
    const queueActions = document.getElementById('dispatchQueueActions');
    if (queueActions) queueActions.style.display = 'none';
    const dispatchActions = document.getElementById('dispatchActions');
    if (dispatchActions) dispatchActions.style.display = 'none';
    const dispatchBody = document.getElementById('dispatchTableBody');
    if (dispatchBody) dispatchBody.innerHTML = '';
    const btnDispatchNav = document.getElementById('btnDispatchNav');
    if (btnDispatchNav) btnDispatchNav.style.display = 'none';

    // Reset QA UI elements
    const qaUrlBar = document.getElementById('qaDeployUrlBar');
    if (qaUrlBar) qaUrlBar.style.display = 'none';
    const qaProgress = document.getElementById('qaWorkflowProgress');
    if (qaProgress) qaProgress.style.display = 'none';

    // Re-render loop nodes (will show all idle)
    renderLoopNodes();
}

// ═════════════════════════════════════════════════════════════════
// Auto-populate build panel when shown (via nav or slide-over)
// ═════════════════════════════════════════════════════════════════

eventBus.on(Events.PANEL_CHANGED, ({ panelId }) => {
    if (panelId === 'panel-issues') {
        renderBuildPreview();
    } else if (panelId === 'panel-qa') {
        try { buildQAGapTable(); } catch (_) {}
    }
});

// Also populate build preview / QA table when opening stages via slide-over
eventBus.on(Events.STAGE_DETAIL_OPENED, ({ stage }) => {
    if (stage === 'build') {
        renderBuildPreview();
    } else if (stage === 'verify') {
        try { buildQAGapTable(); } catch (_) {}
    }
});

// ═════════════════════════════════════════════════════════════════
// Wire stage-node action buttons via event bus
// ═════════════════════════════════════════════════════════════════

eventBus.on('stage:render-action', ({ stage, stageData, actionArea }) => {
    actionArea.innerHTML = '';
    const requirements = store.get('requirements') || [];

    if (stage === 'analyze' && stageData.status === 'waiting') {
        const count = requirements.length;
        if (count > 0) {
            const btn = document.createElement('button');
            btn.className = 'stage-node-action-btn pulse';
            btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg> Analyze ${count}`;
            btn.onclick = (e) => {
                e.stopPropagation();
                document.querySelectorAll('.unified-row input[type="checkbox"]').forEach(cb => { cb.checked = true; });
                updateAnalyzeCount();
                startGapAnalysis();
            };
            actionArea.appendChild(btn);
        }
    } else if (stage === 'build' && stageData.status === 'waiting') {
        const gaps = getGaps();
        const actionableGaps = gaps.filter(g => g.hasGap);
        if (actionableGaps.length > 0) {
            const btn = document.createElement('button');
            btn.className = 'stage-node-action-btn pulse';
            btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg> Select & Dispatch`;
            btn.onclick = (e) => {
                e.stopPropagation();
                openStageDetail('build');
            };
            actionArea.appendChild(btn);
        }
    } else if (stage === 'verify' && stageData.status === 'waiting') {
        const btn = document.createElement('button');
        btn.className = 'stage-node-action-btn pulse';
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg> Ship & Validate`;
        btn.onclick = (e) => {
            e.stopPropagation();
            navigateToVerify();
        };
        actionArea.appendChild(btn);
    } else if (stage === 'verify' && stageData.status === 'error') {
        // Verification completed with test failures — offer re-dispatch to Build
        const failedCount = (getValidationResults() || []).filter(v => !v.passed).length;
        if (failedCount > 0) {
            const btn = document.createElement('button');
            btn.className = 'stage-node-action-btn stage-node-action-btn--fix pulse';
            btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg> Fix & Rebuild ${failedCount}`;
            btn.onclick = (e) => {
                e.stopPropagation();
                redispatchFromVerify();
            };
            actionArea.appendChild(btn);
        }
    }
});

// ═════════════════════════════════════════════════════════════════
// Wire all HTML onclick references to window.*
// ═════════════════════════════════════════════════════════════════

// Landing / Meet
window.startAnalysis        = startAnalysis;
window.toggleMeetingBanner  = toggleMeetingBanner;

// Analyze
window.startGapAnalysis     = startGapAnalysis;
window.analyzeSkipped       = analyzeSkipped;
window.handleCheckboxChange = handleCheckboxChange;
window.handleSelectAll      = handleSelectAll;
window.toggleAllCheckboxes  = toggleAllCheckboxes;
window.toggleReqExpand      = toggleReqExpand;
window.updateAnalyzeCount   = updateAnalyzeCount;

// Build
window.dispatchSelected     = dispatchSelected;
window.dispatchRemaining    = dispatchRemaining;
window.finishDispatch       = finishDispatch;
window.handleBuildCheckboxChange = handleBuildCheckboxChange;
window.handleBuildSelectAll = handleBuildSelectAll;
window.toggleBuildSelectAll = toggleBuildSelectAll;
window.toggleBuildRowExpand = toggleBuildRowExpand;

// Verify
window.launchQAWorkflow     = launchQAWorkflow;
window.runDeployOnly        = runDeployOnly;
window.runValidateOnly      = runValidateOnly;
window.toggleQAMode         = toggleQAMode;
window.redispatchFromVerify = redispatchFromVerify;

// Navigation
window.navigateToPhase      = navigateToPhase;
window.navigateToLanding    = navigateToLanding;
window.navigateToBuild      = navigateToBuild;
window.navigateToVerify     = navigateToVerify;
window.returnToLoop         = returnToLoop;
window.resetApp             = resetApp;

// Stage / Loop
window.openStageDetail      = openStageDetail;
window.closeStageDetail     = closeStageDetail;
window.toggleActivityFeed   = toggleActivityFeed;

// ═════════════════════════════════════════════════════════════════
// Initialise on DOMContentLoaded
// ═════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    // 1. Particle system
    const loopParticles = new LoopParticleSystem();
    loopParticles.init();
    setParticleSystem(loopParticles);

    // 2. Meeting input wiring
    initMeetingFlow();

    // 3. Stage controller (keyboard shortcuts)
    initStageController();

    // 4. Show initial panel
    showPanel('panel-analyze');
    setActivePhase('meeting');
});
