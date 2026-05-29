# Newton Garden

A mobile-first PWA reference for the plants in my garden. Tap a plant, see how to care for it.

Live: <https://kelvination.github.io/newton-garden/>

## Design

- **Static reference site.** All content lives in `data/plants.json`. Each plant has chips (sun/water/season/zone), a stats grid, and care text under standard sections.
- **Three categories:** Flowers / Herbs / Edibles. The home screen lists each section alphabetically.
- **Swipe nav** between plants on a detail page. Order matches the home list and wraps across categories.
- **Living Family Tree** (`#/tree`): a pannable / zoomable taxonomic graph of every plant, grouped family → genus → species → plant. Tap a plant to light up cross-compatibility tiers (same species = cross freely, same genus = maybe, same family = cousins). From a selected plant you can pull related taxa with photos live from the iNaturalist API and graft them onto the tree.
- **PWA:** installable to the home screen, fully offline once installed (`manifest.json` + `sw.js`).
- **No build step.** Vanilla HTML / CSS / JS. Push to `main`, GitHub Pages serves the files.

## File layout

```
index.html          single page — hash routing
manifest.json       PWA manifest
sw.js               service worker (cache-first shell, network-first plants.json + taxonomy.json)
css/styles.css
css/tree.css        family-tree view styles
js/app.js           routing, render, swipe
js/tree.js          family-tree view: taxonomy, layout, pan/zoom, iNaturalist
data/plants.json    all plant data
data/taxonomy.json  genus → family map + family common names
photos/             one .jpg per plant (royalty-free)
icons/              PWA icons (192, 512)
```

## Family tree (`#/tree`)

- Each plant's `scientificName` is parsed into genus / species (cultivars, `spp.`,
  hybrid marks and parentheticals are stripped). Family comes from the
  `genusToFamily` map in `data/taxonomy.json`; unknown genera fall back to an
  iNaturalist ancestor lookup.
- Every node — family, genus, species, plant, and pulled-in relatives — is a photo
  card you can tap for an info panel (rank, lineage, photo + attribution, links).
  Garden plants use their local `photos/<id>.jpg`; structure nodes lazily fetch a
  representative photo from iNaturalist.
- Tapping any node expands it one rank down ("Show genera / species / varieties"),
  or pulls cousins ("Similar in genus / family / species" on a plant). Each call
  hits the read-only iNaturalist API (`api.inaturalist.org/v1`, no key) and grafts
  up to 6 related taxa — de-duplicated against what's already shown. The new nodes
  are themselves selectable and expandable, so you can drill family → genus →
  species. "Collapse added" removes a node's fetched children; "Reset" clears all.
- Pulled relatives are session-only; they are not written back to `plants.json`.
- External `fetch` and `<img>` work on GitHub Pages and over `file://`, but are
  blocked inside in-chat artifact sandboxes — test the live API on Pages.

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
