import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, unlink, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);

// Project root directory (where node_modules lives)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

interface ValidationResult {
    requirementIndex: number;
    requirement: string;
    passed: boolean;
    details: string;
    screenshot?: string;
}

interface ValidateOptions {
    url: string;
    requirements: string[];
    onProgress?: (current: number, total: number, message: string) => void;
    onResult?: (result: ValidationResult) => void;
    onLog?: (message: string) => void;
}

/**
 * Generate a Playwright test script that checks a live URL against requirements.
 * Each requirement becomes a test that checks for visible text, elements, or page behavior.
 */
function generateTestScript(url: string, requirements: string[]): string {
    const checks = requirements.map((req, i) => {
        // Extract keywords from the requirement to search for on the page
        const keywords = extractKeywords(req);
        const searchTerms = keywords.map(k => JSON.stringify(k)).join(', ');
        
        return `
    // Requirement ${i + 1}: ${req.replace(/'/g, "\\'")}
    {
        const reqIndex = ${i};
        const requirement = ${JSON.stringify(req)};
        try {
            await page.goto('${url}', { waitUntil: 'networkidle', timeout: 30000 });
            await page.waitForTimeout(2000); // Wait for dynamic content
            
            const pageContent = await page.evaluate(() => document.body.innerText.toLowerCase());
            const pageHtml = await page.evaluate(() => document.body.innerHTML.toLowerCase());
            
            const keywords = [${searchTerms}];
            const foundKeywords = keywords.filter(kw => 
                pageContent.includes(kw.toLowerCase()) || pageHtml.includes(kw.toLowerCase())
            );
            
            const passed = foundKeywords.length >= Math.max(1, Math.floor(keywords.length * 0.3));
            
            results.push({
                requirementIndex: reqIndex,
                requirement: requirement,
                passed,
                details: passed 
                    ? 'Found indicators: ' + foundKeywords.join(', ')
                    : 'Missing indicators. Searched for: ' + keywords.join(', ') + '. Found: ' + (foundKeywords.length > 0 ? foundKeywords.join(', ') : 'none'),
            });
        } catch (err) {
            results.push({
                requirementIndex: reqIndex,
                requirement: requirement,
                passed: false,
                details: 'Test error: ' + (err.message || String(err)).substring(0, 200),
            });
        }
    }`;
    }).join('\n');

    return `
const { chromium } = require('playwright');

(async () => {
    const results = [];
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ 
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Meeting2Code-Validator/1.0'
    });
    const page = await context.newPage();
    
    try {
${checks}
    } catch (err) {
        console.error('Fatal test error:', err);
    } finally {
        await browser.close();
    }
    
    console.log('__RESULTS_START__');
    console.log(JSON.stringify(results));
    console.log('__RESULTS_END__');
})();
`;
}

/**
 * Extract meaningful keywords from a requirement string for validation.
 */
function extractKeywords(requirement: string): string[] {
    // Remove common filler words and extract meaningful terms
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
        'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
        'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
        'into', 'through', 'during', 'before', 'after', 'above', 'below',
        'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
        'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
        'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
        'too', 'very', 'just', 'because', 'if', 'when', 'where', 'how',
        'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
        'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves',
        'add', 'update', 'create', 'implement', 'include', 'ensure',
        'make', 'provide', 'display', 'show', 'page', 'website', 'site',
        'section', 'feature', 'also', 'new', 'current', 'existing',
    ]);
    
    const words = requirement
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
    
    // Also try to extract multi-word phrases (bigrams)
    const phrases: string[] = [];
    const rawWords = requirement.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/);
    for (let i = 0; i < rawWords.length - 1; i++) {
        if (!stopWords.has(rawWords[i]!) && !stopWords.has(rawWords[i + 1]!)) {
            phrases.push(`${rawWords[i]} ${rawWords[i + 1]}`);
        }
    }
    
    // Combine unique words + phrases, limit to 8
    const combined = [...new Set([...phrases.slice(0, 3), ...words])];
    return combined.slice(0, 8);
}

/**
 * Validate a deployed site against meeting requirements using Playwright.
 */
export async function validateDeployment(options: ValidateOptions): Promise<ValidationResult[]> {
    const progress = options.onProgress ?? (() => {});
    const onResult = options.onResult ?? (() => {});
    const log = options.onLog ?? (() => {});
    
    const total = options.requirements.length;
    log(`Starting validation of ${total} requirements against ${options.url}`);
    progress(0, total, 'Preparing Playwright tests...');
    
    // Ensure playwright is available
    try {
        await execAsync('npx playwright --version', { timeout: 30_000 });
        log('Playwright is available');
    } catch {
        log('Installing Playwright...');
        progress(0, total, 'Installing Playwright browsers...');
        try {
            await execAsync('npx playwright install chromium', { timeout: 120_000 });
            log('Playwright chromium installed');
        } catch (installErr) {
            const msg = installErr instanceof Error ? installErr.message : String(installErr);
            log(`Failed to install Playwright: ${msg}`);
            return options.requirements.map((req, i) => ({
                requirementIndex: i,
                requirement: req,
                passed: false,
                details: 'Playwright is not installed. Run: npx playwright install chromium',
            }));
        }
    }
    
    // Generate and write test script in project directory so it can find node_modules
    const scriptPath = path.join(PROJECT_ROOT, '.tmp-validate.cjs');
    const testScript = generateTestScript(options.url, options.requirements);
    await writeFile(scriptPath, testScript, 'utf-8');
    log('Generated validation script');
    
    progress(0, total, 'Running Playwright validation...');
    
    try {
        const { stdout, stderr } = await execAsync(`node ${scriptPath}`, {
            cwd: PROJECT_ROOT,
            timeout: 180_000, // 3 min max
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: undefined },
        });
        
        if (stderr) {
            log(`Playwright stderr: ${stderr.substring(0, 200)}`);
        }
        
        // Parse results
        const startMarker = '__RESULTS_START__';
        const endMarker = '__RESULTS_END__';
        const startIdx = stdout.indexOf(startMarker);
        const endIdx = stdout.indexOf(endMarker);
        
        if (startIdx === -1 || endIdx === -1) {
            log('Could not parse Playwright output');
            log(`stdout (last 500): ${stdout.slice(-500)}`);
            return options.requirements.map((req, i) => ({
                requirementIndex: i,
                requirement: req,
                passed: false,
                details: 'Could not parse test results',
            }));
        }
        
        const jsonStr = stdout.substring(startIdx + startMarker.length, endIdx).trim();
        const results: ValidationResult[] = JSON.parse(jsonStr);
        
        // Stream results one by one
        for (let i = 0; i < results.length; i++) {
            const result = results[i]!;
            progress(i + 1, total, `Validated: ${result.requirement.substring(0, 50)}...`);
            onResult(result);
            log(`${result.passed ? '✅' : '❌'} Req ${i + 1}: ${result.passed ? 'PASS' : 'FAIL'} — ${result.details.substring(0, 100)}`);
        }
        
        // Cleanup
        try { await unlink(scriptPath); } catch { /* ignore */ }
        
        const passed = results.filter(r => r.passed).length;
        const failed = results.length - passed;
        log(`Validation complete: ${passed} passed, ${failed} failed out of ${results.length}`);
        
        return results;
    } catch (error: unknown) {
        const execErr = error as { stderr?: string; stdout?: string; message?: string };
        const detail = execErr.stderr?.trim() || execErr.stdout?.trim() || (error instanceof Error ? error.message : String(error));
        const msg = detail.length > 400 ? '...' + detail.slice(-400) : detail;
        log(`Playwright execution error: ${msg}`);
        
        return options.requirements.map((req, i) => ({
            requirementIndex: i,
            requirement: req,
            passed: false,
            details: `Execution error: ${msg.substring(0, 200)}`,
        }));
    }
}
