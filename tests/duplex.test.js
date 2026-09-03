import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, rgb } from 'pdf-lib';
import { planJob, buildJobPdf, extractOutputSide, barcodeCollisions, outputBleedAvailability } from '../src/pdf-engine.js';

const front = { width: 88.9, height: 50.8, top: 3, bottom: 2.5, left: 1.5, right: 3 };
const back = { ...front, top: 1, bottom: 3, left: 3, right: 2 };
const defaults = { sheetW: 330.2, sheetH: 482.6, rows: 4, cols: 3, gutterCut: 5, gutterSlit: 5,
  topOffset: 15, sideTrim: 18, horizontalPlacement: 'center', rotation: 0, backRotation: 0,
  rotationPattern: 'same', duplex: true, flipEdge: 'long', marks: true, duploRegMark: true, finishingSide: 'front' };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('all rotations / patterns / flip axes keep physical front-back cut lines aligned', () => {
  for (const rotation of [0, 90, 180, 270]) for (const backRotation of [rotation, (rotation + 180) % 360])
    for (const rotationPattern of ['same', 'alternateRows', 'alternateColumns', 'checkerboard'])
      for (const flipEdge of ['long', 'short']) for (const gutter of [0, 5]) for (const horizontalPlacement of ['center', 'manual']) {
        const settings = { ...defaults, rows: 2, cols: 2, rotation, backRotation, rotationPattern, flipEdge, horizontalPlacement, gutterCut: gutter, gutterSlit: gutter };
        const plan = planJob(front, back, settings);
        assert.equal(plan.fits, true);
        const [f, b] = plan.sides;
        for (let i = 0; i < f.cells.length; i++) {
          const fc = f.cells[i], bc = b.cells[i];
          near(flipEdge === 'long' ? settings.sheetW - bc.x - b.itemW : bc.x, fc.x);
          near(flipEdge === 'short' ? settings.sheetH - bc.y - b.itemH : bc.y, fc.y);
          assert.equal((bc.rotation - fc.rotation + 360) % 360, (backRotation - rotation + 360) % 360);
          const availability = outputBleedAvailability(back, bc.rotation);
          for (const side of ['top', 'bottom', 'left', 'right']) assert.ok(b.outer[side] <= 3);
          if (bc.row === 0) assert.ok(b.outer.top <= availability.top);
          if (bc.col === 0) assert.ok(b.outer.left <= availability.left);
        }
      }
});

test('zero gutter leaves no internal bleed and keeps independent perimeter bleed', () => {
  const plan = planJob(front, back, { ...defaults, gutterCut: 0, gutterSlit: 0 });
  for (const side of plan.sides) for (const cell of side.cells) {
    if (cell.row > 0) assert.equal(cell.bleed.top, 0);
    if (cell.col > 0) assert.equal(cell.bleed.left, 0);
  }
  assert.notDeepEqual(plan.sides[0].outer, plan.sides[1].outer);
});

test('back does not independently recenter when its bleed differs', () => {
  const [f, b] = planJob(front, back, defaults).sides;
  near(defaults.sheetW - b.x - b.width, f.x);
});

test('mismatched / missing sides and fractional rows are rejected', () => {
  assert.throws(() => planJob(front, { ...back, width: 90 }, defaults), /sizes differ/);
  assert.throws(() => planJob(front, null, defaults), /back PDF/);
  assert.throws(() => planJob(front, back, { ...defaults, rows: 2.5 }), /Invalid/);
  assert.throws(() => planJob(front, back, { ...defaults, sheetW: 400 }), /portrait/);
  assert.equal(planJob(front, back, { ...defaults, rows: 25 }).fits, false);
});

test('quarter-turn back page matches landscape front without scaling', () => {
  const plan = planJob(front, { ...back, width: 50.8, height: 88.9 }, { ...defaults, backRotation: 90 });
  assert.equal(plan.fits, true);
});

test('back bleed overflow is caught even when front fits', () => {
  const f = { ...front, top: 1, bottom: 1 };
  const plan = planJob(f, back, { ...defaults, topOffset: 1, flipEdge: 'short' });
  assert.equal(plan.sides[0].fits, true);
  assert.equal(plan.sides[1].fits, false);
});

test('barcode collision checks only finishing sides, including reflected short-edge back', () => {
  const settings = { ...defaults, topOffset: 8, finishingSide: 'front' };
  let plan = planJob(front, back, settings);
  assert.deepEqual(barcodeCollisions(plan, { width: 35, height: 5 }, settings), ['front']);
  settings.finishingSide = 'both';
  plan = planJob(front, back, settings);
  assert.deepEqual(barcodeCollisions(plan, { width: 35, height: 5 }, settings), ['front', 'back']);
  settings.flipEdge = 'short';
  plan = planJob(front, back, settings);
  assert.deepEqual(barcodeCollisions(plan, { width: 35, height: 5 }, settings), ['front']);
});

test('PDF output: paired order, page dimensions, separate sides and single-sided regression', async () => {
  const doc = await PDFDocument.create();
  const mm = 72 / 25.4;
  for (const color of [rgb(1, 0, 0), rgb(0, 0, 1)]) {
    const page = doc.addPage([110 * mm, 75 * mm]);
    page.setTrimBox(10 * mm, 10 * mm, front.width * mm, front.height * mm);
    page.setBleedBox(7 * mm, 7 * mm, (front.width + 6) * mm, (front.height + 6) * mm);
    page.drawRectangle({ x: 7 * mm, y: 7 * mm, width: (front.width + 6) * mm, height: (front.height + 6) * mm, color });
  }
  const file = new Blob([await doc.save()]);
  const meta = { ...front, top: 3, bottom: 3, left: 3, right: 3 };
  const bytes = await buildJobPdf({ file, meta, pageIndex: 0 }, { file, meta, pageIndex: 1 }, defaults);
  const result = await PDFDocument.load(bytes);
  assert.equal(result.getPageCount(), 2);
  for (const page of result.getPages()) { near(page.getWidth(), 330.2 * mm); near(page.getHeight(), 482.6 * mm); }
  for (const index of [0, 1]) assert.equal((await PDFDocument.load(await extractOutputSide(bytes, index))).getPageCount(), 1);
  const single = await buildJobPdf({ file, meta, pageIndex: 0 }, null, { ...defaults, duplex: false });
  assert.equal((await PDFDocument.load(single)).getPageCount(), 1);
});
