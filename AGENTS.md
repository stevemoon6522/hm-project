# shopee-dashboard Agent Instructions

## Default App

Default all dashboard work to the V2 app unless the user explicitly asks for V1.

- Live V2 app: https://shopee-dashboard-kohl.vercel.app/v2/
- V2 source: `C:\dev\shopee-dashboard\v2\index.html`
- V2 shared modules: `C:\dev\shopee-dashboard\v2\*.js`
- V1 legacy source: `C:\dev\shopee-dashboard\index.html`

If the user says "dashboard", "web app", "V2", "Multi Platform Dashboard", "Joom registration", "product registration", "platform coverage", or "marketplace sync" without a V1 qualifier, edit and verify the V2 app.

Do not edit the root `index.html` V1 app unless the user explicitly says V1 or root app.

## Execution Guardrails

Work in the smallest practical unit. After each unit, run the narrowest relevant validation and move to the next unit only when it passes.

- For web/UI changes, review the changed HTML or local V2 app before deployment.
- Do not deploy automatically. Deploy only after the user explicitly says to deploy.
- Keep DB changes staged behind documentation and a small migration plan first; do not mix schema changes, UI rewrites, and live platform calls in one step.
- Treat current DB rows as the fast read model and append-only history tables as the source for rollback/audit decisions.
