import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Check, ChevronLeft, ChevronRight, FileDiff, LoaderCircle, X } from 'lucide-react';
import { indexLines, readDiffRows, type DiffRow, type PreparedExport } from '../core/export-review';
import SafetyNotice from './SafetyNotice';

const PAGE_SIZE = 250;

export default function ExportReview({ review, onClose, onDownload }: {
  review: PreparedExport; onClose: () => void; onDownload: (review: PreparedExport) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), scroller = useRef<HTMLDivElement>(null);
  const targetLine = useRef<number | null>(review.insertionLine);
  const [index, setIndex] = useState<Uint32Array | null>(null), [error, setError] = useState('');
  const [layout, setLayout] = useState<'unified' | 'split'>('unified'), [full, setFull] = useState(false);
  const [page, setPage] = useState(0), [jump, setJump] = useState('');
  const [visible, setVisible] = useState<{ start: number; rows: DiffRow[] } | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const insertion = review.insertionLine - 1, added = review.addedLines.length;
  const total = (index?.length ?? 0) + added;
  const begin = full ? 0 : Math.max(0, insertion - 8);
  const end = full ? total : Math.min(total, insertion + added + 8);
  const pages = Math.max(1, Math.ceil((end - begin) / PAGE_SIZE));
  const start = begin + Math.min(page, pages - 1) * PAGE_SIZE;

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = overflow; };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    indexLines(review.source, abort.signal).then(setIndex).catch(reason => {
      if (!abort.signal.aborted) setError((reason as Error).message);
    });
    return () => abort.abort();
  }, [review]);

  useEffect(() => {
    if (!index) return;
    let cancelled = false;
    setVisible(null);
    readDiffRows(review, index, start, Math.min(PAGE_SIZE, end - start)).then(rows => {
      if (!cancelled) setVisible({ start, rows });
    }).catch(reason => { if (!cancelled) setError((reason as Error).message); });
    return () => { cancelled = true; };
  }, [review, index, start, end]);

  const scrollToTarget = () => {
    if (targetLine.current === null) return false;
    const row = scroller.current?.querySelector(`[data-output-line="${targetLine.current}"]`);
    if (!row) return false;
    row.scrollIntoView({ block: 'center', inline: 'nearest' }); targetLine.current = null;
    return true;
  };
  useEffect(() => { if (visible && !scrollToTarget()) scroller.current?.scrollTo({ top: 0 }); }, [visible]);
  const goTo = (row: number) => { targetLine.current = row + 1; if (!scrollToTarget()) setPage(Math.floor((row - begin) / PAGE_SIZE)); };
  const rows = visible?.start === start ? visible.rows : null;
  const before = Math.min(8, insertion), after = Math.min(8, (index?.length ?? 0) - insertion);

  return <dialog ref={dialog} className="export-review" aria-labelledby="export-review-title"
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="review-shell">
      <header className="review-header">
        <div><span className="eyebrow">EXACT DOWNLOAD PREVIEW</span><h2 id="export-review-title"><FileDiff size={21} />Export review</h2></div>
        <div className="review-header-actions"><button className="button button-primary" disabled={!index || !!error} onClick={() => { onDownload(review); setDownloaded(true); }}><ArrowDownToLine size={16} />Download G-code</button><button className="icon-button" aria-label="Close export review" onClick={onClose} autoFocus><X size={21} /></button></div>
      </header>
      <div className="review-summary"><span className="diff-added-count">+{added.toLocaleString()} added</span><span className="diff-removed-count">−0 removed</span><span>0 changed</span><span className="review-preserved" role="status"><Check size={14} />{downloaded ? 'Download started · original bytes preserved' : 'Original bytes preserved'}</span></div>
      <p className="review-location">One block, immediately before the first model extrusion at original line <strong>{review.insertionLine.toLocaleString()}</strong>. Green <b>+</b> lines are added; unchanged lines provide context.</p>
      <SafetyNotice compact />
      <div className="review-controls">
        <div className="view-tabs" role="group" aria-label="Diff layout"><button className={layout === 'unified' ? 'active' : ''} aria-pressed={layout === 'unified'} onClick={() => setLayout('unified')}>Unified</button><button className={layout === 'split' ? 'active' : ''} aria-pressed={layout === 'split'} onClick={() => setLayout('split')}>Side by side</button></div>
        <label><input type="checkbox" checked={full} onChange={event => { setFull(event.target.checked); setPage(event.target.checked ? Math.floor(insertion / PAGE_SIZE) : 0); }} />Full file</label>
        <button className="review-link" disabled={!index} onClick={() => goTo(insertion)}>Start of insertion</button>
        <button className="review-link" disabled={!index} onClick={() => goTo(insertion + added - 1)}>End of insertion</button>
      </div>
      <div className="diff-filenames"><span title={review.source.name}>a/{review.source.name}</span><span title={review.name}>b/{review.name}</span></div>
      <div className="diff-hunk">{index ? <><code>{full ? `@@ -1,${index.length} +1,${total} @@` : `@@ -${insertion - before + 1},${before + after} +${insertion - before + 1},${before + added + after} @@`}</code><span>{full ? 'Full file' : 'Insertion with 8 lines of context'}</span></> : 'Indexing original lines…'}</div>
      {!full && begin > 0 && <div className="diff-fold">{begin.toLocaleString()} unchanged lines before this block · Enable Full file to inspect</div>}
      <div className={`diff-column-headings ${layout}`} aria-hidden="true">{layout === 'unified' ? <><span>Original</span><span>Export</span><span>G-code</span></> : <><span>Original</span><span>Export</span></>}</div>
      <div ref={scroller} className="diff-scroller" role="region" aria-label="G-code diff" tabIndex={0}>
        {error ? <p className="diff-message" role="alert">{error}</p> : !rows ? <p className="diff-message" role="status"><LoaderCircle className="spin" size={17} />Loading G-code…</p> :
          <div className={`diff-lines ${layout}`}>
            {rows.map(row => layout === 'unified' ?
              <div className={`diff-row ${row.kind}`} key={row.outputLine} data-output-line={row.outputLine}>
                <span className="diff-number">{row.originalLine ?? ''}</span><span className="diff-number">{row.outputLine}</span><span className="diff-sign">{row.kind === 'added' ? '+' : ' '}</span><code>{row.text || ' '}</code>
              </div> :
              <div className="diff-split-row" key={row.outputLine} data-output-line={row.outputLine}>
                <div className={`diff-cell ${row.kind === 'added' ? 'empty' : 'context'}`}><span className="diff-number">{row.originalLine ?? ''}</span><span className="diff-sign"> </span><code>{row.kind === 'context' ? row.text || ' ' : ' '}</code></div>
                <div className={`diff-cell ${row.kind}`}><span className="diff-number">{row.outputLine}</span><span className="diff-sign">{row.kind === 'added' ? '+' : ' '}</span><code>{row.text || ' '}</code></div>
              </div>)}
          </div>}
      </div>
      {!full && index && end < total && <div className="diff-fold">{(total - end).toLocaleString()} unchanged lines after this block</div>}
      <footer className="review-footer">
        <form onSubmit={event => { event.preventDefault(); const line = Number(jump); if (Number.isInteger(line) && line >= 1 && line <= total) { targetLine.current = line; if (full && scrollToTarget()) return; setFull(true); setPage(Math.floor((line - 1) / PAGE_SIZE)); } }}><label htmlFor="review-jump">Export line</label><input id="review-jump" type="number" min={1} max={total} value={jump} onChange={event => setJump(event.target.value)} /><button type="submit" disabled={!index}>Go</button></form>
        <span>{index && `Lines ${(start + 1).toLocaleString()}–${Math.min(start + PAGE_SIZE, end).toLocaleString()}`}</span>
        <div className="diff-pagination"><button className="icon-button" aria-label="Previous diff page" disabled={!index || page === 0} onClick={() => setPage(value => value - 1)}><ChevronLeft size={18} /></button><span>{Math.min(page + 1, pages)} / {pages.toLocaleString()}</span><button className="icon-button" aria-label="Next diff page" disabled={!index || page >= pages - 1} onClick={() => setPage(value => value + 1)}><ChevronRight size={18} /></button></div>
      </footer>
    </div>
  </dialog>;
}
