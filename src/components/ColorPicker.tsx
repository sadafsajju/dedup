import { useEffect, useId, useRef, useState } from "react";
import { Cross2Icon, CheckIcon } from "@radix-ui/react-icons";
import { createPortal } from "react-dom";
import { clamp, parseHex, toHex, type HSV } from "../lib/color";
import { cssColor } from "../lib/tailwind";
import { Swatch } from "./ui";

const PRESETS = ["#FFFFFF", "#111111", "#71717A", "#EF4444", "#F97316", "#FACC15", "#22C55E", "#14B8A6", "#3B82F6", "#8B5CF6", "#D946EF", "#EC4899"];
let gesture = 0;

/** Resolve theme colors through the browser, including Tailwind's oklch palette. */
function resolveColor(value: string | null): HSV | null {
  const css = cssColor(value);
  if (!css) return null;
  const probe = document.createElement("span");
  probe.style.color = css;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = resolved;
  ctx.fillRect(0, 0, 1, 1);
  const bytes = ctx.getImageData(0, 0, 1, 1).data;
  return parseHex([...bytes].map(n => n.toString(16).padStart(2, "0")).join(""));
}

export function ColorPicker({ value, onChange }: { value: string | null; onChange: (hex: string, group?: string) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const id = useId();
  return <>
    <button ref={trigger} type="button" className="color-picker-trigger" aria-label="Choose fill color" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => {
      const rect = trigger.current!.getBoundingClientRect();
      setPosition({ left: Math.max(12, Math.min(rect.left - 294, window.innerWidth - 298)), top: Math.max(12, Math.min(rect.top - 120, window.innerHeight - 450)) });
      setOpen(true);
    }}><Swatch value={value} /></button>
    {open && createPortal(<ColorDialog id={id} value={value} position={position} onChange={onChange} onClose={() => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }} />, document.body)}
  </>;
}

function ColorDialog({ id, value, position, onChange, onClose }: { id: string; value: string | null; position: { left: number; top: number }; onChange: (hex: string, group?: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [location, setLocation] = useState(position);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const keepInWindow = (left: number, top: number) => {
    const rect = dialog.current?.getBoundingClientRect();
    return {
      left: clamp(left, 12, Math.max(12, window.innerWidth - (rect?.width ?? 282) - 12)),
      top: clamp(top, 12, Math.max(12, window.innerHeight - (rect?.height ?? 450) - 12)),
    };
  };
  const endDrag = () => { drag.current = null; setDragging(false); };
  const [color, setColor] = useState<HSV>(() => resolveColor(value) ?? { h: 0, s: 0, v: 1, a: 1 });
  const [draft, setDraft] = useState(() => toHex(color).slice(1));
  const [invalid, setInvalid] = useState(false);
  const group = useRef<string | undefined>(undefined);
  const hex = toHex(color);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    const fit = () => setLocation(current => {
      const next = keepInWindow(current.left, current.top);
      return next.left === current.left && next.top === current.top ? current : next;
    });
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    window.addEventListener("resize", fit);
    return () => { observer.disconnect(); window.removeEventListener("resize", fit); };
  }, []);
  const update = (next: HSV, editGroup?: string) => {
    setColor(next); setDraft(toHex(next).slice(1)); setInvalid(false);
    onChange(toHex(next), editGroup);
  };
  const start = () => { group.current = `color-${++gesture}`; };
  const point = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    update({ ...color, s: clamp((e.clientX - rect.left) / rect.width), v: 1 - clamp((e.clientY - rect.top) / rect.height) }, group.current);
  };
  const saveHex = () => {
    const next = parseHex(draft);
    if (next) update(next); else setInvalid(true);
  };
  return <dialog ref={dialog} id={id} className={`color-picker-dialog ${dragging ? "is-dragging" : ""}`} style={location} aria-labelledby={`${id}-title`} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <header
      tabIndex={0}
      aria-label="Move color picker"
      title="Drag to move · arrow keys to nudge"
      onPointerDown={e => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        const rect = dialog.current!.getBoundingClientRect();
        drag.current = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={e => {
        if (!drag.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
        setLocation(keepInWindow(drag.current.left + e.clientX - drag.current.x, drag.current.top + e.clientY - drag.current.y));
      }}
      onPointerUp={e => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        endDrag();
      }}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={e => {
        if (e.target !== e.currentTarget || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
        e.preventDefault();
        const step = e.shiftKey ? 20 : 5;
        setLocation(current => keepInWindow(current.left + (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0), current.top + (e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0)));
      }}
    ><div><h3 id={`${id}-title`}>Fill color</h3><span>Solid color · live preview</span></div><button type="button" aria-label="Close color picker" onClick={onClose}><Cross2Icon /></button></header>
    <div className="color-picker-plane" style={{ backgroundColor: `hsl(${color.h} 100% 50%)` }} onPointerDown={e => { start(); e.currentTarget.setPointerCapture(e.pointerId); point(e); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) point(e); }} onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); group.current = undefined; }} onPointerCancel={() => { group.current = undefined; }}>
      <span className="color-picker-thumb" style={{ left: `${color.s * 100}%`, top: `${(1 - color.v) * 100}%`, background: toHex(color, false) }} />
    </div>
    <div className="color-picker-sliders"><div className="color-picker-preview"><span style={{ background: hex }} /></div><div>
      <input className="color-picker-hue" aria-label="Hue" type="range" min="0" max="359" value={color.h} onPointerDown={start} onPointerUp={() => { group.current = undefined; }} onKeyDown={() => { group.current = undefined; }} onChange={e => update({ ...color, h: +e.target.value }, group.current)} />
      <input className="color-picker-alpha" style={{ backgroundImage: `linear-gradient(to right, transparent, ${toHex(color, false)}), conic-gradient(#555 25%, #333 0 50%, #555 0 75%, #333 0)` }} aria-label="Opacity" type="range" min="0" max="100" value={Math.round(color.a * 100)} onPointerDown={start} onPointerUp={() => { group.current = undefined; }} onKeyDown={() => { group.current = undefined; }} onChange={e => update({ ...color, a: +e.target.value / 100 }, group.current)} />
    </div></div>
    <div className="color-picker-inputs"><label className="color-picker-hex"><span>HEX</span><input autoFocus aria-label="Hex color" aria-invalid={invalid} value={draft} maxLength={9} spellCheck={false} onChange={e => { setDraft(e.target.value); setInvalid(false); }} onBlur={saveHex} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); saveHex(); } }} /></label><label><span>Alpha</span><input aria-label="Opacity percent" type="number" min="0" max="100" value={Math.round(color.a * 100)} onChange={e => update({ ...color, a: clamp(+e.target.value / 100) })} /><span>%</span></label></div>
    {invalid && <p role="alert" className="color-picker-error">Use 3, 4, 6, or 8 hex digits.</p>}
    <details className="color-picker-precision"><summary>Fine tune</summary><label>Saturation<input aria-label="Saturation" type="range" min="0" max="100" value={Math.round(color.s * 100)} onChange={e => update({ ...color, s: +e.target.value / 100 })} /></label><label>Brightness<input aria-label="Brightness" type="range" min="0" max="100" value={Math.round(color.v * 100)} onChange={e => update({ ...color, v: +e.target.value / 100 })} /></label></details>
    <div className="color-picker-presets"><span>Essentials</span><div>{PRESETS.map(preset => <button type="button" key={preset} aria-label={`Use ${preset}`} aria-pressed={hex === preset} style={{ background: preset }} onClick={() => update(parseHex(preset)!)}>{hex === preset && <CheckIcon style={{ color: color.v > .8 && color.s < .5 ? "#111" : "white" }} />}</button>)}</div></div>
    <footer><span className="color-picker-current"><i style={{ background: hex }} />{hex}</span><button type="button" onClick={onClose}>Done</button></footer>
  </dialog>;
}
