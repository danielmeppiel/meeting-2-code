/* ═══════════════════════════════════════════════════════════════════════════
   Meeting → Code | Application Logic
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── State ────────────────────────────────────────────────────────────────────
let gaps = [];
let requirements = [];
let createdIssues = [];
let currentStep = 1;
let analysisComplete = false;

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
}

function setStep(step) {
    currentStep = step;
    document.querySelectorAll('.step').forEach(s => {
        const stepNum = parseInt(s.dataset.step);
        s.classList.remove('active', 'completed');
        if (stepNum < step) s.classList.add('completed');
        else if (stepNum === step) s.classList.add('active');
    });
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
async function startAnalysis() {
    const btn = document.getElementById('btnAnalyze');
    btn.disabled = true;
    analysisComplete = false;

    setStatus('Analyzing...', 'processing');
    showPanel('panel-loading');

    // Reset progress steps
    const stepIds = ['ls-fetch', 'ls-extract', 'ls-requirements', 'ls-analyze', 'ls-complexity'];
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

    // Show meeting card with initial state
    const liveRight = document.getElementById('liveRightPanel');
    if (liveRight) liveRight.style.display = '';
    const meetingCard = document.getElementById('meetingCard');
    meetingCard.style.display = 'flex';
    meetingCard.classList.remove('found');
    document.getElementById('meetingCardIcon').className = 'meeting-card-icon';
    document.getElementById('meetingCardTitle').textContent = 'Connecting to WorkIQ...';
    document.getElementById('meetingCardDate').textContent = '';
    document.getElementById('meetingCardParticipants').style.display = 'none';
    document.getElementById('meetingCardStatusRow').style.display = 'flex';
    document.getElementById('meetingCardStatus').textContent = 'Initializing session...';

    // Reset agent log
    document.getElementById('agentLogEntries').innerHTML = '';

    requirements = [];
    gaps = [];

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

    markStep(0);

    try {
        const result = await new Promise((resolve, reject) => {
            const eventSource = new EventSource('/api/analyze');
            let gapAnalyzedCount = 0;

            eventSource.addEventListener('progress', (e) => {
                const { step, message } = JSON.parse(e.data);
                console.log(`[Progress] Step ${step}: ${message}`);
                markStep(step);

                // Keep meeting card in sync with progress steps
                const cardTitle = document.getElementById('meetingCardTitle');
                const cardStatus = document.getElementById('meetingCardStatus');
                if (step === 0) {
                    // WorkIQ connected, now searching
                    cardTitle.textContent = 'Searching for meeting...';
                    cardStatus.textContent = 'Connected to WorkIQ';
                } else if (step === 1) {
                    // Meeting found, fetching data
                    cardTitle.textContent = 'Meeting found';
                    cardStatus.textContent = 'Fetching meeting data...';
                } else if (step === 2) {
                    cardStatus.textContent = 'Extracting requirements...';
                }
            });

            eventSource.addEventListener('meeting-info', (e) => {
                const info = JSON.parse(e.data);
                const card = document.getElementById('meetingCard');
                card.style.display = 'flex';
                card.classList.add('found');
                // Swap icon to a checkmark
                const iconEl = document.getElementById('meetingCardIcon');
                iconEl.className = 'meeting-card-icon found';
                iconEl.innerHTML = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
                document.getElementById('meetingCardTitle').textContent = 'Meeting Found';
                if (info.date) {
                    document.getElementById('meetingCardDate').textContent = info.date;
                }
                if (info.title) {
                    // Show meeting title as a secondary line under the date
                    const dateEl = document.getElementById('meetingCardDate');
                    dateEl.textContent = (info.date ? info.date + '  ·  ' : '') + info.title;
                }
                if (info.participants && info.participants.length > 0) {
                    const el = document.getElementById('meetingCardParticipants');
                    el.style.display = 'flex';
                    el.innerHTML = info.participants.map(p => `<span class="participant-chip">${escapeHtml(p)}</span>`).join('');
                }
                document.getElementById('meetingCardStatus').textContent = info.requirementCount
                    ? `Extracting ${info.requirementCount} requirements...`
                    : 'Extracting requirements...';
            });

            eventSource.addEventListener('requirements', (e) => {
                const data = JSON.parse(e.data);
                requirements = data.requirements;
                console.log(`[Requirements] ${requirements.length} items`);
                // Hide meeting card, show table
                document.getElementById('meetingCard').style.display = 'none';
                renderRequirementsAsRows(requirements);
            });

            eventSource.addEventListener('gap-started', (e) => {
                const { id } = JSON.parse(e.data);
                markRowAnalyzing(id);
            });

            eventSource.addEventListener('gap', (e) => {
                const { gap } = JSON.parse(e.data);
                console.log(`[Gap] #${gap.id}: ${gap.requirement.substring(0, 60)}`);
                gap.hasGap = !isNoGap(gap);
                gaps.push(gap);
                gapAnalyzedCount++;
                enrichRowWithGap(gap);
                document.getElementById('gapAnalyzedCount').textContent = gapAnalyzedCount;
            });

            eventSource.addEventListener('log', (e) => {
                const { message } = JSON.parse(e.data);
                appendLog('agentLogEntries', message);
            });

            eventSource.addEventListener('complete', (e) => {
                eventSource.close();
                const data = JSON.parse(e.data);
                stepIds.forEach(id => {
                    const el = document.getElementById(id);
                    el.classList.remove('active');
                    el.classList.add('done');
                    el.querySelector('.loading-step-icon').classList.remove('spinner');
                });
                resolve({ success: data.success, totalGaps: data.totalGaps });
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

        if (!result.success) throw new Error('Analysis failed');

        analysisComplete = true;
        const actionableGaps = gaps.filter(g => g.hasGap).length;
        const noGapCount = gaps.length - actionableGaps;
        setStep(2);
        setStatus(`${actionableGaps} Gaps / ${noGapCount} Met`, '');

        // Reveal checkboxes + actions
        revealCheckboxes();

    } catch (error) {
        showToast(error.message);
        setStatus('Error', 'error');
        showPanel('panel-analyze');
        btn.disabled = false;
    }
}

// ─── Unified table: render requirements as initial rows ──────────────────────

function renderRequirementsAsRows(reqs) {
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
        tr.classList.add('unified-row');
        tr.innerHTML = `
            <td class="col-check" style="display:none;">
                <label class="checkbox-wrapper">
                    <input type="checkbox" data-gap-index="${i}" onchange="handleCheckboxChange(${i})">
                    <span class="checkmark"></span>
                </label>
            </td>
            <td class="col-req">
                <div class="td-requirement">${escapeHtml(req)}</div>
            </td>
            <td class="col-status">
                <span class="status-chip analyzing">
                    <span class="status-chip-dot"></span>
                    Queued
                </span>
            </td>
            <td class="col-current"><span class="cell-pending">—</span></td>
            <td class="col-gap"><span class="cell-pending">—</span></td>
            <td class="col-complexity"><span class="cell-pending">—</span></td>
            <td class="col-effort"><span class="cell-pending">—</span></td>
        `;
        tbody.appendChild(tr);
    });

    const tableContainer = container.querySelector('.table-container');
    if (tableContainer) tableContainer.scrollTop = tableContainer.scrollHeight;
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

    if (noGap) {
        // Mark as "No Gap" — requirement already met
        cells[2].innerHTML = `<span class="status-chip no-gap"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> No Gap</span>`;
        cells[3].innerHTML = `<span class="text-muted">${escapeHtml(gap.currentState)}</span>`;
        cells[4].innerHTML = `<span class="text-muted">${escapeHtml(gap.gap)}</span>`;
        cells[5].innerHTML = `<span class="text-muted">—</span>`;
        cells[5].style.textAlign = 'center';
        cells[6].innerHTML = `<span class="text-muted">—</span>`;
        targetRow.classList.add('no-gap-row');
    } else {
        cells[2].innerHTML = `<span class="status-chip analyzed"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Gap Found</span>`;
        cells[3].innerHTML = escapeHtml(gap.currentState);
        cells[4].innerHTML = escapeHtml(gap.gap);
        cells[5].innerHTML = `<span class="complexity-badge ${gap.complexity.toLowerCase()}">${gap.complexity}</span>`;
        cells[5].style.textAlign = 'center';
        cells[6].textContent = gap.estimatedEffort;
    }

    targetRow.dataset.details = gap.details || '';
    targetRow.dataset.gapId = gap.id;
    targetRow.dataset.hasGap = gap.hasGap ? '1' : '0';

    const reqDiv = cells[1].querySelector('.td-requirement');
    if (reqDiv && gap.details) {
        reqDiv.onclick = () => toggleDetails(targetRow);
        reqDiv.style.cursor = 'pointer';
    }

    targetRow.classList.add('row-enriched');
    setTimeout(() => targetRow.classList.remove('row-enriched'), 1200);
}

// ─── Reveal checkboxes after analysis completes ──────────────────────────────

function revealCheckboxes() {
    document.getElementById('colCheckHeader').style.display = '';

    document.querySelectorAll('.unified-row').forEach(row => {
        const checkTd = row.querySelector('.col-check');
        checkTd.style.display = '';

        const isNoGap = row.dataset.hasGap === '0';
        const checkbox = checkTd.querySelector('input[type="checkbox"]');

        if (isNoGap) {
            checkbox.disabled = true;
            checkbox.checked = false;
            checkTd.querySelector('.checkmark').classList.add('checkmark-disabled');
        } else {
            checkbox.checked = true;
            row.classList.add('selected');
        }
    });

    document.getElementById('tableActions').style.display = 'flex';
    document.getElementById('tableActions').style.animation = 'fadeSlideIn 0.4s var(--ease-out)';

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

    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains('row-details')) {
        existing.classList.toggle('show');
        row.querySelector('.td-requirement')?.classList.toggle('expanded');
        return;
    }

    const detailRow = document.createElement('tr');
    detailRow.className = 'row-details show';
    detailRow.innerHTML = `
        <td colspan="7">
            <div class="details-label">Implementation Details</div>
            <div class="details-content">${escapeHtml(details)}</div>
        </td>
    `;
    row.after(detailRow);
    row.querySelector('.td-requirement')?.classList.add('expanded');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

// ─── Checkbox Handling (gap table) ────────────────────────────────────────────
function handleCheckboxChange(index) {
    const gap = gaps[index];
    if (gap && gap.hasGap) {
        const checkbox = document.querySelector(`input[data-gap-index="${index}"]`);
        gap.selected = checkbox.checked;
        const row = checkbox.closest('tr');
        row.classList.toggle('selected', checkbox.checked);
    }
    updateSelectedCount();
}

function handleSelectAll() {
    const selectAll = document.getElementById('selectAll');
    const checked = selectAll.checked;
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

function toggleAllCheckboxes() {
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

function updateSelectedCount() {
    const actionable = gaps.filter(g => g.hasGap);
    const count = actionable.filter(g => g.selected).length;
    document.getElementById('selectedCount').textContent = count;
    document.getElementById('btnCreateIssues').disabled = count === 0;

    const selectAll = document.getElementById('selectAll');
    selectAll.checked = count === actionable.length && actionable.length > 0;
    selectAll.indeterminate = count > 0 && count < actionable.length;
}

// ─── Step 2: Create Issues (SSE streaming) ────────────────────────────────────
async function createIssues() {
    const selectedGaps = gaps.filter(g => g.selected && g.hasGap);
    if (selectedGaps.length === 0) {
        showToast('Please select at least one gap to create issues for.');
        return;
    }

    const selectedIds = selectedGaps.map(g => g.id);
    const total = selectedIds.length;

    const btn = document.getElementById('btnCreateIssues');
    btn.disabled = true;
    setStatus('Creating Issues...', 'processing');
    setStep(3);

    // Switch to issues panel and reset it
    createdIssues = [];
    document.getElementById('issueCreationProgress').style.display = 'block';
    document.getElementById('issueProgressLabel').textContent = `0 / ${total}`;
    document.getElementById('issueProgressFill').style.width = '0%';
    document.getElementById('issueProgressDetail').textContent = 'Connecting to GitHub...';
    document.getElementById('issueTableHeader').style.display = 'none';
    document.getElementById('issueTableContainer').style.display = 'none';
    document.getElementById('issueTableBody').innerHTML = '';
    document.getElementById('issueLog').style.display = 'block';
    document.getElementById('issueLogEntries').innerHTML = '';
    showPanel('panel-issues');

    try {
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

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // Parse SSE events from buffer
            const chunks = buffer.split('\n\n');
            buffer = chunks.pop(); // keep incomplete chunk

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
                    const { current, total: t, message } = JSON.parse(eventData);
                    document.getElementById('issueProgressLabel').textContent = `${current} / ${t}`;
                    document.getElementById('issueProgressFill').style.width = `${(current / t) * 100}%`;
                    document.getElementById('issueProgressDetail').textContent = message;
                } else if (eventType === 'issue') {
                    const { issue } = JSON.parse(eventData);
                    createdIssues.push(issue);
                    // Show table as soon as first issue arrives
                    document.getElementById('issueTableContainer').style.display = 'block';
                    appendIssueRow(issue);
                } else if (eventType === 'log') {
                    const { message } = JSON.parse(eventData);
                    appendLog('issueLogEntries', message);
                } else if (eventType === 'complete') {
                    finalizeIssueCreation();
                } else if (eventType === 'error') {
                    const { error } = JSON.parse(eventData);
                    throw new Error(error);
                }
            }
        }

        // In case complete event wasn't in the last chunk
        if (createdIssues.length > 0 && document.getElementById('issueTableHeader').style.display === 'none') {
            finalizeIssueCreation();
        }

    } catch (error) {
        showToast(error.message);
        setStatus('Error', 'error');
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>
            Create Issues for Selected
            <span class="btn-badge" id="selectedCount">${selectedIds.length}</span>
        `;
    }
}

function appendIssueRow(issue) {
    const tbody = document.getElementById('issueTableBody');
    const tr = document.createElement('tr');
    tr.classList.add('issue-row');
    tr.dataset.issueNumber = issue.number;

    const failed = !issue.number || issue.number === 0 || issue.error;

    let issueNumCell;
    let statusCell;
    let checkboxCell;

    if (failed) {
        issueNumCell = `<span class="text-muted">—</span>`;
        statusCell = `<span class="status-chip failed"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Failed</span>`;
        checkboxCell = `
            <label class="checkbox-wrapper">
                <input type="checkbox" data-issue-num="0" disabled>
                <span class="checkmark"></span>
            </label>
        `;
        tr.classList.add('issue-row-failed');
    } else {
        const issueUrl = issue.url && issue.url !== '#'
            ? `<a href="${escapeHtml(issue.url)}" target="_blank" class="issue-link">#${issue.number} <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`
            : `<span class="text-muted">#${issue.number}</span>`;
        issueNumCell = issueUrl;
        statusCell = `<span class="status-chip analyzed"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Created</span>`;
        checkboxCell = `
            <label class="checkbox-wrapper">
                <input type="checkbox" data-issue-num="${issue.number}" checked onchange="handleIssueCheckboxChange(${issue.number})">
                <span class="checkmark"></span>
            </label>
        `;
    }

    tr.innerHTML = `
        <td class="col-check">${checkboxCell}</td>
        <td class="col-issue-num">${issueNumCell}</td>
        <td class="col-req"><div class="td-requirement" style="cursor:default;">${escapeHtml(issue.title)}</div></td>
        <td class="col-issue-status">${statusCell}</td>
    `;
    tbody.appendChild(tr);

    issue.selectedForAssign = !failed;

    // Auto-scroll table
    const container = document.getElementById('issueTableContainer');
    if (container) container.scrollTop = container.scrollHeight;
}

function finalizeIssueCreation() {
    // Hide progress, show header + actions
    document.getElementById('issueCreationProgress').style.display = 'none';
    document.getElementById('issueTableHeader').style.display = 'flex';

    const successCount = createdIssues.filter(i => i.number > 0 && !i.error).length;
    const failCount = createdIssues.length - successCount;

    document.getElementById('issueCount').textContent = successCount;

    // Select all successful by default
    document.getElementById('selectAllIssues').checked = successCount > 0;
    updateAssignCount();

    if (failCount > 0 && successCount > 0) {
        setStatus(`${successCount} Issues Created, ${failCount} Failed`, 'warning');
        showToast(`${failCount} issue(s) failed to create. Check logs for details.`);
    } else if (failCount > 0 && successCount === 0) {
        setStatus('All Issues Failed', 'error');
        showToast('All issues failed to create. Check logs for details.');
    } else {
        setStatus(`${successCount} Issues Created`, '');
    }
}

// ─── Issue checkbox handling ──────────────────────────────────────────────────
function handleIssueCheckboxChange(issueNumber) {
    const issue = createdIssues.find(i => i.number === issueNumber);
    if (issue) {
        const cb = document.querySelector(`input[data-issue-num="${issueNumber}"]`);
        issue.selectedForAssign = cb.checked;
        cb.closest('tr').classList.toggle('selected', cb.checked);
    }
    updateAssignCount();
}

function handleSelectAllIssues() {
    const checked = document.getElementById('selectAllIssues').checked;
    createdIssues.forEach(i => { i.selectedForAssign = checked; });
    document.querySelectorAll('.issue-row input[type="checkbox"]').forEach(cb => {
        cb.checked = checked;
        cb.closest('tr').classList.toggle('selected', checked);
    });
    updateAssignCount();
}

function toggleAllIssueCheckboxes() {
    const anySelected = createdIssues.some(i => i.selectedForAssign);
    const newState = !anySelected;
    createdIssues.forEach(i => { i.selectedForAssign = newState; });
    document.querySelectorAll('.issue-row input[type="checkbox"]').forEach(cb => {
        cb.checked = newState;
        cb.closest('tr').classList.toggle('selected', newState);
    });
    document.getElementById('selectAllIssues').checked = newState;
    updateAssignCount();
}

function updateAssignCount() {
    const assignable = createdIssues.filter(i => i.number > 0 && !i.error);
    const count = assignable.filter(i => i.selectedForAssign).length;
    document.getElementById('assignCount').textContent = count;
    document.getElementById('btnAssignAgent').disabled = count === 0;

    const selectAll = document.getElementById('selectAllIssues');
    selectAll.checked = count === assignable.length && assignable.length > 0;
    selectAll.indeterminate = count > 0 && count < assignable.length;
}

// ─── Step 3: Assign Coding Agent ──────────────────────────────────────────────
async function assignAgent() {
    const selectedIssues = createdIssues.filter(i => i.selectedForAssign);
    if (selectedIssues.length === 0) {
        showToast('Please select at least one issue to assign.');
        return;
    }

    const btn = document.getElementById('btnAssignAgent');
    btn.disabled = true;
    btn.innerHTML = `
        <div class="loading-step-icon spinner" style="width:16px;height:16px;border-width:2px;"></div>
        Assigning Copilot...
    `;

    setStatus('Assigning Agent...', 'processing');

    const issueNumbers = selectedIssues.map(i => i.number).filter(n => n > 0);
    const total = issueNumbers.length;

    // Show assignment progress area
    document.getElementById('assignProgress').style.display = 'block';
    document.getElementById('assignProgressLabel').textContent = `0 / ${total}`;
    document.getElementById('assignProgressFill').style.width = '0%';
    document.getElementById('assignLogEntries').innerHTML = '';

    let assignResults = [];

    try {
        const response = await fetch('/api/assign-coding-agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ issueNumbers }),
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'Failed to assign coding agent');
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
                    const { current, total: t } = JSON.parse(eventData);
                    document.getElementById('assignProgressLabel').textContent = `${current} / ${t}`;
                    document.getElementById('assignProgressFill').style.width = `${(current / t) * 100}%`;
                } else if (eventType === 'result') {
                    const { result } = JSON.parse(eventData);
                    assignResults.push(result);
                    // Update the issue row status
                    const row = document.querySelector(`tr[data-issue-number="${result.issueNumber}"]`);
                    if (row) {
                        const statusTd = row.querySelector('.col-issue-status');
                        if (statusTd) {
                            if (result.assigned) {
                                statusTd.innerHTML = `<span class="status-chip assigned"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Assigned</span>`;
                            } else {
                                statusTd.innerHTML = `<span class="status-chip error"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg> Failed</span>`;
                            }
                        }
                    }
                } else if (eventType === 'log') {
                    const { message } = JSON.parse(eventData);
                    appendLog('assignLogEntries', message);
                } else if (eventType === 'complete') {
                    const data = JSON.parse(eventData);
                    assignResults = data.results || assignResults;
                } else if (eventType === 'error') {
                    const { error } = JSON.parse(eventData);
                    throw new Error(error);
                }
            }
        }

        // Finalize
        document.getElementById('assignProgress').style.display = 'none';
        setStep(4);
        setStatus('Complete!', '');
        renderCompletion(assignResults);
        showPanel('panel-complete');
    } catch (error) {
        showToast(error.message);
        setStatus('Error', 'error');
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4z"/>
                <circle cx="12" cy="15" r="2"/>
            </svg>
            Assign Copilot to Selected
            <span class="btn-badge" id="assignCount">${issueNumbers.length}</span>
        `;
    }
}

// ─── Render Completion ────────────────────────────────────────────────────────
function renderCompletion(results) {
    const assigned = results.filter(r => r.assigned).length;

    document.getElementById('completeStats').innerHTML = `
        <div class="stat-item">
            <span class="stat-value">${gaps.filter(g => g.hasGap).length}</span>
            <span class="stat-label">Gaps Found</span>
        </div>
        <div class="stat-item">
            <span class="stat-value">${createdIssues.length}</span>
            <span class="stat-label">Issues Created</span>
        </div>
        <div class="stat-item">
            <span class="stat-value">${assigned}</span>
            <span class="stat-label">Agent Assigned</span>
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
    setStep(1);
    setStatus('Ready', '');
    showPanel('panel-analyze');
    document.getElementById('btnAnalyze').disabled = false;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setStep(1);
    showPanel('panel-analyze');
});
