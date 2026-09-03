import React, { useEffect, useId, useRef } from 'react';
import { ArrowUp, ChevronDown, Download, RotateCcw, RotateCw, X } from 'lucide-react';

export const PATTERNS = [
  { value: 'same', label: 'Uniform', description: 'Every item faces the same way.' },
  { value: 'alternateRows', label: 'Alternate rows', description: 'Every second row turns 180°.' },
  { value: 'alternateColumns', label: 'Alternate columns', description: 'Every second column turns 180°.' },
  { value: 'checkerboard', label: 'Checkerboard', description: 'Neighboring items alternate by 180°.' },
];

export function SegmentedChoice({ label, name, value, options, onChange }) {
  const id = useId();
  return <fieldset className="segmented-choice" aria-label={name || label}>
    <legend>{label}</legend>
    <div className="segmented-options">{options.map(option => <label key={option.value}>
      <input type="radio" name={id} value={option.value} checked={value === option.value}
        onChange={() => onChange(option.value)}/>
      <span>{option.label}</span>
    </label>)}</div>
  </fieldset>;
}

export function InspectorTabs({ value, onChange }) {
  const tabs = ['artwork', 'layout', 'duplo'];
  function navigate(event, index) {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    onChange(tabs[next]);
    document.getElementById(`tab-${tabs[next]}`)?.focus();
  }
  return <div className="inspector-tabs" role="tablist" aria-label="Inspector settings">
    {tabs.map((tab, index) => <button key={tab} type="button" id={`tab-${tab}`} role="tab"
      aria-controls={`panel-${tab}`} aria-selected={value === tab} tabIndex={value === tab ? 0 : -1}
      onKeyDown={event => navigate(event, index)} onClick={() => onChange(tab)}>
      {tab[0].toUpperCase() + tab.slice(1)}
    </button>)}
  </div>;
}

export function SourceCard({ side, expanded, onToggle, fileName, pageIndex, angle, dimensions, children }) {
  return <section className={`source-card ${expanded ? 'is-open' : ''}`}>
    <button type="button" className="source-card-heading" aria-expanded={expanded} aria-controls={`source-${side.toLowerCase()}`} onClick={onToggle}>
      <span className="direction-sample" aria-hidden="true"><span style={{ transform: `rotate(${-angle}deg)` }}><ArrowUp size={14}/><b>Aa</b></span></span>
      <span className="source-card-info"><strong>{side}<small>{angle}°</small></strong>
        <span title={fileName}>{fileName || 'Choose a PDF'}</span>
        <small>{fileName ? `PDF page ${pageIndex + 1} · ${dimensions || 'Reading size…'}` : 'TrimBox & BleedBox detected automatically'}</small>
      </span><ChevronDown size={16} className="source-chevron"/>
    </button>
    <div id={`source-${side.toLowerCase()}`} className="source-editor" hidden={!expanded}>{children}</div>
  </section>;
}

export function ArtworkDirection({ side, value, onChange }) {
  return <div className="artwork-direction">
    <label htmlFor={`direction-${side}`}>Artwork direction <span>· {side} only</span></label>
    <div className="direction-controls">
      <button type="button" title="Turn left 90°" aria-label={`Turn ${side.toLowerCase()} left 90°`} onClick={() => onChange((value + 90) % 360)}><RotateCcw size={14}/></button>
      <select id={`direction-${side}`} aria-label={`${side} artwork direction`} value={value} onChange={event => onChange(Number(event.target.value))}>
        {[0, 90, 180, 270].map(angle => <option key={angle} value={angle}>{angle}°</option>)}
      </select>
      <button type="button" title="Turn right 90°" aria-label={`Turn ${side.toLowerCase()} right 90°`} onClick={() => onChange((value + 270) % 360)}><RotateCw size={14}/></button>
      <button type="button" className="direction-reset" aria-label={`Reset ${side.toLowerCase()} rotation`} title={`Reset ${side} to 0° only`} disabled={value === 0} onClick={() => onChange(0)}>Reset</button>
    </div>
  </div>;
}

export function PatternPicker({ value, onChange, duplex }) {
  return <fieldset className="pattern-picker"><legend>Grid pattern</legend>
    <p className="section-intro">Choose how repeated items face{duplex ? ' on both sides' : ' on the sheet'}.</p>
    <div className="pattern-options">{PATTERNS.map(pattern => <label key={pattern.value} className={`pattern-choice ${value === pattern.value ? 'is-selected' : ''}`}>
      <input type="radio" name="grid-pattern" value={pattern.value} checked={value === pattern.value} onChange={() => onChange(pattern.value)}/>
      <span className="mini-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => {
        const row = Math.floor(i / 3), col = i % 3;
        const down = pattern.value === 'alternateRows' ? row % 2 : pattern.value === 'alternateColumns' ? col % 2 : pattern.value === 'checkerboard' ? (row + col) % 2 : false;
        return <span key={i}><ArrowUp size={15} style={{ transform: down ? 'rotate(180deg)' : undefined }}/></span>;
      })}</span><span>{pattern.label}</span>
    </label>)}</div>
    <p className="pattern-description">{PATTERNS.find(pattern => pattern.value === value)?.description}</p>
  </fieldset>;
}

export function ExportDialog({ duplex, side, onSideChange, onClose, onDownload, ready, sheetLabel, total, issue }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="export-dialog" aria-labelledby="export-title" onCancel={onClose} onClick={event => { if (event.target === ref.current) onClose(); }}>
    <div className="export-dialog-body"><div className="dialog-heading"><div><span className="eyebrow">OUTPUT</span><h2 id="export-title">Export PDF</h2></div><button type="button" className="close-dialog" aria-label="Close export" onClick={onClose}><X size={20}/></button></div>
      <p className="section-intro">The PDF uses the same output shown in your proof.</p>
      {duplex && <label className="select"><span>Include in export</span><select autoFocus aria-label="Export pages" value={side} onChange={event => onSideChange(event.target.value)}><option value="both">Front + Back · 2-page PDF</option><option value="front">Front only</option><option value="back">Back only</option></select></label>}
      <div className="export-recap"><span>Sheet<strong>{sheetLabel}</strong></span><span>Items<strong>{total} up{duplex ? ' / side' : ''}</strong></span><span>PDF order<strong>{!duplex || side === 'front' ? 'Front' : side === 'back' ? 'Back' : '1. Front → 2. Back'}</strong></span></div>
      {duplex && <p className="hint">Print a test sheet at 100%. Match the printer’s duplex setting to Sheet turn.</p>}
      {!ready && <p className="error" role="alert">{issue || 'Wait for the updated output proof.'}</p>}
      <div className="dialog-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button type="button" className="primary-action" disabled={!ready} onClick={onDownload}><Download size={17}/> Download PDF</button></div>
    </div>
  </dialog>;
}
