import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { CopilotClient } from "@github/copilot-sdk";
import { createAgentSession } from "./session-helpers.js";

const execAsync = promisify(exec);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

interface ValidationResult {
    requirementIndex: number;
    requirement: string;
    passed: boolean;
    details: string;
}

interface ValidateOptions {
    url: string;
    requirements: string[];
    client: CopilotClient;
    onProgress?: (current: number, total: number, message: string) => void;
    onResult?: (result: ValidationResult) => void;
    onLog?: (message: string) => void;
}

// ── Playwright Deep Audit ─────────────────────────────────────────────────────

/**
 * Instead of keyword-matching, this script performs a comprehensive browser
 * audit: real DOM inspection, computed styles, form field enumeration,
 * CTA click-through navigation, dedicated-page probing, cookie-consent
 * detection, and mobile performance measurement.  The raw evidence is
 * returned as structured JSON so an AI judge can evaluate each requirement
 * against hard facts.
 */
function generateAuditScript(url: string): string {
    const pagePaths = [
        '/sustainability', '/sustainability.html',
        '/privacy', '/privacy-policy', '/privacy.html',
        '/cookie-policy', '/cookies', '/cookie-policy.html',
        '/about', '/about-us', '/about.html',
        '/contact', '/contact.html',
    ];

    return `
const { chromium } = require('playwright');

(async () => {
    const audit = {};
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    const baseUrl = '${url}'.replace(/\\/$/, '');

    try {
        // ═══════════════════════════════════════════════════
        // 1. MAIN PAGE — full DOM audit
        // ═══════════════════════════════════════════════════
        await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);

        audit.url = baseUrl;
        audit.title = await page.title();

        // Every heading with tag + exact text
        audit.headings = await page.evaluate(() =>
            Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => ({
                level: h.tagName.toLowerCase(),
                text: h.textContent.trim(),
            }))
        );

        // Hero / banner section content (first prominent section)
        audit.heroSection = await page.evaluate(() => {
            const hero = document.querySelector('.hero, [class*="hero"], [class*="banner"], header + section, main > section:first-child');
            if (!hero) return { found: false };
            return {
                found: true,
                text: hero.textContent?.trim()?.substring(0, 1000) || '',
                headings: Array.from(hero.querySelectorAll('h1,h2,h3')).map(h => ({
                    level: h.tagName.toLowerCase(),
                    text: h.textContent?.trim(),
                })),
                links: Array.from(hero.querySelectorAll('a')).map(a => ({
                    text: a.textContent?.trim(),
                    href: a.getAttribute('href'),
                })),
                buttons: Array.from(hero.querySelectorAll('button, a.btn, a[class*="btn"], a[class*="cta"], a[class*="button"]')).map(b => ({
                    text: b.textContent?.trim(),
                    href: b.getAttribute('href') || '',
                    tag: b.tagName.toLowerCase(),
                })),
            };
        });

        // Full visible text
        audit.fullText = await page.evaluate(() => document.body.innerText);

        // All links
        audit.links = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a[href]')).map(a => ({
                text: a.textContent?.trim(),
                href: a.getAttribute('href'),
                visible: a.offsetParent !== null || window.getComputedStyle(a).display !== 'none',
            }))
        );

        // ── Forms with full field inventory ──
        audit.forms = await page.evaluate(() =>
            Array.from(document.querySelectorAll('form')).map(form => {
                const fields = Array.from(form.querySelectorAll('input,textarea,select')).map(f => ({
                    tag: f.tagName.toLowerCase(),
                    type: f.getAttribute('type') || f.tagName.toLowerCase(),
                    name: f.getAttribute('name') || '',
                    id: f.id || '',
                    placeholder: f.getAttribute('placeholder') || '',
                    required: f.hasAttribute('required'),
                    ariaLabel: f.getAttribute('aria-label') || '',
                }));

                const checkboxes = Array.from(form.querySelectorAll('input[type="checkbox"]'));
                const hasPrivacyCheckbox = checkboxes.some(cb => {
                    const ctx = (cb.closest('label')?.textContent || '') + ' ' + (cb.parentElement?.textContent || '');
                    return /privacy|consent|gdpr|agree|policy|cookie/i.test(ctx);
                });
                const hasCookieCheckbox = checkboxes.some(cb => {
                    const ctx = (cb.closest('label')?.textContent || '') + ' ' + (cb.parentElement?.textContent || '');
                    return /cookie/i.test(ctx);
                });

                const hasRecaptcha =
                    !!form.querySelector('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], [class*="recaptcha"]') ||
                    !!document.querySelector('script[src*="recaptcha"], script[src*="hcaptcha"]');

                const formLinks = Array.from(form.querySelectorAll('a')).map(a => ({
                    text: a.textContent?.trim()?.toLowerCase() || '',
                    href: a.getAttribute('href') || '',
                }));
                const hasPrivacyLink = formLinks.some(l => /privacy/i.test(l.text) || /privacy/i.test(l.href));
                const hasCookieLink = formLinks.some(l => /cookie/i.test(l.text) || /cookie/i.test(l.href));

                const nearbyText = form.parentElement?.textContent?.substring(0, 500) || '';

                return {
                    id: form.id || '',
                    action: form.getAttribute('action') || '',
                    method: form.getAttribute('method') || 'GET',
                    fieldCount: fields.length,
                    fields,
                    checkboxCount: checkboxes.length,
                    hasPrivacyCheckbox,
                    hasCookieCheckbox,
                    hasRecaptcha,
                    hasPrivacyLink,
                    hasCookieLink,
                    formLinks,
                    nearbyText: nearbyText.substring(0, 300),
                };
            })
        );

        // ── Computed font families ──
        audit.fonts = await page.evaluate(() => {
            const sample = (selector) =>
                [...new Set(
                    Array.from(document.querySelectorAll(selector))
                        .slice(0, 20)
                        .map(el => window.getComputedStyle(el).fontFamily)
                )];

            const headingFonts = sample('h1,h2,h3,h4,h5,h6');
            const bodyFonts = sample('p,li,span,td');
            const buttonFonts = sample('button,a.btn,input[type="submit"]');

            const hasInterImport =
                Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
                    .some(l => /inter/i.test(l.href)) ||
                Array.from(document.querySelectorAll('style'))
                    .some(s => /inter/i.test(s.textContent || '')) ||
                !!document.querySelector('link[href*="fonts.googleapis.com"][href*="Inter"]') ||
                !!document.querySelector('link[href*="fonts.bunny.net"][href*="Inter"]');

            const allFontsUseInter = [...headingFonts, ...bodyFonts].every(f => /inter/i.test(f));

            return { headingFonts, bodyFonts, buttonFonts, hasInterImport, allFontsUseInter };
        });

        // ── CTA buttons — identify and test click-through ──
        audit.ctaButtons = await page.evaluate(() =>
            Array.from(document.querySelectorAll(
                'a.btn, a.button, a.cta, a[class*="btn"], a[class*="cta"], ' +
                'button, [role="button"], .hero a, header a'
            )).map(el => ({
                text: el.textContent?.trim(),
                href: el.getAttribute('href') || '',
                tag: el.tagName.toLowerCase(),
                classes: el.className,
            }))
        );

        // Actually click the most prominent CTAs and record where they lead
        audit.ctaNavigation = [];
        const ctaHandles = await page.$$(
            'a.btn, a.button, a.cta, a[class*="btn"], a[class*="cta"], ' +
            '.hero a, header a[href*="contact"], header a[href*="consult"]'
        );
        for (const cta of ctaHandles.slice(0, 5)) {
            try {
                const text = (await cta.textContent())?.trim();
                const href = await cta.getAttribute('href');
                if (!href) continue;

                if (href.startsWith('#')) {
                    const targetId = href.substring(1);
                    const info = await page.evaluate((id) => {
                        const el = document.getElementById(id);
                        if (!el) return { exists: false };
                        return {
                            exists: true,
                            hasForm: !!el.querySelector('form'),
                            text: el.textContent?.substring(0, 300)?.trim(),
                        };
                    }, targetId);
                    audit.ctaNavigation.push({ text, href, anchor: true, ...info });
                } else if (!href.startsWith('mailto:') && !href.startsWith('tel:')) {
                    const targetUrl = new URL(href, baseUrl).href;
                    const sub = await context.newPage();
                    try {
                        await sub.goto(targetUrl, { waitUntil: 'networkidle', timeout: 15000 });
                        const info = await sub.evaluate(() => ({
                            title: document.title,
                            hasForm: !!document.querySelector('form'),
                            formPurpose: (() => {
                                const f = document.querySelector('form');
                                if (!f) return 'none';
                                const t = f.textContent?.toLowerCase() || '';
                                if (t.includes('contact') || t.includes('consultation') || t.includes('get in touch')) return 'contact';
                                if (t.includes('subscribe') || t.includes('newsletter')) return 'newsletter';
                                return 'other';
                            })(),
                            headings: Array.from(document.querySelectorAll('h1,h2')).map(h => h.textContent?.trim()),
                        }));
                        audit.ctaNavigation.push({ text, href, targetUrl, ...info });
                    } catch (e) {
                        audit.ctaNavigation.push({ text, href, targetUrl, error: e.message?.substring(0, 100) });
                    } finally {
                        await sub.close();
                    }
                }
            } catch { /* skip broken handles */ }
        }

        // ── Cookie-consent banner ──
        audit.cookieConsent = await page.evaluate(() => {
            const selectors = [
                '[class*="cookie"]', '[id*="cookie"]',
                '[class*="consent"]', '[id*="consent"]',
                '[class*="gdpr"]', '[id*="gdpr"]',
                '[class*="privacy-banner"]',
            ];
            let banner = null;
            for (const s of selectors) { banner = document.querySelector(s); if (banner) break; }
            const btn = banner?.querySelector('button, a.btn, [class*="accept"]');
            return {
                hasBanner: !!banner,
                bannerText: banner?.textContent?.trim()?.substring(0, 400) || '',
                hasAcceptButton: !!btn,
                acceptButtonText: btn?.textContent?.trim() || '',
            };
        });

        // ═══════════════════════════════════════════════════
        // 2. DEDICATED PAGES — probe each path
        // ═══════════════════════════════════════════════════
        audit.pages = {};
        const pagePaths = ${JSON.stringify(pagePaths)};
        for (const pp of pagePaths) {
            const pageUrl = baseUrl + pp;
            try {
                const sub = await context.newPage();
                const resp = await sub.goto(pageUrl, { waitUntil: 'networkidle', timeout: 15000 });
                const status = resp?.status() || 0;
                if (status >= 400) {
                    audit.pages[pp] = { exists: false, status };
                } else {
                    const data = await sub.evaluate((home) => {
                        const isHome = window.location.href.replace(/\\/$/, '') === home.replace(/\\/$/, '');
                        return {
                            isHome,
                            title: document.title,
                            headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(h => h.textContent?.trim()),
                            textPreview: document.body.innerText.substring(0, 2000),
                            hasContent: document.body.innerText.trim().length > 100,
                        };
                    }, baseUrl);
                    audit.pages[pp] = {
                        exists: !data.isHome && data.hasContent,
                        redirectedToHome: data.isHome,
                        status,
                        title: data.title,
                        headings: data.headings,
                        textPreview: data.textPreview,
                    };
                }
                await sub.close();
            } catch (e) {
                audit.pages[pp] = { exists: false, error: e.message?.substring(0, 100) };
            }
        }

        // ═══════════════════════════════════════════════════
        // 3. MOBILE + PERFORMANCE
        // ═══════════════════════════════════════════════════
        const mobilePage = await context.newPage();
        await mobilePage.setViewportSize({ width: 375, height: 812 });
        const mobileStart = Date.now();
        await mobilePage.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });
        const mobileLoadTime = Date.now() - mobileStart;

        audit.performance = await mobilePage.evaluate(() => {
            const nav = performance.getEntriesByType('navigation')[0];
            const fcp = performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint');
            return {
                domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
                loadComplete: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
                firstContentfulPaint: fcp ? Math.round(fcp.startTime) : null,
                transferSize: nav ? nav.transferSize : null,
                resourceCount: performance.getEntriesByType('resource').length,
            };
        });
        audit.performance.mobileLoadTime = mobileLoadTime;

        audit.mobile = await mobilePage.evaluate(() => {
            const meta = document.querySelector('meta[name="viewport"]');
            return {
                hasViewportMeta: !!meta,
                viewportContent: meta?.getAttribute('content') || '',
                bodyScrollWidth: document.body.scrollWidth,
                viewportWidth: window.innerWidth,
                hasHorizontalScroll: document.body.scrollWidth > window.innerWidth + 5,
                smallTextElements: Array.from(document.querySelectorAll('p,li,span,a'))
                    .filter(el => parseFloat(window.getComputedStyle(el).fontSize) < 12).length,
            };
        });
        await mobilePage.close();

    } catch (err) {
        audit.fatalError = (err.message || String(err)).substring(0, 300);
    } finally {
        await browser.close();
    }

    console.log('__AUDIT_START__');
    console.log(JSON.stringify(audit));
    console.log('__AUDIT_END__');
})();
`;
}

// ── Evidence formatter ────────────────────────────────────────────────────────

function formatAuditEvidence(audit: Record<string, unknown>): string {
    const a = audit as any;
    let r = '';

    r += `## Page: ${a.url}\nTitle: "${a.title}"\n\n`;

    r += `## All Headings\n`;
    for (const h of a.headings ?? []) r += `  <${h.level}>: "${h.text}"\n`;

    if (a.heroSection?.found) {
        r += `\n## Hero / Banner Section\n`;
        r += `Text: "${a.heroSection.text?.substring(0, 600)}"\n`;
        r += `Hero headings:\n`;
        for (const h of a.heroSection.headings ?? []) r += `  <${h.level}>: "${h.text}"\n`;
        r += `Hero buttons/links:\n`;
        for (const b of a.heroSection.buttons ?? []) r += `  [${b.tag}] "${b.text}" → ${b.href}\n`;
    }

    r += `\n## Full Page Text (first 4000 chars)\n${(a.fullText ?? '').substring(0, 4000)}\n`;

    r += `\n## Links (${(a.links ?? []).length} total)\n`;
    for (const l of (a.links ?? []).slice(0, 40)) r += `  "${l.text}" → ${l.href} ${l.visible ? '' : '(hidden)'}\n`;

    r += `\n## Forms (${(a.forms ?? []).length})\n`;
    for (const f of a.forms ?? []) {
        r += `\nForm id="${f.id}" action="${f.action}" method="${f.method}" (${f.fieldCount} fields)\n`;
        for (const fld of f.fields ?? []) {
            r += `  <${fld.tag} type="${fld.type}" name="${fld.name}"${fld.required ? ' REQUIRED' : ''}${fld.placeholder ? ' placeholder="' + fld.placeholder + '"' : ''}>\n`;
        }
        r += `  Checkboxes: ${f.checkboxCount}\n`;
        r += `  Has privacy/consent checkbox: ${f.hasPrivacyCheckbox}\n`;
        r += `  Has cookie consent checkbox: ${f.hasCookieCheckbox}\n`;
        r += `  Has reCAPTCHA/captcha: ${f.hasRecaptcha}\n`;
        r += `  Has privacy policy link: ${f.hasPrivacyLink}\n`;
        r += `  Has cookie policy link: ${f.hasCookieLink}\n`;
        if (f.formLinks?.length) {
            r += `  Links in/near form:\n`;
            for (const fl of f.formLinks) r += `    "${fl.text}" → ${fl.href}\n`;
        }
    }

    r += `\n## Computed Fonts\n`;
    r += `Heading font-families: ${JSON.stringify(a.fonts?.headingFonts)}\n`;
    r += `Body font-families: ${JSON.stringify(a.fonts?.bodyFonts)}\n`;
    r += `Button font-families: ${JSON.stringify(a.fonts?.buttonFonts)}\n`;
    r += `Inter font imported via stylesheet: ${a.fonts?.hasInterImport}\n`;
    r += `ALL text elements use Inter: ${a.fonts?.allFontsUseInter}\n`;

    r += `\n## CTA Buttons Found\n`;
    for (const c of a.ctaButtons ?? []) r += `  [${c.tag}] "${c.text}" → ${c.href} (class="${c.classes}")\n`;

    r += `\n## CTA Click-Through Navigation Tests\n`;
    for (const n of a.ctaNavigation ?? []) {
        r += `  Clicked "${n.text}" (href=${n.href})\n`;
        if (n.error) { r += `    ❌ Navigation error: ${n.error}\n`; continue; }
        if (n.anchor) {
            r += `    Anchor → target exists: ${n.exists}, target has form: ${n.hasForm}\n`;
            if (n.text) r += `    Target section text: "${(n.text || '').substring(0, 200)}"\n`;
        } else {
            r += `    Navigated to: ${n.targetUrl}\n`;
            r += `    Has form: ${n.hasForm}, form purpose: ${n.formPurpose}\n`;
            r += `    Page title: "${n.title}", headings: ${JSON.stringify(n.headings)}\n`;
        }
    }

    r += `\n## Cookie Consent Banner\n`;
    r += `Banner found: ${a.cookieConsent?.hasBanner}\n`;
    r += `Banner text: "${a.cookieConsent?.bannerText}"\n`;
    r += `Accept button: ${a.cookieConsent?.hasAcceptButton} ("${a.cookieConsent?.acceptButtonText}")\n`;

    r += `\n## Dedicated Pages Probed\n`;
    for (const [pp, d] of Object.entries(a.pages ?? {}) as [string, any][]) {
        r += `  ${pp}: exists=${d.exists}`;
        if (d.redirectedToHome) r += ' ⚠ REDIRECTED TO HOME';
        if (d.status) r += `, HTTP ${d.status}`;
        r += '\n';
        if (d.exists) {
            if (d.headings?.length) r += `    Headings: ${d.headings.join(' | ')}\n`;
            if (d.textPreview) r += `    Content (preview): "${d.textPreview.substring(0, 400)}"\n`;
        }
    }

    r += `\n## Performance (mobile viewport 375×812)\n`;
    r += `Mobile page load time: ${a.performance?.mobileLoadTime}ms\n`;
    r += `DOM Content Loaded: ${a.performance?.domContentLoaded}ms\n`;
    r += `Full load: ${a.performance?.loadComplete}ms\n`;
    r += `First Contentful Paint: ${a.performance?.firstContentfulPaint}ms\n`;
    r += `Resources fetched: ${a.performance?.resourceCount}\n`;

    r += `\n## Mobile Friendliness\n`;
    r += `<meta viewport>: ${a.mobile?.hasViewportMeta} ("${a.mobile?.viewportContent}")\n`;
    r += `Horizontal scroll: ${a.mobile?.hasHorizontalScroll} (body ${a.mobile?.bodyScrollWidth}px vs viewport ${a.mobile?.viewportWidth}px)\n`;
    r += `Text elements < 12px: ${a.mobile?.smallTextElements}\n`;

    return r;
}

// ── AI Judge ──────────────────────────────────────────────────────────────────

async function evaluateRequirements(
    client: CopilotClient,
    audit: Record<string, unknown>,
    requirements: string[],
    log: (msg: string) => void,
): Promise<ValidationResult[]> {
    const evidence = formatAuditEvidence(audit);

    log('Creating strict QA evaluation session...');
    const session = await createAgentSession(client, {
        model: "claude-sonnet-4",
        mcpServers: {},
        systemMessage: {
            content: `You are the STRICTEST QA lead performing final acceptance testing on a deployed website.

You are given DETAILED EVIDENCE collected by a real Playwright browser from a live website.
For each requirement you must determine PASS or FAIL based ONLY on the evidence.

## YOUR RULES — NO EXCEPTIONS

1. **EXACT MATCH for text requirements**: If a requirement specifies exact wording (e.g., a headline, tagline, or specific text), the EXACT words must appear in the correct HTML element. Finding similar words somewhere on the page is NOT enough. An <h1> must contain the exact headline text. A tagline must be visible in the hero section.

2. **FUNCTIONAL requirements must be functionally verified**: If a requirement says "CTA funnels users to the contact form", the CTA navigation test MUST show it actually navigates to a page/section with a contact form. Just having a button that says "Contact" is not enough — the click-through test must confirm the destination.

3. **ALL sub-requirements must pass**: If a requirement lists multiple things (e.g., "cookie consent, privacy policy checkbox, AND reCAPTCHA"), then ALL of them must be present. Partial = FAIL.

4. **Dedicated page means a SEPARATE page**: "Move X to a dedicated page" means a distinct URL with that content. Not just a section on the home page. The page probe results must show the page exists at a real URL and was NOT redirected to home.

5. **Performance thresholds are non-negotiable**: If a requirement says "speed score exceeds 85", you must evaluate the measured performance metrics. Without a real Lighthouse score, assess based on load times: mobile load > 3s or FCP > 2.5s = likely below 85. Be honest about what we can and cannot measure.

6. **Font requirements need computed style proof**: "Use Inter font family" means the computed font-family on headings AND body text must actually resolve to Inter. Just importing the stylesheet is not enough — the computed styles must show Inter.

7. **Page existence requirements**: "Publish privacy policy and cookie policy pages" means those pages must exist at accessible URLs, have real content, and not redirect to the home page.

8. **Content completeness**: If a requirement says "Include X, Y, and Z details", ALL of X, Y, and Z must be present in the appropriate section. Finding one out of three = FAIL.

## OUTPUT FORMAT

Return ONLY a JSON array. No markdown fences, no commentary before or after.
Each element:
{
  "requirementIndex": <0-based>,
  "passed": true | false,
  "details": "<2-3 sentences: cite the SPECIFIC evidence (or lack thereof) that determined your verdict. Quote actual values from the evidence like exact heading text, computed font families, navigation results, page probe results.>"
}`,
        },
        label: 'qa-judge',
        onLog: log,
    });

    const reqList = requirements.map((r, i) => `${i + 1}. ${r}`).join('\n');

    log('Sending evidence to QA judge for strict evaluation...');
    const result = await session.sendAndWait({
        prompt: `## EVIDENCE COLLECTED FROM LIVE SITE BY PLAYWRIGHT

${evidence}

---

## REQUIREMENTS TO EVALUATE (be ruthlessly strict)

${reqList}

Evaluate EACH requirement. Return ONLY a JSON array.`,
    }, 180_000);

    const content = result?.data?.content || '[]';
    await session.destroy();

    try {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        const parsed = JSON.parse(jsonMatch?.[0] || '[]');
        return parsed.map((item: any, i: number) => ({
            requirementIndex: item.requirementIndex ?? i,
            requirement: requirements[item.requirementIndex ?? i] || requirements[i] || '',
            passed: item.passed === true,
            details: item.details || 'No evaluation details',
        }));
    } catch {
        log('Failed to parse AI judge response, marking all as failed');
        log(`Raw response (first 500): ${content.substring(0, 500)}`);
        return requirements.map((req, i) => ({
            requirementIndex: i,
            requirement: req,
            passed: false,
            details: 'QA judge response could not be parsed — treating as FAIL',
        }));
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate a deployed site by:
 * 1. Running a deep Playwright audit that collects real DOM evidence
 * 2. Feeding the evidence to an AI judge that strictly evaluates each requirement
 */
export async function validateDeployment(options: ValidateOptions): Promise<ValidationResult[]> {
    const progress = options.onProgress ?? (() => {});
    const onResult = options.onResult ?? (() => {});
    const log = options.onLog ?? (() => {});

    const total = options.requirements.length;
    log(`Starting deep validation of ${total} requirements against ${options.url}`);
    progress(0, total, 'Preparing Playwright deep audit...');

    // Ensure Playwright is available
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
                details: 'Playwright not installed. Run: npx playwright install chromium',
            }));
        }
    }

    // ── Phase 1: Deep browser audit ──
    progress(0, total, 'Running Playwright deep site audit...');
    log('Phase 1: Collecting comprehensive site evidence with Playwright...');

    const scriptPath = path.join(PROJECT_ROOT, '.tmp-audit.cjs');
    const script = generateAuditScript(options.url);
    await writeFile(scriptPath, script, 'utf-8');

    let audit: Record<string, unknown>;
    try {
        const { stdout, stderr } = await execAsync(`node ${scriptPath}`, {
            cwd: PROJECT_ROOT,
            timeout: 240_000,
            maxBuffer: 20 * 1024 * 1024,
            env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: undefined },
        });

        if (stderr) log(`Playwright stderr: ${stderr.substring(0, 300)}`);

        const startIdx = stdout.indexOf('__AUDIT_START__');
        const endIdx = stdout.indexOf('__AUDIT_END__');
        if (startIdx === -1 || endIdx === -1) {
            log('Could not parse Playwright audit output');
            log(`stdout tail: ${stdout.slice(-400)}`);
            return options.requirements.map((req, i) => ({
                requirementIndex: i, requirement: req, passed: false,
                details: 'Playwright audit produced no parseable output',
            }));
        }

        const json = stdout.substring(startIdx + '__AUDIT_START__'.length, endIdx).trim();
        audit = JSON.parse(json);
        log(`Phase 1 complete — collected ${Object.keys(audit).length} evidence categories`);
    } catch (error: unknown) {
        const execErr = error as { stderr?: string; stdout?: string; message?: string };
        const detail = execErr.stderr?.trim() || execErr.stdout?.trim() || (error instanceof Error ? error.message : String(error));
        const msg = detail.length > 400 ? '...' + detail.slice(-400) : detail;
        log(`Playwright audit error: ${msg}`);
        return options.requirements.map((req, i) => ({
            requirementIndex: i, requirement: req, passed: false,
            details: `Audit error: ${msg.substring(0, 200)}`,
        }));
    } finally {
        try { await unlink(scriptPath); } catch { /* ignore */ }
    }

    // ── Phase 2: AI strict evaluation ──
    progress(0, total, 'AI judge evaluating requirements against evidence...');
    log('Phase 2: Strict AI evaluation of each requirement against collected evidence...');

    const results = await evaluateRequirements(options.client, audit, options.requirements, log);

    // Stream results
    for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        progress(i + 1, total, `Evaluated: ${result.requirement.substring(0, 50)}...`);
        onResult(result);
        log(`${result.passed ? '✅' : '❌'} Req ${i + 1}: ${result.passed ? 'PASS' : 'FAIL'} — ${result.details.substring(0, 120)}`);
    }

    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;
    log(`Validation complete: ${passed} passed, ${failed} failed out of ${results.length}`);

    return results;
}
