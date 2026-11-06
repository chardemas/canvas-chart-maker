# Canvas Chart Maker

Turns a picture into a needlepoint chart: symbol chart with a marked centre, DMC thread matches,
a print version sized in inches, and a tick-off checklist saved in the browser.

## Run it

    npm install      # first time only
    npm run dev      # then open the address it prints
    npm test         # chart-step tests
    npm run build    # production build into dist/

## Where things live

- `src/lib/chart.ts`: the chart recipe (trim, size, background, boost, k-means colours, DMC matching). No browser needed; covered by `chart.test.ts`.
- `src/lib/color.ts`, `src/lib/dmc.ts`: colour maths (CIEDE2000) and the DMC floss table.
- `src/worker/chart.worker.ts`: runs the recipe off the main thread.
- `src/lib/image.ts`: crop, trim and shrink the picture (browser canvas).
- `src/lib/render.ts`: draws the chart, print version and the image to save.
- `src/App.tsx` + `src/components/`: the screens.

Thread colour data: craft-color-codes by MakeBead (https://makebead.com/), CC BY 4.0. Keep the credit line in the legend.
