import { useEffect, useRef, useState } from 'react';
import { GCodePreview } from 'gcode-preview';
import * as THREE from 'three';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import type { BrimResult, GeometryContext, ParsedJob } from '../core/types';

interface Props {
  file: File; job: ParsedJob; geometry: GeometryContext; brim: BrimResult | null;
  layer: number; showBrim: boolean; showTravel: boolean; fitKey: number;
}

function brimMesh(brim: BrimResult, z: number): THREE.Mesh {
  const vertices: number[] = [];
  const half = brim.settings.lineWidth / 2;
  for (const path of brim.paths) for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) continue;
    const dx = -(b.y - a.y) / length * half, dy = (b.x - a.x) / length * half;
    const p = [a.x + dx, z, -(a.y + dy)], q = [b.x + dx, z, -(b.y + dy)];
    const r = [b.x - dx, z, -(b.y - dy)], s = [a.x - dx, z, -(a.y - dy)];
    vertices.push(...p, ...q, ...r, ...p, ...r, ...s);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#ffb454', side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  mesh.name = 'Rolling brim extrusion';
  return mesh;
}

export default function GcodeView({ file, job, geometry, brim, layer, showBrim, showTravel, fitKey }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null), preview = useRef<GCodePreview | null>(null);
  const overlay = useRef<THREE.Mesh | null>(null), extras = useRef<THREE.Group | null>(null);
  const [status, setStatus] = useState('Loading 3D toolpaths…'), [error, setError] = useState(''), [ready, setReady] = useState(0);
  const fitRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!canvas.current) return;
    let disposed = false;
    const abort = new AbortController();
    setStatus('Loading 3D toolpaths…'); setError('');
    let instance: GCodePreview;
    try {
      instance = new GCodePreview({
        canvas: canvas.current, backgroundColor: '#10191e', extrusionColor: '#94aaac',
        travelColor: '#35536a', renderTubes: file.size < 30_000_000, renderTravel: false, disableGradient: true,
        lineWidth: 1, lineHeight: job.settings.layerHeight, extrusionWidth: job.settings.lineWidth,
        keepLines: false, droppable: false,
      });
    } catch { setError('3D rendering is unavailable in this browser. The first-layer view and export are still available.'); setStatus(''); return; }
    preview.current = instance;
    const group = new THREE.Group(); extras.current = group;
    const bedBounds = job.bed.length ? new THREE.Box2().setFromPoints(job.bed.map(p => new THREE.Vector2(p.x, p.y))) : null;
    const bedSize = bedBounds ? Math.max(bedBounds.max.x - bedBounds.min.x, bedBounds.max.y - bedBounds.min.y) : 250;
    const grid = new THREE.GridHelper(bedSize, Math.round(bedSize / 10), '#33434b', '#223039');
    const bedCenter = bedBounds?.getCenter(new THREE.Vector2()) || new THREE.Vector2(125, 125);
    grid.position.set(bedCenter.x, -0.03, -bedCenter.y); group.add(grid);
    const b = geometry.bounds, cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    fitRef.current = () => {
      const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 30);
      const target = new THREE.Vector3(cx, job.layerCount * job.settings.layerHeight / 3, -cy);
      instance.sceneManager.controls.target.copy(target);
      const camera = instance.sceneManager.camera;
      const halfFov = camera instanceof THREE.PerspectiveCamera ? THREE.MathUtils.degToRad(camera.fov / 2) : Math.PI / 8;
      const aspect = canvas.current ? canvas.current.clientWidth / Math.max(canvas.current.clientHeight, 1) : 1;
      const limitingAngle = Math.min(halfFov, Math.atan(Math.tan(halfFov) * aspect));
      const radius = Math.hypot(b.maxX - b.minX + 28, b.maxY - b.minY + 28, job.layerCount * job.settings.layerHeight) / 2;
      const distance = Math.max(span, radius / Math.sin(limitingAngle)) * 1.05;
      camera.position.copy(target).addScaledVector(new THREE.Vector3(0.55, 0.8, 0.8).normalize(), distance);
      instance.sceneManager.camera.lookAt(target);
      instance.sceneManager.controls.update();
    };
    fitRef.current();
    instance.sceneManager.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const resize = new ResizeObserver(() => { if (!disposed) instance.sceneManager.resize(); });
    resize.observe(canvas.current.parentElement!);
    const started = performance.now();
    const textStream = file.stream().pipeThrough(new TextDecoderStream(), { signal: abort.signal });
    instance.processGCodeStream(textStream, { render: true }).then(() => {
      if (disposed) return;
      instance.sceneManager.scene.add(group);
      fitRef.current();
      setStatus(''); setReady(value => value + 1);
      if (import.meta.env.DEV) console.info('Viewer loaded ' + JSON.stringify({ layers: instance.job.countLayers, ms: Math.round(performance.now() - started), paths: instance.job.paths.length }));
    }).catch(reason => { if (!disposed) { setError(`Could not render the 3D preview: ${reason instanceof Error ? reason.message : 'unknown error'}`); setStatus(''); } });
    return () => {
      disposed = true; abort.abort(); resize.disconnect();
      overlay.current?.geometry.dispose();
      if (overlay.current) (overlay.current.material as THREE.Material).dispose();
      overlay.current = null;
      grid.geometry.dispose();
      const materials = Array.isArray(grid.material) ? grid.material : [grid.material]; materials.forEach(material => material.dispose());
      instance.dispose(); preview.current = null; extras.current = null;
    };
  }, [file, job, geometry]);

  useEffect(() => { fitRef.current(); }, [fitKey]);
  useEffect(() => {
    const instance = preview.current;
    if (!instance) return;
    instance.sceneManager.endLayer = layer;
    instance.sceneManager.renderTravel = showTravel;
  }, [layer, showTravel, ready]);
  useEffect(() => {
    const instance = preview.current;
    if (!instance) return;
    if (overlay.current) {
      overlay.current.removeFromParent(); overlay.current.geometry.dispose();
      (overlay.current.material as THREE.Material).dispose(); overlay.current = null;
    }
    if (brim) {
      const mesh = brimMesh(brim, job.firstLayerZ + 0.015);
      mesh.visible = showBrim;
      overlay.current = mesh; instance.sceneManager.scene.add(mesh);
    }
  }, [brim, job.firstLayerZ, ready]);
  useEffect(() => { if (overlay.current) overlay.current.visible = showBrim; }, [showBrim]);

  return <div className="gcode-view">
    <canvas ref={canvas} aria-label="Interactive 3D G-code toolpath preview" />
    {status && <div className="viewer-loading"><LoaderCircle size={20} className="spin" />{status}</div>}
    {error && <div className="viewer-error"><TriangleAlert size={24} /><p>{error}</p></div>}
    <div className="view-instructions">Drag to orbit <span>·</span> Right-drag to pan <span>·</span> Scroll to zoom</div>
    <div className="axis-guide" aria-hidden="true"><svg viewBox="0 0 72 72"><path d="M32 41L58 47" stroke="#e1a167"/><path d="M32 41L13 54" stroke="#8fbca9"/><path d="M32 41V13" stroke="#84b2d2"/><text x="60" y="52" fill="#e1a167">X</text><text x="5" y="64" fill="#8fbca9">Y</text><text x="28" y="10" fill="#84b2d2">Z</text></svg></div>
  </div>;
}
