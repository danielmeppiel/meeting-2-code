# Architecture Design: MDD Frontend Modular Refactor

## 1. Executive Summary

The current `app.js` (~3100 lines) is a monolithic file mixing state management, DOM rendering, SSE streaming, event handling, animation, and business logic. This design document specifies a clean modular architecture using **vanilla ES modules** (`<script type="module">`) with no build step, no bundler, and no framework.

### Key Design Decisions

| Decision | Rationale |
|---|---|
| ES modules via `import`/`export` | No build tools needed; native browser support; clean dependency graph |
| Observable state store (pub/sub) | Single source of truth; UI auto-updates; eliminates scattered mutations |
| Single `RequirementsTable` class | One component renders into any container; eliminates 3× duplicated table code |
| Event bus for cross-module comms | Decouples modules; enables future extensibility |
| Stage controller for panel routing | Fixes the meet/analyze panel confusion; centralizes navigation logic |

---

## 2. Module Dependency Graph

```
index.html
  └── <script type="module" src="js/main.js">

main.js
  ├── store.js              (state store — no dependencies)
  ├── event-bus.js           (event bus — no dependencies)
  ├── api/
  │   ├── sse-client.js      (generic SSE/streaming helpers)
  │   ├── analyze-api.js     (meet + gap analysis endpoints)
  │   ├── dispatch-api.js    (issue creation + agent assignment)
  │   ├── deploy-api.js      (deploy + validate endpoints)
  │   └── index.js           (re-exports)
  ├── components/
  │   ├── requirements-table.js  (unified table component)
  │   ├── activity-log.js        (agent log + activity feed)
  │   ├── progress-strip.js      (loading step indicators)
  │   ├── meeting-card.js        (M365 meeting card)
  │   ├── dispatch-progress.js   (dispatch progress bar)
  │   ├── qa-workflow.js         (deploy + validate workflow UI)
  │   ├── toast.js               (notification toasts)
  │   └── completion-panel.js    (final stats view)
  ├── controllers/
  │   ├── stage-controller.js    (panel routing + stage transitions)
  │   ├── slide-over.js          (slide-over panel management)
  │   └── header-controller.js   (header nav + status badge)
  ├── loop/
  │   ├── loop-renderer.js       (stage node cards + SVG loop)
  │   └── particle-system.js     (LoopParticleSystem class — moved as-is)
  └── utils/
      ├── dom.js                 (escapeHtml, element helpers)
      └── format.js              (time formatting, status text)
```

### Dependency Flow (Directed Acyclic Graph)

```
                    ┌──────────┐
                    │  main.js │
                    └────┬─────┘
           ┌─────────┬──┴──┬──────────┬────────────┐
           ▼         ▼     ▼          ▼            ▼
      store.js  event-bus  api/*  controllers/*  components/*
           │         │      │         │            │
           │         │      ├── sse-client.js      │
           │         │      │                      │
           ▼         ▼      ▼                      ▼
        (no deps)  (no deps) store.js           store.js
                              event-bus.js       event-bus.js
                                                 utils/*
```

**Rules:**
- `store.js` and `event-bus.js` depend on **nothing** (leaf modules)
- `utils/*` depend on **nothing**
- `api/*` modules depend on `store.js`, `event-bus.js`, and `sse-client.js`
- `components/*` depend on `store.js`, `event-bus.js`, and `utils/*`
- `controllers/*` depend on `store.js`, `event-bus.js`, `components/*`
- `main.js` wires everything together — it's the only module that imports from all layers

---

## 3. State Store Design

### 3.1 API

```js
// js/store.js

class Store {
  constructor(initialState) { ... }

  /** Get a deep-frozen snapshot of current state */
  getState(): State

  /** Merge a partial patch into state (shallow merge at top level, deep merge for nested objects).
   *  Notifies all subscribers whose watched paths are affected. */
  setState(patch: Partial<State>): void

  /** Subscribe to changes on a specific state path (dot-notation).
   *  Returns an unsubscribe function.
   *  Examples: subscribe('requirements', cb), subscribe('loop.stages.meet', cb) */
  subscribe(path: string, callback: (newValue, oldValue, fullState) => void): () => void

  /** Subscribe to ANY state change. Use sparingly. */
  subscribeAll(callback: (state, patch) => void): () => void

  /** Batch multiple setState calls — listeners fire once at the end. */
  batch(fn: () => void): void

  /** Reset state to initial values */
  reset(): void
}

export const store = new Store(INITIAL_STATE);
```

### 3.2 State Schema

```js
const INITIAL_STATE = {

  // ─── Meeting / Extraction ──────────────────────────
  meeting: {
    name: '',                    // user input meeting name
    info: null,                  // { title, date, participants[], summary } from M365
  },

  // ─── Requirements (SINGLE SOURCE OF TRUTH) ────────
  requirements: [],              // string[] — raw requirement texts

  // ─── Gap Analysis ──────────────────────────────────
  gaps: [],                      // GapResult[] — { id, requirement, gap, currentState,
                                 //   details, estimatedEffort, complexity, hasGap, selected }
  gapAnalysis: {
    phase: 'idle',               // 'idle' | 'selecting' | 'analyzing' | 'reviewed'
    analyzingIds: new Set(),     // IDs currently being analyzed
    selectedIndices: [],         // indices selected for analysis
  },

  // ─── Epic ──────────────────────────────────────────
  epic: {
    number: 0,
    url: '',
  },

  // ─── Dispatch / Build ──────────────────────────────
  dispatch: {
    inProgress: false,
    dispatchedGapIds: new Set(), // gap IDs that have been dispatched
    agentAssignments: {},        // { [gapId]: 'cloud' | 'local' | 'developer' }
    results: [],                 // DispatchResult[] per gap
    totalItems: 0,
    completedItems: 0,
  },

  issues: [],                    // CreatedIssue[] — { number, url, title, gapId }

  // ─── Deploy & Validate ─────────────────────────────
  deploy: {
    url: '',                     // deployed URL
    status: 'idle',              // 'idle' | 'deploying' | 'deployed' | 'failed'
  },

  validation: {
    status: 'idle',              // 'idle' | 'validating' | 'complete' | 'failed'
    results: [],                 // ValidationResult[] — { requirement, passed, details }
    validatingIndex: -1,         // currently validating requirement index
  },

  // ─── Loop / Pipeline ──────────────────────────────
  loop: {
    iteration: 1,
    activeStage: null,           // 'meet' | 'analyze' | 'build' | 'verify' | null
    detailPanelOpen: null,       // which stage's slide-over is open
    stages: {
      meet:    { status: 'idle', metrics: {}, startTime: null, endTime: null },
      analyze: { status: 'idle', metrics: {}, startTime: null, endTime: null },
      build:   { status: 'idle', metrics: {}, startTime: null, endTime: null },
      verify:  { status: 'idle', metrics: {}, startTime: null, endTime: null },
    },
  },

  // ─── UI Navigation ────────────────────────────────
  ui: {
    activePanel: 'panel-analyze',    // current visible panel ID
    activePhase: 'meeting',          // header nav highlight
    completedPhases: new Set(),      // phases marked completed
    statusText: 'Ready',
    statusType: '',                  // '' | 'processing' | 'error'
  },
};
```

### 3.3 Path-Based Subscriptions

The store uses **dot-notation paths** so components only re-render when their data changes:

```js
// RequirementsTable only re-renders when requirements or gaps change
store.subscribe('requirements', (reqs) => table.onRequirementsChanged(reqs));
store.subscribe('gaps', (gaps) => table.onGapsChanged(gaps));

// Loop renderer only re-renders when loop state changes
store.subscribe('loop.stages', (stages) => loopRenderer.update(stages));

// Header only updates when ui.statusText changes
store.subscribe('ui.statusText', (text) => headerController.setStatus(text));
```

---

## 4. Event Bus Design

### 4.1 API

```js
// js/event-bus.js

class EventBus {
  /** Emit an event with optional payload */
  emit(event: string, payload?: any): void

  /** Subscribe to an event. Returns unsubscribe function. */
  on(event: string, callback: (payload) => void): () => void

  /** Subscribe once — auto-unsubscribes after first call */
  once(event: string, callback: (payload) => void): () => void

  /** Remove all listeners for an event (or all events if no arg) */
  off(event?: string): void
}

export const bus = new EventBus();
```

### 4.2 Event Catalog

| Event Name | Payload | Emitted By | Consumed By |
|---|---|---|---|
| `analysis:start` | `{ meetingName }` | `analyze-api` | `stage-controller`, `loop-renderer`, `meeting-card` |
| `analysis:meeting-found` | `{ title, date, participants }` | `analyze-api` | `meeting-card`, `loop-renderer` |
| `analysis:requirements-loaded` | `{ requirements[] }` | `analyze-api` | `requirements-table`, `loop-renderer` |
| `analysis:epic-created` | `{ number, url }` | `analyze-api` | `requirements-table` header |
| `analysis:complete` | `{}` | `analyze-api` | `stage-controller` |
| `gaps:analysis-start` | `{ selectedIndices[] }` | `analyze-api` | `requirements-table`, `progress-strip` |
| `gaps:item-started` | `{ id }` | `analyze-api` | `requirements-table` |
| `gaps:item-complete` | `{ gap }` | `analyze-api` | `requirements-table`, `loop-renderer` |
| `gaps:all-complete` | `{}` | `analyze-api` | `stage-controller`, `requirements-table` |
| `dispatch:start` | `{ gapIds[], agentMap }` | `dispatch-api` | `stage-controller`, `requirements-table` |
| `dispatch:issue-created` | `{ gapId, issue }` | `dispatch-api` | `requirements-table` |
| `dispatch:item-complete` | `{ gapId, status, result }` | `dispatch-api` | `requirements-table`, `dispatch-progress` |
| `dispatch:all-complete` | `{ results[] }` | `dispatch-api` | `stage-controller` |
| `deploy:start` | `{}` | `deploy-api` | `qa-workflow`, `loop-renderer` |
| `deploy:complete` | `{ url }` | `deploy-api` | `qa-workflow`, `loop-renderer` |
| `deploy:failed` | `{ error }` | `deploy-api` | `qa-workflow` |
| `validate:start` | `{ url }` | `deploy-api` | `qa-workflow`, `requirements-table` |
| `validate:item-start` | `{ requirementIndex }` | `deploy-api` | `requirements-table` |
| `validate:item-complete` | `{ result }` | `deploy-api` | `requirements-table` |
| `validate:all-complete` | `{}` | `deploy-api` | `qa-workflow`, `stage-controller` |
| `stage:transition` | `{ from, to }` | `stage-controller` | `loop-renderer`, `particle-system` |
| `stage:detail-open` | `{ stage }` | `slide-over` | `loop-renderer` |
| `stage:detail-close` | `{}` | `slide-over` | `loop-renderer` |
| `log:entry` | `{ source, message }` | any api module | `activity-log` |
| `toast:show` | `{ message, type }` | any module | `toast` |
| `nav:phase-change` | `{ phase }` | `header-controller` | `stage-controller` |
| `nav:panel-change` | `{ panelId }` | `stage-controller` | `header-controller` |

---

## 5. Unified Requirements Table Design

### 5.1 Class API

```js
// js/components/requirements-table.js

class RequirementsTable {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.container - DOM element to render into
   * @param {Store} options.store - state store reference
   * @param {EventBus} options.bus - event bus reference
   * @param {'meet'|'analyze'|'build'|'verify'} options.mode - rendering mode
   */
  constructor({ container, store, bus, mode })

  /** Change the rendering mode (re-renders the table) */
  setMode(mode: 'meet' | 'analyze' | 'build' | 'verify'): void

  /** Get current mode */
  getMode(): string

  /** Force a full re-render (normally handled by subscriptions) */
  render(): void

  /** Clean up subscriptions and DOM */
  destroy(): void
}
```

### 5.2 Modes and Columns

| Column | Meet | Analyze | Build | Verify |
|---|---|---|---|---|
| Checkbox | — | ✓ (select for analysis) | ✓ (select for dispatch) | — |
| Requirement | ✓ (read-only, streams in) | ✓ (expandable, click to see detail) | ✓ (expandable) | ✓ (expandable) |
| Status | — | Pending → Analyzing → Gap Found/No Gap/Skipped | Dispatching → Assigned/Implemented/Failed | Pending → Validating → Pass/Fail |
| Complexity | — | ✓ (Low/Med/High/Critical badge) | ✓ (from gap analysis) | — |
| Agent Type | — | — | ✓ (dropdown: Local/Cloud/Developer) | — |
| Issue Link | — | — | ✓ (#number link for cloud/developer) | — |
| Validation | — | — | — | ✓ (Pass/Fail chip) |

### 5.3 Column Configuration Registry

```js
const COLUMN_CONFIGS = {
  meet: [
    { key: 'requirement', header: 'Requirement', width: 'auto', render: renderReqText },
  ],

  analyze: [
    { key: 'checkbox', header: selectAllCheckbox, width: '48px', render: renderCheckbox },
    { key: 'requirement', header: 'Requirement', width: 'auto', render: renderReqExpandable },
    { key: 'status', header: 'Status', width: '110px', render: renderAnalyzeStatus },
    { key: 'complexity', header: 'Complexity', width: '100px', render: renderComplexity },
  ],

  build: [
    { key: 'requirement', header: 'Requirement', width: 'auto', render: renderReqText },
    { key: 'agentType', header: 'Mode', width: '90px', render: renderAgentDropdown },
    { key: 'issue', header: 'Issue', width: '140px', render: renderIssueLink },
    { key: 'status', header: 'Status', width: '140px', render: renderDispatchStatus },
  ],

  verify: [
    { key: 'requirement', header: 'Requirement', width: 'auto', render: renderReqExpandable },
    { key: 'status', header: 'Status', width: '100px', render: renderValidationStatus },
  ],
};
```

### 5.4 Rendering Strategy

1. **Table element is created once** per `RequirementsTable` instance. The `<thead>` is rebuilt when mode changes. The `<tbody>` is rebuilt when data changes.

2. **Data source** — The table reads from `store.getState().requirements` (for row count/text) and `store.getState().gaps` (for analysis results, statuses). It **never** holds its own copy of the data.

3. **Incremental updates** — For streaming scenarios (requirements arriving one at a time, gap results arriving one at a time), the table subscribes to fine-grained store paths:
   - `requirements` → append new rows
   - `gaps` → update existing rows with enrichment data (status chip, complexity badge, detail expansion)
   - `dispatch.results` → update issue links and dispatch statuses
   - `validation.results` → update pass/fail chips

4. **Expandable detail rows** — Each row can expand to show a detail sub-row (gap description, current state, implementation details, validation evidence). This is handled by a `<tr class="row-details-expandable">` inserted after each data row, toggled via click.

5. **Single instance, re-mounted** — When the slide-over opens, the table's container element may be moved/cloned into the slide-over. The `RequirementsTable` supports being in different containers by re-attaching to a new parent without losing state.

### 5.5 Actions Toolbar

Each mode has a configurable toolbar rendered above the table:

```js
const TOOLBAR_CONFIGS = {
  meet: [],  // no actions during streaming

  analyze: [
    { id: 'toggleAll', label: 'Toggle All', icon: checkboxIcon, action: 'toggleAll' },
    { id: 'analyzeGaps', label: 'Analyze Gaps', icon: searchIcon, primary: true, badge: 'selectedCount', action: 'analyzeGaps' },
    { id: 'analyzeSkipped', label: 'Skipped', icon: searchIcon, badge: 'skippedCount', visible: false, action: 'analyzeSkipped' },
    { id: 'dispatch', label: 'Dispatch', icon: sendIcon, primary: true, badge: 'selectedCount', visible: false, action: 'dispatch' },
  ],

  build: [
    { id: 'dispatchMore', label: 'Dispatch Remaining', icon: sendIcon, primary: true, badge: 'remainingCount', action: 'dispatchRemaining' },
    { id: 'done', label: 'Done', icon: checkIcon, action: 'finishDispatch' },
  ],

  verify: [
    { id: 'launchQA', label: 'Ship & Validate', icon: sendIcon, primary: true, action: 'launchQA' },
  ],
};
```

---

## 6. Panel / Stage Controller

### 6.1 Stage-to-Panel Mapping (Fixed)

The current code maps both `meet` and `analyze` stages to `panel-loading`, which causes the "same content" bug. The new mapping:

```js
// js/controllers/stage-controller.js

const STAGE_PANEL_MAP = {
  meet:    'panel-meet',       // NEW: dedicated panel for meet stage
  analyze: 'panel-analyze-detail',  // NEW: renamed from panel-loading
  build:   'panel-build',     // renamed from panel-issues
  verify:  'panel-verify',    // renamed from panel-qa
};
```

However, since `meet` and `analyze` share the same physical `panel-loading` section in the HTML, we solve this differently: **same panel, different content mode**.

**Revised approach** — Keep one panel (`panel-pipeline`) for meet+analyze but use the `RequirementsTable` mode to control what's shown:

```js
const STAGE_CONFIG = {
  meet: {
    panel: 'panel-pipeline',     // shared panel for meet + analyze
    tableMode: 'meet',           // RequirementsTable shows streaming read-only list
    showProgressStrip: true,
    showMeetingCard: true,
    showToolbar: false,
  },
  analyze: {
    panel: 'panel-pipeline',     // same panel
    tableMode: 'analyze',        // RequirementsTable shows checkboxes + gap status
    showProgressStrip: true,
    showMeetingCard: false,
    showToolbar: true,
  },
  build: {
    panel: 'panel-build',
    tableMode: 'build',
    showProgressStrip: false,
    showMeetingCard: false,
    showToolbar: true,
  },
  verify: {
    panel: 'panel-verify',
    tableMode: 'verify',
    showProgressStrip: false,
    showMeetingCard: false,
    showToolbar: true,
  },
};
```

### 6.2 Controller API

```js
class StageController {
  constructor({ store, bus, slideOver })

  /** Transition from current stage to a new stage.
   *  Updates store, emits events, switches panels, updates table mode. */
  transitionTo(stage: 'meet' | 'analyze' | 'build' | 'verify'): void

  /** Mark a stage as complete and advance to the next waiting stage */
  completeStage(stage: string): void

  /** Open the appropriate panel for a stage (used for direct navigation) */
  showStagePanel(stage: string): void

  /** Get current stage */
  getCurrentStage(): string | null

  /** Show a specific panel by ID */
  showPanel(panelId: string): void
}
```

### 6.3 Slide-Over Controller

```js
class SlideOverController {
  constructor({ store, bus })

  /** Open slide-over with content for a stage.
   *  Re-parents the stage's panel into the slide-over. */
  open(stage: string): void

  /** Close slide-over, return re-parented panel to main. */
  close(): void

  /** Is the slide-over currently open? */
  isOpen(): boolean

  /** Which stage is currently shown in the slide-over? */
  currentStage(): string | null
}
```

---

## 7. API Layer Design

### 7.1 SSE Client (Generic Streaming Helper)

```js
// js/api/sse-client.js

/**
 * Generic SSE stream consumer that handles both EventSource and
 * fetch+ReadableStream patterns used by the backend.
 */

/** For EventSource-based endpoints (GET /api/analyze) */
export function consumeSSE(url, handlers: { [eventType: string]: (data: any) => void }): { close: () => void }

/** For fetch-based SSE endpoints (POST /api/analyze-gaps, etc.) */
export async function consumeStreamingResponse(
  url: string,
  options: RequestInit,
  handlers: { [eventType: string]: (data: any) => void }
): Promise<void>
```

### 7.2 Module APIs

```js
// js/api/analyze-api.js
export async function startMeetingAnalysis(meetingName: string): Promise<void>
  // Uses consumeSSE for GET /api/analyze
  // Writes to: store.meeting, store.requirements, store.epic, store.loop.stages.meet
  // Emits: analysis:start, analysis:meeting-found, analysis:requirements-loaded, analysis:epic-created, analysis:complete, log:entry

export async function startGapAnalysis(selectedIndices: number[]): Promise<void>
  // Uses consumeStreamingResponse for POST /api/analyze-gaps
  // Writes to: store.gaps, store.gapAnalysis, store.loop.stages.analyze
  // Emits: gaps:analysis-start, gaps:item-started, gaps:item-complete, gaps:all-complete, log:entry


// js/api/dispatch-api.js
export async function dispatchGaps(cloudGaps, localGaps, developerGaps): Promise<DispatchResult[]>
  // Orchestrates cloud/local/developer dispatch
  // Writes to: store.dispatch, store.issues, store.loop.stages.build
  // Emits: dispatch:start, dispatch:issue-created, dispatch:item-complete, dispatch:all-complete, log:entry

export async function dispatchCloudGaps(gaps): Promise<DispatchResult[]>
export async function dispatchLocalGaps(gaps): Promise<DispatchResult[]>
export async function dispatchDeveloperGaps(gaps): Promise<DispatchResult[]>


// js/api/deploy-api.js
export async function runDeploy(): Promise<string>
  // Writes to: store.deploy
  // Emits: deploy:start, deploy:complete, deploy:failed, log:entry

export async function runValidation(url: string, requirements: string[]): Promise<void>
  // Writes to: store.validation
  // Emits: validate:start, validate:item-start, validate:item-complete, validate:all-complete, log:entry
```

---

## 8. File Structure

```
public/
├── index.html              (updated: <script type="module" src="js/main.js">)
├── styles.css              (unchanged initially)
├── app.js                  (DEPRECATED — kept during migration, then deleted)
│
└── js/
    ├── main.js             Entry point. Imports all modules. Wires store + bus +
    │                       controllers + components. Attaches global event handlers.
    │
    ├── store.js            Observable state store. Path-based subscriptions.
    │                       Exports singleton `store` instance.
    │
    ├── event-bus.js        Lightweight pub/sub event bus.
    │                       Exports singleton `bus` instance.
    │
    ├── api/
    │   ├── index.js        Re-exports all API functions for convenience.
    │   ├── sse-client.js   Generic SSE + streaming response helpers.
    │   ├── analyze-api.js  Meeting analysis + gap analysis.
    │   ├── dispatch-api.js Issue creation + agent assignment.
    │   └── deploy-api.js   Deploy to Azure + Playwright validation.
    │
    ├── components/
    │   ├── requirements-table.js   Unified table: multi-mode, subscribes to store.
    │   ├── activity-log.js         Agent log panel + activity feed widget.
    │   ├── progress-strip.js       Step indicators (M365 → Fetch → Extract → Epic).
    │   ├── meeting-card.js         M365 meeting card + brand banner.
    │   ├── dispatch-progress.js    Progress bar for dispatch panel.
    │   ├── qa-workflow.js          Deploy + Validate step UI (2-step workflow bar).
    │   ├── toast.js                Notification toasts.
    │   └── completion-panel.js     Final stats + "View Repository" actions.
    │
    ├── controllers/
    │   ├── stage-controller.js     Stage transitions, panel routing, table mode switching.
    │   ├── slide-over.js           Slide-over open/close, panel re-parenting.
    │   └── header-controller.js    Phase nav tabs, status badge, loop header info.
    │
    ├── loop/
    │   ├── loop-renderer.js        Stage node cards rendering + state-to-class mapping.
    │   └── particle-system.js      LoopParticleSystem class (SVG particle animation).
    │
    └── utils/
        ├── dom.js                  escapeHtml(), createElement helpers.
        └── format.js               Time formatting, status label maps.
```

### File Size Estimates

| File | Est. Lines | Responsibility |
|---|---|---|
| `store.js` | ~120 | State container + path subscriptions |
| `event-bus.js` | ~60 | Pub/sub |
| `sse-client.js` | ~80 | SSE parsing |
| `analyze-api.js` | ~200 | Meet + gap analysis streaming |
| `dispatch-api.js` | ~250 | Cloud/local/developer dispatch |
| `deploy-api.js` | ~150 | Deploy + validate |
| `requirements-table.js` | ~400 | Unified table (largest component) |
| `activity-log.js` | ~80 | Log rendering |
| `progress-strip.js` | ~60 | Step indicators |
| `meeting-card.js` | ~100 | M365 branding |
| `qa-workflow.js` | ~150 | Deploy/validate workflow UI |
| `toast.js` | ~40 | Notifications |
| `completion-panel.js` | ~60 | Stats view |
| `stage-controller.js` | ~200 | Panel routing + stage logic |
| `slide-over.js` | ~100 | Slide-over management |
| `header-controller.js` | ~100 | Header nav |
| `loop-renderer.js` | ~150 | Stage node cards |
| `particle-system.js` | ~250 | Particle animation (existing code) |
| `dom.js` | ~30 | Utilities |
| `format.js` | ~30 | Utilities |
| `main.js` | ~100 | Wiring |
| **Total** | **~2710** | Down from ~3100 monolith |

---

## 9. `main.js` Wiring

```js
// js/main.js — Entry point

import { store } from './store.js';
import { bus } from './event-bus.js';
import { StageController } from './controllers/stage-controller.js';
import { SlideOverController } from './controllers/slide-over.js';
import { HeaderController } from './controllers/header-controller.js';
import { RequirementsTable } from './components/requirements-table.js';
import { ActivityLog } from './components/activity-log.js';
import { ProgressStrip } from './components/progress-strip.js';
import { MeetingCard } from './components/meeting-card.js';
import { QAWorkflow } from './components/qa-workflow.js';
import { Toast } from './components/toast.js';
import { CompletionPanel } from './components/completion-panel.js';
import { LoopRenderer } from './loop/loop-renderer.js';
import { LoopParticleSystem } from './loop/particle-system.js';
import * as api from './api/index.js';

// ─── Initialize components ───────────────────────────────
const slideOver = new SlideOverController({ store, bus });
const stageController = new StageController({ store, bus, slideOver });
const headerController = new HeaderController({ store, bus, stageController });

const reqTable = new RequirementsTable({
  container: document.getElementById('unifiedTableContainer'),
  store,
  bus,
  mode: 'meet',
});

const activityLog = new ActivityLog({ store, bus });
const progressStrip = new ProgressStrip({ store, bus });
const meetingCard = new MeetingCard({ store, bus });
const qaWorkflow = new QAWorkflow({ store, bus });
const toast = new Toast({ bus });
const completionPanel = new CompletionPanel({ store, bus });
const loopRenderer = new LoopRenderer({ store, bus });
const particleSystem = new LoopParticleSystem();

// ─── Wire global actions ─────────────────────────────────
// Expose minimal functions to window for onclick handlers in HTML
// (gradually migrate to addEventListener in components)
window.startAnalysis = () => {
  const name = document.getElementById('meetingNameInput')?.value?.trim();
  if (name) api.startMeetingAnalysis(name);
};
window.startGapAnalysis = () => { /* delegate to stageController */ };
window.dispatchSelected = () => { /* delegate to stageController */ };
// ... etc

// ─── Init ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  particleSystem.init();
  stageController.showPanel('panel-analyze');
});
```

---

## 10. Migration Strategy

### Phase 0: Preparation (no behavior change)

1. **Add `<script type="module" src="js/main.js">` to `index.html`** alongside the existing `<script src="app.js">`. Both scripts load. `main.js` starts empty.
2. **Create the file structure** — empty files with just `export {}` so imports don't fail.
3. **Copy `escapeHtml()` and `isNoGap()` to `utils/dom.js` and `utils/format.js`** — export them. Have `app.js` call the util versions (or keep both alive temporarily).

### Phase 1: Extract infrastructure (store + event bus)

1. **Implement `store.js`** with the full state schema. Initialize it with the same values as the current globals.
2. **Implement `event-bus.js`**.
3. **In `app.js`, add bridge code**: when a global variable changes, also call `store.setState(...)`. This keeps both systems in sync during migration.
4. **Verify**: app still works identically.

### Phase 2: Extract API layer

1. **Move `sse-client.js`** — extract the SSE parsing logic from `startAnalysis()` and `startGapAnalysis()`.
2. **Move `analyze-api.js`** — extract `startAnalysis()` and `startGapAnalysis()`. Instead of touching DOM directly, they now call `store.setState()` and `bus.emit()`.
3. **Move `dispatch-api.js`** — extract `dispatchCloudFromGaps()`, `dispatchLocalFromGaps()`, `dispatchDeveloperFromGaps()`.
4. **Move `deploy-api.js`** — extract `runDeploy()` and `runValidation()`.
5. **Update `app.js`** to call the new API functions instead of its own copies. Remove the old function bodies, replace with thin wrappers.
6. **Verify**: app still works. API calls go through new modules.

### Phase 3: Extract components

1. **`RequirementsTable`** — the biggest extraction. Create the class with mode support. Wire it to the store.
   - Start with `analyze` mode (the most complex — checkboxes, gap enrichment, detail expansion).
   - Remove `renderRequirementsForSelection()`, `enrichRowWithGap()`, `buildQAGapTable()`, `renderDispatchTable()` from `app.js`.
   - The table instance subscribes to store changes and re-renders automatically.
2. **`ActivityLog`** — extract `appendLog()` and `appendToActivityFeed()`. Subscribe to `log:entry` events.
3. **`ProgressStrip`** — extract `markStep()` and `markAllStepsDone()`.
4. **`MeetingCard`** — extract meeting card DOM manipulation.
5. **`QAWorkflow`** — extract `launchQAWorkflow()`, `runDeployOnly()`, `runValidateOnly()` orchestration UI.
6. **`Toast`** — extract `showToast()`.
7. **`CompletionPanel`** — extract `renderCompletion()`.
8. **Verify after each component**: app still works.

### Phase 4: Extract controllers

1. **`StageController`** — extract `showPanel()`, `setStep()`, `setActivePhase()`, `advanceStage()`, `navigateToPhase()`, and the `STAGE_PANEL_MAP` logic. Fix the meet/analyze panel confusion.
2. **`SlideOverController`** — extract `openStageDetail()`, `closeStageDetail()`, `_returnPanelToMain()`.
3. **`HeaderController`** — extract `setStatus()`, `showLoopHeader()`, phase tab management.
4. **Verify**: navigation, slide-over, and stage transitions all work.

### Phase 5: Extract loop rendering

1. **`LoopRenderer`** — extract `renderLoopNodes()`, `renderStageAction()`, `updateLoopState()`.
2. **`LoopParticleSystem`** — move the existing class as-is to its own file. It's already self-contained.
3. **Verify**: infinite loop visualization and particles work.

### Phase 6: Cleanup

1. **Remove all code from `app.js`** — it should now be empty or contain only the `window.*` shims.
2. **Move `window.*` shims to `main.js`** — these are needed until `onclick="..."` attributes in HTML are converted to `addEventListener()`.
3. **Delete `app.js`**.
4. **Update `index.html`** — remove `<script src="app.js">`, keep only `<script type="module" src="js/main.js">`.
5. **Final verification**: full app works end-to-end with no `app.js`.

### Phase 7: HTML onclick cleanup (optional, polish)

1. Replace all `onclick="functionName()"` attributes in HTML with `addEventListener()` calls in the appropriate component constructors.
2. This removes the need for `window.*` global function exports.

### Migration Safety Rules

- **One module extraction at a time.** Don't extract two components in parallel.
- **After each extraction, the app must work identically.** Run through the full flow: landing → enter meeting name → stream requirements → select → analyze gaps → dispatch → deploy → validate.
- **Keep `app.js` as a shrinking wrapper** during phases 1–5. Functions in `app.js` progressively become thin delegates to the new modules.
- **No CSS changes during migration.** The new modules use the same class names and DOM structure. CSS refactoring is a separate effort.
- **Test the slide-over re-parenting** after each panel component is extracted — it's the most fragile part of the architecture.

---

## 11. Key Design Patterns

### 11.1 Component Lifecycle

Every component follows the same pattern:

```js
class MyComponent {
  constructor({ store, bus, container }) {
    this._container = container;
    this._store = store;
    this._bus = bus;
    this._unsubscribers = [];

    // Subscribe to relevant state paths
    this._unsubscribers.push(
      store.subscribe('some.path', (val) => this._onDataChanged(val))
    );

    // Subscribe to relevant events
    this._unsubscribers.push(
      bus.on('some:event', (payload) => this._onEvent(payload))
    );

    // Initial render
    this.render();
  }

  render() { /* build/update DOM */ }

  destroy() {
    this._unsubscribers.forEach(unsub => unsub());
    this._container.innerHTML = '';
  }
}
```

### 11.2 Store Update Flow

```
User Action (click, input)
  → Component method
    → api.doSomething() or store.setState(...)
      → Store notifies subscribers
        → Components re-render affected parts
          → DOM updates
```

No component directly manipulates another component's DOM. All cross-component communication goes through the store or the event bus.

### 11.3 SSE → Store → UI Pipeline

```
Server SSE Event
  → sse-client parses event
    → api module handler called
      → store.setState({ gaps: [...existing, newGap] })
        → RequirementsTable subscription fires
          → Table renders new/updated row
      → bus.emit('log:entry', { message })
        → ActivityLog renders new log line
```

---

## 12. Open Questions / Future Considerations

1. **Shadow DOM** — Should components use Shadow DOM for style encapsulation? **Recommendation: No.** The existing CSS is tightly coupled to class names. Shadow DOM would require duplicating styles or adopting CSS parts. Keep flat DOM for now.

2. **Web Components** — Should `RequirementsTable` be a Custom Element? **Recommendation: Not yet.** Plain classes with manual lifecycle are simpler. Can upgrade to Custom Elements later if needed.

3. **CSS Modules / Scoping** — The CSS file is ~4200 lines. A future effort should split it into per-component CSS files using `@import` or CSS layers. Out of scope for this refactor.

4. **TypeScript** — The architecture is designed to be TypeScript-ready. JSDoc type annotations in the modules would provide IDE support without requiring a build step. Consider `// @ts-check` at the top of each file.

5. **Testing** — The new module structure makes unit testing possible. `store.js` and `event-bus.js` can be tested in isolation. API modules can be tested with mocked `fetch`. Components can be tested with JSDOM.
