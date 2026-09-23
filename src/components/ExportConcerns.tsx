import type { ExportConcern } from '../core/types';

export default function ExportConcerns({ concerns, accepted, onAccept }: {
  concerns: ExportConcern[]; accepted?: string[]; onAccept?: (id: string, value: boolean) => void;
}) {
  return <ul className="concern-list">{concerns.map(issue => <li key={issue.id}>
    <strong>Line {issue.line}: {issue.message}</strong><code>{issue.command}</code>
    <p><b>Assumption:</b> {issue.assumption}</p><p><b>Consequence:</b> {issue.consequence}</p>
    {onAccept && <label className="concern-accept"><input type="checkbox" checked={accepted?.includes(issue.id) ?? false} onChange={event => onAccept(issue.id, event.target.checked)} />I accept this assumption for this export.</label>}
  </li>)}</ul>;
}
