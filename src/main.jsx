import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, CheckCircle2, Download, FileUp, FolderOpen, Minus, Plus, Save, Settings2, Trash2, X } from 'lucide-react';
import { PDFDocument } from 'pdf-lib';
import { buildJobPdf, planJob, calculateOuterBleed, inspectBarcode, extractOutputSide, finishedSize } from './pdf-engine.js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import './styles.css';
import './duplo.css';
import { ArtworkDirection, ExportDialog, InspectorTabs, PatternPicker, SegmentedChoice } from './workspace-ui.jsx';
import { SourceCard } from './workspace-ui.jsx';
import './workspace-ui.css';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const MM_PER_POINT = 25.4 / 72;
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

async function renderOutputPdf(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  try {
    const pdf = await task.promise;
    const images = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
      images.push(canvas.toDataURL('image/png'));
      page.cleanup();
    }
    return images;
  } finally { await task.destroy(); }
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
  const [duplex, setDuplex] = useState(false);
  const [backInput, setBackInput] = useState('same');
  const [backFile, setBackFile] = useState(null);
  const [backSelectedPage, setBackSelectedPage] = useState(1);
  const [backRotation, setBackRotation] = useState(0);
  const [flipEdge, setFlipEdge] = useState('long');
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

  const factor = unit === 'in' ? 25.4 : 1;
  const display = value => unit === 'in' ? `${(value / 25.4).toFixed(3)} in` : `${Number(value).toFixed(1)} mm`;
  const effectiveBackFile = backInput === 'same' ? sourceFile : backFile;
  const inspectionRequest = useMemo(() => ({ sourceFile, selectedPage, duplex, effectiveBackFile, backSelectedPage }),
    [sourceFile, selectedPage, duplex, effectiveBackFile, backSelectedPage]);
  const meta = inspection?.request === inspectionRequest ? inspection.front : null;
  const backMeta = inspection?.request === inspectionRequest ? inspection.back : null;
  const inspectionError = inspection?.request === inspectionRequest ? inspection.error : '';
  const settings = useMemo(() => ({
    rotation, rotationPattern, cols, rows, sheetW, sheetH, gutterCut, gutterSlit, topOffset,
    horizontalPlacement, sideTrim, marks, duploRegMark, barcodeFile,
    duplex, backRotation, flipEdge, finishingSide,
  }), [rotation, rotationPattern, cols, rows, sheetW, sheetH, gutterCut, gutterSlit, topOffset,
    horizontalPlacement, sideTrim, marks, duploRegMark, barcodeFile, duplex, backRotation, flipEdge, finishingSide]);
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
  const canExport = geometricFit && (!barcodeName || Boolean(barcodeFile));
  const proofRequest = useMemo(() => ({ inspectionRequest, meta, backMeta, settings }), [inspectionRequest, meta, backMeta, settings]);
  const outputBytes = proof?.request === proofRequest ? proof.bytes : null;
  const proofImages = proof?.request === proofRequest ? proof.images : [];
  const processing = busy || Boolean(sourceFile && inspection?.request !== inspectionRequest);
  const statusError = error || inspectionError || (sourceFile && !processing ? planned.error : '');
  const shownSides = duplex ? (proofView === 'both' ? ['front', 'back'] : [proofView]) : ['front'];
  const exportReady = Boolean(outputBytes && !processing && canExport);
  const barcodeNeedsAttention = Boolean(barcodeName && !barcodeFile);
  const sheetLabel = paperPreset === '13x19' ? '13 × 19 in' : paperPreset === '12.4x18.4' ? '12.4 × 18.4 in' : `${display(sheetW)} × ${display(sheetH)}`;
  const backSize = backMeta ? finishedSize(backMeta, backRotation) : null;
  const sizesMatch = Boolean(meta && (!duplex || (backSize && Math.abs(itemW - backSize.width) <= 0.01 && Math.abs(itemH - backSize.height) <= 0.01)));
  const issueText = statusError || (barcodeNeedsAttention ? 'Reconnect the selected barcode file.' : sourceFile && !processing && !geometricFit ? 'This layout does not fit. Review sheet size and repeat count.' : '');
  const issueTab = barcodeNeedsAttention ? 'duplo' : !meta || (duplex && !sizesMatch) || inspectionError ? 'artwork' : 'layout';
  const changeInspectorTab = tab => { setInspectorTab(tab); inspectorScroll.current?.scrollTo({ top: 0 }); };
  const reviewIssue = () => {
    changeInspectorTab(!sourceFile ? 'artwork' : issueTab);
    if (issueTab === 'duplo') setBarcodeOpen(true);
    if (issueTab === 'artwork') setEditingSide(duplex && meta ? 'back' : 'front');
    requestAnimationFrame(() => {
      const target = document.getElementById(issueTab === 'duplo' ? 'barcode-details' : `panel-${!sourceFile ? 'artwork' : issueTab}`);
      target?.scrollIntoView({ block: 'nearest' });
      target?.querySelector('select, input, button')?.focus();
    });
  };

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
    setProof(null);
    if (!sourceFile || !meta || !geometricFit || (duplex && !backMeta)) {
      setBusy(false);
      return () => { cancelled = true; };
    }
    setBusy(true);
    // Debounce stepper changes; never leave a stale proof exportable while recomputing.
    const timer = setTimeout(async () => {
      try {
        const bytes = await buildJobPdf(
          { file: sourceFile, meta, pageIndex: meta.pageIndex },
          duplex ? { file: effectiveBackFile, meta: backMeta, pageIndex: backMeta.pageIndex } : null,
          settings,
        );
        if (cancelled) return;
        const images = await renderOutputPdf(bytes);
        if (!cancelled) { setProof({ request: proofRequest, bytes, images }); setError(''); }
      } catch (failure) {
        if (!cancelled) setError(`Preview generation failed: ${failure.message}`);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [proofRequest, geometricFit]);


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
      topTrim: topOffset, horizontalPlacement, sideTrim, marks, duploRegMark, barcodeName,
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
    setTopOffset(preset.topTrim); setHorizontalPlacement(preset.horizontalPlacement || 'center'); setSideTrim(preset.sideTrim ?? 10); setMarks(preset.marks); setDuploRegMark(preset.duploRegMark);
    setDuplex(Boolean(preset.duplex)); setBackInput(preset.backInput || 'same');
    setSelectedPage(preset.frontPage ?? 0); setBackSelectedPage(preset.backPage ?? 1);
    setBackRotation(preset.backRotation ?? 0); setFlipEdge(preset.flipEdge || 'long'); setFinishingSide(preset.finishingSide || 'front');
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
    setSourceFile(null); setSelectedPage(0); setProof(null); setError('');
  };
  const newJob = () => {
    clearFront(); setBackFile(null); setBackSelectedPage(1); setInspection(null);
    setEditingSide('front'); changeInspectorTab('artwork'); setExportOpen(false);
  };
  const upload = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setSourceFile(file); setSelectedPage(0); setError('');
  };
  const uploadBack = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBackFile(file); setBackSelectedPage(0); setError('');
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
      <button className="rail-action" type="button" title="New Job" onClick={newJob}><Plus size={18}/><span>New</span></button>
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
        <div><b>{paperPreset === '13x19' ? '13 × 19 in' : paperPreset === '12.4x18.4' ? '12.4 × 18.4 in' : 'Custom sheet'}</b><span>{display(sheetW)} × {display(sheetH)} · portrait</span></div>
        {duplex && <div className="view-switch" aria-label="Proof view">{['front', 'back', 'both'].map(view => <button key={view} aria-pressed={proofView === view} onClick={() => setProofView(view)}>{view === 'both' ? 'Both' : view === 'front' ? 'Front' : 'Back'}</button>)}</div>}
      </div>
      <div className={`canvas-wrap duplex-canvas ${shownSides.length === 2 ? 'two-proofs' : ''}`} aria-busy={processing}>
        {shownSides.map(side => <figure className="proof-panel" key={side}>
          <figcaption>{side === 'front' ? 'Front' : 'Back'}<small>Output proof</small></figcaption>
          <div className="proof-frame"><div className="sheet proof-sheet" style={{ aspectRatio: sheetW / sheetH, '--sheet-ratio': sheetW / sheetH }}>
            {proofImages[side === 'front' ? 0 : 1] ? <img className="proof-image" src={proofImages[side === 'front' ? 0 : 1]} alt={`${side === 'front' ? 'Front' : 'Back'} exported PDF proof`}/> : <div className="proof-empty">{processing ? 'Generating output proof…' : statusError || (sourceFile && !geometricFit ? 'Front or Back layout does not fit this sheet' : 'Upload a PDF to generate the exact output proof')}</div>}
          </div></div>
        </figure>)}
      </div>
      <footer><button type="button" className={`proof-status ${exportReady ? 'ok' : 'warn'}`} disabled={exportReady || processing} onClick={reviewIssue}>{exportReady ? <CheckCircle2/> : <AlertTriangle/>} {processing ? 'Updating proof…' : !sourceFile ? 'Choose artwork →' : barcodeNeedsAttention ? 'Review barcode →' : !outputBytes ? 'Review artwork / layout →' : 'Preview matches export'}</button><span>Finished · {display(itemW)} × {display(itemH)}</span><span>{cols} × {rows} · {cols * rows} up{duplex ? ' / side' : ''}</span></footer>
    </section>

    <aside className="inspector redesigned-inspector">
      <InspectorTabs value={inspectorTab} onChange={changeInspectorTab}/>
      {issueText && !processing && <div className="inspector-issue" role="alert"><AlertTriangle size={16}/><div><p>{issueText}</p><button type="button" onClick={reviewIssue}>Review {issueTab === 'duplo' ? 'barcode' : issueTab} →</button></div></div>}
      <div className="inspector-body" ref={inspectorScroll}>
      <section className="artwork-panel" role="tabpanel" id="panel-artwork" aria-labelledby="tab-artwork" hidden={inspectorTab !== 'artwork'}>
        <div className="panel-heading"><span className="eyebrow">01 / SOURCE</span><h1>Choose your artwork</h1><p className="section-intro">Set each side’s PDF page and direction here.</p></div>
        <SegmentedChoice label="Printed sides" name="Job mode" value={duplex ? 'duplex' : 'single'} options={[{ value: 'single', label: 'Single side' }, { value: 'duplex', label: 'Double side' }]} onChange={value => { setDuplex(value === 'duplex'); setEditingSide('front'); setError(''); }}/>
        <SourceCard side="Front" expanded={editingSide === 'front'} onToggle={() => setEditingSide(editingSide === 'front' ? '' : 'front')} fileName={sourceFile?.name} pageIndex={meta?.pageIndex ?? selectedPage} angle={rotation} dimensions={meta ? `${display(itemW)} × ${display(itemH)}` : ''}>
          <section className="upload compact-upload"><input id="upload" aria-label="Upload front PDF" type="file" accept="application/pdf" onChange={upload}/><label htmlFor="upload"><FileUp size={17}/><b>{sourceFile ? 'Replace PDF' : 'Upload PDF'}</b></label>{sourceFile && <button className="clear" onClick={clearFront}><X size={14}/> Remove</button>}</section>
          {meta && <label className="select compact-select"><span>Source PDF page</span><select aria-label="Front page" value={meta.pageIndex} onChange={event => { setSelectedPage(Number(event.target.value)); setError(''); }}>{Array.from({ length: meta.pages }, (_, index) => <option key={index} value={index}>PDF page {index + 1} of {meta.pages}</option>)}</select></label>}
          <ArtworkDirection side="Front" value={rotation} onChange={setRotation}/>
        </SourceCard>
        {duplex && <SourceCard side="Back" expanded={editingSide === 'back'} onToggle={() => setEditingSide(editingSide === 'back' ? '' : 'back')} fileName={effectiveBackFile?.name} pageIndex={backMeta?.pageIndex ?? backSelectedPage} angle={backRotation} dimensions={backSize ? `${display(backSize.width)} × ${display(backSize.height)}` : ''}>
          <SegmentedChoice label="Back source" value={backInput} options={[{ value: 'same', label: 'Same PDF' }, { value: 'separate', label: 'Separate PDF' }]} onChange={value => { setBackInput(value); setBackSelectedPage(value === 'same' ? 1 : 0); setError(''); }}/>
          {backInput === 'separate' && <><section className="upload compact-upload"><input id="upload-back" aria-label="Upload back PDF" type="file" accept="application/pdf" onChange={uploadBack}/><label htmlFor="upload-back"><FileUp size={17}/><b>{backFile ? 'Replace back PDF' : 'Upload back PDF'}</b></label>{backFile && <button className="clear" onClick={() => { setBackFile(null); setError(''); }}><X size={14}/> Remove</button>}</section>{backFile && <p className="source-name" title={backFile.name}>{backFile.name}</p>}</>}
          {backMeta && <label className="select compact-select"><span>Source PDF page</span><select aria-label="Back page" value={backMeta.pageIndex} onChange={event => { setBackSelectedPage(Number(event.target.value)); setError(''); }}>{Array.from({ length: backMeta.pages }, (_, index) => <option key={index} value={index}>PDF page {index + 1} of {backMeta.pages}</option>)}</select></label>}
          {backInput === 'same' && meta?.pages === 1 && <p className="hint">This PDF has one page. Both sides use Page 1; upload a separate back if needed.</p>}
          <ArtworkDirection side="Back" value={backRotation} onChange={setBackRotation}/>
        </SourceCard>}
        {meta && sizesMatch && <div className="source-check"><CheckCircle2 size={16}/><span>{duplex ? 'Finished sizes match' : 'Finished size detected'}<small>{display(itemW)} × {display(itemH)} · no scaling</small></span></div>}
        <div className="panel-next"><span>Ready to arrange the sheet?</span><button type="button" onClick={() => changeInspectorTab('layout')}>Sheet & grid layout →</button></div>
      </section>
      <div className="tab-panel" role="tabpanel" id="panel-layout" aria-labelledby="tab-layout" hidden={inspectorTab !== 'layout'}>
        <div className="panel-heading"><span className="eyebrow">02 / ARRANGE</span><h1>Build the sheet</h1></div>
        <section><h2>Sheet & repeat</h2><label className="select"><span>Paper size</span><select aria-label="Sheet preset" value={paperPreset} onChange={event => selectPaper(event.target.value)}><option value="13x19">13 × 19 in</option><option value="12.4x18.4">12.4 × 18.4 in</option><option value="custom">Custom size</option></select></label>{paperPreset === 'custom' && <div className="two"><NumberField label="Sheet width" value={sheetW} setValue={setSheetW} min={MIN_SHEET_MM} max={MAX_SHEET_WIDTH_MM} unit={unit} factor={factor}/><NumberField label="Sheet length" value={sheetH} setValue={setSheetH} min={MIN_SHEET_MM} max={MAX_SHEET_HEIGHT_MM} unit={unit} factor={factor}/></div>}<div className="two"><NumberField label="Columns" value={cols} setValue={setCols} min={1} max={25} unit=""/><NumberField label="Rows" value={rows} setValue={setRows} min={1} max={25} unit=""/></div><div className="layout-total"><span>Total up</span><b>{cols * rows}</b></div></section>
        <section><PatternPicker value={rotationPattern} onChange={setRotationPattern} duplex={duplex}/></section>
        {duplex && <section><h2>Two-sided printing</h2><SegmentedChoice label="Sheet turn" name="Sheet flip" value={flipEdge} options={[{ value: 'long', label: 'Long edge' }, { value: 'short', label: 'Short edge' }]} onChange={setFlipEdge}/><p className="section-intro">{flipEdge === 'long' ? 'Turn left / right.' : 'Turn top / bottom.'} Turns the sheet, not the artwork. Match your printer’s duplex setting.</p><details className="inline-help"><summary>Alignment & test-print guidance</summary><p className="hint">Print one test sheet at 100% before production. Manual refeeding depends on the printer. Back cut positions follow Front; artwork text is never mirrored.</p>{plan?.sides[1] && <div className="calculation"><span>Back placement · automatic</span><b>Top {display(plan.sides[1].y)} · Right {display(sheetW - plan.sides[1].x - layoutW)}</b></div>}</details></section>}
        <details className="advanced output-details"><summary>Output size & bleed</summary><div className="details-body"><div className="summary-grid"><span>Finished item<b>{display(itemW)} × {display(itemH)}</b></span><span>Layout<b>{display(layoutW)} × {display(layoutH)}</b></span><span>Outer bleed<b>T {display(appliedOuterBleed.top)} · B {display(appliedOuterBleed.bottom)} · L {display(appliedOuterBleed.left)} · R {display(appliedOuterBleed.right)}</b></span></div>{duplex && plan?.sides[1] && <p className="hint">Back outer bleed: {Object.entries(plan.sides[1].outer).map(([side, value]) => `${side} ${display(value)}`).join(' · ')}</p>}</div></details>
        {(outerBleedShortfall || plan?.sides.some(side => !side.marksOnSheet)) && <div className="layout-advisory">{outerBleedShortfall && <p>Some source bleed is below 3 mm. Available bleed is used without stretching.</p>}{plan?.sides.some(side => !side.marksOnSheet) && <p>Some trim marks fall outside the sheet. Increase margins for full marks.</p>}</div>}
      </div>
      <div className="tab-panel" role="tabpanel" id="panel-duplo" aria-labelledby="tab-duplo" hidden={inspectorTab !== 'duplo'}>
        <div className="panel-heading"><span className="eyebrow">03 / FINISH</span><h1>Duplo setup</h1></div>
        {barcodeFile && marks && <p className="hint barcode-mark-notice">Barcode on: top-right corner trim marks hidden {duplex ? finishingSide === 'both' ? 'on both sides' : `on the ${finishingSide}` : 'on this sheet'}. Select No barcode to restore them. Registration mark is unchanged.</p>}
        <section><h2>Duplo finishing</h2><div className="two"><NumberField label="Lead Trim" value={topOffset} setValue={setTopOffset} max={100} unit={unit} factor={factor}/><NumberField label="Side Trim" value={calculatedSideTrim} setValue={setSideTrim} max={100} unit={unit} factor={factor} disabled={horizontalPlacement === 'center'}/></div><SegmentedChoice label="Horizontal placement" value={horizontalPlacement} options={[{ value: 'center', label: 'Centered' }, { value: 'manual', label: 'Manual Side Trim' }]} onChange={mode => { if (mode === 'manual') setSideTrim(calculatedSideTrim); setHorizontalPlacement(mode); }}/><div className="two"><NumberField label="Gutter Cut" value={gutterCut} setValue={setGutterCut} unit={unit} factor={factor}/><NumberField label="Gutter Slit" value={gutterSlit} setValue={setGutterSlit} unit={unit} factor={factor}/></div><p className="hint">Lead Trim is measured from the sheet top to the first finished cut line. Side Trim is measured from the sheet right edge to the first finished slit line.</p></section>
        <section className="switches">{duplex && <label className="select"><span>Duplo barcode & registration on</span><select aria-label="Finishing side" value={finishingSide} onChange={event => setFinishingSide(event.target.value)}><option value="front">Front · finishing feed side</option><option value="back">Back · finishing feed side</option><option value="both">Both sides</option></select></label>}<label className="toggle-row"><span>Production trim marks</span><input type="checkbox" checked={marks} onChange={event => setMarks(event.target.checked)}/></label><label className="toggle-row"><span>Duplo registration mark</span><input type="checkbox" checked={duploRegMark} onChange={event => setDuploRegMark(event.target.checked)}/></label></section>
        <details id="barcode-details" className="advanced" open={barcodeOpen} onToggle={event => setBarcodeOpen(event.currentTarget.open)}><summary>Job barcode <span className="details-value">{barcodeName ? barcodeName.replace(/\.pdf$/i, '') : 'None'}</span></summary><div className="details-body"><div className="barcode-actions"><button type="button" className="secondary" onClick={connectBarcodeDirectory}><FolderOpen size={14}/> {barcodeDirectoryHandle ? 'Reconnect folder' : 'Choose barcode folder'}</button><span className="barcode-status">{barcodeFolderStatus}</span></div><label className="session-loader"><input className="barcode-file-input" type="file" accept="application/pdf" multiple webkitdirectory="" onChange={loadBarcodeFilesForSession}/><span>Load folder for this session</span></label><label className="select"><span>Job barcode</span><select aria-label="Job barcode" value={barcodeName} onChange={event => setBarcodeFromEntry(event.target.value)}><option value="">No barcode</option>{barcodeEntries.map(entry => <option key={entry.name} value={entry.name}>{entry.name.replace(/\.pdf$/i, '')}</option>)}</select></label><div className="calculation barcode-spec"><span>Bottom crop · white knockout · top layer</span><b>{display(BARCODE_HEIGHT_MM)} high · top {display(BARCODE_TOP_OFFSET_MM)} · right {display(BARCODE_RIGHT_OFFSET_MM)}</b></div></div></details>
        <div className={canExport ? 'summary compact-check' : 'summary warning compact-check'}><span>DC-616 CHECK</span><b>{!sourceFile ? 'Choose artwork to check fit' : barcodeNeedsAttention ? 'Review barcode before export' : canExport ? 'Sheet & layout fit' : 'Review artwork and layout'}</b><small>Lead {display(topOffset)} · Side {display(calculatedSideTrim)} · Cut {display(gutterCut)} · Slit {display(gutterSlit)}</small></div>
      </div>
      </div>
    </aside>
    {exportOpen && <ExportDialog duplex={duplex} side={exportSide} onSideChange={setExportSide} onClose={() => setExportOpen(false)} onDownload={downloadOutput} ready={exportReady} sheetLabel={sheetLabel} total={cols * rows} issue={issueText}/>}
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
