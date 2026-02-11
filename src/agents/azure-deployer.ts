import { exec } from "child_process";
import { promisify } from "util";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const execAsync = promisify(exec);

const REPO = "corporate-website";
const REPO_PATH = `/Users/${process.env.USER || "danielmeppiel"}/Repos/${REPO}`;
const ENV_NAME = "corporate-website-dev";
const AZURE_LOCATION = "eastus2";

interface DeployResult {
    success: boolean;
    url?: string;
    message: string;
    errorType?: 'auth' | 'subscription' | 'timeout' | 'infra' | 'unknown';
}

interface DeployOptions {
    onProgress?: (step: number, message: string) => void;
    onLog?: (message: string) => void;
}

/** Run a shell command in the repo directory, streaming output to log */
async function run(
    cmd: string,
    log: (msg: string) => void,
    timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string }> {
    console.log(`[azure-deployer] $ ${cmd}`);
    log(`$ ${cmd}`);
    const result = await execAsync(cmd, {
        cwd: REPO_PATH,
        timeout: timeoutMs,
        env: { ...process.env, GITHUB_TOKEN: undefined, GH_PAGER: "cat" },
        maxBuffer: 10 * 1024 * 1024, // 10 MB for azd output
    });
    if (result.stdout.trim()) {
        const preview = result.stdout.trim().split("\n").slice(-5).join("\n");
        log(preview);
    }
    return result;
}

/**
 * Check if the corporate-website is already deployed on Azure via azd.
 * Returns the endpoint URL if deployed, null otherwise.
 */
async function checkExistingDeployment(log: (msg: string) => void): Promise<string | null> {
    try {
        log("Checking for existing Azure deployment...");
        const { stdout } = await run("azd show --output json 2>/dev/null", log, 30_000);
        const data = JSON.parse(stdout);
        if (data?.services) {
            for (const [, svc] of Object.entries(data.services as Record<string, { endpoint?: string }>)) {
                if (svc?.endpoint) {
                    log(`Found existing deployment: ${svc.endpoint}`);
                    return svc.endpoint;
                }
            }
        }
        return null;
    } catch {
        log("No existing azd environment — will deploy fresh.");
        return null;
    }
}

/**
 * Merge any feature/gap-* branches from origin into local main.
 * This picks up changes made by the local Copilot SDK agent
 * (which creates remote branches via GitHub MCP).
 * Returns the list of branches that were merged.
 */
async function mergeLocalAgentBranches(log: (msg: string) => void): Promise<string[]> {
    const merged: string[] = [];
    try {
        // Ensure we are on main
        await run("git checkout main", log, 10_000);

        // List LOCAL feature/gap-* branches (created by the local agent)
        const { stdout } = await execAsync(
            "git branch --list 'feature/gap-*' | tr -d ' '",
            { cwd: REPO_PATH, timeout: 10_000 },
        );
        const branches = stdout.trim().split("\n").filter(Boolean);

        if (branches.length === 0) {
            log("No local-agent feature branches found to merge.");
            return [];
        }

        log(`Found ${branches.length} local-agent branch(es) to merge: ${branches.join(", ")}`);

        for (const branch of branches) {
            try {
                await run(`git merge ${branch} --no-edit -m "Merge ${branch} into main for deploy"`, log, 15_000);
                log(`Merged: ${branch}`);
                merged.push(branch);
            } catch (mergeErr) {
                const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
                log(`Warning: could not merge ${branch} — ${msg.substring(0, 120)}`);
                // Abort failed merge to keep tree clean
                try { await execAsync("git merge --abort", { cwd: REPO_PATH, timeout: 5_000 }); } catch { /* ignore */ }
            }
        }

        if (merged.length > 0) {
            log(`Successfully merged ${merged.length} branch(es) into main.`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Warning: branch merge step failed — ${msg.substring(0, 200)}`);
    }
    return merged;
}

/**
 * Reset the corporate-website repo to a clean origin/main state.
 * Deletes local feature/gap-* branches and hard-resets main.
 * Called on server startup to ensure a clean demo environment.
 */
export async function resetCorpWebsiteRepo(): Promise<void> {
    const log = (msg: string) => console.log(`[reset-repo] ${msg}`);
    try {
        // Ensure we are on main
        try {
            await execAsync("git checkout main --force", { cwd: REPO_PATH, timeout: 10_000 });
        } catch { /* may already be on main */ }

        // Hard reset to origin/main
        await execAsync("git fetch origin", { cwd: REPO_PATH, timeout: 30_000 });
        await execAsync("git reset --hard origin/main", { cwd: REPO_PATH, timeout: 10_000 });
        await execAsync("git clean -fd", { cwd: REPO_PATH, timeout: 10_000 });
        log("Reset corporate-website to origin/main.");

        // Delete local feature/gap-* branches
        const { stdout } = await execAsync(
            "git branch --list 'feature/gap-*' | tr -d ' '",
            { cwd: REPO_PATH, timeout: 10_000 },
        );
        const localBranches = stdout.trim().split("\n").filter(Boolean);
        for (const branch of localBranches) {
            try {
                await execAsync(`git branch -D ${branch}`, { cwd: REPO_PATH, timeout: 5_000 });
                log(`Deleted local branch: ${branch}`);
            } catch { /* ignore */ }
        }

        log("Corporate-website repo is clean and ready for demo.");
    } catch (err) {
        console.error("[reset-repo] Warning: could not fully reset corporate-website:", err instanceof Error ? err.message : String(err));
    }
}

/** Extract an Azure-like URL from text */
function extractUrl(text: string): string | null {
    const match = text.match(
        /https?:\/\/[a-zA-Z0-9\-._]+\.(?:azurestaticapps\.net|azurewebsites\.net|azure-api\.net|azurefd\.net)[^\s)"']*/,
    );
    return match?.[0] ?? null;
}

/**
 * Scaffold Bicep infrastructure files for a Static Web App deployment.
 * Creates infra/main.bicep, infra/main.parameters.json, and
 * infra/modules/staticwebapp.bicep so that `azd up` can provision resources.
 */
function scaffoldBicepInfra(repoPath: string, log: (msg: string) => void): void {
    const infraDir = join(repoPath, "infra");
    const modulesDir = join(infraDir, "modules");

    // Skip if main.bicep already exists
    if (existsSync(join(infraDir, "main.bicep"))) {
        log("infra/main.bicep already exists — skipping scaffold.");
        return;
    }

    mkdirSync(modulesDir, { recursive: true });

    const mainBicep = `targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment used to generate a unique resource token')
param environmentName string

@minLength(1)
@description('Primary location for all resources')
param location string

var tags = { 'azd-env-name': environmentName }
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: 'rg-\${environmentName}'
  location: location
  tags: tags
}

module web 'modules/staticwebapp.bicep' = {
  name: 'web'
  scope: rg
  params: {
    name: 'swa-\${resourceToken}'
    location: location
    tags: tags
  }
}

output AZURE_LOCATION string = location
output SERVICE_WEB_URI string = 'https://\${web.outputs.defaultHostname}'
`;

    const swaModule = `param name string
param location string
param tags object = {}

resource swa 'Microsoft.Web/staticSites@2022-09-01' = {
  name: name
  location: location
  tags: union(tags, { 'azd-service-name': 'web' })
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {}
}

output defaultHostname string = swa.properties.defaultHostname
output name string = swa.name
output id string = swa.id
`;

    const mainParams = JSON.stringify(
        {
            $schema:
                "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
            contentVersion: "1.0.0.0",
            parameters: {
                environmentName: { value: "${AZURE_ENV_NAME}" },
                location: { value: "${AZURE_LOCATION}" },
            },
        },
        null,
        2,
    );

    writeFileSync(join(infraDir, "main.bicep"), mainBicep);
    writeFileSync(join(modulesDir, "staticwebapp.bicep"), swaModule);
    writeFileSync(join(infraDir, "main.parameters.json"), mainParams);

    log("Scaffolded infra/main.bicep, infra/modules/staticwebapp.bicep, and infra/main.parameters.json.");
}

/**
 * Deploy corporate-website to Azure using azd CLI directly.
 * Steps: check existing → azd init → env setup → azd up → get URL.
 */
export async function deployToAzure(options: DeployOptions): Promise<DeployResult> {
    const progress = options.onProgress ?? (() => {});
    const log = options.onLog ?? (() => {});

    try {
        // ── Step 0: check existing ────────────────────────────────────────
        progress(0, "Checking existing Azure deployment...");
        const existingUrl = await checkExistingDeployment(log);
        if (existingUrl) {
            // Existing deployment found — merge any local-agent branches and redeploy
            progress(1, "Merging local agent changes...");
            const merged = await mergeLocalAgentBranches(log);

            // Also check for uncommitted local changes (from local agent filesystem edits).
            // NOTE: This commit is LOCAL-ONLY (never pushed to origin).
            // It gets discarded on server restart by resetCorpWebsiteRepo() which
            // runs `git reset --hard origin/main`.
            let hasLocalChanges = false;
            try {
                const { stdout: statusOut } = await execAsync("git status --porcelain", { cwd: REPO_PATH, timeout: 10_000 });
                if (statusOut.trim()) {
                    hasLocalChanges = true;
                    log(`Found uncommitted local changes:\n${statusOut.trim().split("\n").slice(0, 10).join("\n")}`);
                    await run('git add -A && git commit -m "Include local agent changes for deployment"', log, 15_000);
                    log("Committed local changes for deployment.");
                }
            } catch (commitErr) {
                const msg = commitErr instanceof Error ? commitErr.message : String(commitErr);
                log(`Warning: could not commit local changes — ${msg.substring(0, 200)}`);
            }

            // Always redeploy when user explicitly triggers deploy (picks up merged branches + local changes)
            progress(2, "Redeploying to Azure...");
            log("Running azd deploy to push updated code...");
            try {
                await run("azd deploy --no-prompt 2>&1", log, 600_000);
                log("Redeployment complete.");
            } catch (deployErr) {
                const msg = deployErr instanceof Error ? deployErr.message : String(deployErr);
                log(`azd deploy failed, falling back to azd up: ${msg.substring(0, 200)}`);
                await run("azd up --no-prompt 2>&1", log, 600_000);
            }
            progress(4, "Redeployment complete!");

            const changeDesc = merged.length > 0 || hasLocalChanges
                ? `Redeployed with ${merged.length} merged branch(es)${hasLocalChanges ? " + local changes" : ""}`
                : "Redeployed to Azure";
            return { success: true, url: existingUrl, message: changeDesc };
        }

        // ── Step 1: scaffold azure.yaml if missing ────────────────────────
        progress(1, "Preparing Azure deployment config...");

        // Also merge any local-agent branches before first deploy
        await mergeLocalAgentBranches(log);

        let hasAzureYaml = false;
        try {
            await execAsync(`test -f ${REPO_PATH}/azure.yaml`);
            hasAzureYaml = true;
            log("azure.yaml already exists.");
        } catch {
            log("No azure.yaml found — initializing with azd...");
        }

        if (!hasAzureYaml) {
            try {
                // Try azd init --from-code first (auto-detect project type)
                await run("azd init --from-code --no-prompt", log, 60_000);
                log("azd init completed — azure.yaml created.");
            } catch (initErr) {
                const msg = initErr instanceof Error ? initErr.message : String(initErr);
                log(`azd init --from-code failed: ${msg.substring(0, 200)}`);
                log("Creating azure.yaml manually for Vite static site...");

                // Manually create azure.yaml for a static web app
                const azureYaml = [
                    "# yaml-language-server: $schema=https://raw.githubusercontent.com/Azure/azure-dev/main/schemas/v1.0/azure.yaml.json",
                    `name: ${REPO}`,
                    "services:",
                    "  web:",
                    "    project: .",
                    "    language: js",
                    "    host: staticwebapp",
                    "    dist: dist",
                    "    hooks:",
                    "      prepackage:",
                    "        shell: sh",
                    "        run: npm install && npm run build",
                ].join("\n");

                await execAsync(`cat > ${REPO_PATH}/azure.yaml << 'YAML'\n${azureYaml}\nYAML`, {
                    cwd: REPO_PATH,
                    timeout: 5_000,
                });
                log("Created azure.yaml for static web app deployment.");
            }
        }

        // ── Step 1b: scaffold Bicep infra if missing ──────────────────────
        scaffoldBicepInfra(REPO_PATH, log);

        // ── Step 2: set up azd environment ────────────────────────────────
        progress(2, "Configuring Azure environment...");

        // Create env (ignore error if already exists)
        try {
            await run(`azd env new ${ENV_NAME} --no-prompt`, log, 30_000);
        } catch {
            log(`Environment "${ENV_NAME}" may already exist — continuing.`);
        }

        // Select it
        try {
            await run(`azd env select ${ENV_NAME}`, log, 10_000);
        } catch {
            log("Could not select env — it may already be active.");
        }

        // Set location
        try {
            await run(`azd env set AZURE_LOCATION ${AZURE_LOCATION}`, log, 10_000);
        } catch {
            log("Warning: could not set AZURE_LOCATION — azd up will prompt or use default.");
        }

        // Set subscription — match to the azd-authenticated user's tenant
        try {
            // Get the azd-authenticated user to find the right subscription
            let azdUser: string | null = null;
            try {
                const { stdout: azdStatus } = await execAsync(
                    "azd auth login --check-status 2>&1",
                    { timeout: 15_000 },
                );
                const userMatch = azdStatus.match(/Logged in to Azure as (\S+)/);
                if (userMatch) azdUser = userMatch[1] ?? null;
                log(`azd authenticated as: ${azdUser || "unknown"}`);
            } catch {
                log("Could not determine azd auth user — falling back to az CLI.");
            }

            // List all enabled subscriptions (includes user info)
            const { stdout: listJson } = await execAsync(
                'az account list --query "[?state==\'Enabled\'].{id:id,tenantId:tenantId,name:name,user:user.name}" -o json',
                { timeout: 15_000 },
            );
            const subs = JSON.parse(listJson.trim());

            // Pick the subscription matching the azd user, fall back to az CLI default
            let sub = null;
            if (azdUser) {
                sub = subs.find((s: { user: string }) => s.user === azdUser);
            }
            if (!sub) {
                const { stdout: accountJson } = await execAsync(
                    'az account show --query "{id:id,tenantId:tenantId,user:user.name}" -o json',
                    { timeout: 15_000 },
                );
                const account = JSON.parse(accountJson.trim());
                sub = subs.find((s: { tenantId: string }) => s.tenantId === account.tenantId) || subs[0];
            }

            if (sub) {
                // Align az CLI + azd to the same subscription
                await execAsync(`az account set --subscription ${sub.id}`, { timeout: 10_000 });
                await run(`azd env set AZURE_SUBSCRIPTION_ID ${sub.id}`, log, 10_000);
                log(`Using subscription: ${sub.name} (${sub.id}) [tenant: ${sub.tenantId}]`);
            } else {
                log("Warning: no enabled subscriptions found.");
            }
        } catch {
            log("Warning: could not auto-detect subscription — azd up may prompt.");
        }

        // ── Step 3: azd up ────────────────────────────────────────────────
        progress(2, "Running Azure deployment (this may take a few minutes)...");
        log("Running azd up --no-prompt ...");

        const { stdout: upOut, stderr: upErr } = await run(
            "azd up --no-prompt 2>&1",
            log,
            600_000, // 10 min
        );

        const combined = upOut + "\n" + (upErr || "");
        console.log("[azure-deployer] azd up output (last 2000 chars):", combined.slice(-2000));

        // Try to extract URL from azd output
        let url = extractUrl(combined);

        // ── Step 4: get URL via azd show ──────────────────────────────────
        if (!url) {
            progress(3, "Retrieving deployment URL...");
            try {
                const { stdout: showOut } = await run("azd show --output json", log, 30_000);
                const data = JSON.parse(showOut);
                if (data?.services) {
                    for (const [, svc] of Object.entries(data.services as Record<string, { endpoint?: string }>)) {
                        if (svc?.endpoint) {
                            url = svc.endpoint;
                            break;
                        }
                    }
                }
            } catch {
                log("Could not retrieve URL from azd show.");
            }
        }

        progress(4, "Deployment complete!");

        if (url) {
            log(`Live URL: ${url}`);
            return { success: true, url, message: "Successfully deployed to Azure" };
        }

        return { success: true, message: "Deployment completed — check Azure Portal for the URL" };
    } catch (error: unknown) {
        // exec errors have stderr/stdout with the real details
        const execErr = error as { stderr?: string; stdout?: string; message?: string };
        const detail =
            execErr.stderr?.trim() ||
            execErr.stdout?.trim() ||
            (error instanceof Error ? error.message : String(error));
        // Take last 600 chars which usually contain the actual error reason
        const msg = detail.length > 600 ? "..." + detail.slice(-600) : detail;
        console.error("[azure-deployer] Error:", msg);
        log(`Deployment error: ${msg}`);

        // Classify error type
        const lowerMsg = msg.toLowerCase();
        const authPatterns = ["auth", "login", "access to subscription", "reload subscriptions", "resolve user"];
        const isAuth = authPatterns.some(p => lowerMsg.includes(p));
        const isSubscription = !isAuth && lowerMsg.includes("subscription");
        const isTimeout = lowerMsg.includes("timeout") || lowerMsg.includes("etimedout");
        const isInfra = lowerMsg.includes("bicep") || lowerMsg.includes("infra") || lowerMsg.includes("provision");

        let errorType: DeployResult["errorType"] = "unknown";
        if (isAuth) {
            errorType = "auth";
            // Try auto-heal: check if re-auth is needed
            try {
                await execAsync("azd auth login --check-status", { timeout: 15_000 });
                log("Auth status check passed — token may have refreshed.");
            } catch {
                log("Auth check failed — user needs to re-authenticate with 'azd auth login'.");
            }
        } else if (isSubscription) {
            errorType = "subscription";
        } else if (isTimeout) {
            errorType = "timeout";
        } else if (isInfra) {
            errorType = "infra";
        }

        return { success: false, message: msg, errorType };
    }
}
