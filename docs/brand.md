# Brand

Alba means dawn. Workers carry orders through the night; a person comes back in the morning to what is ready, what needs them and what landed. The mark is a letter A whose arch holds the rising sun, resting on the horizon.

## Logo files

| File | Use |
|---|---|
| [img/brand/alba-mark.svg](img/brand/alba-mark.svg) | App icon, favicon, avatars |
| [img/brand/alba-logo-light.svg](img/brand/alba-logo-light.svg) | Mark and wordmark on light backgrounds |
| [img/brand/alba-logo-dark.svg](img/brand/alba-logo-dark.svg) | Mark and wordmark on dark backgrounds |

The console draws the same mark from `ui/src/components/brand/Logo.tsx`. Keep clear space of at least a quarter of the mark's width around it. Do not recolor, rotate or outline the mark, and do not put it on a busy image.

The Alba name and logo are not covered by the Apache-2.0 license; see [NOTICE](../NOTICE).

## Colors

| Name | Hex | Role |
|---|---|---|
| Night | `#14183A` | Tile, dark surfaces, text on light |
| Dusk | `#2B3170` | Tile edge, selected navigation in dark mode |
| Dawn | `#F5A524` | Sun, primary actions, "needs you" |
| Ember | `#F0785A` | Horizon line, chart accent |
| Paper | `#FAF3E6` | Letter A, light surfaces |

The console theme tokens live in `ui/src/index.css`. Stage colors carry meaning across every page: running is sky blue, needs you is dawn amber, waiting for review is dusk violet, merged is teal and failed is red. Chart series use `ui/src/lib/palette.ts`.

## Type

The interface uses the system sans-serif stack led by Inter, with a monospaced stack for tags, branches and logs. The wordmark is set lower case in the interface font at semibold weight. No web fonts are downloaded, so the console makes no third-party requests.
