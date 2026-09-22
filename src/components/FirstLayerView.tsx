import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrimResult, GeometryContext, ParsedJob, Point, Rings } from '../core/types';

export function svgPath(rings: Rings): string {
  return rings.map(ring => ring.length ? `M${ring.map(p => `${p.x},${p.y}`).join('L')}Z` : '').join('');
}

interface Props {
  geometry: GeometryContext; job: ParsedJob; brim: BrimResult | null;
  diameter: number; showBrim: boolean; showMissed: boolean; probe: boolean; fitKey: number; demo?: boolean;
}
interface ViewBox { x: number; y: number; w: number; h: number }

export default function FirstLayerView({ geometry, job, brim, diameter, showBrim, showMissed, probe, fitKey, demo }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; box: ViewBox } | null>(null);
  const [view, setView] = useState<ViewBox>({ x: 0, y: 0, w: 200, h: 200 });
  const viewRef = useRef(view); viewRef.current = view;
  const [cursor, setCursor] = useState<Point | null>(null);
  const fit = useCallback(() => {
    const element = svg.current;
    if (!element) return;
    const rect = element.getBoundingClientRect(), aspect = rect.width / Math.max(rect.height, 1);
    const b = geometry.bounds, padding = 18;
    let w = b.maxX - b.minX + padding * 2, h = b.maxY - b.minY + padding * 2;
    if (w / h < aspect) w = h * aspect; else h = w / aspect;
    setView({ x: (b.minX + b.maxX - w) / 2, y: -(b.minY + b.maxY + h) / 2, w, h });
  }, [geometry]);
  useEffect(() => { fit(); }, [fit, fitKey]);
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(() => fit()); observer.observe(svg.current);
    return () => observer.disconnect();
  }, [fit]);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const fx = (event.clientX - rect.left) / rect.width, fy = (event.clientY - rect.top) / rect.height;
      const box = viewRef.current, factor = Math.exp(Math.max(-0.4, Math.min(0.4, event.deltaY * 0.001)));
      const w = Math.max(3, Math.min(1500, box.w * factor)), h = w / box.w * box.h;
      setView({ x: box.x + (box.w - w) * fx, y: box.y + (box.h - h) * fy, w, h });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  return <div className="layer-view">
    <svg ref={svg} role="img" aria-label="First layer with model footprint, rolling brim, and highlighted uncovered islands"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} onDoubleClick={fit}
      onPointerDown={event => { if (event.button === 0) { svg.current?.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, box: view }; } }}
      onPointerUp={event => { drag.current = null; if (svg.current?.hasPointerCapture(event.pointerId)) svg.current.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current = null; }}
      onPointerLeave={() => setCursor(null)}
      onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (drag.current) {
          const d = drag.current;
          setView({ ...d.box, x: d.box.x - (event.clientX - d.x) / rect.width * d.box.w, y: d.box.y - (event.clientY - d.y) / rect.height * d.box.h });
        }
        setCursor({ x: view.x + (event.clientX - rect.left) / rect.width * view.w, y: -(view.y + (event.clientY - rect.top) / rect.height * view.h) });
      }}>
      <defs>
        <pattern id="grid-small" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M 10 0 L 0 0 0 10" fill="none" stroke="#233139" strokeWidth="0.12" /></pattern>
        <pattern id="grid-large" width="50" height="50" patternUnits="userSpaceOnUse"><rect width="50" height="50" fill="url(#grid-small)" /><path d="M 50 0 L 0 0 0 50" fill="none" stroke="#304149" strokeWidth="0.2" /></pattern>
        <pattern id="unserved-hatch" width="1.4" height="1.4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.4" height="1.4" fill="#fc806641"/><path d="M0 0V1.4" stroke="#ff8972" strokeWidth="0.35" /></pattern>
      </defs>
      <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="url(#grid-large)" />
      <g transform="scale(1,-1)">
        <path d={svgPath([job.bed])} stroke="#52616b" strokeWidth="0.3" fill="none" />
        <path d={svgPath(geometry.model)} fill="#a7babd" fillRule="evenodd" stroke="#c6d4d5" strokeWidth="0.04" />
        <path d={svgPath(geometry.auxiliary)} fill="#526d81" fillRule="evenodd" />
        {brim && showBrim && <>
          <path d={svgPath(brim.area)} fill="#ffb45412" fillRule="evenodd" />
          {brim.paths.map((path, i) => <polyline key={i} points={path.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#ffb454" strokeWidth={brim.settings.lineWidth} strokeLinejoin="round" strokeLinecap="round" />)}
        </>}
        {brim && showMissed && <path d={svgPath(brim.unserved)} fill="url(#unserved-hatch)" stroke="#ff8972" strokeWidth="0.2" fillRule="evenodd" />}
        {probe && cursor && <g pointerEvents="none">
          <circle cx={cursor.x} cy={cursor.y} r={diameter / 2} fill="#ffb45412" stroke="#ffca87" strokeWidth="0.18" strokeDasharray="0.8 0.5" />
          <path d={`M${cursor.x - 0.8},${cursor.y}h1.6 M${cursor.x},${cursor.y - 0.8}v1.6`} stroke="#ffca87" strokeWidth="0.13" />
        </g>}
      </g>
      {demo && <g fill="#bacbd0" fontSize="2.6" textAnchor="middle" pointerEvents="none" aria-label="Test plate: A large hole, B narrow-entry pocket, C small hole, D wide opening">
        <text x="40" y="-70">A · 20 mm enclosed hole</text>
        <text x="100" y="-70">B · 4 mm entry, 20 mm pocket</text>
        <text x="40" y="-10">C · 4 mm enclosed hole</text>
        <text x="100" y="-10">D · 20 mm open entrance</text>
      </g>}
    </svg>
    <div className="view-instructions">Drag to pan <span>·</span> Scroll to zoom <span>·</span> Double-click to fit</div>
    {probe && <div className="probe-note">Circle gauge <strong>Ø {diameter} mm</strong><span>Move over the first layer</span></div>}
    <div className="scale-readout">{cursor ? `X ${cursor.x.toFixed(1)}   Y ${cursor.y.toFixed(1)} mm` : 'ORTHOGRAPHIC · XY'}</div>
  </div>;
}
