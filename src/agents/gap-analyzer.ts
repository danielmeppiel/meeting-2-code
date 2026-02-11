import type { CopilotClient, MCPLocalServerConfig, MCPRemoteServerConfig } from "@github/copilot-sdk";
import { createAgentSession } from "./session-helpers.js";

export interface GapItem {
    id: number;
    requirement: string;
    currentState: string;
    gap: string;
    complexity: "Low" | "Medium" | "High" | "Critical";
    estimatedEffort: string;
    details: string;
}

export interface MeetingInfo {
    title: string;
    date?: string;
    participants?: string[];
    summary?: string;
    requirementCount?: number;
}

export interface MeetingResult {
    info: MeetingInfo;
    requirements: string[];
}

// ── Parsing helper ─────────────────────────────────────────────────────────

function parseMeetingResponse(
    content: string,
    fallbackInfo: MeetingInfo,
    onMeetingInfo: (info: MeetingInfo) => void,
    log: (msg: string) => void,
): { requirements: string[]; info: MeetingInfo } {
    let requirements: string[] = [];
    let info = { ...fallbackInfo };

    try {
        const jsonObjMatch = content.match(/\{[\s\S]*\}/);
        if (jsonObjMatch) {
            const parsed = JSON.parse(jsonObjMatch[0]);
            if (parsed.requirements && Array.isArray(parsed.requirements)) {
                requirements = parsed.requirements.filter((r: unknown) => typeof r === "string" && r.trim().length > 0);
                info = {
                    title: parsed.title || fallbackInfo.title,
                    date: parsed.date,
                    participants: parsed.participants,
                    summary: parsed.summary,
                    requirementCount: requirements.length,
                };
                onMeetingInfo(info);
                log(`Meeting: "${info.title}"`);
                if (parsed.participants?.length) {
                    log(`Participants: ${parsed.participants.join(", ")}`);
                }
            }
        }
        if (requirements.length === 0) {
            const jsonArrMatch = content.match(/\[[\s\S]*\]/);
            const arr = JSON.parse(jsonArrMatch?.[0] || "[]");
            requirements = Array.isArray(arr) ? arr.filter((r: unknown) => typeof r === "string" && r.trim().length > 0) : [];
            info.requirementCount = requirements.length;
            onMeetingInfo(info);
        }
        log(`Parsed ${requirements.length} requirements`);
    } catch {
        log("Response wasn't valid JSON, parsing as text lines...");
        requirements = content
            .split("\n")
            .map((l: string) => l.replace(/^[\d\-.*]+\s*/, "").trim())
            .filter((l: string) => l.length > 10);
        info.requirementCount = requirements.length;
        onMeetingInfo(info);
        log(`Extracted ${requirements.length} lines from text`);
    }

    return { requirements, info };
}

// ── Phase 1: Extract meeting requirements via WorkIQ ───────────────────────

interface ExtractOptions {
    workiqMcp: Record<string, MCPLocalServerConfig | MCPRemoteServerConfig>;
    onProgress?: (step: number, message: string) => void;
    onMeetingInfo?: (info: MeetingInfo) => void;
    onLog?: (message: string) => void;
}

export async function extractMeetingRequirements(
    client: CopilotClient,
    options: ExtractOptions,
): Promise<MeetingResult> {
    const progress = options.onProgress ?? (() => {});
    const onMeetingInfo = options.onMeetingInfo ?? (() => {});
    const log = options.onLog ?? (() => {});

    progress(0, "Connecting to M365 MCP Server...");
    log("Initializing WorkIQ MCP session (npx @microsoft/workiq mcp)...");
    console.log("[gap-analyzer] Creating WorkIQ MCP session...");

    let requirements: string[] = [];
    let info: MeetingInfo = { title: "Contoso Industries Redesign" };

    try {
        const meetingSession = await createAgentSession(client, {
            model: "gpt-5.2-codex",
            mcpServers: options.workiqMcp,
            systemMessage: {
                content: `You are a meeting analyst. Your ONLY purpose: retrieve meeting data from Microsoft 365 using WorkIQ tools.

## Tool Usage — MANDATORY
1. You MUST call WorkIQ tools to search for meetings. These are the ONLY tools you should use.
2. NEVER call filesystem tools (glob, view, grep, read_file, list_directory, etc.). They are IRRELEVANT to your task.
3. If a tool call fails or returns no results, try different search queries (see Search Strategy below).

## Search Strategy
Search for the meeting using MULTIPLE approaches if needed:
- First try: search for "Contoso Industries Redesign"
- If no results: search for "Contoso" alone
- If no results: search for "Redesign"
- If no results: list recent meetings/calendar events and find the most relevant one about Contoso or a website redesign

## Output Format
After retrieving the meeting data, return ONLY a JSON object:
{
  "title": "the meeting title",
  "date": "meeting date/time if available",
  "participants": ["list", "of", "attendees"],
  "summary": "A brief 2-3 sentence summary of the key decisions and topics discussed",
  "requirements": ["requirement 1", "requirement 2", ...]
}

Requirements should be specific, actionable items — things that need to change in code/design.
Do NOT output anything before or after the JSON object.`,
            },
            label: "workiq-meeting",
            onLog: log,
        });

        progress(1, "Fetching meeting from WorkIQ...");
        log("Session created. Searching for meeting \"Contoso Industries Redesign\"...");
        console.log("[gap-analyzer] Sending WorkIQ query...");

        const meetingResult = await meetingSession.sendAndWait({
            prompt: `Find the meeting about "Contoso Industries Redesign" in my Microsoft 365 calendar.

Step-by-step:
1. Use the WorkIQ search/calendar tools to search for this meeting. Try the full title first: "Contoso Industries Redesign".
2. If that returns nothing, search for just "Contoso".
3. If still nothing, list my recent meetings and pick the one about Contoso or a website redesign.
4. Once you find the meeting, retrieve its full notes, transcript, or body content.
5. Extract all actionable requirements, decisions, and action items from the content.

Return the JSON object with title, date, participants, summary, and requirements array.

IMPORTANT: Do NOT use glob, view, grep, read_file, or any filesystem tools. Only use WorkIQ/meeting/calendar tools.`,
        }, 300_000);
        const meetingContent = meetingResult?.data?.content || "{}";
        console.log("[gap-analyzer] WorkIQ response:", meetingContent.substring(0, 500));
        log(`Agent response received (${meetingContent.length} chars)`);

        // Parse meeting info + requirements
        ({ requirements, info } = parseMeetingResponse(meetingContent, info, onMeetingInfo, log));

        // ── Retry with broader search if first attempt found nothing ──────
        if (requirements.length === 0) {
            log("No requirements found on first attempt — retrying with broader search...");
            console.log("[gap-analyzer] Retry: broader WorkIQ search...");

            const retryResult = await meetingSession.sendAndWait({
                prompt: `The previous search didn't return meeting content. Try again with these strategies IN ORDER:

1. List ALL my recent meetings or calendar events from the last 30 days.
2. Look for any meeting with "Contoso" in the title, body, or attendees.
3. If you find it, retrieve the full notes/transcript/body.
4. Extract actionable requirements from the content.

Return the same JSON format: { title, date, participants, summary, requirements: [...] }

CRITICAL: Only use WorkIQ/calendar tools. Do NOT use filesystem tools.`,
            }, 180_000);

            const retryContent = retryResult?.data?.content || "{}";
            console.log("[gap-analyzer] Retry response:", retryContent.substring(0, 500));
            log(`Retry response received (${retryContent.length} chars)`);

            ({ requirements, info } = parseMeetingResponse(retryContent, info, onMeetingInfo, log));
        }

        await meetingSession.destroy();
    } catch (err) {
        console.error("[gap-analyzer] WorkIQ MCP error:", err);
        log(`❌ WorkIQ MCP error: ${err instanceof Error ? err.message : String(err)}`);
        throw new Error(
            `Failed to connect to WorkIQ MCP Server: ${err instanceof Error ? err.message : String(err)}. ` +
            `Make sure 'npx -y @microsoft/workiq mcp' works and you have authenticated.`
        );
    }

    if (requirements.length === 0) {
        throw new Error(
            `No requirements found in the meeting. Make sure a meeting titled 'Contoso Industries Redesign' exists in your M365 calendar.`
        );
    }

    progress(2, `Extracted ${requirements.length} requirements from meeting`);
    log(`✔ ${requirements.length} requirements extracted successfully`);
    console.log(`[gap-analyzer] ${requirements.length} requirements extracted.`);

    return { info, requirements };
}

// ── Phase 2: Parallel gap analysis for selected requirements ───────────────

interface AnalyzeGapsOptions {
    requirements: Array<{ index: number; text: string }>;
    githubMcp: Record<string, MCPLocalServerConfig | MCPRemoteServerConfig>;
    onProgress?: (step: number, message: string) => void;
    onGapStarted?: (id: number) => void;
    onGap?: (gap: GapItem) => void;
    onLog?: (message: string) => void;
}

const MAX_CONCURRENT = 4;

export async function analyzeSelectedGaps(
    client: CopilotClient,
    options: AnalyzeGapsOptions,
): Promise<GapItem[]> {
    const { requirements } = options;
    const progress = options.onProgress ?? (() => {});
    const onGapStarted = options.onGapStarted ?? (() => {});
    const onGap = options.onGap ?? (() => {});
    const log = options.onLog ?? (() => {});

    const concurrent = Math.min(MAX_CONCURRENT, requirements.length);
    progress(4, "Analyzing danielmeppiel/corporate-website...");
    log(`Starting parallel gap analysis (${concurrent} concurrent sessions)...`);
    console.log(`[gap-analyzer] Starting parallel analysis of ${requirements.length} requirements (concurrency: ${concurrent})...`);

    const gapItems: GapItem[] = [];
    let completedCount = 0;

    async function analyzeOne(req: { index: number; text: string }): Promise<void> {
        const id = req.index + 1; // 1-based ID matching original requirement index
        const label = req.text.length > 50 ? req.text.substring(0, 50) + "..." : req.text;

        onGapStarted(id);
        log(`🔍 [${completedCount + 1}/${requirements.length}] Analyzing: ${label}`);
        console.log(`[gap-analyzer] Starting analysis #${id}: ${label}`);

        try {
            const session = await createAgentSession(client, {
                model: "claude-opus-4.5",
                mcpServers: options.githubMcp,
                systemMessage: {
                    content: `You are a senior software architect performing gap analysis on the GitHub repository "danielmeppiel/corporate-website".

You have access to GitHub MCP tools — USE THEM to browse the repository structure, read source files, and understand what currently exists.

For the requirement you are given, you MUST:
1. Browse the repo to find relevant files
2. Read actual code to understand what's implemented
3. Compare what exists against what the requirement asks for

Return ONLY a valid JSON object (no markdown, no commentary):
{
  "requirement": "the requirement text",
  "currentState": "what ACTUALLY exists (cite specific files)",
  "gap": "what's missing or needs to change (or 'No gap' if fully met)",
  "complexity": "Low|Medium|High|Critical",
  "estimatedEffort": "time estimate",
  "details": "specific implementation steps"
}`,
                },
                label: `gap-${id}`,
            });

            const result = await session.sendAndWait({
                prompt: `Analyze this ONE requirement against the repository "danielmeppiel/corporate-website":

"${req.text}"

Use GitHub MCP tools to browse and read the actual source files. Be specific about what files exist and what's missing.
Return ONLY a valid JSON object.`,
            }, 120_000);

            const content = result?.data?.content || "{}";
            await session.destroy();

            const jsonMatch = content.match(/\{[\s\S]*\}/);
            const parsed = JSON.parse(jsonMatch?.[0] || "{}");

            const gap: GapItem = {
                id,
                requirement: parsed.requirement || req.text,
                currentState: parsed.currentState || "Not assessed",
                gap: parsed.gap || "Unknown",
                complexity: parsed.complexity || "Medium",
                estimatedEffort: parsed.estimatedEffort || "TBD",
                details: parsed.details || "No details available",
            };
            gapItems.push(gap);
            onGap(gap);
        } catch (err) {
            console.error(`[gap-analyzer] Error analyzing requirement #${id}:`, err);
            const gap: GapItem = {
                id,
                requirement: req.text,
                currentState: "Analysis failed",
                gap: `Error: ${err instanceof Error ? err.message : String(err)}`.substring(0, 200),
                complexity: "Medium",
                estimatedEffort: "TBD",
                details: "Retry recommended",
            };
            gapItems.push(gap);
            onGap(gap);
        }

        completedCount++;
        log(`✔ [${completedCount}/${requirements.length}] Done: ${label}`);
        console.log(`[gap-analyzer] Completed #${id} (${completedCount}/${requirements.length})`);
    }

    // Bounded concurrency worker pool
    const queue = [...requirements];
    const workers = Array.from({ length: concurrent }, async () => {
        while (queue.length > 0) {
            const req = queue.shift()!;
            await analyzeOne(req);
        }
    });
    await Promise.all(workers);

    log(`✔ Analysis complete: ${gapItems.length} gaps analyzed`);
    console.log(`[gap-analyzer] ${gapItems.length} gaps analyzed.`);
    return gapItems;
}
