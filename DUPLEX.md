# Front / Back imposition (experimental)

Choose **Artwork > Job mode > Front & Back**. Select front and back pages from one PDF, or choose **Separate PDF file** for the back. Both sides must have the same finished size after their independent base rotations (tolerance 0.01 mm); no automatic scaling is performed.

## Preview and export

- **Both** shows both full sheets. **Front / Back** expands a single side.
- Preview images are rendered from the exact PDF bytes offered for download.
- Default paired export is Page 1 = Front, Page 2 = Back. Export pages can also select one side only, extracted from the same paired output.
- Pending/invalid input immediately invalidates the previous proof and export.
- Presets retain duplex mode, page selections, back source mode, rotations, flip and finishing side. Artwork files themselves are not saved; reselect them when starting another session.

## Physical alignment

All sheet, repeat and cut geometry comes from the front. Long-edge flip reflects back cell positions across sheet width. Short-edge flip reflects them across sheet height. This changes cell placement, not mirrored text. Back base rotation is independent; alternate-row/column/checkerboard rotations stay associated with each physical front card even when destination row/column order reverses.

Back Lead Trim and Side Trim are derived; the back must not be recentered independently using its own asymmetric bleed. Source bleed limits are evaluated independently on both sides after cell rotation. At zero gutter, internal bleed is zero; outer edges still use up to 3 mm of available bleed. Fit is checked for both sides.

Production trim marks are generated on both sides. Duplo barcode and registration mark default to Front; choose Back or Both according to the physical finishing-feed side. Barcode may overlap artwork without a warning or approval step; it stays on top with a white knockout background. Top-right corner trim marks are hidden on barcode sides and restored when barcode is off. Inadequate margins for full-length trim marks produce a warning.

## Before production

Print at **100% / Actual size** and match the printer driver's long-edge/short-edge setting. Do not also mirror or rotate the back in a RIP. Manually refed sheets depend on the printer's feed path. Confirm front/back cut-line alignment, reading direction, bleed, barcode readability and finishing-feed orientation with one test sheet before cutting a production run. Physical duplex registration accuracy and DC-616 machine operation are not certified by software tests.

## Developer verification

`npm test` covers both flip axes, all four rotations, all repeat patterns, centered/manual placement, zero/nonzero gutters, asymmetric bleed, mismatched and missing backs, fit rejection, finishing-side barcode collisions, output page count and dimensions, and single-sided export.

This feature is local to branch `feature/front-back-duplex`. It does not change the published v0.1.0 Windows installer until a new installer is built and released.
