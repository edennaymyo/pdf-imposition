import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, rgb } from 'pdf-lib';
import { planJob, buildJobPdf, extractOutputSide, barcodeCollisions, outputBleedAvailability, classifyPlacement, stripRegistrationColorStrokes } from '../src/pdf-engine.js';

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

test('mixed artwork keeps the master slot and centers smaller finished artwork without scaling', () => {
  const smaller = { ...front, width: 60, height: 30 };
  const settings = { ...defaults, duplex: false, fillMode: 'mixed', mixedPlacements: {
    1: { meta: smaller, pageIndex: 0, rotation: 0 },
  } };
  const plan = planJob(front, null, settings);
  const cell = plan.sides[0].cells.find(item => item.slotIndex === 1);
  assert.equal(classifyPlacement(front.width, front.height, smaller).status, 'smaller');
  assert.equal(cell.placementStatus, 'smaller');
  near(cell.artX, cell.x + (front.width - smaller.width) / 2);
  near(cell.artY, cell.y + (front.height - smaller.height) / 2);
  assert.throws(() => planJob(front, null, { ...settings, mixedPlacements: { 0: { meta: { ...front, width: 100 }, rotation: 0 } } }), /larger/);
});

test('an empty mixed block keeps its slot geometry while removing printable artwork and bleed', () => {
  const baseline = planJob(front, null, { ...defaults, duplex: false, rows: 2, cols: 2, fillMode: 'mixed', mixedPlacements: {} });
  const plan = planJob(front, null, { ...defaults, duplex: false, rows: 2, cols: 2, fillMode: 'mixed', mixedPlacements: { 1: { empty: true } } });
  const baseCell = baseline.sides[0].cells.find(cell => cell.slotIndex === 1);
  const emptyCell = plan.sides[0].cells.find(cell => cell.slotIndex === 1);
  assert.equal(emptyCell.empty, true);
  assert.equal(emptyCell.placementStatus, 'empty');
  for (const property of ['x', 'y']) near(emptyCell[property], baseCell[property]);
  near(plan.sides[0].itemW, baseline.sides[0].itemW);
  near(plan.sides[0].itemH, baseline.sides[0].itemH);
  assert.deepEqual(emptyCell.bleed, { top: 0, bottom: 0, left: 0, right: 0 });
});

test('duplex mixed artwork keeps paired slot ids while allowing independent side rotation', () => {
  const frontPlacement = { meta: front, pageIndex: 1, rotation: 180 };
  const backPlacement = { meta: back, pageIndex: 2, rotation: 180 };
  const plan = planJob(front, back, { ...defaults, rows: 2, cols: 2, fillMode: 'mixed',
    mixedPlacements: { 1: frontPlacement }, mixedBackPlacements: { 1: backPlacement } });
  const frontCell = plan.sides[0].cells.find(cell => cell.slotIndex === 1);
  const backCell = plan.sides[1].cells.find(cell => cell.slotIndex === 1);
  assert.equal(frontCell.rotation, 180);
  assert.equal(backCell.rotation, 180);
  assert.equal(frontCell.slotIndex, backCell.slotIndex);
  near(backCell.artW, back.width);
  near(backCell.artH, back.height);
  near(backCell.artX, backCell.x);
});

test('preview zoom metadata cannot alter print geometry or artwork ratio', () => {
  const basePlacement = { meta: front, pageIndex: 0, rotation: 0 };
  const baseline = planJob(front, back, { ...defaults, rows: 1, cols: 1, fillMode: 'mixed', mixedPlacements: { 0: basePlacement } });
  const attemptedZoom = planJob(front, back, { ...defaults, rows: 1, cols: 1, fillMode: 'mixed', mixedPlacements: { 0: { ...basePlacement, zoom: 2 } } });
  const baseCell = baseline.sides[0].cells[0];
  const zoomCell = attemptedZoom.sides[0].cells[0];
  for (const property of ['artX', 'artY', 'artW', 'artH']) near(zoomCell[property], baseCell[property]);
  near(zoomCell.artW / zoomCell.artH, front.width / front.height);
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

test('registration-color crop marks are removed while source bleed artwork is preserved', async () => {
  const content = [
    '0 0 0 1 k',
    '24.496 24.496 269.007 161.007 re f',
    '/CS0 CS 0 SCN 0.25 w',
    'q 1 0 0 1 27 177 cm',
    '0 0 m -27 0 l 264 0 m 291 0 l 0 -144 m -27 -144 l 264 -144 m 291 -144 l S',
    'Q',
  ].join('\n');
  const clean = stripRegistrationColorStrokes(content, new Set(['/CS0']));
  assert.match(clean, /24\.496 24\.496 269\.007 161\.007 re f/);
  assert.doesNotMatch(clean, /-27 0 l/);

  const source = await PDFDocument.create();
  const mm = 72 / 25.4;
  const page = source.addPage([318, 210]);
  page.setTrimBox(33, 33, 252, 144);
  page.setBleedBox(24.496, 24.496, 269.007, 161.007);
  const tint = source.context.obj({ FunctionType: 2, Domain: [0, 1], C0: [1], C1: [0], N: 1 });
  const registration = source.context.obj([
    PDFName.of('Separation'), PDFName.of('All'), PDFName.of('DeviceGray'), tint,
  ]);
  const colorSpaces = source.context.obj({ CS0: registration });
  page.node.Resources().set(PDFName.of('ColorSpace'), colorSpaces);
  page.node.set(PDFName.of('Contents'), source.context.register(source.context.flateStream(content)));
  const file = new Blob([await source.save()]);
  const meta = { width: 252 / mm, height: 144 / mm, top: 3, bottom: 3, left: 3, right: 3 };
  const settings = { ...defaults, duplex: false, rows: 1, cols: 1, marks: false, duploRegMark: false };
  const output = await PDFDocument.load(await buildJobPdf({ file, meta, pageIndex: 0 }, null, settings));
  const xObjects = output.getPage(0).node.Resources().lookup(PDFName.of('XObject'), PDFDict);
  const embedded = output.context.lookup([...xObjects.entries()][0][1]);
  const embeddedContent = new TextDecoder().decode(decodePDFRawStream(embedded).decode());
  assert.match(embeddedContent, /269\.007 161\.007 re f/);
  assert.doesNotMatch(embeddedContent, /-27 0 l/);
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

  const smallDoc = await PDFDocument.create();
  const smallMeta = { width: 60, height: 30, top: 3, bottom: 3, left: 3, right: 3 };
  const smallPage = smallDoc.addPage([66 * mm, 36 * mm]);
  smallPage.setTrimBox(3 * mm, 3 * mm, smallMeta.width * mm, smallMeta.height * mm);
  smallPage.setBleedBox(0, 0, 66 * mm, 36 * mm);
  smallPage.drawRectangle({ x: 0, y: 0, width: 66 * mm, height: 36 * mm, color: rgb(0, 1, 0) });
  const smallFile = new Blob([await smallDoc.save()]);
  const mixed = await buildJobPdf({ file, meta, pageIndex: 0 }, null, {
    ...defaults, duplex: false, fillMode: 'mixed',
    mixedPlacements: { 1: { file: smallFile, meta: smallMeta, pageIndex: 0, rotation: 0 } },
  });
  assert.equal((await PDFDocument.load(mixed)).getPageCount(), 1);
  const empty = await buildJobPdf({ file, meta, pageIndex: 0 }, null, {
    ...defaults, duplex: false, rows: 1, cols: 1, fillMode: 'mixed', mixedPlacements: { 0: { empty: true } },
  });
  assert.equal((await PDFDocument.load(empty)).getPageCount(), 1);
});
