import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { LampColor, Side, SideSignalState } from "../types";

export type LightPos = { x: number; y: number };

interface Props {
  side: Side;
  state: SideSignalState;
  active: boolean;
  pos: LightPos;
  onPosChange: (side: Side, pos: LightPos) => void;
}

/** Single aspect lamp (red / amber / green / blinking orange). */
function Aspect({ color, title }: { color: LampColor | "off"; title: string }) {
  const cls =
    color === "red"
      ? "on-red"
      : color === "yellow"
        ? "on-yellow"
        : color === "green"
          ? "on-green"
          : color === "orange"
            ? "on-orange blink"
            : "";
  return <span className={`lamp ${cls}`} title={title} />;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Lane signal head: Left | Straight | Right
 * Oriented toward the approaching driver; L/S/R letters stay screen-readable.
 * Drag to reposition (position is percent of the junction).
 */
export function TrafficLight({ side, state, active, pos, onPosChange }: Props) {
  const { left, straight, right } = state.lamps;
  const dragging = useRef(false);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const node = e.currentTarget;
    const junction = node.closest(".junction");
    if (!junction) return;

    dragging.current = true;
    node.classList.add("dragging");
    node.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const box = junction.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      onPosChange(side, {
        x: clamp(((ev.clientX - box.left) / box.width) * 100, 3, 97),
        y: clamp(((ev.clientY - box.top) / box.height) * 100, 3, 97),
      });
    };

    const up = (ev: PointerEvent) => {
      dragging.current = false;
      node.classList.remove("dragging");
      node.releasePointerCapture(ev.pointerId);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
    };

    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    move(e.nativeEvent);
  }

  return (
    <div
      className={`traffic-light side-${side} ${active ? "active" : ""}`}
      style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
      onPointerDown={onPointerDown}
      title={`${side} signals — drag to move`}
      role="group"
    >
      <div className="light-orient">
        <div className="light-head" aria-label={`${side} signals`}>
          <div className="lane-signal" title="Left — always permitted">
            <Aspect color={left === "orange" ? "orange" : left || "orange"} title="Left" />
            <span className="lamp-label">L</span>
          </div>
          <div className="lane-signal" title="Straight">
            <Aspect color={straight} title="Straight" />
            <span className="lamp-label">S</span>
          </div>
          <div className="lane-signal" title="Right — timed green">
            <Aspect color={right} title="Right" />
            <span className="lamp-label">R</span>
          </div>
        </div>
      </div>
      {active && (
        <div className="light-timer">
          {state.remaining_straight_s.toFixed(0)}s
          {right === "green" && (
            <span className="right-timer"> · R {state.remaining_right_s.toFixed(0)}s</span>
          )}
        </div>
      )}
    </div>
  );
}
