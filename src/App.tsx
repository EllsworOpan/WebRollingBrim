import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Box, Check, ChevronDown, Circle, CircleHelp, FileCode2, FileDiff, Focus, Layers3, LoaderCircle, LockKeyhole, RotateCcw, ScanLine, Settings2, ShieldCheck, SlidersHorizontal, TriangleAlert, Upload, X } from 'lucide-react';
import FirstLayerView from './components/FirstLayerView';
import ExportReview from './components/ExportReview';
import { exportBlockers } from './core/export';
import { prepareExport, type PreparedExport } from './core/export-review';
import { DEFAULT_BRIM, type BrimResult, type BrimSettings, type ExportMode, type LoadedJob, type WorkerRequest, type WorkerResponse } from './core/types';
import sampleUrl from '../examples/gcodes/clearance-test-plate.gcode?url';
import sampleModelUrl from '../examples/models/clearance-test-plate.stl?url';

const GcodeView = lazy(() => import('./components/GcodeView'));
const sameSettings = (a: BrimSettings, b: BrimSettings) => JSON.stringify(a) === JSON.stringify(b);
const formatBytes = (bytes: number) => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`;

function NumberControl({ label, value, min, max, step, onChange, description, unit = 'mm' }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; description: string; unit?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() && Number.isFinite(n)) { const next = Math.min(max, Math.max(min, n)); setDraft(String(next)); onChange(next); }
    else setDraft(String(value));
  };
  return <div className="number-control">
    <div className="control-heading"><label htmlFor={`input-${label}`}>{label}</label><div className="number-box"><input id={`input-${label}`} type="number" value={draft} min={min} max={max} step={step} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { commit(); event.currentTarget.blur(); } }} /><span>{unit}</span></div></div>
    <input className="range-input" aria-label={`${label} slider`} type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} style={{ '--range-fill': `${(value - min) / (max - min) * 100}%` } as React.CSSProperties} />
    <p className="control-description">{description}</p>
  </div>;
}

function Toggle({ label, description, checked, onChange, count }: { label: string; description?: string; checked: boolean; onChange: (value: boolean) => void; count?: number }) {
  return <label className="toggle-row"><span><span className="toggle-title">{label}{count !== undefined && <span className="count-badge">{count}</span>}</span>{description && <span className="toggle-description">{description}</span>}</span><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} role="switch" /><span className="toggle-track" aria-hidden="true" /></label>;
}

function EmptyIllustration() {
  return <svg className="empty-diagram" viewBox="0 0 320 170" role="img" aria-label="Diagram of a circle defining a brim around a model footprint">
    <defs><pattern id="empty-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#29363e" strokeWidth=".6" /></pattern></defs>
    <rect x="5" y="5" width="310" height="160" rx="14" fill="url(#empty-grid)" />
    <path d="M104 49H191V80H222V116H179V105H104Z" fill="#91a7ae18" stroke="#95afb7" strokeWidth="1.4" />
    <path d="M104 33H191Q207 33 207 49V64H222Q238 64 238 80V116Q238 132 222 132H179Q164 132 163 121H104Q88 121 88 105V49Q88 33 104 33Z" fill="none" stroke="#ffb454" strokeWidth="1.6" />
    <path d="M104 38H191Q202 38 202 49V69H222Q233 69 233 80V116Q233 127 222 127H179Q166 127 167 116H104Q93 116 93 105V49Q93 38 104 38Z" fill="none" stroke="#ffb454" strokeOpacity=".5" strokeWidth="1" />
    <circle cx="80" cy="66" r="24" fill="#ffb4540d" stroke="#ffb454" strokeWidth="1.5" strokeDasharray="4 3" /><circle cx="80" cy="66" r="2" fill="#ffb454" />
    <path d="M78 35Q69 22 51 27" fill="none" stroke="#73868d" strokeWidth="1" /><text x="21" y="25" fill="#a1b0b5" fontSize="10" fontFamily="monospace">ROLLING Ø</text>
    <text x="243" y="146" fill="#7e9199" fontSize="9" fontFamily="monospace">XY / 01</text>
  </svg>;
}

export default function App() {
  const [loaded, setLoaded] = useState<LoadedJob | null>(null), [file, setFile] = useState<File | null>(null);
  const [brim, setBrim] = useState<BrimResult | null>(null), [settings, setSettings] = useState<BrimSettings>(DEFAULT_BRIM);
  const [exportMode, setExportMode] = useState<ExportMode>('standard');
  const [review, setReview] = useState<PreparedExport | null>(null);
  const [status, setStatus] = useState(''), [error, setError] = useState(''), [toast, setToast] = useState('');
  const [view, setView] = useState<'3d' | '2d'>('3d'), [layer, setLayer] = useState(1), [fitKey, setFitKey] = useState(0);
  const [showBrim, setShowBrim] = useState(true), [showMissed, setShowMissed] = useState(true), [showTravel, setShowTravel] = useState(false), [probe, setProbe] = useState(false);
  const [dragging, setDragging] = useState(false), [help, setHelp] = useState(false);
  const [demo, setDemo] = useState(false);
  const input = useRef<HTMLInputElement>(null), worker = useRef<Worker | null>(null), requestId = useRef(0);
  const dragDepth = useRef(0), generationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadUrls = useRef<string[]>([]);
  const update = <K extends keyof BrimSettings>(key: K, value: BrimSettings[K]) => setSettings(previous => ({ ...previous, [key]: value }));

  useEffect(() => () => { worker.current?.terminate(); downloadUrls.current.forEach(url => URL.revokeObjectURL(url)); }, []);
  useEffect(() => { if (toast) { const timeout = setTimeout(() => setToast(''), 5000); return () => clearTimeout(timeout); } }, [toast]);
  useEffect(() => { if (help) { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setHelp(false); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); } }, [help]);

  const loadFile = useCallback(async (incoming: File, isDemo = false) => {
    if (!/\.(gcode|gco|gc)$/i.test(incoming.name)) { setError('Choose a plain-text .gcode file exported by PrusaSlicer. Binary .bgcode files are not supported.'); return; }
    if (incoming.size > 200_000_000) { setError('This file exceeds the 200 MB browser limit. Try a smaller G-code file.'); return; }
    worker.current?.terminate();
    if (generationTimer.current) clearTimeout(generationTimer.current);
    const id = ++requestId.current;
    setLoaded(null); setBrim(null); setFile(incoming); setError(''); setStatus('Opening G-code…'); setProbe(false); setExportMode('standard'); setReview(null);
    setDemo(isDemo);
    if (isDemo) { setSettings(DEFAULT_BRIM); setView('2d'); }
    const instance = new Worker(new URL('./core/worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance;
    instance.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.id !== requestId.current) return;
      if (message.type === 'progress') setStatus(message.message);
      if (message.type === 'error') { setError(message.message); setStatus(''); }
      if (message.type === 'loaded') {
        if (!message.value.geometry.model.length) { setError('No usable first-layer model footprint was found. Export a complete text G-code file from PrusaSlicer.'); setStatus(''); return; }
        setLoaded(message.value); setLayer(message.value.job.layerCount);
        setSettings(previous => ({ ...previous, lineWidth: message.value.job.settings.lineWidth, speed: message.value.job.settings.printSpeed, travelLift: message.value.job.settings.zHop }));
        setStatus('Preparing rolling brim…');
      }
      if (message.type === 'generated') { setBrim(message.value); setStatus(''); setError(''); }
    };
    instance.onerror = event => { if (worker.current === instance) { setError(event.message || 'The processing worker stopped. Try loading the file again.'); setStatus(''); } };
    try {
      const bytes = await incoming.arrayBuffer();
      if (requestId.current === id) instance.postMessage({ type: 'load', id, name: incoming.name, bytes } satisfies WorkerRequest, [bytes]);
    } catch (reason) { if (requestId.current === id) { setError((reason as Error).message); setStatus(''); } }
  }, []);

  useEffect(() => {
    if (!loaded || !worker.current) return;
    const id = ++requestId.current;
    setStatus('Updating brim…');
    generationTimer.current = setTimeout(() => {
      worker.current?.postMessage({ type: 'generate', id, settings } satisfies WorkerRequest);
    }, 300);
    return () => { if (generationTimer.current) clearTimeout(generationTimer.current); };
  }, [loaded, settings]);

  const loadSample = async () => {
    setError(''); setStatus('Opening the clearance test plate…');
    try {
      const response = await fetch(sampleUrl);
      if (!response.ok) throw new Error('The sample could not be loaded. You can still open a local G-code file.');
      const blob = await response.blob();
      await loadFile(new File([blob], 'clearance-test-plate.gcode', { type: 'text/plain' }), true);
    } catch (reason) { setError((reason as Error).message); setStatus(''); }
  };
  const reviewGcode = () => {
    if (!loaded || !file || !brim || !sameSettings(settings, brim.settings)) return;
    try {
      setReview(prepareExport(file, loaded.job, brim, exportMode));
    } catch (reason) { setError((reason as Error).message); }
  };
  const downloadGcode = (prepared: PreparedExport) => {
    try {
      const url = URL.createObjectURL(prepared.output); downloadUrls.current.push(url);
      const link = document.createElement('a'); link.href = url; link.download = prepared.name;
      document.body.append(link); link.click(); link.remove();
      setToast('Download started from the reviewed output. All original lines are preserved.');
    } catch (reason) { setError((reason as Error).message); }
  };
  const blockers = loaded ? exportBlockers(loaded.job, exportMode) : [];
  const canExport = !!loaded && !blockers.length && !!brim?.paths.length && sameSettings(settings, brim.settings) && !status && !error;
  const notices = [...(loaded?.job.warnings || []), ...(brim?.warnings || [])];
  const stale = !!brim && !sameSettings(settings, brim.settings);

  return <div className="app-shell"
    onDragEnter={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true); } }}
    onDragOver={event => event.preventDefault()}
    onDragLeave={event => { event.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); const first = event.dataTransfer.files[0]; if (first) void loadFile(first); }}>
    <input ref={input} className="visually-hidden" tabIndex={-1} aria-label="Open G-code file" type="file" accept=".gcode,.gco,.gc" onChange={event => { const incoming = event.target.files?.[0]; if (incoming) void loadFile(incoming); event.target.value = ''; }} />
    <header className="app-header">
      <div className="brand"><img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" /><div>Rolling Brim<span>FIRST LAYER, RECONSIDERED.</span></div><span className="version-tag">BETA</span></div>
      <div className="header-actions"><span className="local-label"><LockKeyhole size={13} /> Local to your browser</span><button className="icon-button help-button" title="How Rolling Brim works" aria-label="How Rolling Brim works" onClick={() => setHelp(true)}><CircleHelp size={19} /></button><button className="button button-primary export-button" disabled={!canExport} onClick={reviewGcode}><FileDiff size={17} /> Review export</button></div>
    </header>

    <div className="workbench">
      <aside className="sidebar">
        <div className="sidebar-top"><span className="eyebrow">BRIM WORKSPACE</span><SlidersHorizontal size={16} /></div>
        <button className={`source-card ${loaded ? 'has-file' : ''}`} onClick={() => input.current?.click()}>
          <span className="source-icon">{loaded ? <FileCode2 size={20} /> : <Upload size={20} />}</span>
          <span className="source-text"><strong title={file?.name}>{loaded ? file?.name : 'Open a G-code file'}</strong><span>{loaded ? `${formatBytes(loaded.job.bytes)} · ${loaded.job.layerCount} layers` : 'PrusaSlicer · .gcode'}</span></span><span className="source-arrow"><ArrowUpRight size={16} /></span>
        </button>
        {loaded && <button className="sample-link sidebar-sample" onClick={() => void loadSample()} disabled={!!status}>Load clearance test plate <ArrowUpRight size={14} /></button>}

        <section className="settings-section"><div className="section-label"><span>01</span><h2>Shape the brim</h2></div>
          <NumberControl label="Rolling diameter" value={settings.diameter} min={0.5} max={50} step={0.5} onChange={value => update('diameter', value)} description="Larger circles stay out of tighter gaps." />
          <NumberControl label="Brim width" value={settings.width} min={0.5} max={20} step={0.5} onChange={value => update('width', value)} description="Nominal width, rounded down to whole line spacings." />
          <NumberControl label="Separation gap" value={settings.gap} min={-0.2} max={1} step={0.01} onChange={value => update('gap', value)} description={settings.gap < 0 ? 'Negative values overlap the model for a stronger bond.' : 'Nominal gap, using PrusaSlicer’s spacing convention. Zero joins the brim to the model.'} />
        </section>

        <section className="settings-section regions-section"><div className="section-label"><span>02</span><h2>Choose where it goes</h2></div>
          <div className="always-row"><span><Circle size={14} />Reachable outside</span><span className="always-badge">ALWAYS ON</span></div>
          <Toggle label="Inside enclosed holes" checked={settings.holes} onChange={value => update('holes', value)} count={brim?.regions.holes} description="Only where the rolling circle fits." />
          <Toggle label="Inside narrow-entry pockets" checked={settings.pockets} onChange={value => update('pockets', value)} count={brim?.regions.pockets} description="Place the circle beyond a tight entrance." />
          <div className="region-note">The circle must fit inside either region. Narrow slots stay clear.</div>
        </section>

        <details className="print-details"><summary><span><Settings2 size={15} /> Print settings</span><ChevronDown size={15} /></summary><div className="print-settings-body">
          <p>Defaults from your file’s slicer settings. Overrides apply only to the added brim.</p>
          <NumberControl label="Line width" value={settings.lineWidth} min={Math.max(0.2, loaded?.job.settings.layerHeight || 0.2)} max={1.5} step={0.01} onChange={value => update('lineWidth', value)} description="Width of each new extrusion line." />
          <NumberControl label="Brim speed" value={settings.speed} min={1} max={100} step={1} onChange={value => update('speed', value)} description="First-layer printing speed." unit="mm/s" />
          <NumberControl label="Travel lift" value={settings.travelLift} min={0} max={Math.max(5, loaded?.job.settings.zHop || 0)} step={0.1} onChange={value => update('travelLift', value)} description="Z-hop for brim travel. Zero means no lift and no added Z moves." />
          {loaded && <p className="file-setting-reference">From file: {loaded.job.settings.zHop} mm{!('retract_lift' in loaded.job.config) && !('filament_retract_lift' in loaded.job.config) ? ' (not specified; starts at zero)' : ''}</p>}
          {loaded && <><dl className="metadata-list"><div><dt>Firmware from file</dt><dd>{loaded.job.flavor}</dd></div><div><dt>Printer model</dt><dd>{loaded.job.config.printer_model || 'Not specified'}</dd></div><div><dt>Layer height</dt><dd>{loaded.job.settings.layerHeight} mm</dd></div><div><dt>Filament</dt><dd>{loaded.job.settings.filamentDiameter} mm</dd></div><div><dt>Flow multiplier</dt><dd>{loaded.job.settings.flow}</dd></div><div><dt>Retraction</dt><dd>{loaded.job.settings.retractLength} mm</dd></div></dl>
            <div className="export-settings"><label htmlFor="export-mode">Export method</label><select id="export-mode" value={exportMode} onChange={event => setExportMode(event.target.value as ExportMode)}><option value="standard">Standard G-code</option><option value="klipper" disabled={loaded.job.flavor !== 'klipper'}>Klipper state restore</option></select><p>{exportMode === 'standard' ? 'Ordinary commands, checked against the remaining original program.' : 'Uses Klipper’s runtime snapshot. Position and model checks still apply.'}</p></div>
            <div className={`compatibility-summary ${blockers.length ? 'needs-attention' : ''}`}><strong>{blockers.length ? <TriangleAlert size={14} /> : <ShieldCheck size={14} />}{blockers.length ? 'Export checks need attention' : 'Export checks passed'}</strong><p>State is read immediately before the first model extrusion, including commands after the skirt.</p>{loaded.job.insertion && <dl className="metadata-list"><div><dt>Insertion line</dt><dd>{loaded.job.insertion.line.toLocaleString()}</dd></div><div><dt>XYZ positioning</dt><dd>{loaded.job.insertion.state.absoluteXYZ ? 'Absolute' : 'Relative'}</dd></div><div><dt>Extrusion</dt><dd>{loaded.job.insertion.state.absoluteE ? 'Absolute' : 'Relative'}</dd></div><div><dt>Resume feed</dt><dd>{Number.isFinite(loaded.job.insertion.state.f) ? `${(loaded.job.insertion.state.f / 60).toFixed(1)} mm/s` : 'Unknown'}</dd></div></dl>}{exportMode === 'standard' && !loaded.job.standardBlockers.length && loaded.job.insertion && <p>{loaded.job.extrusionResetLine ? `E use checked through the original reset at line ${loaded.job.extrusionResetLine.toLocaleString()}.` : 'E use checked through the rest of the file.'}</p>}</div></>}
        </div></details>
        <button className="reset-settings" onClick={() => { setSettings({ ...DEFAULT_BRIM, lineWidth: loaded?.job.settings.lineWidth ?? DEFAULT_BRIM.lineWidth, speed: loaded?.job.settings.printSpeed ?? DEFAULT_BRIM.speed, travelLift: loaded?.job.settings.zHop ?? DEFAULT_BRIM.travelLift }); setExportMode('standard'); }}><RotateCcw size={13} /> Reset settings</button>
        <div className="sidebar-footer"><ShieldCheck size={18} /><div><strong>Your original stays intact.</strong><p>One added brim block. No rewritten lines.</p></div></div>
      </aside>

      <main className="main-panel">
        <div className="workspace-toolbar">
          <div className="view-tabs" role="tablist" aria-label="Preview mode"><button role="tab" aria-selected={view === '3d'} className={view === '3d' ? 'active' : ''} onClick={() => setView('3d')}><Box size={16} />3D toolpaths</button><button role="tab" aria-selected={view === '2d'} className={view === '2d' ? 'active' : ''} onClick={() => setView('2d')}><Layers3 size={16} />First layer</button></div>
          <div className="toolbar-actions">{view === '2d' && <button className={`toolbar-button ${probe ? 'selected' : ''}`} onClick={() => setProbe(!probe)} aria-label="Circle gauge" aria-pressed={probe} title="Inspect gaps with a circle of the selected diameter"><Circle size={15} /><span>Circle gauge</span></button>}<button className="toolbar-button" aria-label="Fit view" disabled={!loaded} onClick={() => setFitKey(value => value + 1)}><Focus size={16} /><span>Fit view</span></button></div>
        </div>

        {error && <div className="error-banner" role="alert"><TriangleAlert size={18} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}

        <div className={`viewer-surface ${stale ? 'is-updating' : ''}`}>
          {loaded && file ? <>
            <div className={`view-container ${view !== '3d' ? 'hidden-view' : ''}`}><Suspense fallback={<div className="viewer-loading"><LoaderCircle className="spin" size={20} />Starting viewer…</div>}><GcodeView file={file} job={loaded.job} geometry={loaded.geometry} brim={brim} layer={layer} showBrim={showBrim} showTravel={showTravel} fitKey={fitKey} /></Suspense></div>
            {view === '2d' && <FirstLayerView geometry={loaded.geometry} job={loaded.job} brim={brim} diameter={settings.diameter} showBrim={showBrim} showMissed={showMissed} probe={probe} fitKey={fitKey} demo={demo} />}
            <div className="viewer-heading"><span className="eyebrow">{view === '2d' ? 'FIRST-LAYER INSPECTION' : 'TOOLPATH PREVIEW'}</span><span>{view === '2d' ? `Z ${loaded.job.firstLayerZ.toFixed(2)} mm · ${loaded.geometry.islands.length} islands` : `${loaded.job.slicer} · ${loaded.job.flavor}`}</span></div>
            <div className="viewer-legend"><span><i className="swatch model-swatch" />Model</span><button onClick={() => setShowBrim(!showBrim)} className={showBrim ? '' : 'muted'} aria-pressed={showBrim}><i className="swatch brim-swatch" />Rolling brim</button>{view === '2d' && <><span><i className="swatch auxiliary-swatch" />Existing paths</span>{!!brim?.unserved.length && <button onClick={() => setShowMissed(!showMissed)} aria-pressed={showMissed} className={showMissed ? '' : 'muted'}><i className="swatch missed-swatch" />Uncovered ({brim.unserved.length})</button>}</>}</div>
          </> : <div className="empty-state"><EmptyIllustration /><span className="eyebrow">A LITTLE MORE HOLD. A LOT LESS HASSLE.</span><h1>Give your print a better start.</h1><p>Roll past the tight gaps. Keep the parts that matter<br className="desktop-break" /> anchored with a brim you can actually remove.</p><button className="button button-primary" onClick={() => input.current?.click()} disabled={!!status}><Upload size={17} /> Open G-code</button><span className="drop-hint">or drop a PrusaSlicer file anywhere</span><button className="sample-link" onClick={() => void loadSample()} disabled={!!status}>Try the holes & pockets test plate <ArrowUpRight size={14} /></button><div className="empty-local"><LockKeyhole size={13} />Your file stays in this browser. No upload required.</div></div>}
          {status && <div className="processing-status" role="status"><LoaderCircle className="spin" size={15} /><span>{status}</span></div>}
        </div>

        <div className="layer-bar">
          {view === '3d' ? <><div className="layer-title"><Layers3 size={16} /><span>Layers</span></div><input aria-label="Visible layer" type="range" min={1} max={loaded?.job.layerCount || 1} value={layer} disabled={!loaded} onChange={event => setLayer(Number(event.target.value))} /><span className="layer-count"><strong>{loaded ? layer : '—'}</strong> / {loaded?.job.layerCount || '—'}</span><label className="travel-control"><input type="checkbox" checked={showTravel} onChange={event => setShowTravel(event.target.checked)} />Travel moves</label></>
            : <><div className="layer-title"><ScanLine size={16} /><span>First layer</span></div><span className="first-layer-caption">Actual extrusion widths · one-layer brim</span><span className="layer-count">{loaded ? `${loaded.job.settings.layerHeight.toFixed(2)} mm` : '—'}</span></>}
        </div>

        <div className="result-panel">
          {demo && <div className="demo-guide">
            <strong>Original clearance test plate</strong>
            <p>At Ø 10 mm: A fills with <b>enclosed holes</b>; B fills with <b>narrow-entry pockets</b>. C stays empty. D is always reachable.</p>
            <p>Try Ø 3 mm: B becomes reachable from outside, and C can receive brim with holes enabled. Use Ø 10 mm to compare the toggles again.</p>
            <small>This sample uses generic print settings. To print the plate, <a href={sampleModelUrl} download="clearance-test-plate.stl">download the original STL</a> and slice it for your printer.</small>
          </div>}
          <div className="result-heading"><div><span className="eyebrow">ADDED BRIM</span><h2>{loaded ? 'Ready for a closer look.' : 'Your brim, at a glance.'}</h2></div><span className={`result-status ${brim && !status ? 'ready' : ''}`}>{status ? <LoaderCircle size={13} className="spin" /> : brim ? <Check size={13} /> : <Circle size={12} />}{status ? 'Calculating' : brim ? 'Preview generated' : 'Waiting for a file'}</span></div>
          <div className="metrics"><div><span>Toolpath length</span><strong>{brim ? (brim.length / 1000).toFixed(2) : '—'}<small>m</small></strong></div><div><span>Extra filament</span><strong>{brim ? (brim.filament / 1000).toFixed(2) : '—'}<small>m</small></strong></div><div><span>Estimated time</span><strong>{brim ? brim.minutes < 1 ? '< 1' : Math.round(brim.minutes) : '—'}<small>min</small></strong></div><div><span>Island coverage</span><strong>{brim && loaded ? `${loaded.geometry.islands.length - brim.unserved.length}` : '—'}<small>{loaded ? `/ ${loaded.geometry.islands.length}` : 'islands'}</small></strong></div></div>
          {loaded && <div className="result-footnote">Estimates cover the added brim. Original file estimates and thumbnails are preserved.</div>}
          {!!blockers.length && <div className="export-blockers" role="alert"><strong><TriangleAlert size={16} />Preview only — export needs attention</strong><ul>{blockers.map(item => <li key={item}>{item}</li>)}</ul></div>}
          {!!notices.length && <details className="review-notes"><summary><span><CircleHelp size={14} />File & brim notes <span className="count-badge">{notices.length}</span></span><ChevronDown size={14} /></summary><ul>{notices.map(note => <li key={note}>{note}</li>)}</ul></details>}
        </div>
      </main>
    </div>
    <footer className="app-footer"><span>ROLLING BRIM <span className="footer-divider">/</span> G-CODE WORKSPACE</span><span>PrusaSlicer text G-code <span className="footer-divider">·</span> All dimensions in mm</span></footer>

    {review && <ExportReview review={review} onClose={() => setReview(null)} onDownload={downloadGcode} />}
    {dragging && <div className="drop-overlay"><div><Upload size={40} /><h2>Drop your G-code here</h2><p>We’ll read the first layer and take it from there.</p></div></div>}
    {toast && <div className="toast" role="status"><Check size={17} />{toast}</div>}
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={event => event.stopPropagation()}><button className="icon-button modal-close" aria-label="Close help" onClick={() => setHelp(false)} autoFocus><X size={20} /></button><span className="eyebrow">THE ROLLING BRIM</span><h2 id="help-title">Adhesion with room to move.</h2><p>A virtual circle decides which areas can receive brim. A larger circle skips narrow gaps, keeping delicate joints easier to free.</p><dl><div><dt>Rolling diameter</dt><dd>The size of the circle used to test access and clearance.</dd></div><div><dt>Brim width</dt><dd>The width of the added band, measured from the separation gap.</dd></div><div><dt>Enclosed holes</dt><dd>Allow brim inside sealed holes that have enough room for the circle.</dd></div><div><dt>Narrow-entry pockets</dt><dd>Lift the circle into roomy pockets it cannot enter from outside. Their narrow entrances remain subject to the same clearance rule.</dd></div><div><dt>Island coverage</dt><dd>An island is covered when a generated extrusion reaches its boundary at the selected separation gap. Highlighting is advisory; no connecting tabs are added.</dd></div></dl><p className="help-note">Use the first-layer view to inspect the result. Positive gap separates, zero touches, and negative gap overlaps. The 3D view shows extrusions; larger files use lightweight lines. The first-layer view shows deposited widths.</p><button className="button button-primary" onClick={() => setHelp(false)}>Back to the workspace</button></section></div>}
  </div>;
}
