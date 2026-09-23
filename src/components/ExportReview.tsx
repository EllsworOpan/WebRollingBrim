import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Check, FileDiff, LoaderCircle, X } from 'lucide-react';
import { indexLines, type PreparedExport } from '../core/export-review';
import { diffSections, diffRowCount, diffViewport, displayRowForOutput, readReviewRows, scrollTopForRow, type FoldId, type ReviewRow } from '../core/diff-view';
import SafetyNotice from './SafetyNotice';

export default function ExportReview({ review, onClose, onDownload }: {
  review: PreparedExport; onClose: () => void; onDownload: (review: PreparedExport) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), scroller = useRef<HTMLDivElement>(null);
  const pendingTarget = useRef<number | null>(review.insertionLine - 1);
  const [navigation, setNavigation] = useState(0);
  const [index, setIndex] = useState<Uint32Array | null>(null), [error, setError] = useState('');
  const [layout, setLayout] = useState<'unified' | 'split'>('unified');
  const [expanded, setExpanded] = useState<FoldId[]>([]), [jump, setJump] = useState('');
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const [downloaded, setDownloaded] = useState(false);
  const insertion = review.insertionLine - 1, added = review.addedLines.length;
  const total = (index?.length ?? 0) + added;
  const sections = useMemo(() => index ? diffSections(index.length, insertion, added, expanded) : [], [index, insertion, added, expanded]);
  const count = diffRowCount(sections);
  const window = diffViewport(count, viewport.height, viewport.top);
  const [visible, setVisible] = useState<{ sections: typeof sections; start: number; end: number; rows: ReviewRow[] } | null>(null);
  const rows = visible?.sections === sections && visible.start === window.start && visible.end === window.end ? visible.rows : null;

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = overflow; };
  }, []);

  useEffect(() => {
    const element = scroller.current!;
    const update = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    const resize = new ResizeObserver(update);
    resize.observe(element); update();
    return () => resize.disconnect();
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    indexLines(review.source, abort.signal).then(setIndex).catch(reason => {
      if (!abort.signal.aborted) setError((reason as Error).message);
    });
    return () => abort.abort();
  }, [review]);

  useLayoutEffect(() => {
    if (pendingTarget.current === null || !index) return;
    const element = scroller.current!;
    element.scrollTop = scrollTopForRow(count, element.clientHeight, displayRowForOutput(sections, pendingTarget.current));
    setViewport({ top: element.scrollTop, height: element.clientHeight });
    pendingTarget.current = null;
  }, [navigation, sections, count, index]);

  useEffect(() => {
    if (!index) return;
    let cancelled = false;
    readReviewRows(review, index, sections, window.start, window.end - window.start).then(rows => {
      if (!cancelled) setVisible({ sections, start: window.start, end: window.end, rows });
    }).catch(reason => { if (!cancelled) setError((reason as Error).message); });
    return () => { cancelled = true; };
  }, [review, index, sections, window.start, window.end]);

  const goTo = (row: number, nextExpanded = expanded) => {
    const hidden = sections.find(section => section.fold && row >= section.start && row < section.end)?.fold;
    pendingTarget.current = row;
    setExpanded(hidden && !nextExpanded.includes(hidden) ? [...nextExpanded, hidden] : nextExpanded);
    setNavigation(value => value + 1);
    scroller.current?.focus({ preventScroll: true });
  };
  const compact = () => {
    pendingTarget.current = insertion;
    setExpanded([]); setNavigation(value => value + 1);
  };

  return <dialog ref={dialog} className="export-review" aria-labelledby="export-review-title"
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="review-shell">
      <header className="review-header">
        <div><span className="eyebrow">EXACT DOWNLOAD PREVIEW</span><h2 id="export-review-title"><FileDiff size={21} />Export review</h2></div>
        <div className="review-header-actions"><button className="button button-primary" disabled={!index || !!error} onClick={() => { onDownload(review); setDownloaded(true); }}><ArrowDownToLine size={16} />Download G-code</button><button className="icon-button" aria-label="Close export review" onClick={onClose} autoFocus><X size={21} /></button></div>
      </header>
      <div className="review-summary"><span className="diff-added-count">+{added.toLocaleString()} added</span><span className="diff-removed-count">−0 removed</span><span>0 changed</span><span className="review-preserved" role="status"><Check size={14} />{downloaded ? 'Download started · original bytes preserved' : 'Original bytes preserved'}</span></div>
      <p className="review-location">One block at original line <strong>{review.insertionLine.toLocaleString()}</strong>. {review.insertionDescription} Green <b>+</b> lines are added; unchanged lines provide context.</p>
      <SafetyNotice compact />
      <div className="review-controls">
        <div className="view-tabs" role="group" aria-label="Diff layout"><button className={layout === 'unified' ? 'active' : ''} aria-pressed={layout === 'unified'} onClick={() => setLayout('unified')}>Unified</button><button className={layout === 'split' ? 'active' : ''} aria-pressed={layout === 'split'} onClick={() => setLayout('split')}>Side by side</button></div>
        <button className="review-link" disabled={!index} onClick={compact}>Compact view</button>
        <button className="review-link" disabled={!index} onClick={() => goTo(insertion, ['before', 'added', 'after'])}>Expand all</button>
        <button className="review-link" disabled={!index} onClick={() => goTo(insertion)}>Start of insertion</button>
        <button className="review-link" disabled={!index} onClick={() => goTo(insertion + added - 1)}>End of insertion</button>
      </div>
      <div className="diff-filenames"><span title={review.source.name}>a/{review.source.name}</span><span title={review.name}>b/{review.name}</span></div>
      <div className="diff-hunk"><span>{!index ? 'Indexing original lines…' : sections.some(section => section.fold) ? 'Insertion boundaries with 8 original context lines · Expand folded sections to inspect every line' : 'Full file · All original and added lines available by scrolling'}</span></div>
      <div className={`diff-column-headings ${layout}`} aria-hidden="true">{layout === 'unified' ? <><span>Original</span><span>Export</span><span>G-code</span></> : <><span>Original</span><span>Export</span></>}</div>
      <div ref={scroller} className="diff-scroller" role="region" aria-label="G-code diff" tabIndex={0}
        onScroll={event => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
        {error ? <p className="diff-message" role="alert">{error}</p> : !index ? <p className="diff-message" role="status"><LoaderCircle className="spin" size={17} />Indexing G-code…</p> :
          <div className="diff-track" style={{ height: window.height }}>
            <div className={`diff-lines ${layout}`} style={{ top: window.offset }}>
              {!rows ? <p className="diff-message" role="status">Loading lines…</p> : rows.map(row => row.kind === 'fold' ?
                <button className={`diff-fold ${row.section.kind === 'added' ? 'fold-added' : ''}`} key={`fold-${row.section.fold}`} aria-expanded={false}
                  onClick={() => goTo(row.section.start)}>
                  <span>↕ Show {(row.section.end - row.section.start).toLocaleString()} {row.section.kind === 'added' ? 'added' : 'unchanged'} lines</span>
                  <span className="diff-fold-range"> · export {(row.section.start + 1).toLocaleString()}–{row.section.end.toLocaleString()}</span>
                </button> : layout === 'unified' ?
                <div className={`diff-row ${row.kind}`} key={row.outputLine} data-output-line={row.outputLine}>
                  <span className="diff-number">{row.originalLine ?? ''}</span><span className="diff-number">{row.outputLine}</span><span className="diff-sign">{row.kind === 'added' ? '+' : ' '}</span><code>{row.text || ' '}</code>
                </div> :
                <div className="diff-split-row" key={row.outputLine} data-output-line={row.outputLine}>
                  <div className={`diff-cell ${row.kind === 'added' ? 'empty' : 'context'}`}><span className="diff-number">{row.originalLine ?? ''}</span><span className="diff-sign"> </span><code>{row.kind === 'context' ? row.text || ' ' : ' '}</code></div>
                  <div className={`diff-cell ${row.kind}`}><span className="diff-number">{row.outputLine}</span><span className="diff-sign">{row.kind === 'added' ? '+' : ' '}</span><code>{row.text || ' '}</code></div>
                </div>)}
            </div>
          </div>}
      </div>
      <footer className="review-footer">
        <form onSubmit={event => { event.preventDefault(); const line = Number(jump); if (Number.isInteger(line) && line >= 1 && line <= total) goTo(line - 1); }}><label htmlFor="review-jump">Export line</label><input id="review-jump" type="number" min={1} max={total} value={jump} onChange={event => setJump(event.target.value)} /><button type="submit" disabled={!index}>Go</button></form>
        <span>{index && `${total.toLocaleString()} export lines · Continuous scroll`}</span>
      </footer>
    </div>
  </dialog>;
}
