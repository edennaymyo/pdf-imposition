import {
  cmyk, decodePDFRawStream, degrees, PDFArray, PDFDict, PDFDocument,
  PDFName, PDFRawStream, rgb,
} from 'pdf-lib';
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
const TRIMBOX_STROKE_POINTS = 0.25;
const TRIMBOX_CORNER_LENGTH_MM = 2;

const CONTENT_OPERATORS = new Set([
  'b', 'B', 'b*', 'B*', 'BDC', 'BI', 'BMC', 'BT', 'BX', 'c', 'cm', 'CS', 'cs',
  'd', 'd0', 'd1', 'Do', 'DP', 'EI', 'EMC', 'ET', 'EX', 'f', 'F', 'f*', 'G',
  'g', 'gs', 'h', 'i', 'ID', 'j', 'J', 'K', 'k', 'l', 'm', 'M', 'MP', 'n',
  'q', 'Q', 're', 'RG', 'rg', 'ri', 's', 'S', 'SC', 'SCN', 'sc', 'scn', 'sh',
  'Tc', 'Td', 'TD', 'Tf', 'Tj', 'TJ', 'TL', 'Tm', 'Tr', 'Ts', 'Tw', 'Tz',
  'v', 'w', 'W', 'W*', 'y', "'", '"',
]);
const PATH_OPERATORS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);

function tokenizeContentStream(content) {
  const tokens = [];
  const whitespace = /[\0\t\n\f\r ]/;
  const delimiter = /[\0\t\n\f\r ()<>\[\]{}/%]/;
  let index = 0;
  while (index < content.length) {
    const char = content[index];
    if (whitespace.test(char)) { index += 1; continue; }
    if (char === '%') {
      while (index < content.length && content[index] !== '\n' && content[index] !== '\r') index += 1;
      continue;
    }
    if (char === '(') {
      const start = index++;
      let depth = 1;
      while (index < content.length && depth > 0) {
        if (content[index] === '\\') { index += 2; continue; }
        if (content[index] === '(') depth += 1;
        if (content[index] === ')') depth -= 1;
        index += 1;
      }
      if (depth !== 0) return null;
      tokens.push(content.slice(start, index));
      continue;
    }
    if (char === '<') {
      const paired = content[index + 1] === '<';
      const closing = paired ? '>>' : '>';
      const start = index;
      index += paired ? 2 : 1;
      const end = content.indexOf(closing, index);
      if (end < 0) return null;
      index = end + closing.length;
      tokens.push(content.slice(start, index));
      continue;
    }
    if ('[]{}'.includes(char)) { tokens.push(char); index += 1; continue; }
    if (char === '/') {
      const start = index++;
      while (index < content.length && !delimiter.test(content[index])) index += 1;
      tokens.push(content.slice(start, index));
      continue;
    }
    const start = index++;
    while (index < content.length && !delimiter.test(content[index])) index += 1;
    tokens.push(content.slice(start, index));
  }
  return tokens;
}

// Adobe and other prepress tools normally draw crop marks with the PDF
// Registration color (/Separation /All). Remove only pure stroked paths using
// that color; fills, images, ordinary black strokes and all bleed artwork stay.
export function stripRegistrationColorStrokes(content, registrationColorSpaces) {
  if (!registrationColorSpaces?.size) return content;
  const tokens = tokenizeContentStream(content);
  if (!tokens || tokens.includes('BI')) return content;
  const output = [];
  const operands = [];
  let strokeColorSpace = null;
  const graphicsStack = [];
  let path = null;
  let removed = false;
  const write = operation => output.push(...operation);
  for (const token of tokens) {
    if (!CONTENT_OPERATORS.has(token)) { operands.push(token); continue; }
    const operation = [...operands, token];
    operands.length = 0;
    if (token === 'q') graphicsStack.push(strokeColorSpace);
    if (token === 'Q') strokeColorSpace = graphicsStack.pop() ?? null;
    if (token === 'CS') strokeColorSpace = operation.at(-2) || null;
    if (PATH_OPERATORS.has(token)) {
      if (!path) path = [];
      path.push(...operation);
      continue;
    }
    if (path) {
      if ((token === 'S' || token === 's') && registrationColorSpaces.has(strokeColorSpace)) {
        path = null;
        removed = true;
        continue;
      }
      if (token === 'n') { path = null; continue; }
      path.push(...operation);
      if (['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(token)) {
        write(path);
        path = null;
      }
      continue;
    }
    write(operation);
  }
  if (path) write(path);
  write(operands);
  return removed ? `${output.join(' ')}\n` : content;
}

function binaryString(bytes) {
  let output = '';
  for (let index = 0; index < bytes.length; index += 1) output += String.fromCharCode(bytes[index]);
  return output;
}

function binaryBytes(value) {
  return Uint8Array.from(value, char => char.charCodeAt(0) & 255);
}

function registrationColorSpaceNames(page, document) {
  const resources = page.node.Resources();
  const colorSpacesEntry = resources?.get(PDFName.of('ColorSpace'));
  const colorSpaces = colorSpacesEntry ? document.context.lookup(colorSpacesEntry) : null;
  if (!(colorSpaces instanceof PDFDict)) return new Set();
  const names = new Set();
  for (const [name, reference] of colorSpaces.entries()) {
    const definition = document.context.lookup(reference);
    if (!(definition instanceof PDFArray) || definition.size() < 2) continue;
    const family = document.context.lookup(definition.get(0));
    const colorant = document.context.lookup(definition.get(1));
    if (family instanceof PDFName && colorant instanceof PDFName
      && family.toString() === '/Separation' && colorant.toString() === '/All') names.add(name.toString());
  }
  return names;
}

function removeSourceRegistrationMarks(document) {
  for (const page of document.getPages()) {
    const names = registrationColorSpaceNames(page, document);
    if (!names.size) continue;
    const contentsEntry = page.node.get(PDFName.of('Contents'));
    if (!contentsEntry) continue;
    const contents = document.context.lookup(contentsEntry);
    const streams = contents instanceof PDFArray
      ? contents.asArray().map(reference => document.context.lookup(reference))
      : [contents];
    if (!streams.every(stream => stream instanceof PDFRawStream)) continue;
    let changed = false;
    const sanitized = streams.map(stream => {
      const original = binaryString(decodePDFRawStream(stream).decode());
      const clean = stripRegistrationColorStrokes(original, names);
      if (clean !== original) changed = true;
      return clean;
    });
    if (!changed) continue;
    const stream = document.context.flateStream(binaryBytes(sanitized.join('\n')));
    page.node.set(PDFName.of('Contents'), document.context.register(stream));
  }
}

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
  // Keep the top-right finishing corner clear for barcode or registration hardware marks.
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

function trimBoxMarkColor(hex = '#ff00ff') {
  const normalized = hex.toLowerCase();
  if (normalized === '#000000') return cmyk(0, 0, 0, 1);
  if (normalized === '#00ffff') return cmyk(1, 0, 0, 0);
  if (normalized === '#ff00ff') return cmyk(0, 1, 0, 0);
  if (normalized === '#ffff00') return cmyk(0, 0, 1, 0);
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return cmyk(0, 1, 0, 0);
  const value = Number.parseInt(match[1], 16);
  return rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
}

function drawTrimBoxGuides(page, geometry, sheetHeight, color, style = 'corners') {
  const markColor = trimBoxMarkColor(color);
  for (const cell of geometry.cells) {
    const left = cell.x * POINTS_PER_MM;
    const bottom = (sheetHeight - cell.y - geometry.itemH) * POINTS_PER_MM;
    const width = geometry.itemW * POINTS_PER_MM;
    const height = geometry.itemH * POINTS_PER_MM;
    if (style === 'outline') {
      page.drawRectangle({
        x: left, y: bottom, width, height,
        borderColor: markColor,
        borderWidth: TRIMBOX_STROKE_POINTS,
      });
      continue;
    }
    const right = left + width;
    const top = bottom + height;
    const arm = Math.min(TRIMBOX_CORNER_LENGTH_MM * POINTS_PER_MM, width / 2, height / 2);
    const line = (x1, y1, x2, y2) => page.drawLine({
      start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
      color: markColor, thickness: TRIMBOX_STROKE_POINTS,
    });
    line(left, top, left + arm, top); line(left, top, left, top - arm);
    line(right, top, right - arm, top); line(right, top, right, top - arm);
    line(left, bottom, left + arm, bottom); line(left, bottom, left, bottom + arm);
    line(right, bottom, right - arm, bottom); line(right, bottom, right, bottom + arm);
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

export function classifyPlacement(slotWidth, slotHeight, meta, rotation = 0) {
  const size = finishedSize(meta, rotation);
  const tolerance = 0.01;
  const oversized = size.width > slotWidth + tolerance || size.height > slotHeight + tolerance;
  const exact = !oversized && Math.abs(size.width - slotWidth) <= tolerance && Math.abs(size.height - slotHeight) <= tolerance;
  return {
    status: oversized ? 'oversized' : exact ? 'exact' : 'smaller',
    width: size.width,
    height: size.height,
    offsetX: Math.max(0, (slotWidth - size.width) / 2),
    offsetY: Math.max(0, (slotHeight - size.height) / 2),
  };
}

// Build an isolated, TrimBox-only proof for one slot. This intentionally does not
// crop the imposed sheet preview, avoiding adjacent artwork at fractional UI scales.
export async function buildPlacementPreviewPdf(input, slotWidth, slotHeight, rotation = 0) {
  if (!input?.file || !input?.meta || !Number.isInteger(input.pageIndex)) throw new Error('Choose artwork for this block.');
  const fit = classifyPlacement(slotWidth, slotHeight, input.meta, rotation);
  if (fit.status === 'oversized') throw new Error('This artwork is larger than the confirmed slot.');
  const source = await PDFDocument.load(await input.file.arrayBuffer(), { updateMetadata: false });
  removeSourceRegistrationMarks(source);
  const sourcePage = source.getPage(input.pageIndex);
  const trim = sourcePage.getTrimBox();
  const output = await PDFDocument.create();
  const page = output.addPage([slotWidth * POINTS_PER_MM, slotHeight * POINTS_PER_MM]);
  const embedded = await output.embedPage(sourcePage, {
    left: trim.x,
    bottom: trim.y,
    right: trim.x + trim.width,
    top: trim.y + trim.height,
  });
  drawEmbeddedArtwork(
    page,
    embedded,
    trim,
    { top: 0, bottom: 0, left: 0, right: 0 },
    rotation,
    fit.offsetX * POINTS_PER_MM,
    (slotHeight - fit.offsetY - fit.height) * POINTS_PER_MM,
  );
  return output.save({ useObjectStreams: false });
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
      const slotIndex = row * cols + col;
      const placements = isBack ? settings.mixedBackPlacements : settings.mixedPlacements;
      const placement = settings.fillMode === 'mixed' ? placements?.[slotIndex] : null;
      const empty = Boolean(placement?.empty);
      const sourceMeta = placement?.meta || meta;
      const angle = placement && !empty ? placement.rotation ?? 0 : cellRotation(baseRotation, rotationPattern, row, col);
      const fit = empty ? { status: 'empty', width: 0, height: 0 } : classifyPlacement(itemW, itemH, sourceMeta, angle);
      if (fit.status === 'oversized') throw new Error(`Artwork in slot ${slotIndex + 1} is larger than the confirmed item size.`);
      const availability = empty ? { top: 0, bottom: 0, left: 0, right: 0 } : outputBleedAvailability(sourceMeta, angle);
      if (destRow === 0) outer.top = Math.min(outer.top, availability.top);
      if (destRow === rows - 1) outer.bottom = Math.min(outer.bottom, availability.bottom);
      if (destCol === 0) outer.left = Math.min(outer.left, availability.left);
      if (destCol === cols - 1) outer.right = Math.min(outer.right, availability.right);
      const cellX = x + destCol * (itemW + gutterSlit);
      const cellY = y + destRow * (itemH + gutterCut);
      cells.push({ row: destRow, col: destCol, partnerRow: row, partnerCol: col, slotIndex,
        rotation: angle, sourceMeta, placementStatus: fit.status, empty,
        x: cellX, y: cellY, artX: cellX + (itemW - fit.width) / 2, artY: cellY + (itemH - fit.height) / 2,
        artW: fit.width, artH: fit.height });
    }
    for (const cell of cells) {
      const desiredOutputBleed = {
        top: cell.row === 0 ? outer.top : gutterCut / 2,
        bottom: cell.row === rows - 1 ? outer.bottom : gutterCut / 2,
        left: cell.col === 0 ? outer.left : gutterSlit / 2,
        right: cell.col === cols - 1 ? outer.right : gutterSlit / 2,
      };
      cell.bleed = cell.empty ? { top: 0, bottom: 0, left: 0, right: 0 } : sourceBleedsForOutput(cell.sourceMeta, cell.rotation, desiredOutputBleed);
    }
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
    const outputPage = output.addPage([settings.sheetW * POINTS_PER_MM, settings.sheetH * POINTS_PER_MM]);
    const embeddedByInput = new Map();
    for (const cell of geometry.cells) {
      const defaultInput = geometry.side === 'front' ? front : back;
      const placements = geometry.side === 'back' ? settings.mixedBackPlacements : settings.mixedPlacements;
      const placement = settings.fillMode === 'mixed' ? placements?.[cell.slotIndex] : null;
      if (placement?.empty) continue;
      const input = placement || defaultInput;
      let source = documents.get(input.file);
      if (!source) {
        source = await PDFDocument.load(await input.file.arrayBuffer(), { updateMetadata: false });
        removeSourceRegistrationMarks(source);
        documents.set(input.file, source);
      }
      const sourcePage = source.getPage(input.pageIndex);
      const trim = sourcePage.getTrimBox();
      const bleed = cell.bleed;
      let fileEmbeds = embeddedByInput.get(input.file);
      if (!fileEmbeds) { fileEmbeds = new Map(); embeddedByInput.set(input.file, fileEmbeds); }
      const cropKey = `${input.pageIndex}:${JSON.stringify(bleed)}`;
      let embedded = fileEmbeds.get(cropKey);
      if (!embedded) {
        embedded = await output.embedPage(sourcePage, {
          left: trim.x - bleed.left, bottom: trim.y - bleed.bottom,
          right: trim.x + trim.width + bleed.right, top: trim.y + trim.height + bleed.top,
        });
        fileEmbeds.set(cropKey, embedded);
      }
      drawEmbeddedArtwork(outputPage, embedded, trim, bleed, cell.rotation,
        cell.artX * POINTS_PER_MM, (settings.sheetH - cell.artY - cell.artH) * POINTS_PER_MM);
    }
    if (settings.trimBoxOutline && settings.trimBoxOutput === 'export') {
      drawTrimBoxGuides(outputPage, geometry, settings.sheetH, settings.trimBoxColor, settings.trimBoxStyle);
    }
    const finishingMarkOnSide = finishingOnSide(geometry.side, settings);
    const barcodeOnSide = Boolean(settings.barcodeFile) && finishingMarkOnSide;
    const registrationMarkOnSide = Boolean(settings.duploRegMark) && finishingMarkOnSide;
    if (settings.marks) drawProductionMarks(outputPage, {
      x: geometry.x * POINTS_PER_MM, y: (settings.sheetH - geometry.y - geometry.height) * POINTS_PER_MM,
      itemWidth: geometry.itemW * POINTS_PER_MM, itemHeight: geometry.itemH * POINTS_PER_MM,
      layoutWidth: geometry.width * POINTS_PER_MM, layoutHeight: geometry.height * POINTS_PER_MM,
      cols: settings.cols, rows: settings.rows,
      gutterCut: settings.gutterCut * POINTS_PER_MM, gutterSlit: settings.gutterSlit * POINTS_PER_MM,
    }, barcodeOnSide || registrationMarkOnSide);
    if (finishingMarkOnSide) {
      if (registrationMarkOnSide) drawDuploRegistrationMark(outputPage);
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
