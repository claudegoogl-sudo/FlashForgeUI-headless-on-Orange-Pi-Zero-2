# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
The owner of one Flashforge Creator 5 (4 tools, T1-T4, material station, camera, light). Two situations:
- Standing at the printer with a phone: is it printing, how far along, is it healthy, what does the camera show. Glances of a few seconds.
- At a desk with a monitor: watch a long multicolour job, manage the job library and upload queue, check the G-code layer view, change speed or light timer.
The UI is read-mostly while a job runs. Pause and cancel are rare and consequential.
(Inferred from the project handoff, not interviewed: no one was available to answer during the pilot.)

## Product Purpose
FlashForge Web UI (headless fork) shows and controls a Creator 5 from a browser on a Linux board (Orange Pi Zero 2, 1 GB RAM) over a tailnet.
Success: the state of the print is understood in one glance, and the rare control actions are deliberate and safe.

## Positioning
Not a generic printer dashboard: it carries features of this fork that no neighbour has: a job library that is also an upload queue with per-file sync markers, a live G-code viewer in tool colours, a light timer that runs on the server, and a print speed slider.

## Operating Context
- Served by a single `pkg` binary; static files are bundled. A deploy is a rebuild and binary swap.
- Viewed over Tailscale; the Pi also serves the camera, so payload must stay small and nothing animates heavy.
- Dark only (the user rejected a light theme). The five theme colours can still be changed in Settings.

## Capabilities and Constraints
- Keep the existing element IDs and feature modules; the shell and layout were replaced.
- App shell: a dock with screens (Print, Heat, Move, Files, Light), each inside the viewport, never scrolling. The camera is the hero. The user chose this over the customisable grid (2026-10-31).
- Self-host fonts (woff2, subset, one or two families). No CDN, no framework, no large dependency.
- Camera stream (go2rtc) is never cropped or distorted.
- Destructive or rare actions (cancel print, reboot, delete file) are separated and confirmed. Disabled controls say why when cheap.
- Terms: tools are T1-T4; "Library" is the job library on the WebUI host; sync markers are On printer, Queued, Failed, Not synced.

## Brand Commitments
None beyond the name "FlashForge Web UI". Sentence case copy; one name per action everywhere.

## Evidence on Hand
Baseline screenshots and detector output in `~/Projects/ffui-redesign/baseline/`. A local mock of the whole stack in `~/Projects/ffui-redesign/mock/` (screenshots of every printer state). No real-user feedback exists.

## Product Principles
1. State first: what the printer is doing, how far, how long, is anything wrong.
2. Rare actions are quiet and deliberate; frequent actions are one tap.
3. Every state is designed: idle, heating, printing, paused, finished, error, offline, empty library.
4. Cheap to serve: small CSS and JS, one font family, no animated layout.

## Accessibility & Inclusion
WCAG AA contrast, visible focus, labelled controls, targets at least 24 px (44 px on touch), reduced motion respected.
