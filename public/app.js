/* ═══════════════════════════════════════════════════════════════════════════
   Meeting → Code | Application Logic
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
    if (panelId !== 'panel-qa') {
        previousPanel = panelId;
    }
}

function setStep(step) {
    currentStep = step;
    // Update shared steps (1,2) and build-track steps (3,4)
    document.querySelectorAll('.stepper > .step, #trackBuild .step').forEach(s => {
        const stepNum = parseInt(s.dataset.step);
        if (isNaN(stepNum)) return;
        s.classList.remove('active', 'completed');
        if (stepNum < step) s.classList.add('completed');
        else if (stepNum === step) s.classList.add('active');
    });
}

function setQAStep(phase) {
    // phase: null | 'deploy' | 'validate' | 'complete'
    const deployStep = document.querySelector('[data-step="qa-deploy"]');
    const validateStep = document.querySelector('[data-step="qa-validate"]');
    if (!deployStep || !validateStep) return;
    deployStep.classList.remove('active', 'completed');
    validateStep.classList.remove('active', 'completed');
    if (phase === 'deploy') {
        deployStep.classList.add('active');
    } else if (phase === 'validate') {
        deployStep.classList.add('completed');
        validateStep.classList.add('active');
    } else if (phase === 'complete') {
        deployStep.classList.add('completed');
        validateStep.classList.add('completed');
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
    container.scrollTop = container.scrollHeight;
}

// ─── Agent Identity ─────────────────────────────────────────────────────────────
const AGENTS = {
    extractor: { name: 'Extractor', role: 'Requirements Agent', letter: 'E', class: 'extractor' },
    analyzer:  { name: 'Analyzer',  role: 'Gap Analysis Agent', letter: 'A', class: 'analyzer' },
    builder:   { name: 'Builder',   role: 'Build Agent',        letter: 'B', class: 'builder' },
    deployer:  { name: 'Deployer',  role: 'Deploy Agent',       letter: 'D', class: 'deployer' },
    validator: { name: 'Validator', role: 'QA Agent',           letter: 'V', class: 'validator' },
};

function setActiveAgent(agentKey) {
    const agent = AGENTS[agentKey];
    if (!agent) return;
    const badge = document.getElementById('activeAgentBadge');
    if (badge) {
        badge.className = `agent-badge agent-badge--${agent.class}`;
        badge.innerHTML = `
            <span class="agent-avatar">${agent.letter}</span>
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

// ─── Step 1: Analyze Meeting ──────────────────────────────────────────────────
const stepIds = ['ls-fetch', 'ls-extract', 'ls-requirements', 'ls-analyze', 'ls-complexity'];

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
    const btn = document.getElementById('btnAnalyze');
    btn.disabled = true;
    analysisComplete = false;
    analysisPhase = 'extracting';

    setStatus('Analyzing...', 'processing');
    showPanel('panel-loading');

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
    if (meetingSourceBrand) meetingSourceBrand.style.display = 'none';
    const meetingCard = document.getElementById('meetingCard');
    meetingCard.style.display = 'flex';
    meetingCard.classList.remove('found');
    document.getElementById('meetingCardIcon').className = 'meeting-card-icon';
    document.getElementById('meetingCardTitle').textContent = 'Extractor is connecting to WorkIQ...';
    document.getElementById('meetingCardDate').textContent = '';
    document.getElementById('meetingCardParticipants').style.display = 'none';
    document.getElementById('meetingCardAgent').style.display = 'none';
    document.getElementById('meetingCardStatusRow').style.display = 'flex';
    document.getElementById('meetingCardStatus').textContent = 'Extractor is initializing...';

    // Reset agent log
    document.getElementById('agentLogEntries').innerHTML = '';

    requirements = [];
    gaps = [];

    markStep(0);

    try {
        const result = await new Promise((resolve, reject) => {
            const eventSource = new EventSource('/api/analyze');

            eventSource.addEventListener('progress', (e) => {
                const { step, message } = JSON.parse(e.data);
                console.log(`[Progress] Step ${step}: ${message}`);
                markStep(step);

                // Keep meeting card in sync with progress steps
                const cardTitle = document.getElementById('meetingCardTitle');
                const cardStatus = document.getElementById('meetingCardStatus');
                if (step === 0) {
                    cardTitle.textContent = 'Extractor is searching for meeting...';
                    cardStatus.textContent = 'Connected to WorkIQ';
                    setActiveAgent('extractor');
                } else if (step === 1) {
                    cardTitle.textContent = 'Meeting Found by Extractor';
                    cardStatus.textContent = 'Fetching meeting data...';
                } else if (step === 2) {
                    cardStatus.textContent = 'Extractor is extracting requirements...';
                } else if (step === 3) {
                    cardStatus.textContent = 'Extractor is creating epic issue...';
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
                const iconEl = document.getElementById('meetingCardIcon');
                iconEl.className = 'meeting-card-icon found';
                iconEl.innerHTML = `<img src="https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Microsoft_Office_logo_%282013%E2%80%932019%29.svg/120px-Microsoft_Office_logo_%282013%E2%80%932019%29.svg.png" alt="Microsoft Office" width="48" height="48" style="object-fit: contain;" class="office-logo-img">`;
                document.getElementById('meetingCardTitle').textContent = 'Meeting Found by Extractor';
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
                // Show agent attribution
                const agentAttr = document.getElementById('meetingCardAgent');
                if (agentAttr) agentAttr.style.display = 'flex';
                document.getElementById('meetingCardStatus').textContent = info.requirementCount
                    ? `Extractor processing ${info.requirementCount} requirements...`
                    : 'Extractor processing requirements...';
            });

            eventSource.addEventListener('requirements', (e) => {
                const data = JSON.parse(e.data);
                requirements = data.requirements;
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
    const tbody = document.getElementById('unifiedTableBody');
    const count = document.getElementById('reqCount');

    container.style.display = '';
    count.textContent = reqs.length;
    tbody.innerHTML = '';

    reqs.forEach((req, i) => {
        const tr = document.createElement('tr');
        tr.id = `unified-row-${i}`;
        tr.dataset.index = i;
        tr.style.animationDelay = `${i * 0.04}s`;
        tr.classList.add('unified-row', 'selected');
        tr.innerHTML = `
            <td class="col-check">
                <label class="checkbox-wrapper">
                    <input type="checkbox" data-gap-index="${i}" checked onchange="handleCheckboxChange(${i})">
                    <span class="checkmark"></span>
                </label>
            </td>
            <td class="col-req">
                <div class="td-requirement">${escapeHtml(req)}</div>
            </td>
            <td class="col-status">
                <span class="status-chip pending">Pending</span>
            </td>
            <td class="col-complexity"><span class="cell-pending">—</span></td>
            <td class="col-agent-type" style="display:none;"><span class="cell-pending">—</span></td>
        `;
        // Create hidden expandable detail row
        const detailTr = document.createElement('tr');
        detailTr.id = `unified-detail-${i}`;
        detailTr.className = 'row-details-expandable';
        detailTr.innerHTML = `
            <td colspan="5">
                <div class="detail-grid">
                    <div class="detail-item">
                        <span class="detail-label">Current State</span>
                        <span class="detail-value" data-field="currentState">—</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Gap</span>
                        <span class="detail-value" data-field="gap">—</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Est. Effort</span>
                        <span class="detail-value" data-field="effort">—</span>
                    </div>
                    <div class="detail-item detail-item-full" style="display:none;">
                        <span class="detail-label">Implementation Details</span>
                        <span class="detail-value" data-field="details"></span>
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

    // Mark selected rows as "Queued", non-selected as "Skipped"
    document.querySelectorAll('.unified-row').forEach((row, i) => {
        const statusCell = row.querySelector('.col-status');
        const cb = row.querySelector('input[type="checkbox"]');
        cb.disabled = true; // Lock checkboxes during analysis
        if (selectedIndices.includes(i)) {
            statusCell.innerHTML = `<span class="status-chip analyzing"><span class="status-chip-dot"></span> Queued</span>`;
        } else {
            statusCell.innerHTML = `<span class="status-chip no-gap">Skipped</span>`;
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
        if (!row) return;
        const statusCell = row.querySelector('.col-status');
        statusCell.innerHTML = `<span class="status-chip analyzing"><span class="status-chip-dot"></span> Queued</span>`;
        row.classList.remove('no-gap-row');
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
    if (!row) return;

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

// ─── Enrich a row when gap data arrives ──────────────────────────────────────

function enrichRowWithGap(gap) {
    const tbody = document.getElementById('unifiedTableBody');
    const rows = tbody.querySelectorAll('.unified-row');
    let targetRow = null;

    const idx = gap.id - 1;
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
    const noGap = !gap.hasGap;
    const rowIdx = targetRow.dataset.index;
    const detailRow = document.getElementById(`unified-detail-${rowIdx}`);

    if (noGap) {
        // Mark as "No Gap" — requirement already met
        cells[2].innerHTML = `<span class="status-chip no-gap"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> No Gap</span>`;
        cells[3].innerHTML = `<span class="text-muted">—</span>`;
        cells[3].style.textAlign = 'center';
        cells[4].style.display = 'none';
        targetRow.classList.add('no-gap-row');
    } else {
        cells[2].innerHTML = `<span class="status-chip analyzed"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Gap Found</span>`;
        cells[3].innerHTML = `<span class="complexity-badge ${gap.complexity.toLowerCase()}">${gap.complexity}</span>`;
        cells[3].style.textAlign = 'center';
    }

    // Populate expandable detail row
    if (detailRow) {
        const csVal = detailRow.querySelector('[data-field="currentState"]');
        const gapVal = detailRow.querySelector('[data-field="gap"]');
        const effVal = detailRow.querySelector('[data-field="effort"]');
        const detVal = detailRow.querySelector('[data-field="details"]');
        if (csVal) csVal.innerHTML = escapeHtml(gap.currentState) || '—';
        if (gapVal) gapVal.innerHTML = escapeHtml(gap.gap) || '—';
        if (effVal) effVal.textContent = gap.estimatedEffort || '—';
        if (detVal && gap.details) {
            detVal.innerHTML = escapeHtml(gap.details);
            detVal.closest('.detail-item').style.display = '';
        }
        if (noGap) {
            detailRow.classList.add('no-gap-detail');
        }
    }

    targetRow.dataset.details = gap.details || '';
    targetRow.dataset.gapId = gap.id;
    targetRow.dataset.hasGap = gap.hasGap ? '1' : '0';

    // Make requirement clickable to expand details
    const reqDiv = cells[1].querySelector('.td-requirement');
    if (reqDiv) {
        reqDiv.onclick = () => toggleExpandableDetail(targetRow);
        reqDiv.classList.add('expandable-req');
    }

    targetRow.classList.add('row-enriched');
    setTimeout(() => targetRow.classList.remove('row-enriched'), 1200);
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
                    <option value="cloud" selected>⚡ Copilot</option>
                    <option value="local">💻 Local</option>
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
        // Phase 1: selecting which requirements to analyze
        const checkbox = document.querySelector(`input[data-gap-index="${index}"]`);
        const row = checkbox.closest('tr');
        row.classList.toggle('selected', checkbox.checked);
        updateAnalyzeCount();
    } else if (analysisPhase === 'reviewed') {
        // Phase 2: selecting which gaps to create issues for
        const gap = gaps.find(g => g.id === index + 1);
        if (gap && gap.hasGap) {
            const checkbox = document.querySelector(`input[data-gap-index="${index}"]`);
            gap.selected = checkbox.checked;
            const row = checkbox.closest('tr');
            row.classList.toggle('selected', checkbox.checked);
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
        // Toggle all requirements
        const all = document.querySelectorAll('.unified-row input[type="checkbox"]:not(:disabled)');
        const anyChecked = Array.from(all).some(cb => cb.checked);
        const newState = !anyChecked;
        all.forEach(cb => {
            cb.checked = newState;
            cb.closest('tr').classList.toggle('selected', newState);
        });
        document.getElementById('selectAll').checked = newState;
        updateAnalyzeCount();
    } else {
        // Toggle gap-found rows for issue creation
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
    selectedGaps.forEach(gap => {
        const select = document.querySelector(`.agent-type-select[data-gap-id="${gap.id}"]`);
        const agentType = select ? select.value : 'cloud';
        if (agentType === 'local') {
            localGaps.push(gap);
        } else {
            cloudGaps.push(gap);
        }
    });

    const btn = document.getElementById('btnCreateIssues');
    btn.disabled = true;
    const cloudLabel = cloudGaps.length > 0 ? `${cloudGaps.length} cloud` : '';
    const localLabel = localGaps.length > 0 ? `${localGaps.length} local` : '';
    const dispatchLabel = [cloudLabel, localLabel].filter(Boolean).join(' + ');
    btn.innerHTML = `<div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div> Dispatching ${dispatchLabel}...`;

    setStatus('Builder Dispatching...', 'processing');
    setStep(3);
    setActiveAgent('builder');
    dispatchInProgress = true;

    // Build and show the dispatch table on first dispatch
    showPanel('panel-issues');
    renderDispatchTable(selectedGaps, cloudGaps, localGaps);
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
        document.getElementById('dispatchProgressFill').style.width = '100%';

        setStep(4);
        setStatus('Agents Dispatched', '');
        dispatchInProgress = false;

        // Show actions bar with remaining count
        updateDispatchCounts();
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
function renderDispatchTable(selectedGaps, cloudGaps, localGaps) {
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

    sorted.forEach((gap, i) => {
        const isDispatching = selectedIds.has(gap.id);
        const wasDispatched = dispatchedGapIds.has(gap.id);
        const isCloud = cloudIds.has(gap.id);
        const isLocal = localIds.has(gap.id);

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
        if (isCloud || (wasDispatched && !isLocal)) {
            modeBadge = `<span class="dispatch-mode-badge cloud"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" class="copilot-dispatch-icon"><path d="M7.998 0a8 8 0 0 0-2.528 15.59c.4.074.546-.174.546-.386 0-.19-.007-.694-.01-1.362-2.226.484-2.695-1.074-2.695-1.074-.364-.924-.889-1.17-.889-1.17-.726-.496.055-.486.055-.486.803.057 1.225.824 1.225.824.714 1.222 1.873.87 2.329.665.073-.517.279-.87.508-1.07-1.777-.201-3.644-.888-3.644-3.953 0-.874.312-1.588.823-2.147-.083-.202-.357-1.015.077-2.117 0 0 .672-.215 2.2.82A7.673 7.673 0 0 1 8 3.868a7.68 7.68 0 0 1 2.003.27c1.527-1.035 2.198-.82 2.198-.82.435 1.102.162 1.915.08 2.117.512.56.822 1.273.822 2.147 0 3.073-1.87 3.749-3.653 3.947.287.248.543.735.543 1.481 0 1.07-.01 1.933-.01 2.196 0 .214.144.463.55.385A8.002 8.002 0 0 0 7.998 0z"/></svg> Copilot</span>`;
        } else if (isLocal) {
            modeBadge = `<span class="dispatch-mode-badge local"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg> Local</span>`;
        } else {
            modeBadge = `<span class="dispatch-mode-badge pending">—</span>`;
        }

        // Issue column
        let issueCell = '';
        if (isDispatching && isCloud) {
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
    document.getElementById('dispatchProgressFill').style.width = `${percent}%`;
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
                updateDispatchRowStatus(data.id, data.success ? 'completed' : 'failed');

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
    dispatchedGapIds = new Set();
    dispatchInProgress = false;
    setStep(1);
    setStatus('Ready', '');
    showPanel('panel-analyze');
    document.getElementById('btnAnalyze').disabled = false;
    // Reset agent column visibility
    const colAgentHeader = document.getElementById('colAgentHeader');
    if (colAgentHeader) colAgentHeader.style.display = 'none';

    const fab = document.getElementById('fabQA');
    if (fab) {
        fab.classList.remove('active', 'visible');
        const buildLabel = fab.querySelector('.mode-switch-label--build');
        const qaLabel = fab.querySelector('.mode-switch-label--qa');
        if (buildLabel) buildLabel.classList.add('active');
        if (qaLabel) qaLabel.classList.remove('active');
    }
    const buildTrack = document.getElementById('trackBuild');
    const qaTrack = document.getElementById('trackQA');
    if (buildTrack) buildTrack.classList.add('active');
    if (qaTrack) qaTrack.classList.remove('active');
    setQAStep(null);
    const qaUrlBar = document.getElementById('qaDeployUrlBar');
    if (qaUrlBar) qaUrlBar.style.display = 'none';
    const qaProgress = document.getElementById('qaWorkflowProgress');
    if (qaProgress) qaProgress.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════════════════
// QA MODE — Ship & Validate
// ═══════════════════════════════════════════════════════════════════════════════

function updateQAFabVisibility() {
    const fab = document.getElementById('fabQA');
    fab.classList.add('visible');
}

function toggleQAMode() {
    qaMode = !qaMode;
    const sw = document.getElementById('fabQA');
    const buildLabel = sw.querySelector('.mode-switch-label--build');
    const qaLabel = sw.querySelector('.mode-switch-label--qa');
    const buildTrack = document.getElementById('trackBuild');
    const qaTrack = document.getElementById('trackQA');

    if (qaMode) {
        sw.classList.add('active');
        buildLabel.classList.remove('active');
        qaLabel.classList.add('active');
        if (buildTrack) buildTrack.classList.remove('active');
        if (qaTrack) qaTrack.classList.add('active');
        try { buildQAGapTable(); } catch (e) { console.warn('buildQAGapTable error:', e); }
        showPanel('panel-qa');
    } else {
        sw.classList.remove('active');
        buildLabel.classList.add('active');
        qaLabel.classList.remove('active');
        if (buildTrack) buildTrack.classList.add('active');
        if (qaTrack) qaTrack.classList.remove('active');
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
        let complexityHtml = '<span class="text-muted">\u2014</span>';

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

        if (gap && gap.hasGap) {
            complexityHtml = `<span class="complexity-badge ${gap.complexity.toLowerCase()}">${gap.complexity}</span>`;
        }

        if (gap && !gap.hasGap && !vr) tr.classList.add('no-gap-row');

        tr.innerHTML = `
            <td><div class="td-requirement">${escapeHtml(req)}</div></td>
            <td>${statusHtml}</td>
            <td>${complexityHtml}</td>
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
                        <span class="detail-value">${escapeHtml(vr.evidence || vr.message || (vr.passed ? 'Passed' : 'Failed'))}</span>
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

async function launchQAWorkflow() {
    const btn = document.getElementById('btnLaunchQA');
    btn.disabled = true;
    btn.innerHTML = `<div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div> Deployer running...`;

    setStatus('Deployer running...', 'processing');
    setQAStep('deploy');
    validationResults = [];

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

    buildQAGapTable();
    appendLog('qaWorkflowLogEntries', `🤖 Agent: Deployer starting...`);

    try {
        const deployUrl = await runDeploy();
        if (!deployUrl) throw new Error('Deployment did not return a URL');

        deployedUrl = deployUrl;
        const urlBar = document.getElementById('qaDeployUrlBar');
        urlBar.style.display = 'flex';
        const urlLink = document.getElementById('qaDeployUrlLink');
        urlLink.href = deployUrl;
        urlLink.textContent = deployUrl;

        wfDeploy.classList.remove('active');
        wfDeploy.classList.add('done');
        wfValidate.classList.add('active');

        btn.innerHTML = `<div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div> Validator running...`;
        setStatus('Validator running...', 'processing');
        setQAStep('validate');
        appendLog('qaWorkflowLogEntries', `🤖 Handoff: Deployer → Validator`);

        await runValidation(deployUrl);

        wfValidate.classList.remove('active');
        wfValidate.classList.add('done');

        const passed = validationResults.filter(v => v.passed).length;
        const total = validationResults.length;
        const failed = total - passed;
        if (passed === total && total > 0) {
            setStatus(`Validator: All ${total} Passed — Ship it!`, '');
            appendLog('qaWorkflowLogEntries', `\u2705 Validator complete: ${passed}/${total} passed. All meeting requirements met.`);
        } else {
            setStatus(`Validator: ${failed} of ${total} Failed`, 'error');
            appendLog('qaWorkflowLogEntries', `\u274C Validator report: ${passed} passed, ${failed} failed out of ${total}. Not ready to ship.`);
        }
        setQAStep('complete');
    } catch (error) {
        showToast(error.message);
        setStatus('Workflow Failed', 'error');
        if (!wfDeploy.classList.contains('done')) {
            wfDeploy.classList.remove('active');
            wfDeploy.classList.add('failed');
        } else {
            wfValidate.classList.remove('active');
            wfValidate.classList.add('failed');
        }
    } finally {
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
            Re-deploy &amp; Validate
        `;
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
    const evidence = result.evidence || result.message || (result.passed ? 'Passed' : 'Failed');
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

// ─── Clickable Step Navigation ────────────────────────────────────────────────
function navigateToStep(stepKey) {
    // stepKey is: '1' (Analyze), '2' (Review Gaps), '3' (Dispatch/Builder),
    //             'qa-deploy' or 'qa-validate' (QA track), '4' (Complete)

    if (stepKey === '1') {
        // If we've started analysis, show the loading/gap panel; otherwise landing
        if (analysisPhase !== 'idle') {
            showPanel('panel-loading');
        } else {
            showPanel('panel-analyze');
        }
    } else if (stepKey === '2') {
        // Gap review table lives in panel-loading
        if (analysisPhase !== 'idle') {
            showPanel('panel-loading');
        }
    } else if (stepKey === '3') {
        // Dispatch / Issues
        showPanel('panel-issues');
    } else if (stepKey === 'qa-deploy' || stepKey === 'qa-validate') {
        // Switch into QA mode and show QA panel
        if (!qaMode) {
            toggleQAMode();
        } else {
            showPanel('panel-qa');
        }
    } else if (stepKey === '4') {
        showPanel('panel-complete');
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setStep(1);
    showPanel('panel-analyze');
    updateQAFabVisibility();

    // Make all stepper steps clickable
    document.querySelectorAll('.stepper .step[data-step]').forEach(stepEl => {
        stepEl.addEventListener('click', () => {
            const key = stepEl.dataset.step;
            navigateToStep(key);
        });
    });
});
