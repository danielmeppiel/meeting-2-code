import type { CopilotClient, MCPLocalServerConfig, MCPRemoteServerConfig } from "@github/copilot-sdk";
import { createAgentSession } from "./session-helpers.js";

interface GapItem {
    id: number;
    requirement: string;
    currentState: string;
    gap: string;
    complexity: "Low" | "Medium" | "High" | "Critical";
    estimatedEffort: string;
    details: string;
}

interface MeetingInfo {
    title: string;
    date?: string;
    participants?: string[];
    requirementCount?: number;
}

interface AnalyzeMeetingOptions {
    workiqMcp: Record<string, MCPLocalServerConfig | MCPRemoteServerConfig>;
    githubMcp: Record<string, MCPLocalServerConfig | MCPRemoteServerConfig>;
    onProgress?: (step: number, message: string) => void;
    onMeetingInfo?: (info: MeetingInfo) => void;
    onRequirements?: (requirements: string[]) => void;
    onGapStarted?: (id: number) => void;
    onGap?: (gap: GapItem) => void;
    onLog?: (message: string) => void;
}

const MAX_CONCURRENT = 4;

export async function analyzeMeetingGaps(
    client: CopilotClient,
    options: AnalyzeMeetingOptions,
): Promise<GapItem[]> {
    const progress = options.onProgress ?? (() => {});
    const onMeetingInfo = options.onMeetingInfo ?? (() => {});
    const onRequirements = options.onRequirements ?? (() => {});
    const onGapStarted = options.onGapStarted ?? (() => {});
    const onGap = options.onGap ?? (() => {});
    const log = options.onLog ?? (() => {});

    // ── Phase 1: Fetch the latest meeting using WorkIQ MCP ─────────────────
    progress(0, "Connecting to WorkIQ MCP Server...");
    log("Initializing WorkIQ MCP session (npx @microsoft/workiq mcp)...");
    console.log("[gap-analyzer] Creating WorkIQ MCP session...");

    let meetingContent = "";
    let requirements: string[] = [];
    try {
        const meetingSession = await createAgentSession(client, {
            model: "gpt-5.2-codex",
            mcpServers: options.workiqMcp,
            systemMessage: {
                content: `You are a meeting analyst that retrieves meeting data from Microsoft 365 via WorkIQ.

CRITICAL RULES:
- You MUST use the WorkIQ meeting/calendar tools to search for and retrieve meetings from Microsoft 365.
- Do NOT use filesystem tools like glob, view, grep, or any file browsing tools.
- Do NOT read or search local files or directories.
- Your ONLY job is to call WorkIQ tools to find the meeting titled "Contoso Industries Redesign" and extract its content.

After retrieving the meeting notes/transcript, return a JSON object with this exact structure:
{
  "title": "the meeting title",
  "date": "meeting date/time if available",
  "participants": ["list", "of", "attendees"],
  "requirements": ["requirement 1", "requirement 2", ...]
}
Only output the JSON object, nothing else.`,
            },
            label: "workiq-meeting",
            onLog: log,
        });

        progress(1, "Fetching meeting from WorkIQ...");
        log("Session created. Searching for meeting \"Contoso Industries Redesign\"...");
        console.log("[gap-analyzer] Sending WorkIQ query...");

        const meetingResult = await meetingSession.sendAndWait({
            prompt: `Use the WorkIQ meeting/calendar tools (NOT filesystem tools) to search for the latest meeting with the subject or title containing "Contoso Industries Redesign".
Retrieve the full meeting notes and/or transcript.
Then extract all actionable requirements, decisions, and action items.

Return a JSON object with:
- title: the meeting subject/title
- date: when the meeting occurred
- participants: array of attendee names
- requirements: array of requirement strings

IMPORTANT: Do NOT use glob, view, grep, or any file-browsing tools. Only use WorkIQ/meeting tools.`,
        }, 300_000);
        meetingContent = meetingResult?.data?.content || "{}";
        console.log("[gap-analyzer] WorkIQ response:", meetingContent.substring(0, 500));
        log(`Agent response received (${meetingContent.length} chars)`);
        await meetingSession.destroy();

        // Parse meeting info + requirements
        try {
            // Try to parse the structured JSON object
            const jsonObjMatch = meetingContent.match(/\{[\s\S]*\}/);
            if (jsonObjMatch) {
                const parsed = JSON.parse(jsonObjMatch[0]);
                if (parsed.requirements && Array.isArray(parsed.requirements)) {
                    requirements = parsed.requirements;
                    // Emit meeting info immediately
                    onMeetingInfo({
                        title: parsed.title || "Contoso Industries Redesign",
                        date: parsed.date,
                        participants: parsed.participants,
                        requirementCount: requirements.length,
                    });
                    log(`Meeting: "${parsed.title || "Contoso Industries Redesign"}"`);
                    if (parsed.participants?.length) {
                        log(`Participants: ${parsed.participants.join(", ")}`);
                    }
                }
            }
            // Fallback: try to extract a JSON array
            if (requirements.length === 0) {
                const jsonArrMatch = meetingContent.match(/\[[\s\S]*\]/);
                requirements = JSON.parse(jsonArrMatch?.[0] || "[]");
                if (!Array.isArray(requirements)) requirements = [];
                onMeetingInfo({
                    title: "Contoso Industries Redesign",
                    requirementCount: requirements.length,
                });
            }
            log(`Parsed ${requirements.length} requirements`);
        } catch {
            // If not valid JSON, split by newlines as fallback
            log("Response wasn't valid JSON, parsing as text lines...");
            requirements = meetingContent
                .split("\n")
                .map((l: string) => l.replace(/^[\d\-.*]+\s*/, "").trim())
                .filter((l: string) => l.length > 10);
            onMeetingInfo({
                title: "Contoso Industries Redesign",
                requirementCount: requirements.length,
            });
            log(`Extracted ${requirements.length} lines from text`);
        }
    } catch (err) {
        console.error("[gap-analyzer] WorkIQ MCP error:", err);
        log(`❌ WorkIQ MCP error: ${err instanceof Error ? err.message : String(err)}`);
        throw new Error(
            `Failed to connect to WorkIQ MCP Server: ${err instanceof Error ? err.message : String(err)}. ` +
            `Make sure 'npx -y @microsoft/workiq mcp' works and you have authenticated.`
        );
    }

    if (requirements.length === 0) {
        log(`❌ No requirements extracted. Raw response was: ${meetingContent.substring(0, 200)}`);
        throw new Error(
            `No requirements found in the meeting. The agent returned: "${meetingContent.substring(0, 100)}"\n` +
            `Make sure a meeting titled 'Contoso Industries Redesign' exists in your M365 calendar with notes or transcript.`
        );
    }

    // ── Stream requirements to frontend ────────────────────────────────────
    progress(2, `Extracted ${requirements.length} requirements from meeting`);
    log(`✔ ${requirements.length} requirements extracted successfully`);
    onRequirements(requirements);
    console.log(`[gap-analyzer] ${requirements.length} requirements extracted.`);

    // ── Phase 2: Parallel gap analysis — one session per requirement ───────
    progress(3, "Analyzing danielmeppiel/corporate-website...");
    log(`Starting parallel gap analysis (${MAX_CONCURRENT} concurrent sessions)...`);
    console.log(`[gap-analyzer] Starting parallel analysis of ${requirements.length} requirements (concurrency: ${MAX_CONCURRENT})...`);

    const gapItems: GapItem[] = new Array(requirements.length);
    let completedCount = 0;

    async function analyzeOneRequirement(index: number): Promise<void> {
        const req = requirements[index]!;
        const id = index + 1;
        const label = req.length > 50 ? req.substring(0, 50) + "..." : req;

        onGapStarted(id);
        log(`🔍 [${id}/${requirements.length}] Analyzing: ${label}`);
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

"${req}"

Use GitHub MCP tools to browse and read the actual source files. Be specific about what files exist and what's missing.
Return ONLY a valid JSON object.`,
            }, 120_000);

            const content = result?.data?.content || "{}";
            await session.destroy();

            // Parse the single gap result
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            const parsed = JSON.parse(jsonMatch?.[0] || "{}");

            gapItems[index] = {
                id,
                requirement: parsed.requirement || req,
                currentState: parsed.currentState || "Not assessed",
                gap: parsed.gap || "Unknown",
                complexity: parsed.complexity || "Medium",
                estimatedEffort: parsed.estimatedEffort || "TBD",
                details: parsed.details || "No details available",
            };
        } catch (err) {
            console.error(`[gap-analyzer] Error analyzing requirement #${id}:`, err);
            gapItems[index] = {
                id,
                requirement: req,
                currentState: "Analysis failed",
                gap: `Error: ${err instanceof Error ? err.message : String(err)}`.substring(0, 200),
                complexity: "Medium",
                estimatedEffort: "TBD",
                details: "Retry recommended",
            };
        }

        completedCount++;
        onGap(gapItems[index]!);
        log(`✔ [${completedCount}/${requirements.length}] Done: ${label}`);
        console.log(`[gap-analyzer] Completed #${id} (${completedCount}/${requirements.length})`);
    }

    // Run with bounded concurrency
    const queue = requirements.map((_, i) => i);
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT, requirements.length) }, async () => {
        while (queue.length > 0) {
            const index = queue.shift()!;
            await analyzeOneRequirement(index);
        }
    });
    await Promise.all(workers);

    progress(4, "Analysis complete");
    log(`✔ Analysis complete: ${gapItems.length} gaps identified`);
    console.log(`[gap-analyzer] ${gapItems.length} gaps identified.`);
    return gapItems;
}
