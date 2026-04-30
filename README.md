# Newton Garden

A mobile-first PWA reference for the plants in my garden. Tap a plant, see how to care for it.

Live: <https://kelvination.github.io/newton-garden/>

## Design

- **Static reference site.** All content lives in `data/plants.json`. Each plant has chips (sun/water/season/zone), a stats grid, and care text under standard sections.
- **Three categories:** Flowers / Herbs / Edibles. The home screen lists each section alphabetically.
- **Swipe nav** between plants on a detail page. Order matches the home list and wraps across categories.
- **PWA:** installable to the home screen, fully offline once installed (`manifest.json` + `sw.js`).
- **No build step.** Vanilla HTML / CSS / JS. Push to `main`, GitHub Pages serves the files.

## File layout

```
index.html          single page — hash routing
manifest.json       PWA manifest
sw.js               service worker (cache-first shell, network-first plants.json)
css/styles.css
js/app.js           routing, render, swipe
data/plants.json    all plant data
photos/             one .jpg per plant (royalty-free)
icons/              PWA icons (192, 512)
```

## Adding or editing a plant

1. Edit `data/plants.json`. Each plant has `id`, `name`, `scientificName`, `category` (`flowers` | `herbs` | `edibles`), `photo`, `chips`, `stats`, `watering`, `lightSoil`, `whatToExpect`, `careTips`, `notes`, `facts`. Edibles add `daysToMaturity`, `yield`, `harvestTips`.
2. Drop a photo at `photos/<id>.jpg`. If none, the page falls back to a gradient.
3. Commit and push. Pages updates in ~1 minute.

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Photo sourcing

Photos are royalty-free, mostly from Wikimedia Commons. Per-photo attribution lives in `photoCredit` on each plant (shown at the bottom of detail pages where present).

## Disclaimer

Care info was researched and hand-edited. Treat it as a starting point — verify against a trusted regional source before making big planting or watering decisions.
