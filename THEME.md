# Theme Spec — "Compendium" (navy · cyan · violet)

A light, clean, developer-tool aesthetic: **navy ink, a cyan→violet gradient accent, soft
navy-tinted shadows, Inter for UI, JetBrains Mono for code.** Extracted from the ThoughtSpot
Embed Playground. This file is self-contained — an agent can implement the whole look from it.

> **Scope note:** This is a *light-only* theme as authored. A ready-to-use dark set is included
> at the bottom under "Optional: dark mode" — wire it up only if the target app needs it.

---

## 1. Design identity (the non-negotiables)

These five moves are what make the theme recognizable. Preserve them; everything else is detail.

1. **The accent is always a gradient, never flat:** `linear-gradient(135deg, #00c9de, #6366f1)`
   (cyan → violet at 135°). Use it on the primary button, the logo mark, and brand chips.
2. **A fixed 3px accent stripe runs down the far left of the viewport** (vertical cyan→violet).
3. **Focus is a soft cyan halo, not a browser outline:** `box-shadow: 0 0 0 3px var(--accent-soft)`
   + `border-color: var(--accent)`. The halo alone is decorative — `--accent-soft` cannot carry
   the 3:1 that WCAG 1.4.11 asks of a focus indicator — so the global `:focus-visible` pairs it
   with a `2px solid var(--accent-ink)` outline (see §8).
4. **Shadows are navy-tinted, never pure black:** `rgba(26,31,74, …)`. Brand buttons get a cyan glow.
5. **Status is a traffic-light dot + soft-background pill:** idle / connecting / success / danger,
   each a `color` + matching `*-soft` background.

---

## 2. Design tokens

Paste this `:root` block in. These are the source of truth — reference the variables everywhere,
never hardcode the hexes in components.

```css
:root {
  /* Surfaces */
  --bg:            #f5fafd;   /* app background */
  --surface:       #ffffff;   /* cards, bars, panels */
  --surface-2:     #f5fafd;   /* subtle inset / nested surface */
  --surface-3:     #eaf1f7;   /* deeper inset, hover fills */

  /* Borders */
  --border:        #e1ecf0;   /* default hairline */
  --border-light:  #c2d4dc;   /* inputs, buttons (slightly stronger) */

  /* Brand palette */
  --navy:          #1a1f4a;   /* brand ink */
  --accent:        #00c9de;   /* cyan — primary accent */
  --accent-2:      #6366f1;   /* violet/indigo — gradient partner */
  --accent-soft:   #ecf7f9;   /* cyan tint — focus halos, soft fills */
  --accent-border: #b8e0dd;   /* cyan-tinted border */

  /* Ink twins of the accent pair — the ONLY accent values allowed to carry text.
     #00c9de is 2.02:1 on white; these are 5.07:1 and 6.29:1. See §8. */
  --accent-ink:    #067a87;   /* cyan-ink — accent TEXT, focus outlines */
  --accent-2-ink:  #4f46e5;   /* violet-ink — gradient partner for white-on-fill */

  --violet-soft:   #eef0fe;   /* violet tint fill */
  --violet-border: #c7cbf5;   /* violet-tinted border */

  /* Text (all AA-contrast on white) */
  --text-primary:  #1a1f4a;   /* = navy */
  --text-secondary:#4a5573;
  --text-muted:    #5d698c;   /* ≥4.5:1 on white — do not lighten past this */

  /* Status (solid + soft pair each) */
  --success:       #2d8b65;   --success-soft: #e6f4ed;
  --warn:          #c08930;   --warn-soft:    #faf3e0;
  --danger:        #b85450;   --danger-soft:  #fae9e8;

  /* Status borders (the tinted hairline each status pill/callout uses) */
  --success-border:#c0dccf;
  --warn-border:   #ead9a8;
  --danger-border: #ebcccc;

  /* Code surface */
  --code-bg:       #0a0f24;   /* near-black navy for code blocks */

  /* Layout (the tool shell's fixed rails) */
  --topbar-h:      52px;
  --rail-w:        212px;
  --insp-w:        340px;
  --bp-collapsed:  40px;
  --bp-open:       300px;

  /* Shape */
  --radius:        9px;       /* cards; buttons/inputs use 7–8px; pills use 999px */

  /* Type */
  --mono:          'JetBrains Mono', ui-monospace, monospace;
}
```

### Elevation (navy-tinted shadows)

> These are **values, not tokens**: `css/styles.css` inlines them and defines no shadow or glow
> custom property in `:root`. Use the literal rather than a `var()` that doesn't exist — or add
> the custom properties to `:root` first if you want them tokenized. Same for the sans stack.

```css
/* Use these instead of black shadows. */
0 1px  3px  rgba(26,31,74,.06)   /* xs — top bar / hairline lift */
0 2px  8px  rgba(26,31,74,.12)   /* sm */
0 8px  24px rgba(26,31,74,.12)   /* md — cards, popovers */
0 10px 28px rgba(26,31,74,.28)   /* lg — modals, drawers */
0 2px  10px rgba(0,201,222,.30)  /* accent glow — primary/brand buttons */
```

---

## 3. Fonts

Add to `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
```

Base:

```css
* , *::before, *::after { box-sizing: border-box; }
body {
  font-family: 'Inter', system-ui, sans-serif;
  background: var(--bg);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
}
```

**Type scale (observed usage):**
- Body / controls: **13px**
- Brand wordmark: **14px / 700**, `letter-spacing: -.2px`
- Section labels & tags: **10–11px / 600**, `text-transform: uppercase`, `letter-spacing: .4px`
- Code, status pills, monospace data: **11–12px**, `var(--mono)`

---

## 4. The signature stripe

```css
body::before {
  content: '';
  position: fixed; left: 0; top: 0; bottom: 0;
  width: 3px;
  background: linear-gradient(180deg, var(--accent), var(--accent-2));
  z-index: 1000; pointer-events: none;
}
```

---

## 5. Component recipes

### Primary (brand) button
```css
.btn-primary {
  height: 34px; padding: 0 14px; border: none; border-radius: 8px;
  font: 600 13px 'Inter', system-ui, sans-serif; color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 2px 10px rgba(0,201,222,.30);
  cursor: pointer;
}
.btn-primary:hover { opacity: .88; }
```

### Secondary button (outline → accent on hover)
```css
.btn {
  height: 34px; padding: 0 14px; border-radius: 8px;
  font: 600 13px 'Inter', system-ui, sans-serif;
  background: var(--surface); color: var(--text-secondary);
  border: 1px solid var(--border-light);
  transition: border-color .18s, color .18s;
  cursor: pointer;
}
.btn:hover { border-color: var(--accent); color: var(--accent); }
```

### Input / select
```css
.input {
  height: 34px; padding: 0 11px; border-radius: 8px;
  font-size: 13px; color: var(--text-primary);
  background: var(--bg); border: 1px solid var(--border-light);
  outline: none; transition: border-color .18s;
}
.input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);   /* the halo */
}
```

### Card / panel
```css
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 8px 24px rgba(26,31,74,.12);
}
```

### Logo mark (gradient tile)
```css
.mark {
  width: 26px; height: 26px; border-radius: 7px;
  display: grid; place-items: center; color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 2px 8px rgba(0,201,222,.3);
}
```

### Beta / brand tag (pill)
```css
.tag {
  font: 600 10px 'Inter', system-ui, sans-serif; text-transform: uppercase; letter-spacing: .4px;
  color: var(--accent); border: 1px solid var(--accent);
  border-radius: 999px; padding: 1px 7px;
}
```

### Status pill + traffic-light dot
```css
.status {
  display: inline-flex; align-items: center; gap: 7px;
  font: 600 11.5px var(--mono); letter-spacing: .02em;
  padding: 4px 11px; border-radius: 20px; white-space: nowrap;
}
.status::before { content:''; width:7px; height:7px; border-radius:50%; background: currentColor; }

.status[data-state="idle"]       { color: var(--text-muted); background: var(--surface-3); }
.status[data-state="connecting"] { color: var(--warn);    background: var(--warn-soft);    border:1px solid #ead9a8; }
.status[data-state="ok"]         { color: var(--success); background: var(--success-soft); border:1px solid #c0dccf; }
.status[data-state="error"]      { color: var(--danger);  background: var(--danger-soft);  border:1px solid #ebcccc; }

/* pulse the dot while connecting */
.status[data-state="connecting"]::before { animation: status-pulse 1s ease-in-out infinite; }
@keyframes status-pulse { 50% { opacity: .3; } }
```

### Code block
```css
.code {
  background: var(--code-bg); color: #e6edf3;
  font: 500 12px var(--mono); line-height: 1.6;
  border-radius: var(--radius); padding: 14px 16px;
}
```

---

## 6. Rules of thumb for the implementing agent

- **Never hardcode a hex** in a component — always go through a `var(--token)`.
- **Accent = gradient** on filled brand elements; **solid `--accent`** only for borders, dots,
  glows and decorative fills — **never for text**. Text uses `--accent-ink` (see §8).
- **Every focusable control** gets `border-color: var(--accent)` + `0 0 0 3px var(--accent-soft)` on
  `:focus` (or `:focus-visible`). No default browser outlines.
- **Shadows use `rgba(26,31,74, …)`**, never `rgba(0,0,0, …)`, except cyan glows on brand buttons.
- **Don't lighten `--text-muted` past `#5d698c`** — it's the AA-contrast floor on white.
- **Radius ladder:** cards `9px`, buttons/inputs `7–8px`, pills/dots `999px`.
- Keep the **left accent stripe** — it's the single most identifying element.

---

## 8. Accessible accent: `--accent-ink` and the focus halo

`--accent` (`#00c9de`) is a **fill colour, not an ink**. Measured against white it is **2.02:1** —
under the 4.5:1 AA floor for text *and* under the 3:1 non-text floor for focus indicators and
control boundaries. Every accent-coloured label in the original sheet failed AA.

**The rule:** `--accent` paints; `--accent-ink` writes.

| Use | Token | Ratio |
|---|---|---|
| Accent-coloured TEXT (section labels, badges, tags, code-ish labels) | `--accent-ink` `#067a87` | 5.07:1 on `#fff` |
| Focus outline | `--accent-ink` | 5.07:1 (≥3:1, WCAG 1.4.11) |
| White text on a filled brand control (primary button, step marker) | `linear-gradient(135deg, var(--accent-ink), var(--accent-2-ink))` | 5.07:1 worst stop |
| Dots, borders, glows, `accent-color`, hairlines, soft fills | `--accent` / `--accent-soft` / `--accent-border` | n/a (decorative) |

`--accent-ink` is 4.65:1 on `--accent-soft` and 4.82:1 on `--bg`, so it also clears AA on the
soft-tinted surfaces. It is **4.45:1 on `--surface-3` (`#eaf1f7`)** — don't put accent text there.

### The focus indicator

The halo is the theme's signature, but a `#ecf7f9` halo on a white page is invisible to a contrast
meter. Ship both: a 3:1-clearing outline in the ink, with the halo just outside it.

```css
:focus-visible {
  outline: 2px solid var(--accent-ink);   /* 5.07:1 — satisfies WCAG 1.4.11 */
  outline-offset: 2px;
  box-shadow: 0 0 0 5px var(--accent-soft);  /* the signature halo, outside the outline */
}
```

Controls that paint their own focus (inputs, the select buttons) keep
`border-color: var(--accent)` + `box-shadow: 0 0 0 3px var(--accent-soft)`. **Never** write
`outline: none` without a replacement indicator.

---

## 9. Optional: dark mode

Not part of the original app. If the target needs it, add this and the tokens auto-swap. Values are
a faithful dark translation of the palette (accent hues unchanged so the brand reads the same).

```css
@media (prefers-color-scheme: dark) {
  :root {
    --bg:            #0a0f24;
    --surface:       #121834;
    --surface-2:     #0e1430;
    --surface-3:     #1b2246;
    --border:        #242c52;
    --border-light:  #313a66;
    --navy:          #e8ecff;
    --accent:        #00c9de;   /* unchanged */
    --accent-2:      #818cf8;   /* lifted for contrast on dark */
    --accent-soft:   #0e2b33;
    --accent-border: #1c4a52;
    --accent-ink:    #3fd9ea;   /* on dark the ink LIGHTENS — 10.2:1 on --surface */
    --accent-2-ink:  #a5b0ff;
    --violet-soft:   #1e2150;
    --violet-border: #3a3f7a;
    --text-primary:  #e8ecff;
    --text-secondary:#aab3d4;
    --text-muted:    #8792b8;
    --success: #4fbf8f; --success-soft: #102a20;
    --warn:    #e0b25a; --warn-soft:    #2c2410;
    --danger:  #e07b76; --danger-soft:  #2e1615;
    --code-bg: #05081a;
  }
}
```

For an explicit toggle instead of OS preference, mirror the same block under
`:root[data-theme="dark"] { … }` and flip `data-theme` on `<html>`.
