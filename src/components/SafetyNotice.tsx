import { TriangleAlert } from 'lucide-react';

export default function SafetyNotice({ compact = false }: { compact?: boolean }) {
  return <aside className={`safety-notice ${compact ? 'compact' : ''}`} aria-label="Safety and liability disclaimer">
    <TriangleAlert size={17} aria-hidden="true" />
    <div><strong>Free, experimental tool — use at your own risk.</strong>
      <p>Rolling Brim edits G-code. You are responsible for reviewing and approving the exported file for your printer before running it. Preview and export checks cannot guarantee safe operation. Keep the original and supervise your first test.</p>
      <details><summary>Warranty & liability disclaimer</summary><p>This tool and its output are provided as is, without warranty. To the extent permitted by law, the developer accepts no responsibility for failed prints, printer or property damage, or other losses caused by using the tool or its output.</p></details>
    </div>
  </aside>;
}
