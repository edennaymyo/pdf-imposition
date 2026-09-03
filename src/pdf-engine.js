import { degrees, PDFDocument, rgb } from 'pdf-lib';
const MM_PER_POINT = 25.4 / 72;
const POINTS_PER_MM = 72 / 25.4;
const MIN_SHEET_MM = 210;
const MAX_SHEET_WIDTH_MM = 330.2;
const MAX_SHEET_HEIGHT_MM = 482.6;
const MARK_OFFSET_MM = 3;
const MARK_LENGTH_MM = 4;
const OUTER_BLEED_MM = 3;
const DUPLO_REG_INSET_MM = 5;
const DUPLO_REG_LENGTH_MM = 5;
const DUPLO_REG_THICKNESS_MM = 0.4;
const BARCODE_TOP_OFFSET_MM = 4;
const BARCODE_RIGHT_OFFSET_MM = 25;
const BARCODE_HEIGHT_MM = 5;
const BARCODE_KNOCKOUT_PADDING_MM = 0.5;

function sourceToOutputSides(rotation) {
  if (rotation === 90) return { top: 'left', bottom: 'right', left: 'bottom', right: 'top' };
  if (rotation === 180) return { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  if (rotation === 270) return { top: 'right', bottom: 'left', left: 'top', right: 'bottom' };
  return { top: 'top', bottom: 'bottom', left: 'left', right: 'right' };
}

function outputBleedAvailability(meta, rotation) {
  const mapping = sourceToOutputSides(rotation);
  const output = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const sourceSide of Object.keys(mapping)) output[mapping[sourceSide]] = meta[sourceSide];
  return output;
}

function cellRotation(baseRotation, rotationPattern, row, col) {
  const flip = rotationPattern === 'alternateRows'
    ? row % 2 === 1
    : rotationPattern === 'alternateColumns'
      ? col % 2 === 1
      : rotationPattern === 'checkerboard'
        ? (row + col) % 2 === 1
        : false;
  return (baseRotation + (flip ? 180 : 0)) % 360;
}

function calculateOuterBleed(meta, baseRotation, rotationPattern, rows, cols) {
  if (!meta) return { top: OUTER_BLEED_MM, bottom: OUTER_BLEED_MM, left: OUTER_BLEED_MM, right: OUTER_BLEED_MM };
  const outer = { top: OUTER_BLEED_MM, bottom: OUTER_BLEED_MM, left: OUTER_BLEED_MM, right: OUTER_BLEED_MM };
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (row !== 0 && row !== rows - 1 && col !== 0 && col !== cols - 1) continue;
      const availability = outputBleedAvailability(meta, cellRotation(baseRotation, rotationPattern, row, col));
      if (row === 0) outer.top = Math.min(outer.top, availability.top);
      if (row === rows - 1) outer.bottom = Math.min(outer.bottom, availability.bottom);
      if (col === 0) outer.left = Math.min(outer.left, availability.left);
      if (col === cols - 1) outer.right = Math.min(outer.right, availability.right);
    }
  }
  return outer;
}

function sourceBleedsForOutput(meta, rotation, desiredOutputBleed) {
  const mapping = sourceToOutputSides(rotation);
  return Object.fromEntries(Object.entries(mapping).map(([sourceSide, outputSide]) => [
    sourceSide,
    Math.min(meta[sourceSide], desiredOutputBleed[outputSide]) * POINTS_PER_MM,
  ]));
}

function drawEmbeddedArtwork(page, embedded, trim, bleed, rotation, trimX, trimY) {
  const width = trim.width + bleed.left + bleed.right;
  const height = trim.height + bleed.top + bleed.bottom;
  const options = { width, height, rotate: degrees(rotation) };
  if (rotation === 90) {
    page.drawPage(embedded, { ...options, x: trimX + bleed.bottom + trim.height, y: trimY - bleed.left });
  } else if (rotation === 180) {
    page.drawPage(embedded, { ...options, x: trimX + bleed.left + trim.width, y: trimY + bleed.bottom + trim.height });
  } else if (rotation === 270) {
    page.drawPage(embedded, { ...options, x: trimX - bleed.bottom, y: trimY + bleed.left + trim.width });
  } else {
    page.drawPage(embedded, { ...options, x: trimX - bleed.left, y: trimY - bleed.bottom });
  }
}

function drawProductionMarks(page, geometry, hideTopRight = false) {
  const { x, y, itemWidth, itemHeight, layoutWidth, layoutHeight, cols, rows, gutterCut, gutterSlit } = geometry;
  const gap = MARK_OFFSET_MM * POINTS_PER_MM;
  const length = MARK_LENGTH_MM * POINTS_PER_MM;
  const style = { thickness: 0.45, color: rgb(0, 0, 0) };
  const line = (x1, y1, x2, y2) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, ...style });
  const top = y + layoutHeight;
  const right = x + layoutWidth;

  // Four outside corner trim marks.
  line(x - gap - length, y, x - gap, y); line(x, y - gap - length, x, y - gap);
  line(right + gap, y, right + gap + length, y); line(right, y - gap - length, right, y - gap);
  line(x - gap - length, top, x - gap, top); line(x, top + gap, x, top + gap + length);
  // Keep the barcode corner clear even when these marks do not intersect the barcode.
  // This is a scanner-clearance rule, not an artwork-collision rule.
  if (!hideTopRight) {
    line(right + gap, top, right + gap + length, top); line(right, top + gap, right, top + gap + length);
  }

  // Slit marks: both finished edges of every vertical gutter, above and below the artwork group.
  for (let col = 1; col < cols; col += 1) {
    const leftEdge = x + col * itemWidth + (col - 1) * gutterSlit;
    const rightEdge = leftEdge + gutterSlit;
    const slitPositions = gutterSlit === 0 ? [leftEdge] : [leftEdge, rightEdge];
    for (const slitX of slitPositions) {
      line(slitX, y - gap - length, slitX, y - gap);
      line(slitX, top + gap, slitX, top + gap + length);
    }
  }

  // Cut marks: both finished edges of every horizontal gutter, left and right of the artwork group.
  for (let row = 1; row < rows; row += 1) {
    const upperBottom = top - row * itemHeight - (row - 1) * gutterCut;
    const lowerTop = upperBottom - gutterCut;
    const cutPositions = gutterCut === 0 ? [upperBottom] : [upperBottom, lowerTop];
    for (const cutY of cutPositions) {
      line(x - gap - length, cutY, x - gap, cutY);
      line(right + gap, cutY, right + gap + length, cutY);
    }
  }
}

function drawDuploRegistrationMark(page) {
  const inset = DUPLO_REG_INSET_MM * POINTS_PER_MM;
  const length = DUPLO_REG_LENGTH_MM * POINTS_PER_MM;
  const thickness = DUPLO_REG_THICKNESS_MM * POINTS_PER_MM;
  const cornerX = page.getWidth() - inset;
  const cornerY = page.getHeight() - inset;
  const color = rgb(0, 0, 0);

  // L mark bounding box stays exactly 5 mm from the sheet's top and right edges.
  page.drawRectangle({ x: cornerX - length, y: cornerY - thickness, width: length, height: thickness, color });
  page.drawRectangle({ x: cornerX - thickness, y: cornerY - length, width: thickness, height: length, color });
}

async function drawJobBarcode(output, outputPage, barcodeFile) {
  if (!barcodeFile) return;
  const barcodeDocument = await PDFDocument.load(await barcodeFile.arrayBuffer(), { updateMetadata: false });
  const barcodePage = barcodeDocument.getPage(0);
  const crop = barcodePage.getCropBox();
  const targetHeight = Math.min(crop.height, BARCODE_HEIGHT_MM * POINTS_PER_MM);
  const croppedBottom = crop.y + crop.height - targetHeight;
  const embedded = await output.embedPage(barcodePage, {
    left: crop.x,
    bottom: croppedBottom,
    right: crop.x + crop.width,
    top: crop.y + crop.height,
  });
  const x = outputPage.getWidth() - BARCODE_RIGHT_OFFSET_MM * POINTS_PER_MM - crop.width;
  const y = outputPage.getHeight() - BARCODE_TOP_OFFSET_MM * POINTS_PER_MM - targetHeight;
  const knockoutPadding = BARCODE_KNOCKOUT_PADDING_MM * POINTS_PER_MM;
  outputPage.drawRectangle({
    x: x - knockoutPadding,
    y: y - knockoutPadding,
    width: crop.width + knockoutPadding * 2,
    height: targetHeight + knockoutPadding * 2,
    color: rgb(1, 1, 1),
  });
  outputPage.drawPage(embedded, {
    x,
    y,
    width: crop.width,
    height: targetHeight,
  });
}

async function inspectBarcode(file) {
  const document = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
  const crop = document.getPage(0).getCropBox();
  return {
    width: crop.width * MM_PER_POINT,
    height: Math.min(crop.height * MM_PER_POINT, BARCODE_HEIGHT_MM),
    originalHeight: crop.height * MM_PER_POINT,
  };
}



export function finishedSize(meta, rotation) {
  const quarter = rotation === 90 || rotation === 270;
  return { width: quarter ? meta.height : meta.width, height: quarter ? meta.width : meta.height };
}

// All plan coordinates are millimetres measured from the top-left of a PDF sheet.
// Reflect positions, never glyphs/images. Each back cell retains its front partner's pattern.
export function planJob(front, back, settings) {
  const { sheetW, sheetH, cols, rows, gutterCut, gutterSlit, topOffset,
    horizontalPlacement, sideTrim, rotation, rotationPattern, duplex, flipEdge, backRotation } = settings;
  if (![sheetW, sheetH, gutterCut, gutterSlit, topOffset, sideTrim].every(Number.isFinite)
      || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 25 || rows > 25
      || gutterCut < 0 || gutterSlit < 0 || topOffset < 0 || sideTrim < 0) throw new Error('Invalid sheet or repeat settings.');
  if (![0, 90, 180, 270].includes(rotation) || !ROTATION_VALUES.includes(rotationPattern))
    throw new Error('Invalid rotation settings.');
  if (sheetW < MIN_SHEET_MM || sheetH < MIN_SHEET_MM || sheetW > MAX_SHEET_WIDTH_MM || sheetH > MAX_SHEET_HEIGHT_MM || sheetW > sheetH)
    throw new Error('Use a portrait sheet between 210 mm and 13 × 19 in.');
  if (!front) throw new Error('Upload the front PDF.');
  const { width: itemW, height: itemH } = finishedSize(front, rotation);
  if (!(itemW > 0 && itemH > 0)) throw new Error('The finished size must be positive.');
  if (duplex) {
    if (!back) throw new Error('Choose a back PDF and page.');
    if (!['long', 'short'].includes(flipEdge) || ![0, 90, 180, 270].includes(backRotation))
      throw new Error('Choose a valid duplex flip and back rotation.');
    const size = finishedSize(back, backRotation);
    if (Math.abs(itemW - size.width) > 0.01 || Math.abs(itemH - size.height) > 0.01)
      throw new Error('Front / Back finished sizes differ. Choose matching pages or adjust back rotation; artwork is never stretched.');
  }
  const width = cols * itemW + (cols - 1) * gutterSlit;
  const height = rows * itemH + (rows - 1) * gutterCut;
  const frontOuter = calculateOuterBleed(front, rotation, rotationPattern, rows, cols);
  const left = horizontalPlacement === 'manual'
    ? sheetW - sideTrim - width
    : (sheetW - width - frontOuter.left - frontOuter.right) / 2 + frontOuter.left;

  const sides = (duplex ? ['front', 'back'] : ['front']).map(side => {
    const isBack = side === 'back';
    const meta = isBack ? back : front;
    const baseRotation = isBack ? backRotation : rotation;
    const x = isBack && flipEdge === 'long' ? sheetW - left - width : left;
    const y = isBack && flipEdge === 'short' ? sheetH - topOffset - height : topOffset;
    const outer = { top: 3, bottom: 3, left: 3, right: 3 };
    const cells = [];
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const destRow = isBack && flipEdge === 'short' ? rows - 1 - row : row;
      const destCol = isBack && flipEdge === 'long' ? cols - 1 - col : col;
      const angle = cellRotation(baseRotation, rotationPattern, row, col);
      const availability = outputBleedAvailability(meta, angle);
      if (destRow === 0) outer.top = Math.min(outer.top, availability.top);
      if (destRow === rows - 1) outer.bottom = Math.min(outer.bottom, availability.bottom);
      if (destCol === 0) outer.left = Math.min(outer.left, availability.left);
      if (destCol === cols - 1) outer.right = Math.min(outer.right, availability.right);
      cells.push({ row: destRow, col: destCol, partnerRow: row, partnerCol: col,
        rotation: angle, x: x + destCol * (itemW + gutterSlit), y: y + destRow * (itemH + gutterCut) });
    }
    for (const cell of cells) cell.bleed = sourceBleedsForOutput(meta, cell.rotation, {
      top: cell.row === 0 ? outer.top : gutterCut / 2,
      bottom: cell.row === rows - 1 ? outer.bottom : gutterCut / 2,
      left: cell.col === 0 ? outer.left : gutterSlit / 2,
      right: cell.col === cols - 1 ? outer.right : gutterSlit / 2,
    });
    const fits = x - outer.left >= -0.001 && x + width + outer.right <= sheetW + 0.001
      && y - outer.top >= -0.001 && y + height + outer.bottom <= sheetH + 0.001;
    const marksOnSheet = !settings.marks || (x >= MARK_OFFSET_MM + MARK_LENGTH_MM
      && y >= MARK_OFFSET_MM + MARK_LENGTH_MM
      && sheetW - x - width >= MARK_OFFSET_MM + MARK_LENGTH_MM
      && sheetH - y - height >= MARK_OFFSET_MM + MARK_LENGTH_MM);
    return { side, x, y, width, height, itemW, itemH, outer, cells, fits, marksOnSheet };
  });
  return { sides, fits: sides.every(side => side.fits), itemW, itemH };
}
const ROTATION_VALUES = ['same', 'alternateRows', 'alternateColumns', 'checkerboard'];

export function finishingOnSide(side, settings) {
  return !settings.duplex || settings.finishingSide === 'both' || settings.finishingSide === side;
}

export function barcodeCollisions(plan, barcodeMeta, settings) {
  if (!barcodeMeta) return [];
  const x = settings.sheetW - BARCODE_RIGHT_OFFSET_MM - barcodeMeta.width;
  const y = BARCODE_TOP_OFFSET_MM;
  const padding = BARCODE_KNOCKOUT_PADDING_MM;
  return plan.sides.filter(side => finishingOnSide(side.side, settings)
    && x + barcodeMeta.width + padding > side.x - side.outer.left
    && x - padding < side.x + side.width + side.outer.right
    && y + barcodeMeta.height + padding > side.y - side.outer.top
    && y - padding < side.y + side.height + side.outer.bottom).map(side => side.side);
}

export async function buildJobPdf(front, back, settings) {
  const plan = planJob(front.meta, back?.meta, settings);
  if (!plan.fits) throw new Error('Front or Back artwork / bleed does not fit the sheet.');
  const output = await PDFDocument.create();
  // A single output owns both pages; preview and export consume these exact bytes.
  const documents = new Map();
  for (const geometry of plan.sides) {
    const input = geometry.side === 'front' ? front : back;
    let source = documents.get(input.file);
    if (!source) {
      source = await PDFDocument.load(await input.file.arrayBuffer(), { updateMetadata: false });
      documents.set(input.file, source);
    }
    const sourcePage = source.getPage(input.pageIndex);
    const trim = sourcePage.getTrimBox();
    const outputPage = output.addPage([settings.sheetW * POINTS_PER_MM, settings.sheetH * POINTS_PER_MM]);
    const embeddedByCrop = new Map();
    for (const cell of geometry.cells) {
      const bleed = cell.bleed;
      const cropKey = JSON.stringify(bleed);
      let embedded = embeddedByCrop.get(cropKey);
      if (!embedded) {
        embedded = await output.embedPage(sourcePage, {
          left: trim.x - bleed.left, bottom: trim.y - bleed.bottom,
          right: trim.x + trim.width + bleed.right, top: trim.y + trim.height + bleed.top,
        });
        embeddedByCrop.set(cropKey, embedded);
      }
      drawEmbeddedArtwork(outputPage, embedded, trim, bleed, cell.rotation,
        cell.x * POINTS_PER_MM, (settings.sheetH - cell.y - geometry.itemH) * POINTS_PER_MM);
    }
    const barcodeOnSide = Boolean(settings.barcodeFile) && finishingOnSide(geometry.side, settings);
    if (settings.marks) drawProductionMarks(outputPage, {
      x: geometry.x * POINTS_PER_MM, y: (settings.sheetH - geometry.y - geometry.height) * POINTS_PER_MM,
      itemWidth: geometry.itemW * POINTS_PER_MM, itemHeight: geometry.itemH * POINTS_PER_MM,
      layoutWidth: geometry.width * POINTS_PER_MM, layoutHeight: geometry.height * POINTS_PER_MM,
      cols: settings.cols, rows: settings.rows,
      gutterCut: settings.gutterCut * POINTS_PER_MM, gutterSlit: settings.gutterSlit * POINTS_PER_MM,
    }, barcodeOnSide);
    if (finishingOnSide(geometry.side, settings)) {
      if (settings.duploRegMark) drawDuploRegistrationMark(outputPage);
      if (settings.barcodeFile) await drawJobBarcode(output, outputPage, settings.barcodeFile);
    }
  }
  return output.save();
}

export async function extractOutputSide(bytes, pageIndex) {
  const source = await PDFDocument.load(bytes);
  const result = await PDFDocument.create();
  const [page] = await result.copyPages(source, [pageIndex]);
  result.addPage(page);
  return result.save();
}
export { calculateOuterBleed, inspectBarcode, cellRotation, outputBleedAvailability };
