import { useEffect, useRef, useState } from 'react';
import type { PreparedExport } from '../core/export-review';

export default function ExportConfirmation({ review, onCancel, onConfirm }: {
  review: PreparedExport; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [accepted, setAccepted] = useState(false);
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className="export-confirmation" aria-labelledby="confirm-export-title"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onCancel(); }}>
    <h2 id="confirm-export-title">Export with unverified assumptions?</h2>
    <p>You are downloading <strong>{review.name}</strong> with these unresolved concerns:</p>
    <ul>{review.concerns?.map(issue => <li key={issue.id}>Line {issue.line}: {issue.message}</li>)}</ul>
    <p>Incorrect assumptions can cause misplaced extrusion, a failed print or a nozzle collision. The original file remains unchanged.</p>
    <label className="concern-accept"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />I understand the listed assumptions and accept their risks for this download.</label>
    <div className="confirmation-actions"><button className="button" onClick={onCancel} autoFocus>Back to review</button><button className="button button-primary" disabled={!accepted} onClick={onConfirm}>Export with these assumptions</button></div>
  </dialog>;
}
