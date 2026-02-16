# Frontend Re-Architecture: File-by-File Implementation Plan

> **Goal:** Refactor `public/app.js` (~3,100 lines) into ES modules under `public/js/`.  
> **Constraint:** The app works after **every** work item. No big-bang rewrite.  
> **Approach:** Bottom-up extraction. Each step creates a new module, wires it in via `import`, and deletes the moved code from `app.js`.

---

## Phase 0 — Scaffolding & Module Bootstrap

### WI-0: Convert to ES modules and create the js/ directory

**Files modified:** `public/index.html`  
**Files created:** `public/js/` (directory)

**Changes to `index.html`:**
- Change `<script src="app.js"></script>` → `<script type="module" src="app.js"></script>`
- That's it. No other HTML changes yet.

**Verification:** App loads identically. The `type="module"` attribute means `app.js` now runs in strict mode and supports `import`/`export`. Since nothing is exported/imported yet, behavior is unchanged. Note: module scripts are `defer`ed by default, so the three `DOMContentLoaded` listeners in `app.js` still fire correctly.

---

## Phase 1 — Pure Utilities (Zero DOM Dependencies)

### WI-1: Extract `public/js/utils.js`

**File created:** `public/js/utils.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `escapeHtml(text)` | function | Creates a text node and returns innerHTML — XSS-safe |

**What moves out of `app.js`:**
- The `escapeHtml()` function (lines ~1275-1279)

**What stays in `app.js`:**
- A new `import { escapeHtml } from './js/utils.js';` at the top

**Dependencies:** None (pure function).

**Removal from `app.js`:** Delete the `function escapeHtml(text) { ... }` block.

---

### WI-2: Extract `public/js/agents.js`

**File created:** `public/js/agents.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `AGENTS` | const object | Agent identity map: `{ extractor, analyzer, builder, deployer, validator }` — each has `name`, `role`, `letter`, `class`, `logo?` |

**What moves out of `app.js`:**
- The `AGENTS` constant (lines ~523-529)

**What stays in `app.js`:**
- `import { AGENTS } from './js/agents.js';`
- `setActiveAgent()` stays in `app.js` for now (it touches the DOM badge)

**Dependencies:** None (pure data).

**Removal from `app.js`:** Delete the `const AGENTS = { ... };` block.

---

### WI-3: Extract `public/js/toast.js`

**File created:** `public/js/toast.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `showToast(message, type='error')` | function | Creates a toast DOM element on `document.body`, auto-dismisses non-error toasts after 6s |

**What moves out of `app.js`:**
- The entire `showToast()` function (lines ~553-574)

**Dependencies:** None (self-contained DOM creation).

**Removal from `app.js`:** Delete `function showToast(...)` block. Add `import { showToast } from './js/toast.js';`.

---

## Phase 2 — Event Bus & State Store

### WI-4: Extract `public/js/event-bus.js`

**File created:** `public/js/event-bus.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `bus` | singleton instance | Pub/sub: `bus.on(event, fn)`, `bus.off(event, fn)`, `bus.emit(event, ...args)` |

**What moves out of `app.js`:** Nothing yet — this is **new** infrastructure. Current `app.js` has no event bus; functions call each other directly. We create the bus now so subsequent extractions can use it instead of direct function calls.

**Implementation:**
```js
class EventBus {
  constructor() { this._listeners = {}; }
  on(event, fn)  { (this._listeners[event] ??= []).push(fn); }
  off(event, fn) { const a = this._listeners[event]; if(a) this._listeners[event] = a.filter(f=>f!==fn); }
  emit(event, ...args) { (this._listeners[event] || []).forEach(fn => fn(...args)); }
}
export const bus = new EventBus();
```

**Dependencies:** None.

---

### WI-5: Extract `public/js/store.js`

**File created:** `public/js/store.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `store` | singleton | Observable state container with `.get(path)`, `.set(path, value)`, `.update(path, fn)`, `.subscribe(path, fn)`, `.getState()` |
| `INITIAL_STATE` | const | The state schema default values |

**Schema (mirrors architect's design):**
```js
export const INITIAL_STATE = {
  meeting:    { name: '', iteration: 1, info: { title: '', date: '', participants: [], summary: '' } },
  stages:     { meet: { status:'idle', startTime:null, endTime:null, metrics:{} },
                analyze: { ... }, build: { ... }, verify: { ... } },
  activeStage:    null,
  detailPanelOpen: null,
  requirements:   [],          // string[]
  gaps:           [],          // gap objects
  epicIssue:      { number: 0, url: '' },
  deployedUrl:    '',
  analysisPhase:  'idle',
  dispatch: { inProgress:false, totalItems:0, completedItems:0, dispatchedIds: new Set() },
  createdIssues:  [],
  validationResults: [],
  qaMode:         false,
  activePhase:    'meeting',
  completedPhases: new Set(),
};
```

**What moves out of `app.js`:**
- All global state variables (lines 1-18): `gaps`, `requirements`, `createdIssues`, `currentStep`, `analysisComplete`, `analysisPhase`, `epicIssueNumber`, `epicIssueUrl`, `deployedUrl`, `validationResults`, `qaMode`, `previousPanel`, `activePhase`, `completedPhases`
- The `loopState` object and `updateLoopState()` function (lines 20-56)

**Migration strategy:**  
This is the largest conceptual change. For backward compat during migration, `app.js` will import `store` and alias convenience getters:
```js
import { store } from './js/store.js';
// Temporary shims — removed when flow modules are extracted
const getGaps = () => store.get('gaps');
```
Direct mutations like `gaps.push(gap)` become `store.update('gaps', arr => [...arr, gap])`.

> **Important:** This WI does NOT move `renderLoopNodes()` or any rendering. The store simply holds data. The existing `updateLoopState()` call sites are rewritten to use `store.set('stages.meet.status', 'active')` etc.

**Dependencies:** `event-bus.js` (store emits change events through the bus).

**Removal from `app.js`:** Delete all 18 global `let` declarations, the `loopState` object, and `updateLoopState()`. Replace with a single `import { store } from './js/store.js';` and thin shims.

---

## Phase 3 — Infrastructure Modules (DOM helpers)

### WI-6: Extract `public/js/api.js`

**File created:** `public/js/api.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `analyzeMeeting(meetingName)` | async generator | SSE stream from `/api/analyze`. Yields `{ type, data }` events: `progress`, `meeting-info`, `requirements`, `epic-created`, `log`, `complete`, `error` |
| `analyzeGaps(selectedIndices)` | async generator | SSE stream from `/api/analyze-gaps`. Yields `gap-started`, `gap`, `log`, `complete`, `error` |
| `createIssues(selectedIds)` | async generator | SSE stream from `/api/create-issues`. Yields `issue`, `log`, `error` |
| `assignCodingAgent(issueNumbers)` | async generator | SSE stream from `/api/assign-coding-agent`. Yields `result`/`assignment`, `log`, `complete` |
| `executeLocalAgent(gapIds)` | async generator | SSE stream from `/api/execute-local-agent`. Yields `item-start`, `item-progress`, `item-complete`, `log`, `error` |
| `deploy()` | async generator | SSE stream from `/api/deploy`. Yields `log`, `deploy-url`, `complete`, `error` |
| `validate(url, requirements)` | async generator | SSE stream from `/api/validate`. Yields `validation-start`, `result`, `log`, `error` |
| `parseSSEStream(response)` | async generator | **Internal** helper: takes a `Response`, reads its body as SSE, yields `{ event, data }` objects. Used by all above functions. |

**What moves out of `app.js`:**
- The duplicated SSE parsing logic embedded in `startAnalysis()`, `startGapAnalysis()`, `analyzeSkipped()`, `dispatchCloudFromGaps()`, `dispatchLocalFromGaps()`, `dispatchDeveloperFromGaps()`, `runDeploy()`, `runValidation()`.
- Specifically: the `EventSource` construction (in `startAnalysis`), and all the `fetch()` → `response.body.getReader()` → `while(true)` SSE parsing loops.

**Migration note:** The *orchestration logic* (what to do when each event arrives) stays in `app.js` for now. The API module only handles network I/O and yields parsed events. Example:
```js
// In app.js (temporary, until flow modules are extracted)
import { analyzeGaps } from './js/api.js';
for await (const { type, data } of analyzeGaps(selectedIndices)) {
  if (type === 'gap') enrichRowWithGap(data.gap);
  ...
}
```

**Dependencies:** None.

**Removal from `app.js`:** Replace every `new EventSource(...)` and every `fetch(...) + reader` SSE loop with calls to `api.js` async generators. This **significantly reduces** `app.js` — roughly 400 lines of SSE parsing code become ~50 lines of `for await` loops.

---

### WI-7: Extract `public/js/loop-particles.js`

**File created:** `public/js/loop-particles.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `LoopParticleSystem` | class | The full particle animation system — `init()`, `start()`, `stop()`, `setActiveStage()`, `triggerBurst()`, `celebratoryLoop()` |
| `initParticles()` | function | Creates global instance, calls `init()`. Returns the instance. |
| `triggerParticleBurst(from, to)` | function | Global convenience wrapper |

**What moves out of `app.js`:**
- The entire `class LoopParticleSystem { ... }` (lines ~174-370, ~200 lines)
- The `let loopParticles = null;` global
- The DOMContentLoaded init block that creates `loopParticles`
- The `triggerParticleBurst()` function

**Dependencies:** None (pure DOM/SVG animation).

**Removal from `app.js`:** Delete ~200 lines. Add `import { initParticles, triggerParticleBurst } from './js/loop-particles.js';`. The remaining `advanceStage()` function calls `triggerParticleBurst()` as before.

---

## Phase 4 — UI Components

### WI-8: Extract `public/js/stage-controller.js`

**File created:** `public/js/stage-controller.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `showPanel(panelId)` | function | Activates a panel by ID, deactivates others |
| `setActivePhase(phase)` | function | Updates phase-tab nav highlight |
| `markPhaseCompleted(phase)` | function | Adds `completed` class to phase tab |
| `setStep(step)` | function | Maps legacy step numbers to phases |
| `setQAStep(phase)` | function | Keeps verify phase active during deploy/validate |
| `setStatus(text, type)` | function | Updates the status badge in the header |
| `showLoopHeader(show)` | function | Toggles between phase-nav and loop-info header |
| `openStageDetail(stage)` | function | Opens the slide-over panel for a stage |
| `closeStageDetail()` | function | Closes slide-over, returns panel to `<main>` |
| `navigateToPhase(phase)` | function | Phase tab click handler |
| `navigateToLanding()` | function | Returns to landing page |
| `returnToLoop()` | function | Returns to loop view |
| `navigateToStep(stepKey)` | function | Legacy step navigation shim |

**What moves out of `app.js`:**
- `showPanel()` (lines ~408-416)
- `setStep()`, `setActivePhase()`, `markPhaseCompleted()`, `setQAStep()` (lines ~418-460)
- `setStatus()` (lines ~462-467)
- `showLoopHeader()` (lines ~3080-3100)
- `openStageDetail()`, `closeStageDetail()`, `_returnPanelToMain()`, `_slideOverSourcePanelId`, `STAGE_PANEL_MAP` (lines ~2092-2220)
- `navigateToPhase()`, `navigateToLanding()`, `returnToLoop()`, `navigateToStep()` (lines ~3070-3160)
- Escape key handler (line ~2222)

**Dependencies:** `store.js` (reads `loopState`, `analysisPhase`), `toast.js`, `loop-particles.js` (for `renderLoopNodes` integration).

**Removal from `app.js`:** ~200 lines removed. Add imports. Functions that currently reference removed globals will import from `store.js`.

---

### WI-9: Extract `public/js/requirements-table.js`

**File created:** `public/js/requirements-table.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `renderRequirementsForSelection(reqs)` | function | Builds the unified table in "meet" mode — checkboxes + requirement text + pending status |
| `enrichRowWithGap(gap)` | function | Updates a table row with gap analysis results (status chip, complexity badge, detail row) |
| `markRowAnalyzing(gapId)` | function | Sets a row status to "Analyzing..." spinner |
| `revealCheckboxesForIssues()` | function | After analysis, shows agent-type dropdowns on gap-found rows, disables no-gap checkboxes |
| `renderDispatchTable(selectedGaps, cloudGaps, localGaps, developerGaps)` | function | Builds the dispatch table with mode badges, status, issue columns |
| `updateDispatchRowIssue(gapId, issue)` | function | Sets the issue link on a dispatch row |
| `updateDispatchRowStatus(gapId, status)` | function | Sets status chip on a dispatch row |
| `updateDispatchCounts()` | function | Updates dispatched/remaining counters in the dispatch panel header |
| `buildQAGapTable()` | function | Renders the QA panel table (requirements + validation status) |
| `setQATableRowValidating(reqIndex, requirement)` | function | Sets a QA row to "Validating" spinner state |
| `updateQATableRowWithValidation(result)` | function | Updates a QA row with pass/fail result + expandable evidence |
| `toggleReqExpand(index)` | function | Toggles the detail expansion row for a requirement |
| `handleCheckboxChange(index)` | function | Dual-phase checkbox handler (selecting vs. reviewed) |
| `handleSelectAll()` | function | Select/deselect all checkboxes |
| `toggleAllCheckboxes()` | function | Toggle all checkbox state |
| `updateAnalyzeCount()` | function | Counts checked boxes, updates analyze button badge |
| `updateSelectedCount()` | function | Counts selected gap items, updates dispatch button badge |

**What moves out of `app.js`:**
- `renderRequirementsForSelection()` (~70 lines)
- `toggleReqExpand()` (~10 lines)
- `updateAnalyzeCount()` (~10 lines)
- `markRowAnalyzing()` (~15 lines)
- `enrichRowWithGap()` (~70 lines)
- `revealCheckboxesForIssues()` (~50 lines)
- `handleCheckboxChange()`, `handleSelectAll()`, `toggleAllCheckboxes()`, `toggleDetails()`, `toggleExpandableDetail()` (~100 lines)
- `updateSelectedCount()` (~15 lines)
- `renderDispatchTable()` (~100 lines)
- `updateDispatchRowIssue()`, `updateDispatchRowStatus()`, `updateDispatchCounts()` (~80 lines)
- `buildQAGapTable()` (~100 lines)
- `setQATableRowValidating()`, `updateQATableRowWithValidation()` (~120 lines)
- `isNoGap()` helper (~15 lines)

**Total:** ~750 lines

**Dependencies:** `utils.js` (`escapeHtml`), `store.js` (reads/writes `gaps`, `requirements`, `analysisPhase`, `dispatch`, `validationResults`).

**Removal from `app.js`:** This is the biggest single extraction. ~750 lines deleted from `app.js`. All table-related DOM manipulation moves out. The flow orchestrators (which stay in `app.js` temporarily) call these functions via import.

**Global function bindings note:** Several functions are referenced from `onclick` handlers in the HTML (`handleSelectAll`, `toggleAllCheckboxes`, etc.). After extraction, `app.js` must re-export them to `window`:
```js
import { handleSelectAll, toggleAllCheckboxes, ... } from './js/requirements-table.js';
window.handleSelectAll = handleSelectAll;
window.toggleAllCheckboxes = toggleAllCheckboxes;
// etc.
```
This is temporary until Phase 5 replaces inline handlers with `addEventListener`.

---

## Phase 5 — Flow Orchestrators

### WI-10: Extract `public/js/meeting-flow.js`

**File created:** `public/js/meeting-flow.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `startAnalysis()` | async function | Full Meet stage orchestrator: resets UI, opens SSE to `/api/analyze`, updates meeting card, streams requirements into table, creates epic. ~150 lines |
| `populateMeetingBanner(info)` | function | Fills meeting detail banner from meeting-info event data |
| `toggleMeetingBanner()` | function | Toggles meeting source brand expansion |
| `markStep(stepNum)` | function | Updates progress strip step indicators |
| `markAllStepsDone()` | function | Marks all progress steps as done |

**What moves out of `app.js`:**
- `startAnalysis()` (~150 lines including SSE event handlers)
- `meetingInfoCache`, `toggleMeetingBanner()`, `populateMeetingBanner()` (~30 lines)
- `stepIds`, `markStep()`, `markAllStepsDone()` (~25 lines)
- DOMContentLoaded handler for `meetingNameInput` wiring (~15 lines)

**Dependencies:** `api.js` (`analyzeMeeting`), `store.js`, `stage-controller.js` (`showPanel`, `setStatus`, `showLoopHeader`), `requirements-table.js` (`renderRequirementsForSelection`), `agents.js` (`AGENTS`), `toast.js`, `utils.js`.

**Window binding:** `window.startAnalysis = startAnalysis;` (called from inline `onclick` on the "Ship the Meeting" button).

---

### WI-11: Extract `public/js/analyze-flow.js`

**File created:** `public/js/analyze-flow.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `startGapAnalysis()` | async function | Analyze stage orchestrator: submits selected requirements, streams gap results, enriches table rows |
| `analyzeSkipped()` | async function | Runs gap analysis on previously-skipped requirements |
| `showAnalyzeSkippedButton()` | function | Shows/hides the "Analyze Skipped" button based on unanaylzed count |
| `getSkippedIndices()` | function | Returns indices of rows with "Skipped" status |

**What moves out of `app.js`:**
- `startGapAnalysis()` (~120 lines)
- `analyzeSkipped()` (~100 lines)
- `showAnalyzeSkippedButton()`, `getSkippedIndices()` (~25 lines)

**Dependencies:** `api.js` (`analyzeGaps`), `store.js`, `requirements-table.js` (`markRowAnalyzing`, `enrichRowWithGap`, `revealCheckboxesForIssues`, `buildQAGapTable`), `stage-controller.js` (`setStatus`), `agents.js`, `toast.js`.

**Window bindings:** `window.startGapAnalysis = startGapAnalysis;`, `window.analyzeSkipped = analyzeSkipped;`

---

### WI-12: Extract `public/js/build-flow.js`

**File created:** `public/js/build-flow.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `dispatchSelected()` | async function | Build stage orchestrator: partitions gaps by agent type, dispatches in parallel (cloud/local/developer) |
| `dispatchRemaining()` | async function | Dispatches undispatched actionable gaps as cloud |
| `finishDispatch()` | function | Transitions to completion panel |
| `dispatchCloudFromGaps(cloudGaps)` | async function | Creates GitHub issues → assigns Copilot coding agent |
| `dispatchLocalFromGaps(localGaps)` | async function | Sends gaps to local Copilot SDK agent |
| `dispatchDeveloperFromGaps(devGaps)` | async function | Creates GitHub issues without agent assignment |
| `renderCompletion(results)` | function | Builds completion panel stats |
| `incrementDispatchProgress()` | function | Bumps dispatch progress bar |

**What moves out of `app.js`:**
- `dispatchedGapIds`, `dispatchInProgress`, `dispatchTotalItems`, `dispatchCompletedItems` → moved into `store.dispatch.*`
- `dispatchSelected()` (~120 lines)
- `dispatchRemaining()` (~80 lines)
- `finishDispatch()` (~15 lines)
- `dispatchCloudFromGaps()` (~120 lines)
- `dispatchLocalFromGaps()` (~90 lines)
- `dispatchDeveloperFromGaps()` (~80 lines)
- `renderCompletion()` (~25 lines)
- `incrementDispatchProgress()` (~10 lines)

**Total:** ~540 lines

**Dependencies:** `api.js` (`createIssues`, `assignCodingAgent`, `executeLocalAgent`), `store.js`, `requirements-table.js` (`renderDispatchTable`, `updateDispatchRowIssue`, `updateDispatchRowStatus`, `updateDispatchCounts`), `stage-controller.js` (`showPanel`, `setStatus`, `setStep`, `setActiveAgent`), `toast.js`, `utils.js`.

**Window bindings:** `window.dispatchSelected`, `window.dispatchRemaining`, `window.finishDispatch`

---

### WI-13: Extract `public/js/verify-flow.js`

**File created:** `public/js/verify-flow.js`

**Exports:**
| Export | Type | Description |
|--------|------|-------------|
| `launchQAWorkflow()` | async function | Full verify orchestrator: deploy → validate |
| `runDeployOnly()` | async function | Deploy-only sub-flow |
| `runValidateOnly()` | async function | Validate-only sub-flow |
| `toggleQAMode()` | function | Toggles QA panel visibility |
| `updateQAFabVisibility()` | function | No-op placeholder |
| `showDeployUrl(url)` | function | Shows deployed URL in the QA panel |
| `resetValidateStepUI(el)` | function | Resets the validate step icon/label |
| `finishValidationUI(el)` | function | Sets final pass/fail state on validate step |
| `runDeploy()` | async function | SSE deploy call |
| `runValidation(url)` | async function | SSE validation call |

**What moves out of `app.js`:**
- `qaWorkflowRunning` flag (→ local module state)
- `launchQAWorkflow()` (~100 lines)
- `runDeployOnly()` (~60 lines)
- `runValidateOnly()` (~60 lines)
- `toggleQAMode()`, `updateQAFabVisibility()` (~15 lines)
- `showDeployUrl()`, `resetValidateStepUI()`, `finishValidationUI()` (~40 lines)
- `runDeploy()` (~50 lines — SSE parsing replaced by `api.deploy()`)
- `runValidation()` (~50 lines — SSE parsing replaced by `api.validate()`)

**Total:** ~375 lines

**Dependencies:** `api.js` (`deploy`, `validate`), `store.js`, `requirements-table.js` (`buildQAGapTable`, `setQATableRowValidating`, `updateQATableRowWithValidation`), `stage-controller.js` (`setStatus`, `setQAStep`, `showPanel`, `setActivePhase`), `toast.js`.

**Window bindings:** `window.launchQAWorkflow`, `window.runDeployOnly`, `window.runValidateOnly`

---

## Phase 6 — Slim `app.js` Down to Bootstrapper

### WI-14: Reduce `app.js` to bootstrapper + window bindings

**File modified:** `public/app.js`

At this point, after WI-1 through WI-13, `app.js` should contain only:

1. **Imports** (~15 lines)
2. **`window.*` bindings** for inline HTML `onclick` handlers (~25 lines)
3. **`renderLoopNodes()`** + **`renderStageAction()`** + **`advanceStage()`** — Loop rendering (~120 lines, subscribers to store)
4. **`setActiveAgent()`** — Agent badge updater (~20 lines)
5. **`appendLog()` + `appendToActivityFeed()` + `toggleActivityFeed()`** — Logging helpers (~50 lines)
6. **`resetApp()`** — Full reset function (~50 lines)
7. **DOMContentLoaded init** (~10 lines)

**Estimated `app.js` size:** ~290 lines (down from ~3,100).

**What this WI does:**
- Clean up any remaining dead code
- Ensure all `window.*` bindings are collected in one block at the top
- Verify every inline `onclick` in `index.html` resolves to a `window` function

**Verification:** Full smoke test — run through the entire Meet → Analyze → Build → Verify flow.

---

### WI-15: Move remaining `app.js` render functions into modules

**File modified:** `public/app.js`, `public/js/stage-controller.js`

**What moves:**
- `renderLoopNodes()`, `renderStageAction()`, `advanceStage()` → `stage-controller.js`
- `setActiveAgent()` → new export in `agents.js` (or a small `public/js/agent-badge.js`)
- `appendLog()`, `appendToActivityFeed()`, `toggleActivityFeed()` → new `public/js/log.js`
- `resetApp()` → `stage-controller.js` or standalone `public/js/reset.js`

**After this WI, `app.js` contains only:**
```js
// ─── Bootstrapper ─────────────────────────────────────────────────────
import { store } from './js/store.js';
import { initParticles } from './js/loop-particles.js';
import { showPanel } from './js/stage-controller.js';
// ... all other imports ...

// ─── Window bindings for inline HTML onclick handlers ─────────────────
window.startAnalysis = startAnalysis;
window.startGapAnalysis = startGapAnalysis;
window.dispatchSelected = dispatchSelected;
// ... etc ...

// ─── Init ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initParticles();
  showPanel('panel-analyze');
});
```

**Estimated final `app.js`:** ~50 lines.

---

## Phase 7 — Clean Up Inline Handlers (Optional, Low Priority)

### WI-16: Replace `onclick` attributes with `addEventListener`

**Files modified:** `public/index.html`, all `public/js/*.js` flow modules

**What changes:**
- Remove all `onclick="functionName()"` attributes from HTML
- Each module registers its own event listeners in an `init()` function
- `app.js` bootstrapper calls each module's `init()`
- Remove all `window.*` bindings from `app.js`

This is optional because the `window.*` binding approach from WI-14 already works. But it's good practice for encapsulation.

---

## Dependency Graph

```
app.js (bootstrapper)
  ├── js/store.js ← js/event-bus.js
  ├── js/utils.js
  ├── js/agents.js
  ├── js/toast.js
  ├── js/loop-particles.js
  ├── js/api.js
  ├── js/stage-controller.js ← store, toast, loop-particles
  ├── js/requirements-table.js ← store, utils
  ├── js/meeting-flow.js ← api, store, stage-controller, requirements-table, agents, toast, utils
  ├── js/analyze-flow.js ← api, store, requirements-table, stage-controller, agents, toast
  ├── js/build-flow.js ← api, store, requirements-table, stage-controller, toast, utils
  └── js/verify-flow.js ← api, store, requirements-table, stage-controller, toast
```

---

## Execution Order Summary

| WI | File | Lines moved out of app.js | Cumulative app.js reduction |
|----|------|--------------------------|----------------------------|
| 0 | index.html | 0 | 0 |
| 1 | js/utils.js | ~5 | ~5 |
| 2 | js/agents.js | ~10 | ~15 |
| 3 | js/toast.js | ~25 | ~40 |
| 4 | js/event-bus.js | 0 (new) | ~40 |
| 5 | js/store.js | ~60 | ~100 |
| 6 | js/api.js | ~400 (SSE parsing) | ~500 |
| 7 | js/loop-particles.js | ~200 | ~700 |
| 8 | js/stage-controller.js | ~200 | ~900 |
| 9 | js/requirements-table.js | ~750 | ~1,650 |
| 10 | js/meeting-flow.js | ~220 | ~1,870 |
| 11 | js/analyze-flow.js | ~245 | ~2,115 |
| 12 | js/build-flow.js | ~540 | ~2,655 |
| 13 | js/verify-flow.js | ~375 | ~3,030 |
| 14 | app.js cleanup | — | ~3,050 (app.js → ~290 lines) |
| 15 | Final extraction | ~240 | ~3,100 (app.js → ~50 lines) |

---

## Testing Strategy Per WI

Every WI must pass this checklist before merging:
1. **Page loads** without console errors
2. **Enter meeting name** → SSE flow starts, meeting card appears, requirements stream in
3. **Select requirements → Analyze Gaps** → gap results stream in, rows enrich
4. **Dispatch** → issues created, agent assigned, progress bar fills
5. **Ship & Validate** → deploy runs, validation runs, pass/fail shown
6. **Reset** → app returns to landing state

For WIs 1-5 (infrastructure), only tests 1-2 are relevant since those don't touch orchestration.

---

## Notes for Engineers

- **`type="module"` and global scope:** ES modules don't pollute `window`. Any function called from an `onclick` attribute in HTML must be explicitly assigned to `window` in `app.js` (the bootstrapper). This is handled in WI-14.

- **Circular dependencies:** The dependency graph above is acyclic. `store.js` and `event-bus.js` are leaf nodes. Flow modules import from components but not from each other.

- **No build step:** All imports use relative paths with `.js` extensions. Browsers require the extension in native ES module imports.

- **Deferred loading:** `<script type="module">` is implicitly deferred. The `DOMContentLoaded` listeners will still fire. No timing changes.

- **`Set` serialization:** `store.dispatch.dispatchedIds` is a `Set`. The store's `subscribe` mechanism should use reference equality (not deep compare) for Sets.

- **SSE parsing:** `api.js` uses async generators. Each flow module consumes them with `for await...of`. This is cleaner than the current duplicated `while(true) { reader.read() }` pattern and enables proper error handling via `try/catch` around the loop.
