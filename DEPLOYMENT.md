# SuiGuard deployment

## Runtime requirements

Use Node.js 22 or newer. Build and run from the project root.

```sh
npm ci --include=dev
npm run build
npm start
```

Set `NODE_ENV=production` in the hosting environment. The server serves the built `dist` directory, keeps `/api/tatum` and `/api/walrus-memory` on the same origin, and binds to `0.0.0.0` using the host-provided `PORT`.

`GET /api/health` is a lightweight deployment health check.

## Environment variables

Set these through the host's private environment-variable settings:

- `TATUM_API_KEY` (required)
- `TATUM_API_BASE` (optional; defaults to `https://api.tatum.io`)
- `SUI_NETWORK` (optional; defaults to `mainnet`)
- `NODE_ENV=production`
- `PORT` (provided by the host; do not hardcode it in the dashboard)

Do not upload or commit `.env`, API keys, or wallet secrets. `.env.example` contains placeholders only.

## Render

Create a Node web service connected to the GitHub repository. Use:

- Build command: `npm ci --include=dev && npm run build`
- Start command: `npm start`
- Health check path: `/api/health`

Add `TATUM_API_KEY` and any optional settings in the service's Environment section. The service redeploys when changes are pushed to its connected branch if auto-deploy is enabled.

## Truehost cPanel

Create a Node.js app in cPanel with the project root as its application root and `server/index.mjs` as the startup file. Select Node.js 22, set `NODE_ENV=production`, and add the private environment variables above. Install dependencies and build from the project root before restarting the app. Use the app URL configured in cPanel with HTTPS enabled.

## Checks before a release

```sh
npm test
npx tsc --noEmit
npm run build
```