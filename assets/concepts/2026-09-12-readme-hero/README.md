# README hero decision record

## Objective

Keep the approved BetterTTS composition and remove the stale release label from the interface screenshot. The final hero must stay evergreen, use the selected ribbon-wave identity, and show the real product clearly at repository width.

## Candidates

| File | Decision | Reason |
|---|---|---|
| `original-version-bearing.png` | Preserve as source | Strong composition and product story, but the interface included a release label. |
| `automated-edit-r1-rejected.png` | Rejected | Changed the canvas size, product framing, and interface details. |
| `automated-edit-r2-rejected.png` | Rejected | Changed the canvas size and redrew product details despite stricter preservation instructions. |
| `final-selected.png` | Selected | Keeps the original 1280 by 640 composition and changes only the 37 by 18 pixel label area. |

## Edit briefs

### First attempt

Edit the supplied BetterTTS marketing hero. Remove only the tiny release label in the upper-right area of the product screenshot. Preserve every other pixel, including the 1280 by 640 canvas, logo, typography, colors, spacing, interface, crop, and copy. Do not add text or a release number.

### Second attempt

Use the supplied hero as a locked source image. Make one inpainting change only: remove the small release label from the upper-right of the interface screenshot and continue the surrounding dark panel background. Do not redraw, resize, reframe, restyle, sharpen, or reinterpret any other part of the image. Keep all existing words, controls, spacing, colors, and dimensions exactly unchanged. Do not add a version number.

## Final repair

The generated attempts did not preserve the approved design. The selected file copies a clean 40 by 18 pixel sample from the same header row over the release label. A pixel comparison confines the changed area to 37 by 18 pixels at x 1199, y 119.

## Verification captures

`source-final-comparison.png` and `source-final-detail-comparison.png` record the same-viewport review. `readme-desktop-final.png` and `readme-mobile-final.png` show the completed README at wide and narrow viewports. `app-current/` contains the nine current product surfaces from the v0.25.2 smoke run. The four README product screenshots were refreshed from those captures.
