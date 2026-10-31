---
name: FlashForge Web UI
description: A brushed-metal instrument for one multicolour printer - the camera is the hero, one screen per job, never scroll.
colors:
  film: "#12171b"
  ink: "#e9e6dc"
  dimension-cyan: "#5ed0e8"
  pencil: "#a0a09a"
  print-blue-hue: "210"
  heat-orange-hue: "28"
  move-green-hue: "140"
  files-violet-hue: "270"
  light-amber-hue: "45"
  ok: "#79d79a"
  warn: "#f2b84b"
  danger: "#ff7a6b"
typography:
  display:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "2.75rem"
    fontWeight: 600
    fontStretch: "87.5%"
    lineHeight: 1
  headline:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 600
    fontStretch: "87.5%"
  body:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
rounded:
  control: "6px"
  panel: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  dock-button:
    backgroundColor: "anodised, hue per view"
    textColor: "#0d1114"
    rounded: "8px"
    height: "56px"
  button-default:
    backgroundColor: "brushed gunmetal"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "40px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    height: "40px"
  panel:
    backgroundColor: "brushed gunmetal"
    rounded: "{rounded.panel}"
    padding: "16px"
---

# Design system: FlashForge Web UI

## Overview

The UI is an app with five screens, not a page of cards. A dock at the bottom switches between them; each screen fits the viewport, so nothing needs scrolling on a phone or a laptop. The camera is the hero: it is the largest thing on Print and Move, it is never cropped, and nothing is drawn over the picture.

Mode: Operate. The person is at the printer with a phone, or at a desk, and wants state in a glance. Pause and Cancel are rare, so they live inside the job panel, and Cancel is separate and confirmed.

The look is brushed anodised aluminium. The surfaces are dark gunmetal with a fine brushed grain (a small CC0 texture blended over a gradient). Colour is anodised metal, mid brightness, and it appears only where it carries meaning: the five dock buttons (one hue per screen) and the filament colours on the tool tiles. Everything else stays gunmetal and ink, so text is always readable.

The signature move is the **dimension line**: a measured value is drawn as a ruled line with end ticks. The job bar has a tick every 10 %. Each heater reading has a line filled to the current temperature with a tick at the target. Numbers ease to new values and the bars grow smoothly; that is the only motion, and it stops under `prefers-reduced-motion`.

## Colors

Dark only. There is no light theme.

- **Film** `#12171b` (`--film`, theme "Page"): the page behind everything.
- **Ink** `#e9e6dc` (`--ink`, theme "Text"; `--action`, theme "Buttons" for the primary dialog button): warm off-white text, 14:1 on film.
- **Dimension cyan** `#5ed0e8` (`--dim`, theme "Measured values and focus"): the filled part of every dimension line, keyboard focus, selection. Nothing else is cyan.
- **Pencil** (68 % ink over film, about `#a0a09a`): secondary text and labels. **Faint** (44 %): disabled text only.
- **View hues** (set as `--h` on `#views` from the active dock button): Print 210 (blue), Heat 28 (orange), Move 140 (green), Files 270 (violet), Light 45 (amber). `--h` tints the gunmetal very slightly (7-9 % saturation) and fully colours the anodised dock buttons (52-55 % saturation).
- **Filament colours** come from the material station and fill the header of a tool tile; the header text turns black or white by contrast. They are data, not palette.
- **Signals**, always with a word: ok `#79d79a` (Printing, On printer), warn `#f2b84b` (Paused, Queued, notices), danger `#ff7a6b` (Error, Failed, Cancel print).

Rule: no raw hex in components; derived colours use `color-mix` or `hsl(var(--h) ...)`. The theme setting stores five colours (page, panel/dialog surface, text, buttons, measured values); saved values equal to the old blue defaults are shown in this palette.

## Typography

One family: **Archivo** variable (OFL), Latin subset, 42 KB woff2 at `fonts/archivo-var-latin.woff2`, weights 400-700, widths 87.5-100 %. Headings and numerals use the semi-condensed width. All numbers are tabular. Scale (rem): 0.8125, 0.9375, 1.0625, 1.25, 1.5, 2, 2.75. Labels are sentence case, never all caps.

## Texture

`img/brushed.webp` (about 10 KB, 256x256, greyscale) comes from ambientCG "Metal 009" (CC0), with the low-frequency tones removed so only the fine grain is left. It is blended with `background-blend-mode: soft-light` over a gradient on panels, buttons, tool-tile headers and the dock. It is static and cheap. Never use it at full contrast: at full contrast it looks like wood.

## Layout

One shell: a slim header (title, printer picker, add printer, connection, log out) and the views, with the dock fixed at the bottom. `#views[data-active-view]` shows one screen; the URL hash (`#print`, `#heat`, `#move`, `#files`, `#light`) keeps the screen.

- **Print:** left, a status bar (state word and dot; lifetime stats on wide screens) with a Camera / Layers switch, and under it the camera (or the layer view). Right, a rail: the four tools as read-only tiles, the job panel (percent, layer, time left, dimension bar, elapsed, weight, length, speed, then Pause or Resume and Cancel print), and the model preview. The tiles and the job panel are in the rail, never over the camera.
- **Heat:** the multi-tool temperature panel (Set and Off per tool, bed, chamber) and the material station. Set and Off are hidden while a job runs, with one line saying why.
- **Move:** the same camera, and a jog pad. The Creator 5 has no move or home command over its network API, so the pad is disabled and says why; the layout is kept for printers or a workaround that can move.
- **Files:** Upload job, Recent files, Local files, Refresh status, then the library list with sync markers. This is the only list; it scrolls inside its own box.
- **Light:** On / Off and the light timer.

Phone (under 900 px): the camera is a 16:9 block at the top, the rail stacks under it, the dock spans the bottom. Wide (900 px and up): camera left, 400 px rail right, the dock floats at the bottom centre. A phone that is too short drops the job facts row before it scrolls.

## Elevation & Depth

Flat with a brushed edge: a 1 px lighter top edge and a 1 px black bottom edge. Only dialogs and toasts have a shadow (`0 16px 40px rgba(0,0,0,.5)`) over a dark overlay. No blur.

## Shapes

Controls 6 px, panels 8 px, dock buttons 8 px, badges 2 px. Circles only for status dots.

## Components

- **Button.** Default: brushed gunmetal, ink text. Hover: brighter. Disabled: faint text, dashed border, `title` says why. Pressed (Light On/Off, Camera/Layers): anodised in the view's hue. Danger: red text and outline, filled on hover.
- **Dock button.** Anodised in its view's hue, dark icon and label; the current screen has a 2 px ink ring.
- **Tool tile.** Header in the filament colour (T number, material), reading (current large, target small), dimension line.
- **Job panel.** One primary action at a time (Pause or Resume), Cancel print alone and outlined red behind a confirm dialog, Clear status only after an error or a finished job.
- **Confirm dialog.** `confirmAction()` in `shared/dom.ts`; focus starts on the safe choice. Used for Cancel print and Delete file.
- **Stale state.** When the browser loses the server, a banner appears, graphics dim and controls are disabled.

## Do's and Don'ts

- Do keep every element ID; feature modules find elements by ID. Panels are created once in `ui/panel-registry.ts` and mounted into the `data-slot` containers of `index.html`.
- Do give each new feature a screen or an existing panel, and keep each screen inside the viewport.
- Do pair every colour signal with a word and give a disabled control a reason.
- Don't put anything over the camera picture.
- Don't add a light theme, a font, a CDN asset, blur, or animation that moves layout.
- Don't use cyan for anything that is not a measured value, focus or selection.
- Don't use the texture at full contrast.
