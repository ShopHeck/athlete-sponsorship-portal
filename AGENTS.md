# heck-sponsor-360 — agent notes

Template + reference implementation of the 360° athlete sponsorship portal (3D placement picker, live bidding,
Lock It Now, Stripe invoicing, Resend email). Live: https://portal.michaelheckert.com (embedded at
https://sponsors.michaelheckert.com).

**Playbook:** `.devin/skills/sponsorship-portal/SKILL.md` (also linked from `.claude/skills/` and
`.agents/skills/`). Read it before building a new portal, changing placements/pricing/copy, launching or
operating one. `reference/gotchas.md` first when debugging.

## Commands
- Build the selected tenant (`portal.config.json` by default): `npm run build`
- Dev server (functions + Blobs sandbox): run `npm run build` first, then `npx netlify dev`
- End-to-end test, no real Stripe/Resend:
  `node scripts/mock-services.mjs &` then `netlify dev` with `STRIPE_API_BASE`/`RESEND_API_BASE=http://127.0.0.1:4242`
  (see `scripts/smoke-test.sh` header), then `scripts/smoke-test.sh http://localhost:8888 <OPEN-ID-A> <OPEN-ID-B>`
  → must print `SMOKE TEST PASSED`. Reset the sandbox with `rm -rf .netlify/blobs-serve`.
- Syntax check: `for f in public/app.js public/arena.js netlify/lib/*.mjs netlify/functions/*.mjs scripts/*.mjs; do node --check "$f" || exit 1; done`
- Package the skill for Claude / Codex / ChatGPT: `scripts/package-skill.sh` → `dist/skill/`
- Production deploys happen from Git (`main`) via Netlify; do not `netlify deploy` a linked site.

## Rules
- Base PRs on `main`; never stack. Verify the Netlify build is live after merging.
- Placement IDs and labels are defined only in the selected tenant config's `garments[].placements`; the build generates the server allowlist and labels from it.
- Secrets only via `netlify env:set … --secret`; never in chat, code or commits.
- Blobs deletions are destructive: confirm the placement ID and back up first.
- Real test emails / locks need explicit confirmation and the owner's own address.
- Address every automated PR-review comment before calling a PR mergeable.
