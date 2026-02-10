import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const OWNER = "danielmeppiel";
const REPO = "corporate-website";

interface AssignResult {
    issueNumber: number;
    assigned: boolean;
    message: string;
}

interface AssignCodingAgentOptions {
    issueNumbers: number[];
    onProgress?: (current: number, total: number, message: string) => void;
    onResult?: (result: AssignResult) => void;
    onLog?: (message: string) => void;
}

export async function assignCodingAgent(
    options: AssignCodingAgentOptions,
): Promise<AssignResult[]> {
    const progress = options.onProgress ?? (() => {});
    const onResult = options.onResult ?? (() => {});
    const log = options.onLog ?? (() => {});
    const total = options.issueNumbers.length;

    progress(0, total, "Connecting to GitHub...");
    log("Assigning Copilot coding agent to issues via GitHub REST API...");
    console.log(`[coding-agent] Assigning copilot-swe-agent to ${total} issues...`);

    const results: AssignResult[] = [];

    for (let i = 0; i < options.issueNumbers.length; i++) {
        const issueNumber = options.issueNumbers[i]!;
        progress(i + 1, total, `Assigning Copilot to issue #${issueNumber}...`);
        log(`Assigning Copilot to issue #${issueNumber} (${i + 1}/${total})...`);
        console.log(`[coding-agent] Assigning copilot to #${issueNumber} (${i + 1}/${total})...`);

        try {
            const payload = JSON.stringify({
                assignees: ["copilot-swe-agent[bot]"],
                agent_assignment: {
                    target_repo: `${OWNER}/${REPO}`,
                    base_branch: "main",
                    custom_instructions: "",
                    custom_agent: "",
                    model: "",
                },
            });

            const cmd = `gh api --method POST ` +
                `-H "Accept: application/vnd.github+json" ` +
                `-H "X-GitHub-Api-Version: 2022-11-28" ` +
                `/repos/${OWNER}/${REPO}/issues/${issueNumber}/assignees ` +
                `--input - <<< '${payload}'`;

            const { stdout, stderr } = await execAsync(cmd, {
                timeout: 30_000,
                env: { ...process.env, GITHUB_TOKEN: undefined, GH_PAGER: "cat" },
            });

            // Check if copilot-swe-agent appears in assignees
            let assigned = false;
            let message = "Assignment request sent";
            try {
                const response = JSON.parse(stdout);
                const assignees = response.assignees ?? [];
                assigned = assignees.some((a: { login?: string }) =>
                    a.login === "Copilot" || a.login?.includes("copilot") || a.login?.includes("swe-agent"),
                );
                message = assigned
                    ? "Copilot coding agent assigned successfully"
                    : `Assignees: ${assignees.map((a: { login?: string }) => a.login).join(", ") || "none"}`;
            } catch {
                // If response isn't JSON, check stderr
                message = stdout.trim() || stderr.trim() || "Request completed";
                assigned = !stderr.includes("error") && !stderr.includes("Error");
            }

            if (stderr && !assigned) {
                console.warn(`[coding-agent] stderr for #${issueNumber}:`, stderr.trim());
            }
            console.log(`[coding-agent] #${issueNumber} stdout:`, stdout.substring(0, 200));

            const result: AssignResult = { issueNumber, assigned, message };
            results.push(result);
            onResult(result);
            log(assigned ? `✔ #${issueNumber}: ${message}` : `⚠ #${issueNumber}: ${message}`);
            console.log(`[coding-agent] #${issueNumber} → assigned: ${assigned}`);
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`[coding-agent] Error assigning #${issueNumber}:`, errorMsg);
            log(`✘ #${issueNumber}: ${errorMsg.substring(0, 150)}`);
            const result: AssignResult = {
                issueNumber,
                assigned: false,
                message: errorMsg.substring(0, 200),
            };
            results.push(result);
            onResult(result);
        }
    }

    const successCount = results.filter(r => r.assigned).length;
    log(`✔ Done — ${successCount}/${total} issues assigned to Copilot`);
    console.log(`[coding-agent] Done. ${successCount}/${total} assigned.`);
    return results;
}
