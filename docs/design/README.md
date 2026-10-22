# Design and front end: how we work

Two Claude instances work on this fork's front end together:

| Who | Owns | Works in |
| --- | --- | --- |
| **Design** (Claude Design, on claude.ai) | How every screen looks and behaves: layout, copy, states, the design system | The "SoulSync Prototypes" canvas and the "SoulSync Design System" in Claude Design |
| **Dev** (Claude Code) | Turning approved designs into code, the API they need, tests, CI, merging into `integration` | This repository |

The person who owns the fork (Ross) approves designs and decides when something is built.

## Where things are

- **Canvas:** [SoulSync Prototypes](https://claude.ai/artifact/MtjZJfCp3xgtnXFurAdXQa), one artboard per screen, with the design system installed.
- **Design system:** [SoulSync Design System](https://claude.ai/artifact/KEJdYBxVhnzDPbuPN1DBVK). It records today's UI exactly; the evolved rules are in `DESIGN-SYSTEM.md` here.
- Both are private to the fork owner's claude.ai account.
- **This folder** is the shared memory. Start every session by reading it.

| File | What it holds | Who writes it |
| --- | --- | --- |
| `BRIEF.md` | What SoulSync is, who uses it, what's wrong today, what we're aiming for | Dev, from Ross and user feedback |
| `DESIGN-SYSTEM.md` | The rules every new screen follows, and the React components that exist | Dev mirrors Design's decisions |
| `SCREENS.md` | Every screen: its status, its artboard, its code | Dev keeps it current |
| `CONTRACTS.md` | The data each screen can rely on, from the real API | Dev |
| `HANDOFF.md` | Decisions and questions passed between Design and Dev, newest first | Both (Design through the canvas) |
| `BACKLOG.md` | New features Ross wants, shaped with Dev against the real data; Design picks up anything "Ready for Design" | Dev, from Ross |

## The loop

1. **Design** reads this folder, works on the canvas, and records decisions as canvas notes or artboard comments. Each note names the artboard and says what changed and why.
2. **Dev** is notified when the canvas changes or gets a comment. It copies decisions into `HANDOFF.md` and `DESIGN-SYSTEM.md`, and updates `SCREENS.md`.
3. When Ross approves a screen, Dev builds it on a branch from `integration`, links the branch in `SCREENS.md`, and adds a screenshot of the built page back to `HANDOFF.md`.
4. Anything the design needs that the API can't give goes into `HANDOFF.md` as a question for Dev, and into `CONTRACTS.md` once it's decided.

Design can read this repository but can't commit to it, so the canvas is how Design talks back. Dev never changes a design without saying so in `HANDOFF.md`.

## Starting a Design session

Open the canvas in Claude Design and start with something like:

> You own SoulSync's front-end design. Read `docs/design/` in github.com/rossdelarge247-debug/SoulSync (branch `integration`), starting with README.md, then BRIEF.md, DESIGN-SYSTEM.md, SCREENS.md, CONTRACTS.md, HANDOFF.md and BACKLOG.md. Work on this canvas. Record each decision as a canvas note naming the artboard, and answer the open questions in HANDOFF.md the same way. Design within CONTRACTS.md; ask for anything new.

If that chat can't read GitHub, attach the six files instead.

## Rules for both

- Design within the data in `CONTRACTS.md`. If a screen needs something new, ask in `HANDOFF.md` rather than drawing data that doesn't exist.
- One artboard per screen, named as in `SCREENS.md`. Put new options beside the current version; don't overwrite it.
- Status always has a word, not just a colour. Copy is plain, specific and in sentence case. More in `DESIGN-SYSTEM.md`.
- Nothing about unreleased security fixes goes in this folder or on the canvas. This repository is public.
