# Jamus: interactive demo (`mock/ui` branch)

A browser version of the Jamus desktop UI, running on **hard-coded fictional data**. Nothing is
recorded, transcribed or uploaded. It exists to show the app on a portfolio site without making
anyone install it.

## How it works

- The page loads the **real renderer** (`electron/renderer/renderer.js` and `styles.css`) unchanged.
- `demo/mock-jamus.js` replaces the Electron bridge (`window.jamus`, normally `electron/preload.cjs`)
  with sample meetings, a scripted "live" conversation, and animated audio-app levels.
- `vercel.json` serves the repo root as a static site and rewrites `/` to `demo/index.html`.
  `.vercelignore` keeps the engine source out of the deployment.

## Deploying

Import the repo in Vercel, set the **Production Branch** to `mock/ui`. No build step.

Preview locally from the repo root: `npx serve .`, then open `/demo/index.html`.

## Keeping it in sync with `main`

UI changes land on `main` (in `electron/renderer/`). To pull them into the demo:

```
git checkout mock/ui
git merge main
```

If you add a method to `electron/preload.cjs`, add the matching method to `demo/mock-jamus.js`,
or the demo will throw when the UI calls it.
