# Model Studio — fake-only browser testing

Browser-driven testing of the athlete/operator Model Studio review and publication workflow against mock
services. Use dummy `ADMIN_TOKEN`, `DASHBOARD_SECRET`, `PREVIEW_TOKEN`, `MESHY_API_KEY`, `STRIPE_SECRET_KEY`,
`RESEND_API_KEY`, and webhook secrets from the repository's test instructions — never bind real provider
credentials.

## Local fake-only setup

- Follow `AGENTS.md` for build and environment. Run one Netlify Dev process per checkout.
- Start mock-services with `MOCK_MESHY_GLB=public/tenants/michael-heckert/models/heckert.glb` for a realistic
  viewer fixture. The tiny default mock model is insufficient for placement-fit visual checks.
- Use only mock provider keys and override Meshy, Stripe and Resend bases to the local mock origin.
- Back up disposable local Blobs state before resetting. The fake email payloads are recorded in
  `.netlify/mock-log.jsonl`.
- Reuse only the setup portion of `scripts/studio-test.sh` to prepare consent, kit, four photo fixtures,
  approved views, and an initial ready build. Stop before review actions if the review workflow is the browser
  test subject.
- Create a fresh magic link immediately before browser sign-in; GET opens a confirmation page and the user must
  click Open my dashboard. Dismiss onboarding if it covers the dashboard.

## Browser review workflow

- Before admin login, prove the athlete cookie alone cannot open the operator studio. Then test wrong and
  correct dummy admin tokens.
- Rebuild before approval so a fresh ready build can be checked without undoing operator state. Compare job IDs
  and remaining attempts, not merely the ready label. Empty rebuild note is valid.
- Rebuild redirects to dashboard. Open the model intake page to observe build polling, then follow Open studio
  preview when ready.
- Test empty required send-back note, 500-character input limit/counter, stored note in athlete studio, and
  reapproval.
- Publish/unpublish through UI while capturing successful GLB network requests. The fake generated model and
  tenant fallback may look identical: model-source URL changes are essential evidence.
- Draft portal needs `?preview=devpreview` even after its model is published. Model publication is separate
  from tenant publication/payout onboarding.
- Desktop and emulated mobile should allow scrolling the full disabled bid panel above the review bar. Wheel
  events over the 3D canvas zoom the camera; scroll outside it or drag the page scrollbar.
- In slow software WebGL, focus the address bar and type in separate actions to avoid dropped navigation text.
- Capture mock approval/send-back/live email payloads, not real delivery.

## Interpretation

- Do not judge frame rate on software WebGL.
- Local bid GETs may time out during heavy rendering; report the offline state and whether the next poll
  recovers rather than calling the run error-free.
- Inspect literal ellipsis asset URLs carefully. Browser HTML inspection tooling can produce truncated
  image-path requests; distinguish these from the application's successful original requests.
