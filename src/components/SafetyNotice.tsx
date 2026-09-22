import { TriangleAlert } from 'lucide-react';

export default function SafetyNotice({ compact = false }: { compact?: boolean }) {
  return <aside className={`safety-notice ${compact ? 'compact' : ''}`} aria-label="Safety and liability disclaimer">
    <TriangleAlert size={17} aria-hidden="true" />
    <div><strong>Experimental tool — use at your own risk.</strong>
      <p>Edited G-code can cause failed prints, collisions, or printer and property damage. Preview and export checks cannot guarantee safe operation. Review the exported file for your printer, keep the original, and supervise a cautious first test.</p>
      <details><summary>Warranty & liability disclaimer</summary><p>Rolling Brim and its generated files are supplied as is. No warranty is offered for accuracy, compatibility, safety, or suitability for your printer. You are responsible for deciding whether to run the output. To the extent allowed by applicable law, the authors, contributors, and site operator disclaim liability for loss or damage resulting from use of the tool or its output. This notice does not exclude liability or rights that applicable law does not allow to be excluded.</p></details>
    </div>
  </aside>;
}
