import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, CheckCircle2, Download, FileUp, FolderOpen, Minus, Plus, Save, Settings2, Trash2, X } from 'lucide-react';
import { degrees, PDFDocument, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import './styles.css';
import './duplo.css';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

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
const STORAGE_DB_NAME = 'duplo-imposition-storage';
const STORAGE_DB_VERSION = 1;
const STORAGE_STORE_NAME = 'handles';
const BARCODE_DIRECTORY_KEY = 'barcode-directory';
const PRESET_STORAGE_KEY = 'duplo-imposition-presets-v1';

const ROTATION_PATTERNS = [
  { value: 'same', label: 'Same rotation' },
  { value: 'alternateRows', label: 'Alternate rows 180°' },
  { value: 'alternateColumns', label: 'Alternate columns 180°' },
  { value: 'checkerboard', label: 'Checkerboard 180°' },
];

const SAMPLE_COLORS = ['#d95d39', '#3460d8', '#edbd37', '#5c9f70', '#a8568b', '#2b9090'];

const numberValue = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

function openStorageDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORAGE_DB_NAME, STORAGE_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORAGE_STORE_NAME)) request.result.createObjectStore(STORAGE_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveStoredHandle(key, handle) {
  const database = await openStorageDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORAGE_STORE_NAME, 'readwrite');
    transaction.objectStore(STORAGE_STORE_NAME).put(handle, key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

async function getStoredHandle(key) {
  const database = await openStorageDatabase();
  const value = await new Promise((resolve, reject) => {
    const request = database.transaction(STORAGE_STORE_NAME, 'readonly').objectStore(STORAGE_STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return value;
}

async function scanBarcodeDirectory(directoryHandle) {
  const entries = [];
  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === 'file' && name.toLowerCase().endsWith('.pdf')) entries.push({ name, handle });
  }
  return entries.toSorted((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function loadStoredPresets() {
  try {
    const value = JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function NumberField({ label, value, setValue, min = 0, max = 999, unit = 'mm', factor = 1, disabled = false }) {
  const shownValue = Number((numberValue(value) / factor).toFixed(unit === 'in' ? 3 : 1));
  return <label className="field"><span>{label}</span><div className="stepper">
    <button type="button" disabled={disabled} onClick={() => setValue(Math.max(min, numberValue(value) - factor))}><Minus size={13}/></button>
    <input
      aria-label={label}
      value={shownValue}
      type="number"
      min={min / factor}
      max={max / factor}
      step={unit === 'in' ? '0.001' : '0.1'}
      disabled={disabled}
      onChange={event => setValue(Math.max(min, Math.min(max, numberValue(event.target.value) * factor)))}
    />
    <button type="button" disabled={disabled} onClick={() => setValue(Math.min(max, numberValue(value) + factor))}><Plus size={13}/></button>
    {unit && <i>{unit}</i>}
  </div></label>;
}

async function inspectPdf(file, pageIndex = 0) {
  const bytes = await file.arrayBuffer();
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = document.getPageCount();
  const safePageIndex = Math.max(0, Math.min(pages - 1, pageIndex));
  const page = document.getPage(safePageIndex);
  const trim = page.getTrimBox();
  const bleed = page.getBleedBox();
  return {
    pages,
    pageIndex: safePageIndex,
    width: trim.width * MM_PER_POINT,
    height: trim.height * MM_PER_POINT,
    top: Math.max(0, (bleed.y + bleed.height - trim.y - trim.height) * MM_PER_POINT),
    bottom: Math.max(0, (trim.y - bleed.y) * MM_PER_POINT),
    left: Math.max(0, (trim.x - bleed.x) * MM_PER_POINT),
    right: Math.max(0, (bleed.x + bleed.width - trim.x - trim.width) * MM_PER_POINT),
  };
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

function drawProductionMarks(page, geometry) {
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
  line(right + gap, top, right + gap + length, top); line(right, top + gap, right, top + gap + length);

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

async function buildImposedPdf(sourceFile, meta, settings) {
  const { pageIndex, rotation, rotationPattern, cols, rows, sheetW, sheetH, gutterCut, gutterSlit, topOffset, horizontalPlacement, sideTrim, marks, duploRegMark, barcodeFile } = settings;
  const source = await PDFDocument.load(await sourceFile.arrayBuffer(), { updateMetadata: false });
  const sourcePage = source.getPage(pageIndex);
  const trim = sourcePage.getTrimBox();
  const output = await PDFDocument.create();
  const outputPage = output.addPage([sheetW * POINTS_PER_MM, sheetH * POINTS_PER_MM]);
  const quarterTurn = rotation === 90 || rotation === 270;
  const itemWidth = quarterTurn ? trim.height : trim.width;
  const itemHeight = quarterTurn ? trim.width : trim.height;
  const gutterCutPt = gutterCut * POINTS_PER_MM;
  const gutterSlitPt = gutterSlit * POINTS_PER_MM;
  const layoutWidth = cols * itemWidth + (cols - 1) * gutterSlitPt;
  const layoutHeight = rows * itemHeight + (rows - 1) * gutterCutPt;
  const outerMm = calculateOuterBleed(meta, rotation, rotationPattern, rows, cols);
  const outer = Object.fromEntries(Object.entries(outerMm).map(([side, value]) => [side, value * POINTS_PER_MM]));
  const footprintWidth = layoutWidth + outer.left + outer.right;
  const layoutX = horizontalPlacement === 'manual'
    ? outputPage.getWidth() - sideTrim * POINTS_PER_MM - layoutWidth
    : (outputPage.getWidth() - footprintWidth) / 2 + outer.left;
  // Top trim is measured to the first finished cut line, not to the outer bleed edge.
  const finishedTop = outputPage.getHeight() - topOffset * POINTS_PER_MM;
  const layoutY = finishedTop - layoutHeight;
  const embeddedByCrop = new Map();

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const actualRotation = cellRotation(rotation, rotationPattern, row, col);
      const desiredOutputBleed = {
        top: row === 0 ? outerMm.top : gutterCut / 2,
        bottom: row === rows - 1 ? outerMm.bottom : gutterCut / 2,
        left: col === 0 ? outerMm.left : gutterSlit / 2,
        right: col === cols - 1 ? outerMm.right : gutterSlit / 2,
      };
      const bleed = sourceBleedsForOutput(meta, actualRotation, desiredOutputBleed);
      const cropKey = `${bleed.top}|${bleed.bottom}|${bleed.left}|${bleed.right}`;
      let embedded = embeddedByCrop.get(cropKey);
      if (!embedded) {
        embedded = await output.embedPage(sourcePage, {
          left: trim.x - bleed.left,
          bottom: trim.y - bleed.bottom,
          right: trim.x + trim.width + bleed.right,
          top: trim.y + trim.height + bleed.top,
        });
        embeddedByCrop.set(cropKey, embedded);
      }
      const trimX = layoutX + col * (itemWidth + gutterSlitPt);
      const trimY = finishedTop - itemHeight - row * (itemHeight + gutterCutPt);
      drawEmbeddedArtwork(outputPage, embedded, trim, bleed, actualRotation, trimX, trimY);
    }
  }

  if (marks) {
    drawProductionMarks(outputPage, {
      x: layoutX, y: layoutY, itemWidth, itemHeight, layoutWidth, layoutHeight,
      cols, rows, gutterCut: gutterCutPt, gutterSlit: gutterSlitPt,
    });
  }
  if (duploRegMark) drawDuploRegistrationMark(outputPage);
  if (barcodeFile) await drawJobBarcode(output, outputPage, barcodeFile);
  return output.save();
}

async function renderOutputPdf(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const document = await task.promise;
  const page = await document.getPage(1);
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = document.createElement ? document.createElement('canvas') : window.document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toDataURL('image/png');
}

function App() {
  const [rotation, setRotation] = useState(0);
  const [rotationPattern, setRotationPattern] = useState('same');
  const [cols, setCols] = useState(3);
  const [rows, setRows] = useState(4);
  const [marks, setMarks] = useState(true);
  const [duploRegMark, setDuploRegMark] = useState(true);
  const [unit, setUnit] = useState('mm');
  const [paperPreset, setPaperPreset] = useState('13x19');
  const [sourceFile, setSourceFile] = useState(null);
  const [meta, setMeta] = useState(null);
  const [selectedPage, setSelectedPage] = useState(0);
  const [proofImage, setProofImage] = useState(null);
  const [outputBytes, setOutputBytes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sheetW, setSheetW] = useState(330.2);
  const [sheetH, setSheetH] = useState(482.6);
  const [gutterCut, setGutterCut] = useState(5);
  const [gutterSlit, setGutterSlit] = useState(5);
  const [topOffset, setTopOffset] = useState(10);
  const [horizontalPlacement, setHorizontalPlacement] = useState('center');
  const [sideTrim, setSideTrim] = useState(10);
  const [inspectorTab, setInspectorTab] = useState('layout');
  const [barcodeDirectoryHandle, setBarcodeDirectoryHandle] = useState(null);
  const [barcodeEntries, setBarcodeEntries] = useState([]);
  const [barcodeFile, setBarcodeFile] = useState(null);
  const [barcodeMeta, setBarcodeMeta] = useState(null);
  const [barcodeName, setBarcodeName] = useState('');
  const [allowBarcodeOverlap, setAllowBarcodeOverlap] = useState(false);
  const [barcodeFolderStatus, setBarcodeFolderStatus] = useState('Choose the barcode PDF folder once');
  const [presetName, setPresetName] = useState('');
  const [savedPresets, setSavedPresets] = useState(loadStoredPresets);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetsOpen, setPresetsOpen] = useState(false);

  const factor = unit === 'in' ? 25.4 : 1;
  const display = value => unit === 'in' ? `${(value / 25.4).toFixed(3)} in` : `${Number(value).toFixed(1)} mm`;
  const quarterTurn = rotation === 90 || rotation === 270;
  const itemW = meta ? (quarterTurn ? meta.height : meta.width) : 63.5;
  const itemH = meta ? (quarterTurn ? meta.width : meta.height) : 88.9;
  const layoutW = cols * itemW + (cols - 1) * gutterSlit;
  const layoutH = rows * itemH + (rows - 1) * gutterCut;
  const appliedOuterBleed = calculateOuterBleed(meta, rotation, rotationPattern, rows, cols);
  const outerBleedShortfall = meta && Object.values(appliedOuterBleed).some(value => value < OUTER_BLEED_MM - 0.01);
  const footprintW = layoutW + appliedOuterBleed.left + appliedOuterBleed.right;
  const footprintH = layoutH + appliedOuterBleed.top + appliedOuterBleed.bottom;
  const validSheet = sheetW >= MIN_SHEET_MM && sheetH >= MIN_SHEET_MM && sheetW <= MAX_SHEET_WIDTH_MM && sheetH <= MAX_SHEET_HEIGHT_MM;
  const layoutLeft = horizontalPlacement === 'manual'
    ? sheetW - sideTrim - layoutW
    : (sheetW - footprintW) / 2 + appliedOuterBleed.left;
  const artworkLeft = layoutLeft - appliedOuterBleed.left;
  const artworkRight = layoutLeft + layoutW + appliedOuterBleed.right;
  const calculatedSideTrim = sheetW - layoutLeft - layoutW;
  const artworkTop = topOffset - appliedOuterBleed.top;
  const barcodeLeft = barcodeMeta ? sheetW - BARCODE_RIGHT_OFFSET_MM - barcodeMeta.width - BARCODE_KNOCKOUT_PADDING_MM : 0;
  const barcodeRight = sheetW - BARCODE_RIGHT_OFFSET_MM + BARCODE_KNOCKOUT_PADDING_MM;
  const barcodeBottom = barcodeMeta ? BARCODE_TOP_OFFSET_MM + barcodeMeta.height + BARCODE_KNOCKOUT_PADDING_MM : 0;
  const barcodeOverlap = Boolean(barcodeMeta && barcodeName && barcodeRight > artworkLeft && barcodeLeft < artworkRight && barcodeBottom > artworkTop);
  const geometricFit = validSheet && artworkLeft >= 0 && artworkRight <= sheetW && topOffset >= appliedOuterBleed.top && topOffset + layoutH + appliedOuterBleed.bottom <= sheetH;
  const canExport = geometricFit && (!barcodeOverlap || allowBarcodeOverlap);
  const settings = useMemo(() => ({ pageIndex: selectedPage, rotation, rotationPattern, cols, rows, sheetW, sheetH, gutterCut, gutterSlit, topOffset, horizontalPlacement, sideTrim, marks, duploRegMark, barcodeFile }), [selectedPage, rotation, rotationPattern, cols, rows, sheetW, sheetH, gutterCut, gutterSlit, topOffset, horizontalPlacement, sideTrim, marks, duploRegMark, barcodeFile]);

  useEffect(() => {
    let cancelled = false;
    const restoreBarcodeDirectory = async () => {
      try {
        const handle = await getStoredHandle(BARCODE_DIRECTORY_KEY);
        if (!handle || cancelled) return;
        setBarcodeDirectoryHandle(handle);
        const permission = await handle.queryPermission({ mode: 'read' });
        if (permission !== 'granted') {
          setBarcodeFolderStatus('Reconnect the saved barcode folder');
          return;
        }
        const entries = await scanBarcodeDirectory(handle);
        if (!cancelled) {
          setBarcodeEntries(entries);
          setBarcodeFolderStatus(`${entries.length} barcode PDFs available`);
        }
      } catch {
        if (!cancelled) setBarcodeFolderStatus('Choose the barcode PDF folder once');
      }
    };
    restoreBarcodeDirectory();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!sourceFile || !meta || !geometricFit) {
      setOutputBytes(null);
      setProofImage(null);
      return () => { cancelled = true; };
    }
    const generate = async () => {
      setBusy(true);
      try {
        const bytes = await buildImposedPdf(sourceFile, meta, settings);
        const image = await renderOutputPdf(bytes);
        if (!cancelled) {
          setOutputBytes(bytes);
          setProofImage(image);
          setError('');
        }
      } catch (generationError) {
        if (!cancelled) {
          setOutputBytes(null);
          setProofImage(null);
          setError(`Preview generation failed: ${generationError.message}`);
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    generate();
    return () => { cancelled = true; };
  }, [sourceFile, meta, geometricFit, settings]);

  useEffect(() => {
    setAllowBarcodeOverlap(false);
  }, [barcodeName, sheetW, sheetH, topOffset, horizontalPlacement, sideTrim, cols, rows, gutterCut, gutterSlit, rotation, rotationPattern, selectedPage]);

  const setBarcodeFromEntry = async (name, entries = barcodeEntries) => {
    setBarcodeName(name);
    if (!name) {
      setBarcodeFile(null);
      setBarcodeMeta(null);
      return;
    }
    const entry = entries.find(item => item.name === name);
    if (!entry) {
      setBarcodeFile(null);
      setBarcodeMeta(null);
      setError(`Barcode ${name} is not available. Reconnect its folder.`);
      return;
    }
    try {
      const file = entry.file || await entry.handle.getFile();
      const dimensions = await inspectBarcode(file);
      setBarcodeFile(file);
      setBarcodeMeta(dimensions);
      setError('');
    } catch (barcodeError) {
      setBarcodeFile(null);
      setBarcodeMeta(null);
      setError(`Barcode PDF could not be read: ${barcodeError.message}`);
    }
  };

  const connectBarcodeDirectory = async () => {
    try {
      if (!window.showDirectoryPicker) throw new Error('Persistent folder access requires Chrome or Edge. Use the session folder loader below in this browser.');
      let handle = barcodeDirectoryHandle;
      if (!handle) handle = await window.showDirectoryPicker({ mode: 'read' });
      const permission = await handle.requestPermission({ mode: 'read' });
      if (permission !== 'granted') throw new Error('Barcode folder permission was not granted.');
      const entries = await scanBarcodeDirectory(handle);
      await saveStoredHandle(BARCODE_DIRECTORY_KEY, handle);
      setBarcodeDirectoryHandle(handle);
      setBarcodeEntries(entries);
      setBarcodeFolderStatus(`${entries.length} barcode PDFs available · folder remembered`);
      setError('');
      if (barcodeName) await setBarcodeFromEntry(barcodeName, entries);
    } catch (folderError) {
      if (folderError.name !== 'AbortError') setError(folderError.message);
    }
  };

  const loadBarcodeFilesForSession = async event => {
    const files = Array.from(event.target.files || []).filter(file => file.name.toLowerCase().endsWith('.pdf'));
    const entries = files.map(file => ({ name: file.name, file })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    setBarcodeEntries(entries);
    setBarcodeDirectoryHandle(null);
    setBarcodeFolderStatus(`${entries.length} barcode PDFs available · this session only`);
    setError('');
    if (barcodeName) await setBarcodeFromEntry(barcodeName, entries);
  };

  const savePreset = () => {
    const cleanName = presetName.trim();
    if (!cleanName) {
      setError('Enter a preset name before saving.');
      return;
    }
    const existing = savedPresets.find(item => item.name.toLowerCase() === cleanName.toLowerCase());
    const preset = {
      id: existing?.id || (globalThis.crypto?.randomUUID?.() ?? `preset-${Date.now()}`),
      name: cleanName,
      paperPreset, sheetW, sheetH, rotation, rotationPattern, cols, rows, gutterCut, gutterSlit,
      topTrim: topOffset, horizontalPlacement, sideTrim, marks, duploRegMark, barcodeName,
    };
    const next = existing ? savedPresets.map(item => item.id === existing.id ? preset : item) : [...savedPresets, preset];
    setSavedPresets(next);
    setSelectedPresetId(preset.id);
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(next));
    setError('');
  };

  const applyPreset = async () => {
    const preset = savedPresets.find(item => item.id === selectedPresetId);
    if (!preset) return;
    setPaperPreset(preset.paperPreset);
    setSheetW(preset.sheetW); setSheetH(preset.sheetH);
    setRotation(preset.rotation); setRotationPattern(preset.rotationPattern || 'same'); setCols(preset.cols); setRows(preset.rows);
    setGutterCut(preset.gutterCut); setGutterSlit(preset.gutterSlit);
    setTopOffset(preset.topTrim); setHorizontalPlacement(preset.horizontalPlacement || 'center'); setSideTrim(preset.sideTrim ?? 10); setMarks(preset.marks); setDuploRegMark(preset.duploRegMark);
    setPresetName(preset.name);
    await setBarcodeFromEntry(preset.barcodeName || '');
  };

  const deletePreset = () => {
    if (!selectedPresetId) return;
    const next = savedPresets.filter(item => item.id !== selectedPresetId);
    setSavedPresets(next);
    setSelectedPresetId('');
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(next));
  };

  const selectPaper = preset => {
    setPaperPreset(preset);
    if (preset === '13x19') { setSheetW(330.2); setSheetH(482.6); }
    if (preset === '12.4x18.4') { setSheetW(315); setSheetH(467.4); }
  };

  const upload = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const inspected = await inspectPdf(file, 0);
      setSelectedPage(0);
      setSourceFile(file);
      setMeta(inspected);
    } catch (uploadError) {
      setSourceFile(null);
      setMeta(null);
      setSelectedPage(0);
      setError(`PDF size / TrimBox / BleedBox ကိုမဖတ်နိုင်ပါ။ ${uploadError.message}`);
    } finally {
      setBusy(false);
    }
  };

  const selectPdfPage = async event => {
    if (!sourceFile) return;
    const nextPage = Number(event.target.value);
    setBusy(true);
    setOutputBytes(null);
    setProofImage(null);
    setError('');
    try {
      const inspected = await inspectPdf(sourceFile, nextPage);
      setSelectedPage(inspected.pageIndex);
      setMeta(inspected);
    } catch (pageError) {
      setError(`PDF page ${nextPage + 1} ကိုမဖတ်နိုင်ပါ။ ${pageError.message}`);
    } finally {
      setBusy(false);
    }
  };

  const downloadOutput = () => {
    if (!outputBytes) return;
    const url = URL.createObjectURL(new Blob([outputBytes], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'duplo-616-imposed.pdf';
    link.click();
    URL.revokeObjectURL(url);
  };

  return <main className="app app-redesign">
    <header className="topbar">
      <div className="brand compact-brand"><span className="brand-mark">R</span><span>Repeat</span></div>
      <button className="top-action new-job-action" type="button" onClick={() => { setSourceFile(null); setMeta(null); setSelectedPage(0); setProofImage(null); setOutputBytes(null); setError(''); }}><Plus size={16}/> New Job</button>
      <div className="preset-menu-wrap">
        <button className="top-action" type="button" aria-expanded={presetsOpen} aria-controls="preset-menu" onClick={() => setPresetsOpen(open => !open)}><Settings2 size={15}/> Presets</button>
        {presetsOpen && <section id="preset-menu" className="preset-menu" aria-label="Saved presets">
          <div className="preset-menu-title"><div><b>Presets</b><span>Save or reuse the complete job setup</span></div><button type="button" aria-label="Close presets" onClick={() => setPresetsOpen(false)}><X size={15}/></button></div>
          <input className="preset-name" aria-label="Preset name" placeholder="Preset name" value={presetName} onChange={event => setPresetName(event.target.value)}/>
          <button type="button" className="secondary preset-save" onClick={savePreset}><Save size={14}/> Save current settings</button>
          <div className="preset-actions"><select aria-label="Saved preset" value={selectedPresetId} onChange={event => setSelectedPresetId(event.target.value)}><option value="">Choose saved preset</option>{savedPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><button type="button" className="secondary" disabled={!selectedPresetId} onClick={async () => { await applyPreset(); setPresetsOpen(false); }}>Apply</button><button type="button" className="icon-button" aria-label="Delete selected preset" disabled={!selectedPresetId} onClick={deletePreset}><Trash2 size={14}/></button></div>
        </section>}
      </div>
      <div className="top-divider"/>
      <div className="job-title"><strong>Duplo 616 sheet</strong><span><CheckCircle2 size={14}/> Output-proof workflow</span></div>
      <button className="export" disabled={!outputBytes || busy || !canExport} onClick={downloadOutput}><Download size={16}/> {busy ? 'Generating…' : 'Export imposed PDF'}</button>
      <div className="unit-switch"><button className={unit === 'mm' ? 'selected' : ''} onClick={() => setUnit('mm')}>mm</button><button className={unit === 'in' ? 'selected' : ''} onClick={() => setUnit('in')}>in</button></div>
    </header>

    <section className="work redesigned-work">
      <div className="canvas-wrap"><div className="sheet proof-sheet" style={{ aspectRatio: sheetW / sheetH }}>
        {proofImage ? <img className="proof-image" src={proofImage} alt="Generated imposed PDF proof"/> : <div className="proof-empty">{sourceFile && !geometricFit ? 'Layout does not fit this sheet' : 'Upload a PDF to generate the exact output proof'}</div>}
      </div></div>
      <footer><span className={canExport ? 'ok' : 'warn'}>{canExport ? <CheckCircle2/> : <AlertTriangle/>} {canExport ? (busy ? 'Generating output proof' : barcodeOverlap ? 'Overlap approved · preview matches export' : 'Preview matches export') : barcodeOverlap ? 'Barcode overlap needs approval' : 'Check sheet / fit'}</span><span>Finished size · {display(itemW)} × {display(itemH)}</span><span>{cols} × {rows} · {cols * rows} up</span></footer>
    </section>

    <aside className="inspector redesigned-inspector">
      <section className="artwork-panel">
        <h1>Artwork</h1>
        <section className="upload compact-upload"><input id="upload" type="file" accept="application/pdf" onChange={upload}/><label htmlFor="upload"><FileUp size={17}/><b>{sourceFile ? 'Replace PDF' : 'Upload PDF'}</b></label>{sourceFile && <button className="clear" onClick={() => { setSourceFile(null); setMeta(null); setSelectedPage(0); setProofImage(null); setOutputBytes(null); setError(''); }}><X size={14}/> Remove</button>}</section>
        {error && <p className="error">{error}</p>}
        {meta ? <div className="detected compact-detected"><CheckCircle2/><div><b>PDF inspected · {meta.pages} {meta.pages === 1 ? 'page' : 'pages'}</b><span>Trim {display(meta.width)} × {display(meta.height)} · Bleed T {display(meta.top)}, B {display(meta.bottom)}, L {display(meta.left)}, R {display(meta.right)}</span></div></div> : <p className="empty-meta">TrimBox and BleedBox are read automatically</p>}
        {meta?.pages > 1 && <label className="select compact-select"><span>Page</span><select aria-label="Artwork page" value={selectedPage} onChange={selectPdfPage} disabled={busy}>{Array.from({ length: meta.pages }, (_, index) => <option key={index} value={index}>Page {index + 1} / {meta.pages}</option>)}</select></label>}
        <div className="control-label">Base rotation</div>
        <div className="rotation segmented">{[0, 90, 180, 270].map(angle => <button key={angle} className={rotation === angle ? 'selected' : ''} onClick={() => setRotation(angle)}>{angle}°</button>)}</div>
        <label className="select rotation-pattern compact-select"><span>Repeat pattern</span><select aria-label="180 degree repeat pattern" value={rotationPattern} onChange={event => setRotationPattern(event.target.value)}>{ROTATION_PATTERNS.map(pattern => <option key={pattern.value} value={pattern.value}>{pattern.label}</option>)}</select></label>
      </section>

      <div className="inspector-tabs" role="tablist" aria-label="Inspector settings">
        <button role="tab" aria-selected={inspectorTab === 'layout'} className={inspectorTab === 'layout' ? 'selected' : ''} onClick={() => setInspectorTab('layout')}>Layout</button>
        <button role="tab" aria-selected={inspectorTab === 'duplo'} className={inspectorTab === 'duplo' ? 'selected' : ''} onClick={() => setInspectorTab('duplo')}>Duplo</button>
      </div>

      {inspectorTab === 'layout' ? <div className="tab-panel" role="tabpanel">
        <section><h2>Sheet & repeat</h2><label className="select"><span>Paper size</span><select aria-label="Sheet preset" value={paperPreset} onChange={event => selectPaper(event.target.value)}><option value="13x19">13 × 19 in</option><option value="12.4x18.4">12.4 × 18.4 in</option><option value="custom">Custom size</option></select></label>{paperPreset === 'custom' && <div className="two"><NumberField label="Sheet width" value={sheetW} setValue={setSheetW} min={MIN_SHEET_MM} max={MAX_SHEET_WIDTH_MM} unit={unit} factor={factor}/><NumberField label="Sheet length" value={sheetH} setValue={setSheetH} min={MIN_SHEET_MM} max={MAX_SHEET_HEIGHT_MM} unit={unit} factor={factor}/></div>}<div className="two"><NumberField label="Columns" value={cols} setValue={setCols} min={1} max={25} unit=""/><NumberField label="Rows" value={rows} setValue={setRows} min={1} max={25} unit=""/></div><div className="layout-total"><span>Total up</span><b>{cols * rows}</b></div></section>
        <section className="compact-summary"><h2>Output size</h2><div className="summary-grid"><span>Finished item<b>{display(itemW)} × {display(itemH)}</b></span><span>Layout<b>{display(layoutW)} × {display(layoutH)}</b></span><span>Outer bleed<b>T {display(appliedOuterBleed.top)} · B {display(appliedOuterBleed.bottom)} · L {display(appliedOuterBleed.left)} · R {display(appliedOuterBleed.right)}</b></span></div>{outerBleedShortfall && <p className="error">Common outer bleed is reduced to the least source bleed available across rotated edge cells.</p>}</section>
      </div> : <div className="tab-panel" role="tabpanel">
        <section><h2>Duplo finishing</h2><div className="two"><NumberField label="Lead Trim" value={topOffset} setValue={setTopOffset} max={100} unit={unit} factor={factor}/><NumberField label="Side Trim" value={calculatedSideTrim} setValue={setSideTrim} max={100} unit={unit} factor={factor} disabled={horizontalPlacement === 'center'}/></div><label className="placement-toggle"><span>Horizontal placement</span><select aria-label="Horizontal placement" value={horizontalPlacement} onChange={event => { const mode = event.target.value; if (mode === 'manual') setSideTrim(calculatedSideTrim); setHorizontalPlacement(mode); }}><option value="center">Centered · auto Side Trim</option><option value="manual">Manual Side Trim</option></select></label><div className="two"><NumberField label="Gutter Cut" value={gutterCut} setValue={setGutterCut} unit={unit} factor={factor}/><NumberField label="Gutter Slit" value={gutterSlit} setValue={setGutterSlit} unit={unit} factor={factor}/></div><p className="hint">Lead Trim is measured from the sheet top to the first finished cut line. Side Trim is measured from the sheet right edge to the first finished slit line.</p></section>
        <section className="switches"><label className="toggle-row"><span>Production trim marks</span><input type="checkbox" checked={marks} onChange={event => setMarks(event.target.checked)}/></label><label className="toggle-row"><span>Duplo registration mark</span><input type="checkbox" checked={duploRegMark} onChange={event => setDuploRegMark(event.target.checked)}/></label></section>
        <details className="advanced"><summary>Job barcode</summary><div className="details-body"><div className="barcode-actions"><button type="button" className="secondary" onClick={connectBarcodeDirectory}><FolderOpen size={14}/> {barcodeDirectoryHandle ? 'Reconnect folder' : 'Choose barcode folder'}</button><span className="barcode-status">{barcodeFolderStatus}</span></div><label className="session-loader"><input className="barcode-file-input" type="file" accept="application/pdf" multiple webkitdirectory="" onChange={loadBarcodeFilesForSession}/><span>Load folder for this session</span></label><label className="select"><span>Job barcode</span><select aria-label="Job barcode" value={barcodeName} onChange={event => setBarcodeFromEntry(event.target.value)}><option value="">No barcode</option>{barcodeEntries.map(entry => <option key={entry.name} value={entry.name}>{entry.name.replace(/\.pdf$/i, '')}</option>)}</select></label><div className="calculation barcode-spec"><span>Bottom crop · white knockout · top layer</span><b>{display(BARCODE_HEIGHT_MM)} high · top {display(BARCODE_TOP_OFFSET_MM)} · right {display(BARCODE_RIGHT_OFFSET_MM)}</b></div>{barcodeOverlap && <div className="overlap-approval"><p><AlertTriangle size={14}/> Barcode overlaps the imposed artwork.</p><label className="toggle-row"><span>Allow barcode over artwork</span><input type="checkbox" checked={allowBarcodeOverlap} onChange={event => setAllowBarcodeOverlap(event.target.checked)}/></label></div>}</div></details>
        <div className={canExport ? 'summary compact-check' : 'summary warning compact-check'}><span>DC-616 CHECK</span><b>{canExport ? barcodeOverlap ? 'Barcode overlap approved' : 'Sheet & layout fit' : barcodeOverlap ? 'Approve barcode overlap to export' : 'Layout exceeds usable sheet area'}</b><small>Lead {display(topOffset)} · Side {display(calculatedSideTrim)} · Cut {display(gutterCut)} · Slit {display(gutterSlit)}</small></div>
      </div>}
    </aside>
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
