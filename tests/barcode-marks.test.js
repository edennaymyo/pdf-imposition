import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFArray, decodePDFRawStream, rgb } from 'pdf-lib';
import { buildJobPdf } from '../src/pdf-engine.js';

// Inspect the actual exported page operators, not only the layout model.
function content(page) {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i)) : [contents];
  return streams.map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join('\n');
}
function lines(page) {
  return [...content(page).matchAll(/([-\d.]+) ([-\d.]+) m\s+([-\d.]+) ([-\d.]+) l\s+S/g)].map(match => match.slice(1).map(Number));
}

test('barcode on hides exactly the top-right corner on barcode sides; off restores all marks', async () => {
  const mm = 72 / 25.4;
  const source = await PDFDocument.create();
  const page = source.addPage([96 * mm, 58 * mm]);
  page.setTrimBox(3 * mm, 3 * mm, 90 * mm, 52 * mm);
  page.drawRectangle({ x: 0, y: 0, width: 96 * mm, height: 58 * mm, color: rgb(1, .5, 0) });
  const artwork = { file: new Blob([await source.save()]), pageIndex: 0,
    meta: { width: 90, height: 52, top: 3, bottom: 3, left: 3, right: 3 } };
  const barcode = await PDFDocument.create();
  barcode.addPage([30 * mm, 5 * mm]).drawRectangle({ x: 4, y: 0, width: 1, height: 10, color: rgb(0, 0, 0) });
  const barcodeFile = new Blob([await barcode.save()]);
  for (const duplex of [false, true]) for (const finishingSide of ['front', 'back', 'both'])
    for (const flipEdge of ['long', 'short']) for (const gutter of [0, 5]) {
      const settings = { sheetW: 330.2, sheetH: 482.6, rows: 3, cols: 3,
        gutterCut: gutter, gutterSlit: gutter, topOffset: 25, sideTrim: 18,
        horizontalPlacement: 'center', rotation: 0, backRotation: 0, rotationPattern: 'same',
        duplex, flipEdge, marks: true, duploRegMark: true, finishingSide };
      const render = async extra => (await PDFDocument.load(await buildJobPdf(artwork, duplex ? artwork : null, { ...settings, ...extra }))).getPages();
      const off = await render({ barcodeFile: null });
      const on = await render({ barcodeFile });
      const restored = await render({ barcodeFile: null });
      const noMarks = await render({ barcodeFile, marks: false });
      for (let i = 0; i < off.length; i++) {
        const baseline = lines(off[i]);
        assert.equal(baseline.length, gutter ? 24 : 16);
        const onThisSide = !duplex || finishingSide === 'both' || finishingSide === (i ? 'back' : 'front');
        // Four corners come first: top-right is segments 6 and 7. Gutters must stay intact.
        assert.deepEqual(lines(on[i]), onThisSide ? baseline.filter((_, n) => n !== 6 && n !== 7) : baseline);
        assert.deepEqual(lines(restored[i]), baseline);
        assert.deepEqual(lines(noMarks[i]), []);
        // The registration L's two filled rectangles stay present on the finishing side.
        const fills = text => (text.match(/\nf\n/g) || []).length;
        assert.equal(fills(content(off[i])), onThisSide ? 2 : 0);
        assert.equal(fills(content(on[i])), onThisSide ? 3 : 0); // + white barcode knockout
      }
    }
});
