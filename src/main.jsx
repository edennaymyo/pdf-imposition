import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Download, FileUp, FolderOpen, GripHorizontal, Minus, Plus, RefreshCcw, RotateCw, Save, Settings2, Trash2, X, ZoomIn } from 'lucide-react';
import { PDFDocument } from 'pdf-lib';
import { buildJobPdf, buildPlacementPreviewPdf, planJob, calculateOuterBleed, classifyPlacement, inspectBarcode, extractOutputSide, finishedSize } from './pdf-engine.js';
import pdfJsWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import './styles.css';
import './duplo.css';
import { ArtworkDirection, ExportDialog, InspectorTabs, PatternPicker, SegmentedChoice } from './workspace-ui.jsx';
import { SourceCard } from './workspace-ui.jsx';
import './workspace-ui.css';

const MM_PER_POINT = 25.4 / 72;
const PREVIEW_SCALE = 1;
const MIN_SHEET_MM = 210;
const MAX_SHEET_WIDTH_MM = 330.2;
const MAX_SHEET_HEIGHT_MM = 482.6;
const OUTER_BLEED_MM = 3;
const BARCODE_TOP_OFFSET_MM = 4;
const BARCODE_RIGHT_OFFSET_MM = 25;
const BARCODE_HEIGHT_MM = 5;
const BARCODE_KNOCKOUT_PADDING_MM = 0.5;
const STORAGE_DB_NAME = 'duplo-imposition-storage';
const STORAGE_DB_VERSION = 1;
const STORAGE_STORE_NAME = 'handles';
const BARCODE_DIRECTORY_KEY = 'barcode-directory';
const PRESET_STORAGE_KEY = 'duplo-imposition-presets-v1';
const inspectedDocuments = new WeakMap();
let pdfRendererPromise;
let pdfBuildWorker;
let pdfBuildRequestId = 0;
const pendingPdfBuilds = new Map();

function getPdfRenderer() {
  if (!pdfRendererPromise) {
    pdfRendererPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfJsWorkerUrl;
      return pdfjs;
    });
  }
  return pdfRendererPromise;
}

function getPdfBuildWorker() {
  if (pdfBuildWorker || typeof Worker === 'undefined') return pdfBuildWorker;
  pdfBuildWorker = new Worker(new URL('./pdf-build.worker.js', import.meta.url), { type: 'module' });
  pdfBuildWorker.onmessage = event => {
    const pending = pendingPdfBuilds.get(event.data.id);
    if (!pending) return;
    pendingPdfBuilds.delete(event.data.id);
    if (event.data.error) pending.reject(new Error(event.data.error));
    else pending.resolve(event.data.bytes);
  };
  pdfBuildWorker.onerror = event => {
    const failure = new Error(event.message || 'PDF worker failed.');
    for (const pending of pendingPdfBuilds.values()) pending.reject(failure);
    pendingPdfBuilds.clear();
    pdfBuildWorker?.terminate();
    pdfBuildWorker = undefined;
  };
  return pdfBuildWorker;
}

function runPdfBuildTask(type, payload) {
  const worker = getPdfBuildWorker();
  if (!worker) {
    return type === 'placement-preview'
      ? buildPlacementPreviewPdf(payload.input, payload.itemWidth, payload.itemHeight, payload.rotation)
      : buildJobPdf(payload.front, payload.back, payload.settings);
  }
  const id = ++pdfBuildRequestId;
  return new Promise((resolve, reject) => {
    pendingPdfBuilds.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

function disposePdfBuildWorker() {
  pdfBuildWorker?.terminate();
  pdfBuildWorker = undefined;
  const failure = new Error('PDF worker stopped.');
  for (const pending of pendingPdfBuilds.values()) pending.reject(failure);
  pendingPdfBuilds.clear();
}

function getInspectedDocument(file) {
  let documentPromise = inspectedDocuments.get(file);
  if (!documentPromise) {
    documentPromise = file.arrayBuffer().then(bytes => PDFDocument.load(bytes, { updateMetadata: false }));
    inspectedDocuments.set(file, documentPromise);
    documentPromise.catch(() => inspectedDocuments.delete(file));
  }
  return documentPromise;
}

function revokeImageUrls(urls = []) {
  for (const url of urls) if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

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
    <button type="button" aria-label={`Decrease ${label}`} disabled={disabled} onClick={() => setValue(Math.max(min, numberValue(value) - factor))}><Minus size={13}/></button>
    <input
      aria-label={label}
      value={shownValue}
      type="number"
      min={min / factor}
      max={max / factor}
      step={unit === '' ? '1' : unit === 'in' ? '0.001' : '0.1'}
      disabled={disabled}
      onChange={event => setValue(Math.max(min, Math.min(max, (unit === '' ? Math.trunc(numberValue(event.target.value)) : numberValue(event.target.value)) * factor)))}
    />
    <button type="button" aria-label={`Increase ${label}`} disabled={disabled} onClick={() => setValue(Math.min(max, numberValue(value) + factor))}><Plus size={13}/></button>
    {unit && <i>{unit}</i>}
  </div></label>;
}

async function inspectPdf(file, pageIndex = 0) {
  const document = await getInspectedDocument(file);
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

async function renderOutputPdf(bytes) {
  const pdfjs = await getPdfRenderer();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const images = [];
  try {
    const pdf = await task.promise;
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const viewport = page.getViewport({ scale: PREVIEW_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const canvasContext = canvas.getContext('2d', { alpha: false, desynchronized: true });
      await page.render({ canvasContext, viewport, intent: 'display' }).promise;
      const blob = await new Promise((resolve, reject) => canvas.toBlob(
        value => value ? resolve(value) : reject(new Error('Preview image encoding failed.')),
        'image/png',
      ));
      images.push(URL.createObjectURL(blob));
      page.cleanup();
      if (index < pdf.numPages) await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return images;
  } catch (failure) {
    revokeImageUrls(images);
    throw failure;
  } finally { await task.destroy(); }
}

function App() {
  const [rotation, setRotation] = useState(0);
  const [rotationPattern, setRotationPattern] = useState('same');
  const [cols, setCols] = useState(1);
  const [rows, setRows] = useState(1);
  const [marks, setMarks] = useState(true);
  const [duploRegMark, setDuploRegMark] = useState(true);
  const [trimBoxOutline, setTrimBoxOutline] = useState(false);
  const [trimBoxColor, setTrimBoxColor] = useState('#ff00ff');
  const [trimBoxOutput, setTrimBoxOutput] = useState('preview');
  const [unit, setUnit] = useState('mm');
  const [paperPreset, setPaperPreset] = useState('13x19');
  const [sourceFile, setSourceFile] = useState(null);
  const [duplex, setDuplex] = useState(false);
  const [backInput, setBackInput] = useState('same');
  const [backFile, setBackFile] = useState(null);
  const [backSelectedPage, setBackSelectedPage] = useState(1);
  const [backRotation, setBackRotation] = useState(0);
  const flipEdge = 'long';
  const [finishingSide, setFinishingSide] = useState('front');
  const [proofView, setProofView] = useState('both');
  const [exportSide, setExportSide] = useState('both');
  const [inspection, setInspection] = useState(null);
  const [proof, setProof] = useState(null);
  const [selectedPage, setSelectedPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sheetW, setSheetW] = useState(330.2);
  const [sheetH, setSheetH] = useState(482.6);
  const [gutterCut, setGutterCut] = useState(5);
  const [gutterSlit, setGutterSlit] = useState(5);
  const [topOffset, setTopOffset] = useState(10);
  const [horizontalPlacement, setHorizontalPlacement] = useState('center');
  const [sideTrim, setSideTrim] = useState(10);
  const [inspectorTab, setInspectorTab] = useState('artwork');
  const [editingSide, setEditingSide] = useState('front');
  const [exportOpen, setExportOpen] = useState(false);
  const [barcodeOpen, setBarcodeOpen] = useState(false);
  const inspectorScroll = useRef(null);
  const [barcodeDirectoryHandle, setBarcodeDirectoryHandle] = useState(null);
  const [barcodeEntries, setBarcodeEntries] = useState([]);
  const [barcodeFile, setBarcodeFile] = useState(null);
  const [barcodeName, setBarcodeName] = useState('');
  const [barcodeFolderStatus, setBarcodeFolderStatus] = useState('Choose the barcode PDF folder once');
  const [presetName, setPresetName] = useState('');
  const [savedPresets, setSavedPresets] = useState(loadStoredPresets);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [masterConfirmed, setMasterConfirmed] = useState(false);
  const [sizeConfirmOpen, setSizeConfirmOpen] = useState(false);
  const [fillMode, setFillMode] = useState('repeat');
  const [mixedPlacements, setMixedPlacements] = useState({});
  const [mixedBackPlacements, setMixedBackPlacements] = useState({});
  const [selectedCell, setSelectedCell] = useState(null);
  const [selectedPlacementSide, setSelectedPlacementSide] = useState('front');
  const [placementNotice, setPlacementNotice] = useState('');
  const [draggedOverCell, setDraggedOverCell] = useState(null);
  const [previewCell, setPreviewCell] = useState(null);
  const [blockPreview, setBlockPreview] = useState({ image: '', error: '' });
  const [editorOffset, setEditorOffset] = useState({ x: 0, y: 0 });
  const [editorDragging, setEditorDragging] = useState(false);
  const editorDrag = useRef(null);
  const editorToolbar = useRef(null);
  const proofImageUrls = useRef([]);
  const proofBuildQueue = useRef(Promise.resolve());
  const slotUploadInput = useRef(null);
  const pendingPlacementCell = useRef(null);
  const pendingPlacementSide = useRef('front');

  const factor = unit === 'in' ? 25.4 : 1;
  const display = value => unit === 'in' ? `${(value / 25.4).toFixed(3)} in` : `${Number(value).toFixed(1)} mm`;
  const displaySheetInches = value => `${Number((value / 25.4).toFixed(3))} in`;
  const effectiveBackFile = backInput === 'same' ? sourceFile : backFile;
  const inspectionRequest = useMemo(() => ({ sourceFile, selectedPage, duplex, effectiveBackFile, backSelectedPage }),
    [sourceFile, selectedPage, duplex, effectiveBackFile, backSelectedPage]);
  const meta = inspection?.request === inspectionRequest ? inspection.front : null;
  const backMeta = inspection?.request === inspectionRequest ? inspection.back : null;
  const inspectionError = inspection?.request === inspectionRequest ? inspection.error : '';
  const settings = useMemo(() => ({
    rotation, rotationPattern, cols, rows, sheetW, sheetH, gutterCut, gutterSlit, topOffset,
    horizontalPlacement, sideTrim, marks, duploRegMark, trimBoxOutline, trimBoxColor, trimBoxOutput, barcodeFile,
    duplex, backRotation, flipEdge, finishingSide, fillMode, mixedPlacements, mixedBackPlacements,
  }), [rotation, rotationPattern, cols, rows, sheetW, sheetH, gutterCut, gutterSlit, topOffset,
    horizontalPlacement, sideTrim, marks, duploRegMark, trimBoxOutline, trimBoxColor, trimBoxOutput, barcodeFile, duplex, backRotation, flipEdge, finishingSide,
    fillMode, mixedPlacements, mixedBackPlacements]);
  const planned = useMemo(() => {
    try { return { plan: planJob(meta, backMeta, settings), error: '' }; }
    catch (failure) { return { plan: null, error: failure.message }; }
  }, [meta, backMeta, settings]);
  const plan = planned.plan;
  const frontGeometry = plan?.sides[0];
  const itemW = meta ? finishedSize(meta, rotation).width : 63.5;
  const itemH = meta ? finishedSize(meta, rotation).height : 88.9;
  const layoutW = cols * itemW + (cols - 1) * gutterSlit;
  const layoutH = rows * itemH + (rows - 1) * gutterCut;
  const appliedOuterBleed = frontGeometry?.outer || calculateOuterBleed(meta, rotation, rotationPattern, rows, cols);
  const outerBleedShortfall = plan?.sides.some(side => Object.values(side.outer).some(value => value < OUTER_BLEED_MM - 0.01));
  const layoutLeft = frontGeometry?.x ?? (sheetW - layoutW) / 2;
  const calculatedSideTrim = sheetW - layoutLeft - layoutW;
  const geometricFit = Boolean(plan?.fits);
  const canExport = masterConfirmed && geometricFit && (!barcodeName || Boolean(barcodeFile));
  const proofRequest = useMemo(() => ({ inspectionRequest, meta, backMeta, settings }), [inspectionRequest, meta, backMeta, settings]);
  const outputBytes = proof?.request === proofRequest ? proof.bytes : null;
  const proofImages = proof?.images || [];
  const processing = busy || Boolean(sourceFile && inspection?.request !== inspectionRequest);
  const statusError = error || inspectionError || (sourceFile && !processing ? planned.error : '');
  const shownSides = duplex ? (proofView === 'both' ? ['front', 'back'] : [proofView]) : ['front'];
  const exportReady = Boolean(outputBytes && !processing && canExport);
  const barcodeNeedsAttention = Boolean(barcodeName && !barcodeFile);
  const sheetLabel = paperPreset === '13x19' ? '13 × 19 in' : paperPreset === '12.4x18.4' ? '12.4 × 18.4 in' : `${display(sheetW)} × ${display(sheetH)}`;
  const backSize = backMeta ? finishedSize(backMeta, backRotation) : null;
  const selectedPlacementMap = selectedPlacementSide === 'back' ? mixedBackPlacements : mixedPlacements;
  const selectedPlacement = selectedCell === null ? null : selectedPlacementMap[selectedCell] || null;
  const selectedMasterFile = selectedPlacementSide === 'back' ? effectiveBackFile : sourceFile;
  const selectedMasterMeta = selectedPlacementSide === 'back' ? backMeta : meta;
  const selectedMasterRotation = selectedPlacementSide === 'back' ? backRotation : rotation;
  const selectedBlockFile = selectedPlacement?.file || selectedMasterFile;
  const selectedBlockMeta = selectedPlacement?.meta || selectedMasterMeta;
  const selectedBlockPage = selectedPlacement?.pageIndex ?? selectedMasterMeta?.pageIndex ?? 0;
  const selectedBlockRotation = selectedPlacement?.rotation ?? selectedMasterRotation;
  const previewGeometry = previewCell ? plan?.sides.find(side => side.side === previewCell.side) : null;
  const previewCellGeometry = previewGeometry?.cells.find(cell => cell.slotIndex === previewCell?.cellIndex);
  const previewPlacementMap = previewCell?.side === 'back' ? mixedBackPlacements : mixedPlacements;
  const previewPlacement = previewCell ? previewPlacementMap[previewCell.cellIndex] || null : null;
  const previewMasterFile = previewCell?.side === 'back' ? effectiveBackFile : sourceFile;
  const previewMasterMeta = previewCell?.side === 'back' ? backMeta : meta;
  const previewFile = previewPlacement?.file || previewMasterFile;
  const previewMeta = previewPlacement?.meta || previewMasterMeta;
  const previewPageIndex = previewPlacement?.pageIndex ?? previewMasterMeta?.pageIndex ?? 0;
  const sizesMatch = Boolean(meta && (!duplex || (backSize && Math.abs(itemW - backSize.width) <= 0.01 && Math.abs(itemH - backSize.height) <= 0.01)));
  const issueText = statusError || (barcodeNeedsAttention ? 'Reconnect the selected barcode file.' : sourceFile && meta && !masterConfirmed ? 'Confirm the finished item size before arranging the sheet.' : sourceFile && !processing && !geometricFit ? 'This layout does not fit. Review sheet size and repeat count.' : '');
  const issueTab = barcodeNeedsAttention ? 'duplo' : !meta || !masterConfirmed || (duplex && !sizesMatch) || inspectionError ? 'artwork' : 'layout';
  const changeInspectorTab = tab => { setInspectorTab(tab); inspectorScroll.current?.scrollTo({ top: 0 }); };
  const reviewIssue = () => {
    changeInspectorTab(!sourceFile ? 'artwork' : issueTab);
    if (issueTab === 'duplo') setBarcodeOpen(true);
    if (issueTab === 'artwork') setEditingSide(duplex && meta && masterConfirmed ? 'back' : 'front');
    requestAnimationFrame(() => {
      const target = document.getElementById(issueTab === 'duplo' ? 'barcode-details' : `panel-${!sourceFile ? 'artwork' : issueTab}`);
      target?.scrollIntoView({ block: 'nearest' });
      target?.querySelector('select, input, button')?.focus();
    });
  };

  const replaceProofImages = (nextProof = null) => {
    const previousUrls = proofImageUrls.current;
    proofImageUrls.current = nextProof?.images || [];
    setProof(nextProof);
    if (previousUrls.length) requestAnimationFrame(() => revokeImageUrls(previousUrls));
  };

  useEffect(() => () => revokeImageUrls(proofImageUrls.current), []);
  useEffect(() => () => disposePdfBuildWorker(), []);

  useEffect(() => {
    let cancelled = false;
    if (!sourceFile) { setInspection(null); return; }
    const inspect = async () => {
      try {
        const [front, back] = await Promise.all([
          inspectPdf(sourceFile, selectedPage),
          duplex && effectiveBackFile ? inspectPdf(effectiveBackFile, backSelectedPage) : Promise.resolve(null),
        ]);
        if (!cancelled) setInspection({ request: inspectionRequest, front, back, error: '' });
      } catch (failure) {
        if (!cancelled) setInspection({ request: inspectionRequest, front: null, back: null, error: `PDF inspection failed: ${failure.message}` });
      }
    };
    inspect();
    return () => { cancelled = true; };
  }, [inspectionRequest]);

  useEffect(() => {
    if (!meta) {
      setSizeConfirmOpen(false);
      return;
    }
    if (!masterConfirmed) setSizeConfirmOpen(true);
  }, [meta, masterConfirmed]);

  useEffect(() => {
    if (!sizeConfirmOpen && !previewCell) return undefined;
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return;
      if (previewCell) setPreviewCell(null);
      else setSizeConfirmOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [sizeConfirmOpen, previewCell]);

  useEffect(() => {
    let cancelled = false;
    let imageUrl = '';
    if (!previewCell || !previewGeometry || !previewCellGeometry || !previewFile || !previewMeta) {
      setBlockPreview({ image: '', error: '' });
      return () => { cancelled = true; };
    }
    setBlockPreview({ image: '', error: '' });
    const renderBlock = async () => {
      try {
        const bytes = await runPdfBuildTask('placement-preview', {
          input: { file: previewFile, meta: previewMeta, pageIndex: previewPageIndex },
          itemWidth: previewGeometry.itemW,
          itemHeight: previewGeometry.itemH,
          rotation: previewCellGeometry.rotation,
        });
        const [image] = await renderOutputPdf(bytes);
        imageUrl = image;
        if (!cancelled) setBlockPreview({ image, error: '' });
        else revokeImageUrls([image]);
      } catch (failure) {
        if (!cancelled) setBlockPreview({ image: '', error: `Block preview failed: ${failure.message}` });
      }
    };
    renderBlock();
    return () => { cancelled = true; revokeImageUrls([imageUrl]); };
  }, [previewCell, previewGeometry, previewCellGeometry, previewFile, previewMeta, previewPageIndex]);

  useEffect(() => {
    setEditorOffset({ x: 0, y: 0 });
    editorDrag.current = null;
    setEditorDragging(false);
  }, [selectedCell, selectedPlacementSide, proofView, cols, rows, sheetW, sheetH]);

  useEffect(() => {
    const keepEditorVisible = () => setEditorOffset({ x: 0, y: 0 });
    window.addEventListener('resize', keepEditorVisible);
    return () => window.removeEventListener('resize', keepEditorVisible);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let idleId;
    let timerId;
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
    if ('requestIdleCallback' in window) idleId = window.requestIdleCallback(restoreBarcodeDirectory, { timeout: 1200 });
    else timerId = window.setTimeout(restoreBarcodeDirectory, 250);
    return () => {
      cancelled = true;
      if (idleId) window.cancelIdleCallback(idleId);
      if (timerId) window.clearTimeout(timerId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!sourceFile || !meta || !masterConfirmed || !geometricFit || (duplex && !backMeta)) {
      replaceProofImages(null);
      setBusy(false);
      return () => { cancelled = true; };
    }
    setBusy(true);
    // Debounce stepper changes; never leave a stale proof exportable while recomputing.
    const timer = setTimeout(() => {
      const generateProof = async () => {
        if (cancelled) return;
        try {
          const bytes = await runPdfBuildTask('job', {
            front: { file: sourceFile, meta, pageIndex: meta.pageIndex },
            back: duplex ? { file: effectiveBackFile, meta: backMeta, pageIndex: backMeta.pageIndex } : null,
            settings,
          });
          if (cancelled) return;
          const images = await renderOutputPdf(bytes);
          if (!cancelled) { replaceProofImages({ request: proofRequest, bytes, images }); setError(''); }
          else revokeImageUrls(images);
        } catch (failure) {
          if (!cancelled) setError(`Preview generation failed: ${failure.message}`);
        } finally {
          if (!cancelled) setBusy(false);
        }
      };
      proofBuildQueue.current = proofBuildQueue.current.then(generateProof, generateProof);
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [proofRequest, geometricFit, masterConfirmed]);


  const setBarcodeFromEntry = async (name, entries = barcodeEntries) => {
    setBarcodeName(name);
    if (!name) {
      setBarcodeFile(null);
      return;
    }
    const entry = entries.find(item => item.name === name);
    if (!entry) {
      setBarcodeFile(null);
      setError(`Barcode ${name} is not available. Reconnect its folder.`);
      return;
    }
    try {
      const file = entry.file || await entry.handle.getFile();
      await inspectBarcode(file);
      setBarcodeFile(file);
      setError('');
    } catch (barcodeError) {
      setBarcodeFile(null);
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
      topTrim: topOffset, horizontalPlacement, sideTrim, marks, duploRegMark,
      trimBoxOutline, trimBoxColor, trimBoxOutput, barcodeName,
      duplex, backInput, backRotation, flipEdge, finishingSide,
      frontPage: meta?.pageIndex ?? selectedPage, backPage: backMeta?.pageIndex ?? backSelectedPage,
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
    setTopOffset(preset.topTrim); setHorizontalPlacement(preset.horizontalPlacement || 'center'); setSideTrim(preset.sideTrim ?? 10); setMarks(preset.marks ?? true); setDuploRegMark(preset.duploRegMark);
    setTrimBoxOutline(Boolean(preset.trimBoxOutline)); setTrimBoxColor(preset.trimBoxColor || '#ff00ff'); setTrimBoxOutput(preset.trimBoxOutput || 'preview');
    setDuplex(Boolean(preset.duplex)); setBackInput(preset.backInput || 'same');
    setSelectedPage(preset.frontPage ?? 0); setBackSelectedPage(preset.backPage ?? 1);
    setBackRotation(preset.backRotation ?? 0); setFinishingSide(preset.finishingSide || 'front');
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

  const clearFront = () => {
    setSourceFile(null); setSelectedPage(0); replaceProofImages(null); setError(''); setMasterConfirmed(false);
    setFillMode('repeat'); setMixedPlacements({}); setMixedBackPlacements({}); setSelectedCell(null); setPlacementNotice('');
  };
  const newJob = () => {
    clearFront(); setBackFile(null); setBackInput('same'); setBackSelectedPage(1); setInspection(null);
    setRotation(0); setBackRotation(0); setRotationPattern('same');
    setDuplex(false); setProofView('both'); setExportSide('both'); setFinishingSide('front');
    setPaperPreset('13x19'); setSheetW(330.2); setSheetH(482.6); setCols(1); setRows(1);
    setGutterCut(5); setGutterSlit(5); setTopOffset(10); setHorizontalPlacement('center'); setSideTrim(10);
    setMarks(true); setDuploRegMark(true); setTrimBoxOutline(false); setTrimBoxColor('#ff00ff'); setTrimBoxOutput('preview'); setBarcodeFile(null); setBarcodeName('');
    setMasterConfirmed(false); setFillMode('repeat'); setMixedPlacements({}); setMixedBackPlacements({}); setSelectedCell(null); setPlacementNotice('');
    setPresetName(''); setSelectedPresetId(''); setPresetsOpen(false); setBarcodeOpen(false);
    setEditingSide('front'); changeInspectorTab('artwork'); setExportOpen(false);
  };
  const requestNewJob = () => {
    if (sourceFile && !window.confirm('Start a new job? Current artwork and unsaved settings will be cleared.')) return;
    newJob();
  };
  const upload = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setSourceFile(file); setSelectedPage(0); setError(''); setMasterConfirmed(false);
    setFillMode('repeat'); setMixedPlacements({}); setMixedBackPlacements({}); setSelectedCell(null); setPlacementNotice('');
  };
  const updateSidePlacements = (side, updater) => (side === 'back' ? setMixedBackPlacements : setMixedPlacements)(updater);
  const addPlacementFile = async (file, cellIndex = selectedCell, side = selectedPlacementSide) => {
    const masterMeta = side === 'back' ? backMeta : meta;
    const masterRotation = side === 'back' ? backRotation : rotation;
    if (!file || cellIndex === null || !masterMeta) return;
    if (!file.name?.toLowerCase().endsWith('.pdf')) {
      setPlacementNotice('Only PDF artwork can be placed in a block.');
      return;
    }
    try {
      const placementMeta = await inspectPdf(file, 0);
      const candidates = [...new Set([masterRotation, (masterRotation + 180) % 360, (masterRotation + 90) % 360, (masterRotation + 270) % 360])];
      const fittingRotation = candidates.find(angle => classifyPlacement(itemW, itemH, placementMeta, angle).status !== 'oversized');
      if (fittingRotation === undefined) {
        setPlacementNotice(`${file.name}: Finished size is larger than the confirmed ${display(itemW)} × ${display(itemH)} slot.`);
        return;
      }
      const fit = classifyPlacement(itemW, itemH, placementMeta, fittingRotation);
      updateSidePlacements(side, current => ({ ...current, [cellIndex]: {
        file, meta: placementMeta, pageIndex: placementMeta.pageIndex, rotation: fittingRotation,
      } }));
      setSelectedCell(cellIndex);
      setSelectedPlacementSide(side);
      setPlacementNotice(fit.status === 'smaller'
        ? `${file.name}: Finished size ${display(fit.width)} × ${display(fit.height)} is smaller and will be centered at 100% scale.`
        : fittingRotation ? `${file.name}: Rotated ${fittingRotation}° to match the confirmed slot.` : '');
      setError('');
    } catch (failure) { setPlacementNotice(`Replacement PDF could not be read: ${failure.message}`); }
  };
  const uploadPlacement = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const cellIndex = pendingPlacementCell.current ?? selectedCell;
    const side = pendingPlacementSide.current ?? selectedPlacementSide;
    pendingPlacementCell.current = null;
    pendingPlacementSide.current = 'front';
    await addPlacementFile(file, cellIndex, side);
  };
  const selectPlacementCell = (cellIndex, side = 'front') => {
    setSelectedCell(cellIndex);
    setSelectedPlacementSide(side);
    setPlacementNotice('');
    changeInspectorTab('artwork');
  };
  const startEditorDrag = event => {
    if (event.button !== 0 || event.target.closest('button, select, input')) return;
    const toolbar = event.currentTarget.closest('.placement-context-toolbar');
    const boundary = toolbar?.closest('.canvas-wrap');
    if (!toolbar || !boundary) return;
    const toolbarRect = toolbar.getBoundingClientRect();
    const boundaryRect = boundary.getBoundingClientRect();
    editorDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: editorOffset.x,
      originY: editorOffset.y,
      minX: editorOffset.x + boundaryRect.left + 10 - toolbarRect.left,
      maxX: editorOffset.x + boundaryRect.right - 10 - toolbarRect.right,
      minY: editorOffset.y + boundaryRect.top + 10 - toolbarRect.top,
      maxY: editorOffset.y + boundaryRect.bottom - 10 - toolbarRect.bottom,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setEditorDragging(true);
  };
  const moveEditorDrag = event => {
    const drag = editorDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const x = Math.max(drag.minX, Math.min(drag.maxX, drag.originX + event.clientX - drag.startX));
    const y = Math.max(drag.minY, Math.min(drag.maxY, drag.originY + event.clientY - drag.startY));
    drag.currentX = x;
    drag.currentY = y;
    const toolbar = editorToolbar.current;
    if (toolbar) {
      toolbar.style.setProperty('--editor-drag-x', `${x}px`);
      toolbar.style.setProperty('--editor-drag-y', `${y}px`);
    }
  };
  const endEditorDrag = event => {
    if (editorDrag.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setEditorOffset({
      x: editorDrag.current.currentX ?? editorDrag.current.originX,
      y: editorDrag.current.currentY ?? editorDrag.current.originY,
    });
    editorDrag.current = null;
    setEditorDragging(false);
  };
  const moveEditorWithKeyboard = event => {
    if (event.target !== event.currentTarget) return;
    const direction = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
    if (!direction && event.key !== 'Home') return;
    event.preventDefault();
    if (event.key === 'Home') { setEditorOffset({ x: 0, y: 0 }); return; }
    const toolbar = event.currentTarget.closest('.placement-context-toolbar');
    const boundary = toolbar?.closest('.canvas-wrap');
    if (!toolbar || !boundary) return;
    const toolbarRect = toolbar.getBoundingClientRect();
    const boundaryRect = boundary.getBoundingClientRect();
    const step = event.shiftKey ? 1 : 10;
    const xDelta = Math.sign(direction[0]) * step;
    const yDelta = Math.sign(direction[1]) * step;
    setEditorOffset(current => ({
      x: Math.max(current.x + boundaryRect.left + 10 - toolbarRect.left, Math.min(current.x + boundaryRect.right - 10 - toolbarRect.right, current.x + xDelta)),
      y: Math.max(current.y + boundaryRect.top + 10 - toolbarRect.top, Math.min(current.y + boundaryRect.bottom - 10 - toolbarRect.bottom, current.y + yDelta)),
    }));
  };
  const changePlacementFile = () => {
    if (selectedCell === null) return;
    pendingPlacementCell.current = selectedCell;
    pendingPlacementSide.current = selectedPlacementSide;
    slotUploadInput.current?.click();
  };
  const dropPlacement = async (event, cellIndex, side) => {
    event.preventDefault();
    event.stopPropagation();
    setDraggedOverCell(null);
    changeInspectorTab('artwork');
    const file = Array.from(event.dataTransfer.files || []).find(item => item.name.toLowerCase().endsWith('.pdf'));
    if (!file) {
      setSelectedCell(cellIndex);
      setSelectedPlacementSide(side);
      setPlacementNotice('Drop a PDF file onto the block.');
      return;
    }
    await addPlacementFile(file, cellIndex, side);
  };
  const updatePlacementPage = async pageIndex => {
    if (selectedCell === null || !selectedBlockFile || !selectedBlockMeta) return;
    try {
      const placementMeta = await inspectPdf(selectedBlockFile, pageIndex);
      const fit = classifyPlacement(itemW, itemH, placementMeta, selectedBlockRotation);
      if (fit.status === 'oversized') { setPlacementNotice(`PDF page ${pageIndex + 1} is larger than the confirmed slot.`); return; }
      updateSidePlacements(selectedPlacementSide, current => ({ ...current, [selectedCell]: { file: selectedBlockFile, meta: placementMeta, pageIndex: placementMeta.pageIndex, rotation: selectedBlockRotation } }));
      setPlacementNotice(fit.status === 'smaller' ? `PDF page ${pageIndex + 1} is smaller and will be centered.` : `${selectedPlacementSide === 'back' ? 'Back' : 'Front'} Block ${selectedCell + 1} now uses Page ${pageIndex + 1}.`);
    } catch (failure) { setPlacementNotice(`PDF page could not be read: ${failure.message}`); }
  };
  const updatePlacementRotation = nextRotation => {
    if (selectedCell === null || !selectedBlockFile || !selectedBlockMeta) return;
    const fit = classifyPlacement(itemW, itemH, selectedBlockMeta, nextRotation);
    if (fit.status === 'oversized') { setPlacementNotice('This rotation would make the artwork larger than the confirmed slot.'); return; }
    updateSidePlacements(selectedPlacementSide, current => ({ ...current, [selectedCell]: { file: selectedBlockFile, meta: selectedBlockMeta, pageIndex: selectedBlockPage, rotation: nextRotation } }));
    setPlacementNotice(fit.status === 'smaller' ? `Rotated ${nextRotation}°. Smaller artwork remains centered.` : `Rotated ${nextRotation}°.`);
  };
  const clearPlacement = () => {
    if (selectedCell === null) return;
    updateSidePlacements(selectedPlacementSide, current => { const next = { ...current }; delete next[selectedCell]; return next; });
    setPlacementNotice(`${selectedPlacementSide === 'back' ? 'Back' : 'Front'} block now uses the master artwork.`);
  };
  const changeMasterPage = pageIndex => {
    if (!meta) return;
    setSelectedPage(Math.max(0, Math.min(meta.pages - 1, pageIndex)));
    setMasterConfirmed(false);
    setMixedPlacements({}); setMixedBackPlacements({});
    setSelectedCell(null);
    setError('');
  };
  const confirmMasterSize = () => {
    setMasterConfirmed(true);
    setSizeConfirmOpen(false);
    setPlacementNotice('');
  };
  const uploadBack = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBackFile(file); setBackSelectedPage(0); setMixedBackPlacements({}); setError('');
  };
  const downloadOutput = async () => {
    if (!outputBytes || processing || !canExport) return;
    try {
      const side = duplex ? exportSide : 'front';
      const bytes = duplex && side !== 'both' ? await extractOutputSide(outputBytes, side === 'front' ? 0 : 1) : outputBytes;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = duplex ? `duplo-616-${side === 'both' ? 'front-back' : side}.pdf` : 'duplo-616-imposed.pdf';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setExportOpen(false);
    } catch (failure) { setError(`Export failed: ${failure.message}`); }
  };

  return <main className="app app-redesign">
    <nav className="utility-rail" aria-label="Job actions">
      <div className="rail-brand" aria-label="Repeat PDF Imposition"><span className="brand-mark">R</span></div>
      <div className="preset-menu-wrap">
        <button className="rail-action" type="button" title="Presets" aria-expanded={presetsOpen} aria-controls="preset-menu" onClick={() => setPresetsOpen(open => !open)}><Settings2 size={18}/><span>Presets</span></button>
        {presetsOpen && <section id="preset-menu" className="preset-menu" aria-label="Saved presets">
          <div className="preset-menu-title"><div><b>Presets</b><span>Save or reuse the complete job setup</span></div><button type="button" aria-label="Close presets" onClick={() => setPresetsOpen(false)}><X size={15}/></button></div>
          <input className="preset-name" aria-label="Preset name" placeholder="Preset name" value={presetName} onChange={event => setPresetName(event.target.value)}/>
          <button type="button" className="secondary preset-save" onClick={savePreset}><Save size={14}/> Save current settings</button>
          <div className="preset-actions"><select aria-label="Saved preset" value={selectedPresetId} onChange={event => setSelectedPresetId(event.target.value)}><option value="">Choose saved preset</option>{savedPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><button type="button" className="secondary" disabled={!selectedPresetId} onClick={async () => { await applyPreset(); setPresetsOpen(false); }}>Apply</button><button type="button" className="icon-button" aria-label="Delete selected preset" disabled={!selectedPresetId} onClick={deletePreset}><Trash2 size={14}/></button></div>
        </section>}
      </div>
      <div className="rail-spacer"/>
      <button className="rail-action rail-export" type="button" title="Export imposed PDF" disabled={!exportReady} onClick={() => setExportOpen(true)}><Download size={19}/><span>{processing ? 'Working' : 'Export'}</span></button>
      <div className="rail-unit" aria-label="Measurement unit"><button className={unit === 'mm' ? 'selected' : ''} onClick={() => setUnit('mm')}>mm</button><button className={unit === 'in' ? 'selected' : ''} onClick={() => setUnit('in')}>in</button></div>
    </nav>

    <section className="work redesigned-work">
      <div className="proof-toolbar">
        <button className="start-new-job" type="button" onClick={requestNewJob}><RefreshCcw size={14}/><span>Start new job</span></button>
        {meta && masterConfirmed && <div className="confirmed-size-bar" aria-label={`Confirmed finished size ${display(itemW)} by ${display(itemH)}`}><span>Finished size</span><strong>{display(itemW)} × {display(itemH)}</strong><button type="button" onClick={() => setSizeConfirmOpen(true)}>Change</button></div>}
        {duplex && <div className="view-switch" aria-label="Proof view">{['front', 'back', 'both'].map(view => <button key={view} aria-pressed={proofView === view} onClick={() => setProofView(view)}>{view === 'both' ? 'Both' : view === 'front' ? 'Front' : 'Back'}</button>)}</div>}
      </div>
      <div className={`canvas-wrap duplex-canvas ${shownSides.length === 2 ? 'two-proofs' : ''}`} aria-busy={processing}>
        {shownSides.map((side, index) => {
          const sideGeometry = plan?.sides.find(item => item.side === side);
          const selectedGeometryCell = sideGeometry?.cells.find(cell => cell.slotIndex === selectedCell);
          const toolbarBelow = Boolean(selectedGeometryCell && selectedGeometryCell.y / sheetH < 0.14);
          return <figure className="proof-panel" key={side}>
          <figcaption>{side === 'front' ? 'Front' : 'Back'}<small>Output proof</small></figcaption>
          <div className="proof-frame"><div className="proof-stage" style={{ '--sheet-ratio': sheetW / sheetH }}>
            {index === 0 && <><div className="sheet-dimension dimension-width" aria-label={`Sheet width ${displaySheetInches(sheetW)}`}><span>{displaySheetInches(sheetW)}</span></div><div className="sheet-dimension dimension-height" aria-label={`Sheet height ${displaySheetInches(sheetH)}`}><span>{displaySheetInches(sheetH)}</span></div></>}
            <div className="sheet proof-sheet" style={{ aspectRatio: sheetW / sheetH, '--sheet-ratio': sheetW / sheetH }}>
              {proofImages[side === 'front' ? 0 : 1] ? <img className="proof-image" src={proofImages[side === 'front' ? 0 : 1]} alt={`${side === 'front' ? 'Front' : 'Back'} exported PDF proof`}/> : <div className="proof-empty">{processing ? 'Generating output proof…' : statusError || (sourceFile && !geometricFit ? 'Front or Back layout does not fit this sheet' : 'Upload a PDF to generate the exact output proof')}</div>}
              {trimBoxOutline && trimBoxOutput === 'preview' && sideGeometry && <svg className="trimbox-outline-overlay" viewBox={`0 0 ${sheetW} ${sheetH}`} aria-label={`${side === 'front' ? 'Front' : 'Back'} TrimBox preview guide`}>
                {sideGeometry.cells.map(cell => <rect key={cell.slotIndex} x={cell.x} y={cell.y} width={sideGeometry.itemW} height={sideGeometry.itemH} style={{ stroke: trimBoxColor }}/>)}</svg>}
              {fillMode === 'mixed' && masterConfirmed && sideGeometry && <div className="placement-overlay" aria-label={`${side === 'back' ? 'Back' : 'Front'} mixed artwork slots`}>{sideGeometry.cells.map(cell => {
                const sidePlacements = side === 'back' ? mixedBackPlacements : mixedPlacements;
                const replacement = sidePlacements[cell.slotIndex];
                const cellKey = `${side}-${cell.slotIndex}`;
                return <div key={cell.slotIndex} className="placement-slot-shell" style={{ left: `${cell.x / sheetW * 100}%`, top: `${cell.y / sheetH * 100}%`, width: `${sideGeometry.itemW / sheetW * 100}%`, height: `${sideGeometry.itemH / sheetH * 100}%` }}>
                  <button type="button" className={`placement-hotspot ${selectedCell === cell.slotIndex && selectedPlacementSide === side ? 'is-selected' : ''} ${replacement ? 'has-replacement' : ''} ${draggedOverCell === cellKey ? 'is-dragover' : ''}`}
                  aria-label={`${side === 'back' ? 'Back' : 'Front'} block ${cell.slotIndex + 1}${replacement ? `, ${replacement.file.name}` : ', master artwork'}. Click to edit or drop a PDF to replace.`}
                  onClick={() => selectPlacementCell(cell.slotIndex, side)}
                  onDragEnter={event => { event.preventDefault(); setDraggedOverCell(cellKey); }}
                  onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDraggedOverCell(cellKey); }}
                  onDragLeave={() => setDraggedOverCell(current => current === cellKey ? null : current)}
                  onDrop={event => dropPlacement(event, cell.slotIndex, side)}>
                  <span className="placement-slot-number">{cell.slotIndex + 1}</span>
                  <span className="placement-slot-action"><FileUp size={14}/>{draggedOverCell === cellKey ? 'Drop PDF here' : 'Edit block'}</span>
                  </button>
                  <button type="button" className="placement-slot-preview" aria-label={`Preview ${side} block ${cell.slotIndex + 1}`} title="Preview block" onClick={() => setPreviewCell({ side, cellIndex: cell.slotIndex })}><ZoomIn size={15}/></button>
                </div>;
              })}</div>}
            </div>
            {selectedPlacementSide === side && fillMode === 'mixed' && masterConfirmed && selectedGeometryCell && <div ref={editorToolbar} className={`placement-context-toolbar ${toolbarBelow ? 'is-below' : ''} ${editorDragging ? 'is-dragging' : ''}`}
              style={{ left: '50%', top: `${(toolbarBelow ? selectedGeometryCell.y + sideGeometry.itemH : selectedGeometryCell.y) / sheetH * 100}%`, '--editor-drag-x': `${editorOffset.x}px`, '--editor-drag-y': `${editorOffset.y}px` }} role="group" aria-label={`Edit ${side} block ${selectedCell + 1}`}>
              <div className="placement-context-title" tabIndex={0} aria-label="Move block editor. Drag or use arrow keys. Press Home to reset position." title="Drag to move · double-click to reset position" onPointerDown={startEditorDrag} onPointerMove={moveEditorDrag} onPointerUp={endEditorDrag} onPointerCancel={endEditorDrag} onDoubleClick={() => setEditorOffset({ x: 0, y: 0 })} onKeyDown={moveEditorWithKeyboard}><GripHorizontal className="placement-drag-grip" size={18} aria-hidden="true"/><div><b>{side === 'back' ? 'Back' : 'Front'} · Block {selectedCell + 1}</b><span title={selectedPlacement ? selectedPlacement.file.name : selectedMasterFile?.name}>{selectedPlacement ? selectedPlacement.file.name : selectedMasterFile?.name || 'Master artwork'}</span></div><button type="button" className="context-close" aria-label="Close block editor" onClick={() => setSelectedCell(null)}><X size={15}/></button></div>
              <div className="placement-primary-controls">
                {selectedBlockMeta && <div className="placement-control-group"><span className="placement-control-caption">Page</span><div className="compact-page-control" aria-label="Block page navigation"><button type="button" aria-label="Previous block page" disabled={selectedBlockPage === 0} onClick={() => updatePlacementPage(selectedBlockPage - 1)}><ChevronLeft size={15}/></button><select aria-label="Block PDF page" value={selectedBlockPage} onChange={event => updatePlacementPage(Number(event.target.value))}>{Array.from({ length: selectedBlockMeta.pages }, (_, pageIndex) => <option key={pageIndex} value={pageIndex}>{pageIndex + 1} / {selectedBlockMeta.pages}</option>)}</select><button type="button" aria-label="Next block page" disabled={selectedBlockPage === selectedBlockMeta.pages - 1} onClick={() => updatePlacementPage(selectedBlockPage + 1)}><ChevronRight size={15}/></button></div></div>}
                <label className="placement-control-group"><span className="placement-control-caption">Rotation</span><span className="compact-rotation-control"><RotateCw size={14}/><select aria-label="Block rotation" value={selectedBlockRotation} onChange={event => updatePlacementRotation(Number(event.target.value))}>{[0, 90, 180, 270].map(angle => <option key={angle} value={angle} disabled={classifyPlacement(itemW, itemH, selectedBlockMeta, angle).status === 'oversized'}>{angle}°</option>)}</select></span></label>
              </div>
              <div className="placement-context-actions"><button type="button" onClick={changePlacementFile}><FileUp size={13}/> Change PDF</button><button type="button" disabled={!selectedPlacement} onClick={clearPlacement}><RefreshCcw size={13}/> Reset</button></div>
            </div>}
          </div></div>
        </figure>;})}
      </div>
      {previewCell && previewGeometry && previewCellGeometry && <div className="block-preview-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setPreviewCell(null); }}>
        <section className="block-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="block-preview-title">
          <header><div><b id="block-preview-title">{previewCell.side === 'back' ? 'Back' : 'Front'} · Block {previewCell.cellIndex + 1}</b><span>Preview only · artwork size, ratio and export stay unchanged</span></div><button type="button" aria-label="Close block preview" onClick={() => setPreviewCell(null)}><X size={18}/></button></header>
          <div className="block-preview-crop" style={{ aspectRatio: previewGeometry.itemW / previewGeometry.itemH }}>
            {blockPreview.image ? <img src={blockPreview.image} alt={`${previewCell.side === 'back' ? 'Back' : 'Front'} block ${previewCell.cellIndex + 1} isolated preview`}/> : <span>{blockPreview.error || 'Rendering selected block…'}</span>}
          </div>
          <p>Inspection view only. The PDF artwork remains at its original 100% size and original aspect ratio.</p>
        </section>
      </div>}
      <footer><button type="button" className={`proof-status ${exportReady ? 'ok' : 'warn'}`} disabled={exportReady || processing} onClick={reviewIssue}>{exportReady ? <CheckCircle2/> : <AlertTriangle/>} {processing ? 'Updating proof…' : !sourceFile ? 'Choose artwork →' : meta && !masterConfirmed ? 'Confirm item size →' : barcodeNeedsAttention ? 'Review barcode →' : !outputBytes ? 'Review artwork / layout →' : trimBoxOutline && trimBoxOutput === 'preview' ? 'TrimBox guide · not exported' : 'Preview matches export'}</button><span>Finished · {display(itemW)} × {display(itemH)}</span><span>{cols} × {rows} · {cols * rows} up{duplex ? ' / side' : ''}</span></footer>
    </section>

    <aside className="inspector redesigned-inspector">
      <InspectorTabs value={inspectorTab} onChange={changeInspectorTab}/>
      {issueText && !processing && <div className="inspector-issue" role="alert"><AlertTriangle size={16}/><div><p>{issueText}</p><button type="button" onClick={reviewIssue}>Review {issueTab === 'duplo' ? 'barcode' : issueTab} →</button></div></div>}
      <div className="inspector-body" ref={inspectorScroll}>
      <section className="artwork-panel" role="tabpanel" id="panel-artwork" aria-labelledby="tab-artwork" hidden={inspectorTab !== 'artwork'}>
        <div className="panel-heading"><span className="eyebrow">01 / SOURCE</span><h1>Choose your artwork</h1><p className="section-intro">Set each side’s PDF page and direction here.</p></div>
        <SegmentedChoice label="Printed sides" name="Job mode" value={duplex ? 'duplex' : 'single'} options={[{ value: 'single', label: 'Single side' }, { value: 'duplex', label: 'Double side' }]} onChange={value => { setDuplex(value === 'duplex'); setFillMode('repeat'); setMixedPlacements({}); setMixedBackPlacements({}); setSelectedCell(null); setSelectedPlacementSide('front'); setEditingSide('front'); setError(''); }}/>
        <SourceCard side="Front" expanded={editingSide === 'front'} onToggle={() => setEditingSide(editingSide === 'front' ? '' : 'front')} fileName={sourceFile?.name} pageIndex={meta?.pageIndex ?? selectedPage} angle={rotation} dimensions={meta ? `${display(itemW)} × ${display(itemH)}` : ''}>
          <section className="upload compact-upload"><input id="upload" aria-label="Upload front PDF" type="file" accept="application/pdf" onChange={upload}/><label htmlFor="upload"><FileUp size={17}/><b>{sourceFile ? 'Replace PDF' : 'Upload PDF'}</b></label>{sourceFile && <button className="clear" onClick={clearFront}><X size={14}/> Remove</button>}</section>
          {meta && <label className="select compact-select"><span>Source PDF page</span><select aria-label="Front page" value={meta.pageIndex} onChange={event => { setSelectedPage(Number(event.target.value)); setMasterConfirmed(false); setMixedPlacements({}); setMixedBackPlacements({}); setSelectedCell(null); setError(''); }}>{Array.from({ length: meta.pages }, (_, index) => <option key={index} value={index}>PDF page {index + 1} of {meta.pages}</option>)}</select></label>}
          <ArtworkDirection side="Front" value={rotation} onChange={angle => { setRotation(angle); setMasterConfirmed(false); setMixedPlacements({}); setMixedBackPlacements({}); setSelectedCell(null); }}/>
          {meta && <button type="button" className={`master-size-confirm ${masterConfirmed ? 'is-confirmed' : ''}`} onClick={() => setSizeConfirmOpen(true)}>{masterConfirmed ? <CheckCircle2 size={15}/> : <AlertTriangle size={15}/>}<span>{masterConfirmed ? 'Finished size confirmed' : 'Confirm finished size'}<small>{display(itemW)} × {display(itemH)} · no scaling{masterConfirmed ? ' · Change' : ''}</small></span></button>}
        </SourceCard>
        {duplex && <SourceCard side="Back" expanded={editingSide === 'back'} onToggle={() => setEditingSide(editingSide === 'back' ? '' : 'back')} fileName={effectiveBackFile?.name} pageIndex={backMeta?.pageIndex ?? backSelectedPage} angle={backRotation} dimensions={backSize ? `${display(backSize.width)} × ${display(backSize.height)}` : ''}>
          <SegmentedChoice label="Back source" value={backInput} options={[{ value: 'same', label: 'Same PDF' }, { value: 'separate', label: 'Separate PDF' }]} onChange={value => { setBackInput(value); setBackSelectedPage(value === 'same' ? 1 : 0); setMixedBackPlacements({}); setError(''); }}/>
          {backInput === 'separate' && <><section className="upload compact-upload"><input id="upload-back" aria-label="Upload back PDF" type="file" accept="application/pdf" onChange={uploadBack}/><label htmlFor="upload-back"><FileUp size={17}/><b>{backFile ? 'Replace back PDF' : 'Upload back PDF'}</b></label>{backFile && <button className="clear" onClick={() => { setBackFile(null); setMixedBackPlacements({}); setError(''); }}><X size={14}/> Remove</button>}</section>{backFile && <p className="source-name" title={backFile.name}>{backFile.name}</p>}</>}
          {backMeta && <label className="select compact-select"><span>Source PDF page</span><select aria-label="Back page" value={backMeta.pageIndex} onChange={event => { setBackSelectedPage(Number(event.target.value)); setMixedBackPlacements({}); setError(''); }}>{Array.from({ length: backMeta.pages }, (_, index) => <option key={index} value={index}>PDF page {index + 1} of {backMeta.pages}</option>)}</select></label>}
          {backInput === 'same' && meta?.pages === 1 && <p className="hint">This PDF has one page. Both sides use Page 1; upload a separate back if needed.</p>}
          <ArtworkDirection side="Back" value={backRotation} onChange={angle => { setBackRotation(angle); setMixedBackPlacements({}); }}/>
        </SourceCard>}
        {meta && sizesMatch && duplex && <div className="source-check"><CheckCircle2 size={16}/><span>Finished sizes match<small>{display(itemW)} × {display(itemH)} · no scaling</small></span></div>}
        {meta && masterConfirmed && sizesMatch && <section className="fill-mode-section"><SegmentedChoice label="Artwork filling" value={fillMode} options={[{ value: 'repeat', label: 'Repeat one artwork' }, { value: 'mixed', label: 'Mixed artworks' }]} onChange={value => { setFillMode(value); setSelectedCell(value === 'mixed' ? 0 : null); setSelectedPlacementSide('front'); setPlacementNotice(''); }}/>
          {fillMode === 'mixed' && <div className="slot-editor"><input ref={slotUploadInput} className="visually-hidden" aria-label="Choose replacement artwork PDF" type="file" accept="application/pdf" onChange={uploadPlacement}/><div className="slot-editor-heading"><div><b>{selectedCell === null ? 'Select a block on the sheet' : `${selectedPlacementSide === 'back' ? 'Back' : 'Front'} · Block ${selectedCell + 1}`}</b><span>{selectedPlacement ? `${selectedPlacement.file.name} · Page ${selectedPlacement.pageIndex + 1}` : selectedCell === null ? 'Click to edit · drop a PDF to replace' : `Master PDF · Page ${(selectedMasterMeta?.pageIndex ?? 0) + 1}`}</span></div></div>
            {placementNotice && <p className="placement-notice" role="status">{placementNotice}</p>}
            <p className="hint">Click a Front or Back block to edit that side. Preview enlarges only the inspection view; artwork size, ratio and export never change.</p>
          </div>}
        </section>}
        <div className="panel-next"><span>Ready to arrange the sheet?</span><button type="button" onClick={() => changeInspectorTab('layout')}>Sheet & grid layout →</button></div>
      </section>
      <div className="tab-panel" role="tabpanel" id="panel-layout" aria-labelledby="tab-layout" hidden={inspectorTab !== 'layout'}>
        <div className="panel-heading"><span className="eyebrow">02 / ARRANGE</span><h1>Build the sheet</h1></div>
        <section><h2>Sheet & repeat</h2><label className="select"><span>Paper size</span><select aria-label="Sheet preset" value={paperPreset} onChange={event => selectPaper(event.target.value)}><option value="13x19">13 × 19 in</option><option value="12.4x18.4">12.4 × 18.4 in</option><option value="custom">Custom size</option></select></label>{paperPreset === 'custom' && <div className="two"><NumberField label="Sheet width" value={sheetW} setValue={setSheetW} min={MIN_SHEET_MM} max={MAX_SHEET_WIDTH_MM} unit={unit} factor={factor}/><NumberField label="Sheet length" value={sheetH} setValue={setSheetH} min={MIN_SHEET_MM} max={MAX_SHEET_HEIGHT_MM} unit={unit} factor={factor}/></div>}<div className="two"><NumberField label="Columns" value={cols} setValue={setCols} min={1} max={25} unit=""/><NumberField label="Rows" value={rows} setValue={setRows} min={1} max={25} unit=""/></div><div className="layout-total"><span>Total up</span><b>{cols * rows}</b></div></section>
        <section><PatternPicker value={rotationPattern} onChange={setRotationPattern} duplex={duplex}/></section>
        {duplex && <section><details className="inline-help duplex-guidance"><summary>Duplex alignment · Long edge</summary><p className="hint">The sheet always turns left / right. Print one test sheet at 100% before production. Back cut positions follow Front; artwork text is never mirrored.</p>{plan?.sides[1] && <div className="calculation"><span>Back placement · automatic</span><b>Top {display(plan.sides[1].y)} · Right {display(sheetW - plan.sides[1].x - layoutW)}</b></div>}</details></section>}
        <details className="advanced output-details"><summary>Output size & bleed</summary><div className="details-body"><div className="summary-grid"><span>Finished item<b>{display(itemW)} × {display(itemH)}</b></span><span>Layout<b>{display(layoutW)} × {display(layoutH)}</b></span><span>Outer bleed<b>T {display(appliedOuterBleed.top)} · B {display(appliedOuterBleed.bottom)} · L {display(appliedOuterBleed.left)} · R {display(appliedOuterBleed.right)}</b></span></div>{duplex && plan?.sides[1] && <p className="hint">Back outer bleed: {Object.entries(plan.sides[1].outer).map(([side, value]) => `${side} ${display(value)}`).join(' · ')}</p>}</div></details>
        {(outerBleedShortfall || plan?.sides.some(side => !side.marksOnSheet)) && <div className="layout-advisory">{outerBleedShortfall && <p>Some source bleed is below 3 mm. Available bleed is used without stretching.</p>}{plan?.sides.some(side => !side.marksOnSheet) && <p>Some trim marks fall outside the sheet. Increase margins for full marks.</p>}</div>}
      </div>
      <div className="tab-panel marks-panel" role="tabpanel" id="panel-marks" aria-labelledby="tab-marks" hidden={inspectorTab !== 'marks'}>
        <div className="panel-heading"><span className="eyebrow">03 / OUTPUT MARKS</span><h1>Marks</h1><p className="section-intro">Control item outlines and sheet finishing marks.</p></div>
        <section className="mark-setting-card"><label className="toggle-row mark-main-toggle"><span><b>TrimBox outline</b><small>Exact confirmed TrimBox · 0 mm offset</small></span><input aria-label="TrimBox outline" type="checkbox" checked={trimBoxOutline} onChange={event => setTrimBoxOutline(event.target.checked)}/></label>
          {trimBoxOutline && <div className="mark-setting-options">
            <fieldset className="mark-color-picker"><legend>Color</legend><div className="mark-color-options">{[['#000000','Black 100K'],['#00ffff','Cyan'],['#ff00ff','Magenta'],['#ffff00','Yellow']].map(([color,label]) => <button key={color} type="button" className={trimBoxColor.toLowerCase() === color ? 'is-selected' : ''} aria-label={`${label} TrimBox color`} aria-pressed={trimBoxColor.toLowerCase() === color} title={label} style={{ '--mark-color': color }} onClick={() => setTrimBoxColor(color)}><span/></button>)}<label className="custom-mark-color" title="Custom color"><input aria-label="Custom TrimBox color" type="color" value={trimBoxColor} onChange={event => setTrimBoxColor(event.target.value)}/><span style={{ '--mark-color': trimBoxColor }}/></label></div></fieldset>
            <SegmentedChoice label="Output" name="TrimBox output" value={trimBoxOutput} options={[{ value: 'preview', label: 'Preview only' }, { value: 'export', label: 'Include in PDF' }]} onChange={setTrimBoxOutput}/>
            <div className="calculation mark-spec"><span>Position</span><b>Exact TrimBox · 0 mm offset · 0.25 pt</b></div>
          </div>}
        </section>
        <section><h2>Sheet marks</h2><label className="toggle-row"><span><b>Production trim marks</b><small>Corner, gutter cut and gutter slit marks</small></span><input type="checkbox" checked={marks} onChange={event => setMarks(event.target.checked)}/></label>{(barcodeFile || duploRegMark) && marks && <p className="hint barcode-mark-notice">{barcodeFile && duploRegMark ? 'Barcode and registration marks on' : barcodeFile ? 'Barcode on' : 'Registration mark on'}: top-right corner trim marks hidden {duplex ? finishingSide === 'both' ? 'on both sides' : `on the ${finishingSide}` : 'on this sheet'}.</p>}</section>
        <div className="panel-next"><span>Continue to machine finishing?</span><button type="button" onClick={() => changeInspectorTab('duplo')}>Duplo setup →</button></div>
      </div>
      <div className="tab-panel" role="tabpanel" id="panel-duplo" aria-labelledby="tab-duplo" hidden={inspectorTab !== 'duplo'}>
        <div className="panel-heading"><span className="eyebrow">04 / FINISH</span><h1>Duplo setup</h1></div>
        <section><h2>Duplo finishing</h2><div className="two"><NumberField label="Lead Trim" value={topOffset} setValue={setTopOffset} max={100} unit={unit} factor={factor}/><NumberField label="Side Trim" value={calculatedSideTrim} setValue={setSideTrim} max={100} unit={unit} factor={factor} disabled={horizontalPlacement === 'center'}/></div><SegmentedChoice label="Horizontal placement" value={horizontalPlacement} options={[{ value: 'center', label: 'Centered' }, { value: 'manual', label: 'Manual Side Trim' }]} onChange={mode => { if (mode === 'manual') setSideTrim(calculatedSideTrim); setHorizontalPlacement(mode); }}/><div className="two"><NumberField label="Gutter Cut" value={gutterCut} setValue={setGutterCut} unit={unit} factor={factor}/><NumberField label="Gutter Slit" value={gutterSlit} setValue={setGutterSlit} unit={unit} factor={factor}/></div><p className="hint">Lead Trim is measured from the sheet top to the first finished cut line. Side Trim is measured from the sheet right edge to the first finished slit line.</p></section>
        <section className="switches">{duplex && <label className="select"><span>Duplo barcode & registration on</span><select aria-label="Finishing side" value={finishingSide} onChange={event => setFinishingSide(event.target.value)}><option value="front">Front · finishing feed side</option><option value="back">Back · finishing feed side</option><option value="both">Both sides</option></select></label>}<label className="toggle-row"><span>Duplo registration mark</span><input type="checkbox" checked={duploRegMark} onChange={event => setDuploRegMark(event.target.checked)}/></label></section>
        <details id="barcode-details" className="advanced" open={barcodeOpen} onToggle={event => setBarcodeOpen(event.currentTarget.open)}><summary>Job barcode <span className="details-value">{barcodeName ? barcodeName.replace(/\.pdf$/i, '') : 'None'}</span></summary><div className="details-body"><div className="barcode-actions"><button type="button" className="secondary" onClick={connectBarcodeDirectory}><FolderOpen size={14}/> {barcodeDirectoryHandle ? 'Reconnect folder' : 'Choose barcode folder'}</button><span className="barcode-status">{barcodeFolderStatus}</span></div><label className="session-loader"><input className="barcode-file-input" type="file" accept="application/pdf" multiple webkitdirectory="" onChange={loadBarcodeFilesForSession}/><span>Load folder for this session</span></label><label className="select"><span>Job barcode</span><select aria-label="Job barcode" value={barcodeName} onChange={event => setBarcodeFromEntry(event.target.value)}><option value="">No barcode</option>{barcodeEntries.map(entry => <option key={entry.name} value={entry.name}>{entry.name.replace(/\.pdf$/i, '')}</option>)}</select></label><div className="calculation barcode-spec"><span>Bottom crop · white knockout · top layer</span><b>{display(BARCODE_HEIGHT_MM)} high · top {display(BARCODE_TOP_OFFSET_MM)} · right {display(BARCODE_RIGHT_OFFSET_MM)}</b></div></div></details>
        <div className={canExport ? 'summary compact-check' : 'summary warning compact-check'}><span>DC-616 CHECK</span><b>{!sourceFile ? 'Choose artwork to check fit' : barcodeNeedsAttention ? 'Review barcode before export' : canExport ? 'Sheet & layout fit' : 'Review artwork and layout'}</b><small>Lead {display(topOffset)} · Side {display(calculatedSideTrim)} · Cut {display(gutterCut)} · Slit {display(gutterSlit)}</small></div>
      </div>
      </div>
    </aside>
    {sizeConfirmOpen && meta && <div className="size-confirm-backdrop" role="presentation"><section className="size-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="size-confirm-title">
      <div className="size-confirm-heading"><div><span className="eyebrow">FINISHED SIZE</span><h2 id="size-confirm-title">Confirm before arranging</h2></div><div className="size-unit-switch" aria-label="Finished size unit"><button type="button" aria-pressed={unit === 'mm'} onClick={() => setUnit('mm')}>mm</button><button type="button" aria-pressed={unit === 'in'} onClick={() => setUnit('in')}>in</button></div></div><p className="size-confirm-copy">The selected PDF TrimBox becomes the fixed size for every block. Artwork is never stretched.</p>
      <div className="size-confirm-value"><span>Finished size</span><strong>{display(itemW)} × {display(itemH)}</strong><small>No scaling</small></div>
      <div className="size-confirm-controls"><div><span>Source page</span><div className="size-page-stepper"><button type="button" aria-label="Previous source page" disabled={meta.pageIndex === 0} onClick={() => changeMasterPage(meta.pageIndex - 1)}><ChevronLeft size={15}/></button><select aria-label="Confirm source PDF page" value={meta.pageIndex} onChange={event => changeMasterPage(Number(event.target.value))}>{Array.from({ length: meta.pages }, (_, pageIndex) => <option key={pageIndex} value={pageIndex}>Page {pageIndex + 1} of {meta.pages}</option>)}</select><button type="button" aria-label="Next source page" disabled={meta.pageIndex === meta.pages - 1} onClick={() => changeMasterPage(meta.pageIndex + 1)}><ChevronRight size={15}/></button></div></div><div><span>Direction</span><div className="size-rotation-options">{[0,90,180,270].map(angle => <button type="button" key={angle} aria-pressed={rotation === angle} onClick={() => { setRotation(angle); setMasterConfirmed(false); setMixedPlacements({}); setSelectedCell(null); }}>{angle}°</button>)}</div></div></div>
      <div className="size-confirm-actions"><label className="secondary size-replace"><input type="file" accept="application/pdf" onChange={upload}/><FileUp size={15}/> Choose another PDF</label><button type="button" className="primary-action" onClick={confirmMasterSize}><CheckCircle2 size={16}/> Confirm finished size</button></div>
    </section></div>}
    {exportOpen && <ExportDialog duplex={duplex} side={exportSide} onSideChange={setExportSide} onClose={() => setExportOpen(false)}
      onDownload={downloadOutput} ready={exportReady} sheetLabel={sheetLabel} total={cols * rows} issue={issueText}
      previewGuide={trimBoxOutline && trimBoxOutput === 'preview'}/>}
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
