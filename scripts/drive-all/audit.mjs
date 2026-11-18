// The design audit: one pass over what is ON SCREEN right now, run in the page after every step.
// Measures coherence, not taste — fonts outside the theme's three families, text colours outside the
// palette, unreadable contrast, controls that overlap or have no name, text cut off, sideways scroll
// on a phone, broken images. Each finding is { kind, severity, message, where }:
//   severity 'fail' — something is broken (sideways scroll, broken image)
//   severity 'warn' — something is inconsistent; a person looks at the screenshot and decides
//
// Runs inside the browser via page.evaluate; needs window.__driveLib (lib.mjs BROWSER_HELPERS).
/* global window, document, getComputedStyle */

export function auditPage({ phone = false, minContrast = 4.5, minLargeContrast = 3, extraFonts = [] } = {}) {
    const L = window.__driveLib
    const out = []
    const add = (kind, severity, message, el, detail) => out.push({ kind, severity, message, where: el ? describe(el) + (detail ? ` ${detail}` : '') : '' })
    const vw = window.innerWidth, vh = window.innerHeight

    function describe(el) {
        const cls = (typeof el.className === 'string' ? el.className : el.getAttribute?.('class') ?? '').split(/\s+/).filter(Boolean)[0]
        const text = (el.getAttribute?.('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32)
        return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${text ? ` "${text}"` : ''}`
    }
    function visible(el) {
        const r = el.getBoundingClientRect()
        if (r.width <= 1 || r.height <= 1 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            const s = getComputedStyle(n)
            if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false
        }
        return true
    }
    // Is the element what a person sees at its centre (not covered by a modal or drawer)?
    function onTop(el) {
        const r = el.getBoundingClientRect()
        const x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1), y = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1)
        const hit = document.elementFromPoint(x, y)
        return !!hit && (hit === el || el.contains(hit) || hit.contains(el))
    }

    // ── the theme: palette + fonts, read from the live :root (whatever theme is active) ──
    const rootStyle = getComputedStyle(document.documentElement)
    const palette = []
    const fontVars = {}
    for (let i = 0; i < rootStyle.length; i++) {
        const name = rootStyle[i]
        if (!name.startsWith('--')) continue
        const v = rootStyle.getPropertyValue(name).trim()
        if (/^--font-/.test(name)) fontVars[name] = v
        const c = L.parseColor(v)
        if (c) palette.push(c)
    }
    const families = new Set([...Object.values(fontVars).map(L.firstFamily), ...extraFonts.map(f => f.toLowerCase())].filter(Boolean))

    // ── 1. sideways scroll ──
    const over = document.documentElement.scrollWidth - vw
    if (over > 1) add('overflow', phone ? 'fail' : 'warn', `the page scrolls sideways by ${over}px at ${vw}px wide`)

    // ── 2. text: font, colour, contrast, clipping ──
    const textEls = []
    const walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */)
    const seen = new Set()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue.trim()) continue
        const el = n.parentElement
        if (!el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT|TITLE|OPTION)$/.test(el.tagName)) continue
        seen.add(el)
        if (el.closest('svg,canvas,[aria-hidden="true"]')) continue
        if (visible(el) && onTop(el)) textEls.push(el)
    }

    const sizes = new Map()
    const offFont = new Map(), offColor = new Map()
    for (const el of textEls) {
        const s = getComputedStyle(el)
        const fam = L.firstFamily(s.fontFamily)
        const px = parseFloat(s.fontSize)
        sizes.set(px, (sizes.get(px) ?? 0) + 1)

        if (families.size && !families.has(fam) && !offFont.has(fam)) {
            offFont.set(fam, el)
            add('font', 'warn', `text in "${fam}", not one of the theme's fonts (${[...families].join(' · ')})`, el)
        }
        if (families.size && !document.fonts.check(`12px "${fam}"`)) {
            add('font', 'warn', `"${fam}" is not loaded — the browser drew a fallback`, el)
        }

        const fg = L.parseColor(s.color)
        if (fg && palette.length) {
            const near = L.nearestColor(fg, palette)
            const key = `${fg.r},${fg.g},${fg.b}`
            if (near && near.d > 8 && !offColor.has(key)) {
                offColor.set(key, el)
                add('color', 'warn', `text colour rgb(${key}) is not in the theme palette (nearest is ${Math.round(near.d)} away)`, el)
            }
        }

        // contrast against the effective background (first opaque-ish ancestor, blended down)
        if (fg && fg.a > 0 && !el.closest(':disabled,[aria-disabled="true"]')) {   // disabled controls are exempt (WCAG 1.4.3)
            const layers = []
            let unknown = false   // a gradient/image, or a colour format we cannot read — skip, never guess
            for (let n = el; n; n = n.parentElement) {
                const ns = getComputedStyle(n)
                if (ns.backgroundImage && ns.backgroundImage !== 'none') { unknown = true; break }
                const bg = L.parseColor(ns.backgroundColor)
                if (!bg) { unknown = true; break }
                if (bg.a > 0) { layers.push(bg); if (bg.a >= 1) break }
            }
            const opacity = (() => { let o = 1; for (let n = el; n; n = n.parentElement) o *= +getComputedStyle(n).opacity; return o })()
            // faded on purpose (a filter's "not this one", a disabled look) is a choice, not a contrast bug
            if (!unknown && layers.length && opacity >= 0.3) {
                let base = { r: 255, g: 255, b: 255, a: 1 }
                for (let i = layers.length - 1; i >= 0; i--) base = L.blend(layers[i], base)
                const ratio = L.contrastRatio(L.blend({ ...fg, a: fg.a * opacity }, base), base)
                const large = px >= 24 || (px >= 18.66 && +s.fontWeight >= 700)
                const need = large ? minLargeContrast : minContrast
                if (ratio < need) {
                    const bucket = ratio < 3 ? 'under 3:1 — hard to read' : `under ${need}:1 — below WCAG AA`
                    add('contrast', ratio < 3 ? 'warn' : 'info', `${large ? 'large ' : ''}text contrast ${bucket}`, el, `${ratio.toFixed(1)}:1`)
                }
            }
        }

        // One floor for every screen: 10px, the app's own minimum (set 2026-11-17). Phones read closer than laptops.
        if (px < 10) add('tiny-text', 'warn', 'text under 10px', el, `${px}px`)

        // cut off: hidden overflow with no ellipsis, or an ellipsis and no way to read the rest
        if (/hidden|clip/.test(s.overflowX) && s.webkitLineClamp === 'none' && el.scrollWidth > el.clientWidth + 1) {
            if (s.textOverflow !== 'ellipsis') add('clipped', 'warn', 'text is cut off with no ellipsis', el)
            else if (!el.title && !el.closest('[title]')) add('truncated', 'info', 'text ends in an ellipsis with no tooltip to read the rest', el)
        }
    }
    const sizeList = [...sizes.entries()].sort((a, b) => a[0] - b[0])

    // ── 3. controls: names, overlap, tap size, off-screen ──
    const controls = [...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=tab]')]
        .filter(el => visible(el) && onTop(el))
    for (const el of controls) {
        const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('placeholder')
            || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent
            || el.querySelector('img[alt]')?.alt || el.labels?.[0]?.textContent || '').trim()
        if (!name) add('no-name', 'warn', 'a control with no accessible name (a screen reader says just "button")', el)
        const r = el.getBoundingClientRect()
        if (phone && el.tagName !== 'A') {
            // An absolutely-placed ::before/::after with negative insets is a deliberate hit area — count it.
            let { width: w, height: h } = r
            for (const pseudo of ['::before', '::after']) {
                const ps = getComputedStyle(el, pseudo)
                if (ps.content === 'none' || ps.position !== 'absolute' || getComputedStyle(el).position === 'static') continue
                const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }
                w = Math.max(w, r.width - px(ps.left) - px(ps.right))
                h = Math.max(h, r.height - px(ps.top) - px(ps.bottom))
            }
            if (w < 24 || h < 24) add('tap-target', 'warn', `tap target ${Math.round(w)}×${Math.round(h)}px (under 24px)`, el)
        }
        if (r.right > vw + 1 || r.left < -1) add('offscreen', 'warn', `control runs past the edge of the screen (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`, el)
    }
    for (let i = 0; i < controls.length; i++) {
        const a = controls[i].getBoundingClientRect()
        for (let j = i + 1; j < controls.length; j++) {
            const x = controls[j]
            if (controls[i].contains(x) || x.contains(controls[i])) continue
            const b = x.getBoundingClientRect()
            const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
            const inside = (p, q) => q.left >= p.left && q.right <= p.right && q.top >= p.top && q.bottom <= p.bottom
            if (inside(a, b) || inside(b, a)) continue   // an icon button laid on a row is deliberate
            if (w > 2 && h > 2) add('overlap', 'warn', `overlaps ${describe(x)} by ${Math.round(w)}×${Math.round(h)}px`, controls[i])
        }
    }

    // ── 4. images ──
    for (const img of document.images) {
        if (img.complete && img.naturalWidth === 0 && visible(img)) add('broken-image', 'fail', `image did not load: ${img.currentSrc || img.src}`.slice(0, 160), img)
    }

    return {
        findings: out,
        inventory: {
            fonts: [...new Set(textEls.map(el => L.firstFamily(getComputedStyle(el).fontFamily)))],
            themeFonts: [...families],
            fontSizes: sizeList,
            textElements: textEls.length,
            controls: controls.length,
            theme: document.documentElement.getAttribute('data-theme') ?? '',
        },
    }
}

/** Wait for CSS animations/transitions on the page to finish (fade-ins skew contrast), up to `ms`. */
export function settleAnimations(ms = 3000) {
    const anims = document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)
    return Promise.race([Promise.all(anims.map(a => a.finished.catch(() => {}))), new Promise(r => setTimeout(r, ms))]).then(() => anims.length)
}
