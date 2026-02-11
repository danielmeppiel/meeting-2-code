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
    onStart?: (requirementIndex: number, requirement: string) => void;
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

    // ── RED FLAGS: explicit summary of missing/failing elements ──
    r += `\n## ⚠️ RED FLAGS — HARD FACTS FROM DOM INSPECTION ⚠️\n`;
    r += `These are BOOLEAN facts extracted directly from the live DOM. Do NOT override these with assumptions.\n\n`;

    // Form compliance flags
    const forms = a.forms ?? [];
    if (forms.length > 0) {
        const totalCheckboxes = forms.reduce((n: number, f: any) => n + (f.checkboxCount || 0), 0);
        const anyPrivacyCb = forms.some((f: any) => f.hasPrivacyCheckbox);
        const anyCookieCb = forms.some((f: any) => f.hasCookieCheckbox);
        const anyCaptcha = forms.some((f: any) => f.hasRecaptcha);
        const anyPrivacyLink = forms.some((f: any) => f.hasPrivacyLink);
        const anyCookieLink = forms.some((f: any) => f.hasCookieLink);

        r += `FORM COMPLIANCE:\n`;
        r += `  Total checkboxes across all forms: ${totalCheckboxes}\n`;
        r += `  Privacy/consent checkbox exists: ${anyPrivacyCb ? '✅ YES' : '❌ NO — MISSING'}\n`;
        r += `  Cookie consent checkbox exists: ${anyCookieCb ? '✅ YES' : '❌ NO — MISSING'}\n`;
        r += `  reCAPTCHA/CAPTCHA exists: ${anyCaptcha ? '✅ YES' : '❌ NO — MISSING'}\n`;
        r += `  Privacy policy link in/near form: ${anyPrivacyLink ? '✅ YES' : '❌ NO — MISSING'}\n`;
        r += `  Cookie policy link in/near form: ${anyCookieLink ? '✅ YES' : '❌ NO — MISSING'}\n`;

        if (!anyPrivacyCb && !anyCookieCb && !anyCaptcha) {
            r += `\n  🚨 CRITICAL: Forms have ZERO compliance elements (no checkboxes, no captcha, no policy links).\n`;
            r += `     Any requirement involving GDPR, consent, privacy, or spam protection MUST FAIL.\n`;
        }
    } else {
        r += `FORM COMPLIANCE: ❌ NO FORMS FOUND ON PAGE\n`;
    }

    // Cookie banner
    r += `\nCOOKIE CONSENT BANNER: ${a.cookieConsent?.hasBanner ? '✅ YES' : '❌ NO — NOT FOUND'}\n`;

    // Dedicated pages
    const missingPages: string[] = [];
    for (const [pp, d] of Object.entries(a.pages ?? {}) as [string, any][]) {
        if (!d.exists || d.redirectedToHome) missingPages.push(pp);
    }
    if (missingPages.length > 0) {
        r += `\nMISSING DEDICATED PAGES: ${missingPages.join(', ')}\n`;
        r += `  These paths either returned 404 or redirected to the home page.\n`;
    }

    return r;
}

// ── Deterministic Pre-Checks ──────────────────────────────────────────────────

/**
 * Check if the audit evidence deterministically fails a requirement BEFORE
 * sending to the AI judge. This catches obvious failures that the AI might
 * hallucinate past — e.g. GDPR compliance when there are literally zero
 * privacy checkboxes and no reCAPTCHA in the DOM.
 */
function deterministicPreCheck(
    audit: Record<string, unknown>,
    requirement: string,
): { autoFail: boolean; reason: string } | null {
    const a = audit as any;
    const reqLower = requirement.toLowerCase();
    const forms = a.forms ?? [];

    // ── GDPR / privacy compliance check ──
    if (
        (reqLower.includes('gdpr') || reqLower.includes('privacy') || reqLower.includes('consent')) &&
        (reqLower.includes('form') || reqLower.includes('contact') || reqLower.includes('checkbox'))
    ) {
        const failReasons: string[] = [];

        // Check for privacy/consent checkbox
        if (reqLower.includes('privacy') && (reqLower.includes('checkbox') || reqLower.includes('mandatory'))) {
            const hasAnyPrivacyCheckbox = forms.some((f: any) => f.hasPrivacyCheckbox);
            if (!hasAnyPrivacyCheckbox) {
                failReasons.push('No privacy/consent checkbox found in any form (hasPrivacyCheckbox=false for all forms)');
            }
        }

        // Check for cookie consent checkbox
        if (reqLower.includes('cookie') && reqLower.includes('consent')) {
            const hasAnyCookieCheckbox = forms.some((f: any) => f.hasCookieCheckbox);
            const hasCookieBanner = a.cookieConsent?.hasBanner === true;
            if (!hasAnyCookieCheckbox && !hasCookieBanner) {
                failReasons.push('No cookie consent checkbox in forms AND no cookie consent banner on page');
            }
        }

        // Check for reCAPTCHA/spam protection
        if (reqLower.includes('recaptcha') || reqLower.includes('captcha') || reqLower.includes('spam')) {
            const hasAnyCaptcha = forms.some((f: any) => f.hasRecaptcha);
            if (!hasAnyCaptcha) {
                failReasons.push('No reCAPTCHA or captcha detected in any form (hasRecaptcha=false for all forms)');
            }
        }

        // Check for privacy policy link
        if (reqLower.includes('privacy') && (reqLower.includes('link') || reqLower.includes('policy'))) {
            const hasPrivacyLink = forms.some((f: any) => f.hasPrivacyLink);
            const hasPrivacyPage = Object.entries(a.pages ?? {}).some(
                ([path, d]: [string, any]) => /privacy/i.test(path) && d?.exists
            );
            if (!hasPrivacyLink && !hasPrivacyPage) {
                failReasons.push('No privacy policy link in/near any form AND no privacy page exists on site');
            }
        }

        if (failReasons.length > 0) {
            return {
                autoFail: true,
                reason: `DETERMINISTIC FAIL — Playwright DOM evidence proves non-compliance:\n${failReasons.map(r => `  • ${r}`).join('\n')}\n\nForm evidence: ${forms.length} form(s) found with total checkboxes: ${forms.reduce((n: number, f: any) => n + (f.checkboxCount || 0), 0)}, hasRecaptcha: ${forms.some((f: any) => f.hasRecaptcha)}, hasPrivacyCheckbox: ${forms.some((f: any) => f.hasPrivacyCheckbox)}, hasCookieCheckbox: ${forms.some((f: any) => f.hasCookieCheckbox)}, hasPrivacyLink: ${forms.some((f: any) => f.hasPrivacyLink)}`,
            };
        }
    }

    // ── Dedicated page existence check ──
    if (reqLower.includes('dedicated page') || reqLower.includes('live before launch')) {
        const pageChecks: { pattern: RegExp; label: string }[] = [];
        if (reqLower.includes('privacy')) pageChecks.push({ pattern: /privacy/i, label: 'privacy' });
        if (reqLower.includes('cookie')) pageChecks.push({ pattern: /cookie/i, label: 'cookie policy' });
        if (reqLower.includes('sustainability')) pageChecks.push({ pattern: /sustainability/i, label: 'sustainability' });

        const missing: string[] = [];
        for (const pc of pageChecks) {
            const found = Object.entries(a.pages ?? {}).some(
                ([path, d]: [string, any]) => pc.pattern.test(path) && d?.exists && !d?.redirectedToHome
            );
            if (!found) missing.push(pc.label);
        }

        if (missing.length > 0) {
            return {
                autoFail: true,
                reason: `DETERMINISTIC FAIL — Required dedicated page(s) do not exist: ${missing.join(', ')}. All probed paths returned 404 or redirected to home.`,
            };
        }
    }

    return null; // no deterministic verdict — defer to AI judge
}

// ── Per-Requirement Sub-Agent Evaluation ──────────────────────────────────────

/**
 * Evaluates a SINGLE requirement by spawning a dedicated sub-agent session.
 * Each sub-agent is an expert QA tester focused exclusively on one requirement,
 * given the full site evidence. This prevents the "averaging" effect where a
 * single model evaluating many requirements tends to be lenient.
 */
async function evaluateSingleRequirement(
    client: CopilotClient,
    audit: Record<string, unknown>,
    requirement: string,
    reqIndex: number,
    log: (msg: string) => void,
): Promise<ValidationResult> {
    // ── Deterministic pre-check: catch obvious failures without AI ──
    const preCheck = deterministicPreCheck(audit, requirement);
    if (preCheck?.autoFail) {
        log(`[Req ${reqIndex + 1}] DETERMINISTIC FAIL — skipping AI judge`);
        log(`[Req ${reqIndex + 1}] ${preCheck.reason.substring(0, 200)}`);
        return {
            requirementIndex: reqIndex,
            requirement,
            passed: false,
            details: preCheck.reason,
        };
    }

    const evidence = formatAuditEvidence(audit);

    const session = await createAgentSession(client, {
        model: "claude-opus-4.6",
        mcpServers: {},
        systemMessage: {
            content: `You are an EXTREMELY strict, adversarial QA tester. Your ONLY job is to determine whether ONE specific website requirement is met, based on real browser evidence collected by Playwright.

## YOUR MINDSET
You are trying to FIND FAILURES. You are not trying to be helpful or give the benefit of the doubt. You are a hostile auditor. If there is ANY ambiguity, the requirement FAILS. If any sub-part is missing, the ENTIRE requirement FAILS. Partial credit does not exist.

## CRITICAL: READ THE RED FLAGS SECTION FIRST
The evidence contains a "⚠️ RED FLAGS" section at the bottom with HARD BOOLEAN FACTS extracted directly from the DOM. These are NOT opinions — they are programmatic checks (e.g., "reCAPTCHA exists: ❌ NO"). You MUST NOT override these facts. If the DOM says hasRecaptcha=false, then there is NO captcha on the page, period. Do not speculate that "the site might use an alternative approach" or "server-side validation could exist".

## DECOMPOSITION RULES
Before evaluating, you MUST decompose the requirement into every individual testable claim. Then check EACH claim against the evidence independently. If even ONE claim fails, the entire requirement fails.

Example: "Contact form must be GDPR compliant with cookie consent, mandatory privacy policy checkbox/link, and reCAPTCHA spam protection"
Decompose to:
  a) Contact form exists → check forms evidence
  b) Cookie consent mechanism present → check cookieConsent evidence AND form checkboxes
  c) Mandatory privacy policy checkbox OR link in/near the form → check hasPrivacyCheckbox AND hasPrivacyLink
  d) reCAPTCHA or equivalent spam protection → check hasRecaptcha evidence
  ALL four must pass. If reCAPTCHA is false, the whole requirement FAILS regardless of everything else.

Example: "Collect full name, business email, company name, phone, and message"
Decompose to:
  a) Field for full name → look for input with name/placeholder/label matching "name"
  b) Field for business email → look for email-type input
  c) Field for company name → look for input with name/placeholder/label matching "company"
  d) Field for phone → look for tel-type input or phone-related name/placeholder
  e) Field for message → look for textarea
  f) Email validation → look for type="email" or pattern attribute
  g) Phone validation → look for type="tel" or pattern attribute
  ALL must be present. Missing "company name" field = FAIL even if other fields exist.

## EVIDENCE INTERPRETATION RULES

1. **Form fields**: Check the ACTUAL field inventory (tag, type, name, placeholder, aria-label). A form with only [name, email, message] does NOT satisfy a requirement for [name, email, company, phone, message]. Count the actual fields.

2. **reCAPTCHA/CAPTCHA**: The evidence explicitly reports hasRecaptcha as true/false. If false, there is no spam protection. Do NOT assume any other mechanism exists unless explicitly shown in evidence. "Server-side validation" is NOT a substitute for reCAPTCHA when reCAPTCHA is explicitly required.

3. **Cookie consent**: Check BOTH the cookieConsent banner evidence AND form-level cookie checkboxes. A cookie consent banner != cookie consent checkbox in a form. They are different things. The requirement may ask for one or both.

4. **Privacy policy**: A "mandatory privacy policy checkbox" means an actual checkbox element in/near the form whose label text references "privacy" or "policy". hasPrivacyCheckbox in the evidence directly answers this. If it says false, there is NO such checkbox. No exceptions.

5. **Text matching**: If exact text is specified (headlines, taglines), it must appear EXACTLY in the corresponding element. "Innovating for Tomorrow" in an <h1> is NOT the same as "Innovation for Tomorrow's World".

6. **Dedicated pages**: A page that returns 200 but redirects to home (redirectedToHome: true) does NOT count as existing.

7. **Computed fonts**: Check the actual computed font-family strings, not just whether a stylesheet was imported.

8. **Performance**: Mobile load > 3000ms or FCP > 2500ms likely means below a score of 85.

## ABSOLUTE RULE
If the RED FLAGS section says an element is "❌ NO — MISSING", that element is MISSING. You cannot rationalize it into passing. Your decomposition claim for that element MUST be marked FAIL.

## OUTPUT FORMAT
Return ONLY valid JSON (no markdown fences, no text before/after):
{
  "passed": true | false,
  "decomposition": ["claim 1 → PASS/FAIL: evidence", "claim 2 → PASS/FAIL: evidence", ...],
  "details": "2-3 sentence summary citing specific evidence values that determined PASS or FAIL"
}`,
        },
        label: `qa-req-${reqIndex + 1}`,
        onLog: (msg) => log(`[Req ${reqIndex + 1}] ${msg}`),
    });

    try {
        const result = await session.sendAndWait({
            prompt: `## EVIDENCE COLLECTED BY PLAYWRIGHT FROM THE LIVE DEPLOYED SITE

${evidence}

---

## THE ONE REQUIREMENT YOU MUST EVALUATE

Requirement #${reqIndex + 1}: "${requirement}"

Decompose this requirement into every individual testable claim. Check each claim against the evidence. If ANY claim fails, the whole requirement FAILS. Return your judgment as JSON.`,
        }, 120_000);

        const content = result?.data?.content || '{}';
        await session.destroy();

        try {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            const parsed = JSON.parse(jsonMatch?.[0] || '{}');

            const decomp = parsed.decomposition;
            const decompStr = Array.isArray(decomp) ? `\nDecomposition:\n${decomp.map((d: string) => `  • ${d}`).join('\n')}` : '';

            return {
                requirementIndex: reqIndex,
                requirement,
                passed: parsed.passed === true,
                details: (parsed.details || 'No evaluation details') + decompStr,
            };
        } catch {
            log(`[Req ${reqIndex + 1}] Failed to parse sub-agent response`);
            log(`[Req ${reqIndex + 1}] Raw (first 400): ${content.substring(0, 400)}`);
            return {
                requirementIndex: reqIndex,
                requirement,
                passed: false,
                details: 'Sub-agent response could not be parsed — treating as FAIL',
            };
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[Req ${reqIndex + 1}] Sub-agent error: ${msg.substring(0, 200)}`);
        try { await session.destroy(); } catch { /* ignore */ }
        return {
            requirementIndex: reqIndex,
            requirement,
            passed: false,
            details: `Sub-agent error: ${msg.substring(0, 200)}`,
        };
    }
}

/**
 * Evaluate all requirements in parallel using dedicated sub-agents.
 * Each requirement gets its own Opus 4.6 session for deep, adversarial analysis.
 * Bounded concurrency prevents overwhelming the API.
 */
async function evaluateRequirementsParallel(
    client: CopilotClient,
    audit: Record<string, unknown>,
    requirements: string[],
    log: (msg: string) => void,
    onResult: (result: ValidationResult) => void,
    onProgress: (current: number, total: number, message: string) => void,
    onStart: (requirementIndex: number, requirement: string) => void,
): Promise<ValidationResult[]> {
    const MAX_CONCURRENT = 4;
    const total = requirements.length;
    const results: ValidationResult[] = new Array(total);
    let completed = 0;

    log(`Spawning ${total} parallel sub-agents (max ${MAX_CONCURRENT} concurrent) using claude-opus-4.6...`);

    // Bounded concurrency via semaphore pattern
    const queue = requirements.map((req, i) => ({ req, i }));
    const workers: Promise<void>[] = [];

    for (let w = 0; w < Math.min(MAX_CONCURRENT, total); w++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const item = queue.shift();
                if (!item) break;
                const { req, i } = item;

                log(`[Req ${i + 1}/${total}] Sub-agent starting: "${req.substring(0, 60)}..."`);
                onStart(i, req);
                const result = await evaluateSingleRequirement(client, audit, req, i, log);
                results[i] = result;
                completed++;

                onProgress(completed, total, `${result.passed ? '✅' : '❌'} Req ${i + 1}: ${req.substring(0, 50)}...`);
                onResult(result);
                log(`${result.passed ? '✅' : '❌'} Req ${i + 1} complete: ${result.passed ? 'PASS' : 'FAIL'} — ${result.details.substring(0, 120)}`);
            }
        })());
    }

    await Promise.all(workers);
    return results;
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
    const onStart = options.onStart ?? (() => {});
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

    // ── Phase 2: Parallel sub-agent evaluation (one Opus 4.6 agent per requirement) ──
    progress(0, total, 'Spawning per-requirement sub-agents (Opus 4.6)...');
    log('Phase 2: Spawning dedicated sub-agent per requirement for adversarial evaluation...');

    const results = await evaluateRequirementsParallel(
        options.client, audit, options.requirements, log, onResult, progress, onStart,
    );

    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;
    log(`Validation complete: ${passed} passed, ${failed} failed out of ${results.length}`);

    return results;
}
