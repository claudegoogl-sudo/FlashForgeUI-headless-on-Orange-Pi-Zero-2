---
name: FlashForge Web UI
description: A drafting sheet for one multicolour printer - state first, measured values drawn as dimension lines.
colors:
  film: "#12171b"
  sheet: "#1b2229"
  ink: "#e9e6dc"
  dimension-cyan: "#5ed0e8"
  pencil: "#a0a09a"
  rule: "#33383b"
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
    fontWeight: 650
    fontStretch: "87.5%"
    lineHeight: 1.1
  title:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "1.25rem"
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
    fontWeight: 500
rounded:
  control: "4px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.film}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 16px"
  button-default:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 16px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    height: "40px"
  panel:
    backgroundColor: "{colors.sheet}"
    padding: "16px 24px"
---

# Design system: FlashForge Web UI

## Overview

The screen is one ruled drawing sheet for one printer. Panels are zones of the sheet: they share hairlines, they have no gaps and no shadows. The first row is a title block (printer state, job, job details), as on an engineering drawing. Below it the camera is the largest zone; heaters, controls and the material station stack beside it.

Mode: Operate. The person is at the printer with a phone, or at a desk with a monitor, and reads state in a few seconds. Brand lives in details: the dimension lines, the tabular numerals, the tool-colour fields. Nothing is decorative.

The signature move is the **dimension line**: a measured value is drawn as a ruled line with end ticks. The job bar has ticks every 10 %. Each heater reading has a line filled to the current temperature with a tick at the target.

## Colors

Five theme colours (Settings > Colors) feed the palette. Their defaults are below; the older blue palette saved in existing configs is replaced by these defaults when the page loads (per colour, only when the saved value is the old default).

- **Film** `#12171b` (`--film`, theme background): page ground, camera frame.
- **Sheet** `#1b2229` (`--sheet`, theme surface): panels.
- **Ink** `#e9e6dc` (`--ink`, theme text; also `--action`, theme primary): text and the primary button. A warm off-white, 14:1 on film.
- **Dimension cyan** `#5ed0e8` (`--dim`, theme secondary): measured values (job bar, heater lines), keyboard focus, selection. Nothing else is cyan.
- **Pencil** `--pencil` (68 % ink on film, about `#a0a09a`): secondary text, labels, 6:1 on sheet. **Faint** (44 %) is for disabled text only. **Rule** (16 % ink) draws hairlines; **raised** (8 % ink over sheet) is the hover fill.
- **Signals**, always paired with a text label: ok `#79d79a` (printing, On printer), warn `#f2b84b` (paused, heating, Queued), danger `#ff7a6b` (error, Failed, Cancel print).
- Filament colours come from the material station and appear only as solid fields on the tool tiles, slot buttons and G-code view. They are data, not palette.

Rule: no raw hex in components. Derived colours use `color-mix` on the tokens.

## Typography

One family: **Archivo** variable (OFL), Latin subset, self-hosted as `fonts/archivo-var-latin.woff2` (42 KB), weights 400-700, widths 87.5-100 %. Labels and body use normal width; headings and numerals use semi-condensed (`font-stretch: 87.5%`). All numbers are tabular (`font-variant-numeric: tabular-nums`).

Scale (rem, ratio about 1.15): 0.8125 (labels), 0.9375 (body), 1.0625, 1.25 (dialog titles, detail values), 1.5, 2 (state word, heater reading), 2.75 (job percent). Labels are sentence case, never all caps. Panel names are small pencil labels, not headings with weight.

## Layout

12-column GridStack, row height 72 px, **no gaps** (`margin: 0`). Default layout (desktop):

```
 0         3                  8           12
 +---------+------------------+-----------+
 | Printer | Job (percent +   | Job       |   rows 0-2   title block
 | state   |  dimension bar)  | details   |
 +---------+------------------+-----------+
 | Camera                     | Temps     |   rows 3-10 / 3-8
 |  (8 cols, 16:9, not        | T1..T4,   |
 |   cropped)                 | bed       |
 |                            +-----------+
 +----------------------------+ Controls  |   right: rows 9-14
 | G-code view                +-----------+
 |                            | Material  |   rows 15-18
 +----------------------+-----+ station ---+
 | Light timer          | Model preview   |   rows 19-22
 +----------------------+-----------------+
```

Hidden panels (features the printer lacks) are parked by the grid manager so they leave no hole. Edit mode shows the construction grid (12 columns, 72 px rows) over the sheet.

Mobile (width 768 px or less): one column, no side borders, in this order: printer state, job, camera (16:9), temperatures, controls, job details, G-code view, material station, light timer, Spoolman, model preview, filtration. Edit mode is off on mobile. Targets are 44 px on touch (`pointer: coarse`), 40 px otherwise (36 px for Set/Off and library actions, never below 24 px).

## Elevation & Depth

Flat. Depth is hairlines and tone: film (lowest), sheet, raised (hover). Only floating things have a shadow: dialogs and toasts (`0 16px 40px rgba(0,0,0,.5)`), over a 78 % film overlay. No blur, no gradients except the drawn rulers.

## Shapes

Panels are square (they are zones of a sheet). Controls, dialogs and toasts have a 4 px radius. Badges 2 px. Filament swatches 2 px. Circles are only status dots and spinners.

## Components

- **Button.** Default: transparent, 1 px strong rule, ink text. Hover: raised fill. Disabled: faint text, dashed rule, `title` says why. Primary (one per area, at most): ink fill, film text. Danger: danger text and outline; fills on hover. Pressed (Light On/Off): cyan-tinted fill and cyan border.
- **Controls panel.** Pause or Resume (one visible), Light segment, Library and Upload job, a closed "More" group, one hint line saying why things are unavailable, and Cancel print alone at the bottom behind a confirm.
- **Confirm dialog.** `confirmAction()` in `shared/dom.ts`. Focus starts on the safe choice; Escape and the backdrop cancel. Used for Cancel print and Delete file.
- **Tool tile.** Header filled with the filament colour (text black or white by contrast), reading (current large, target small), dimension line, Set and Off.
- **Library row.** Thumbnail, name, sync marker (On printer, Queued, Failed, Not synced, as text in a coloured outline), actions. The file being printed has a cyan ring and a "Printing now" marker. Delete is quiet and right-aligned.
- **Stale state.** When the browser loses the server, a banner appears under the header and values dim to 55 %.

## Do's and Don'ts

- Do keep every element ID; feature modules find elements by ID.
- Do add new colours as tokens, derived by `color-mix` from the five theme colours.
- Do pair every colour signal with a word.
- Do give a disabled control a reason (`title` or the hint line).
- Don't use cyan for anything that is not a measured value, focus or selection.
- Don't add cards, shadows, gradients or rounded panels; extend the sheet instead.
- Don't use all-caps labels, kickers above headings, or side-stripe borders.
- Don't crop or stretch the camera (`object-fit: contain`).
- Don't add a font, CDN asset or animated layout; the host is a 1 GB board behind a tailnet.
