# web — LabDeck UI + JSON API

Next.js (App Router) + React + TypeScript, shadcn/ui + SmoothUI (Tailwind v4, Motion), TanStack Query.
One server for the pages and the JSON API of `../../docs/api.md`:

- `src/server/` — the API and the auth redirects (`/api/*`, `/login`, `/auth/*`) as one framework-free dispatcher over
  web-standard `Request`/`Response`; `src/app/api/[...path]`, `src/app/login`, `src/app/auth/[...path]` are the route handlers.
  Tests call the dispatcher directly (`test/`, run with `npm test` from the repo root).
- `src/app/` — one thin client page per route; the pages themselves are in `src/views/` (the former SPA's, unchanged
  apart from `@/lib/router`, a small react-router-compatible shim over `next/navigation`). The app renders in the browser
  only, like the SPA did. Shapes live in `src/lib/types.ts`.
- `src/proxy.ts` — the pages' Content-Security-Policy with a per-request nonce.

```sh
npm ci                                                  # in the repo root (npm workspaces)
npm run -w @labdeck/web dev                             # http://localhost:3000, needs DATA_DIR etc. (docs/design.md 約定 B)
NEXT_PUBLIC_MOCK=1 npm run -w @labdeck/web dev          # dev-only fixture API (src/mocks), no backend needed
NEXT_PUBLIC_MOCK=1 NEXT_PUBLIC_MOCK_HOSTS=19 npm run -w @labdeck/web dev   # ~150 GPU cards for performance checks
npm run -w @labdeck/web build && npm run -w @labdeck/web lint
```

Mock switches (URL query, remembered in localStorage): `?mock_role=anon|identity|member|admin`,
`?mock_metrics=down|up`. The mock layer is excluded from production builds.

Components from the shadcn registry are added with `npx shadcn@latest add <name>` (SmoothUI:
`@smoothui/<name>`) and live in `src/components/ui` and `src/components/smoothui`.
