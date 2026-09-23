import type { ExportConcern } from '../core/types';

export default function ExportConcerns({ concerns, accepted, onAccept }: {
  concerns: ExportConcern[]; accepted?: string[]; onAccept?: (id: string, value: boolean) => void;
}) {
  return <ul className="concern-list">{concerns.map(issue => <li key={issue.id}>
    <strong>Line {issue.line}: {issue.message}</strong><code>{issue.command}</code>
    <p><b>Assumption:</b> {issue.assumption}</p><p><b>Consequence:</b> {issue.consequence}</p>
    {onAccept && <button className="button concern-action" onClick={() => onAccept(issue.id, !accepted?.includes(issue.id))}
      aria-label={`${accepted?.includes(issue.id) ? 'Undo acknowledgement' : 'Acknowledge and collapse'}: line ${issue.line}, ${issue.message}`}>
      {accepted?.includes(issue.id) ? 'Undo acknowledgement' : 'Acknowledge and collapse'}
    </button>}
  </li>)}</ul>;
}
