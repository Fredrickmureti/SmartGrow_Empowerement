import { useState, useRef, useCallback, useEffect } from "react";

type Corner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

const EDGE_OFFSET = 24; // px from edge

function getCornerPosition(corner: Corner) {
  switch (corner) {
    case "bottom-right": return { bottom: EDGE_OFFSET, right: EDGE_OFFSET, top: "auto", left: "auto" };
    case "bottom-left": return { bottom: EDGE_OFFSET, left: EDGE_OFFSET, top: "auto", right: "auto" };
    case "top-right": return { top: EDGE_OFFSET + 56, right: EDGE_OFFSET, bottom: "auto", left: "auto" }; // offset for header
    case "top-left": return { top: EDGE_OFFSET + 56, left: EDGE_OFFSET + 64, bottom: "auto", right: "auto" }; // offset for sidebar
  }
}

function getClosestCorner(x: number, y: number): Corner {
  const midX = window.innerWidth / 2;
  const midY = window.innerHeight / 2;
  if (x >= midX && y >= midY) return "bottom-right";
  if (x < midX && y >= midY) return "bottom-left";
  if (x >= midX && y < midY) return "top-right";
  return "top-left";
}

export function useDraggableFAB() {
  const [corner, setCorner] = useState<Corner>(() => {
    return (localStorage.getItem("ai-fab-corner") as Corner) || "bottom-right";
  });
  const [isDragging, setIsDragging] = useState(false);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const wasDraggedRef = useRef(false);

  useEffect(() => {
    localStorage.setItem("ai-fab-corner", corner);
  }, [corner]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragStartRef.current = { x: e.clientX, y: e.clientY, time: Date.now() };
    wasDraggedRef.current = false;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      wasDraggedRef.current = true;
      setIsDragging(true);
      setDragPos({ x: e.clientX - 28, y: e.clientY - 28 }); // center the 56px button
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (wasDraggedRef.current) {
      const newCorner = getClosestCorner(e.clientX, e.clientY);
      setCorner(newCorner);
    }
    dragStartRef.current = null;
    setIsDragging(false);
    setDragPos(null);
  }, []);

  const style: React.CSSProperties = isDragging && dragPos
    ? { position: "fixed", left: dragPos.x, top: dragPos.y, right: "auto", bottom: "auto", transition: "none" }
    : { position: "fixed", ...getCornerPosition(corner), transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)" };

  return {
    style,
    isDragging,
    wasDragged: wasDraggedRef,
    handlers: { onPointerDown, onPointerMove, onPointerUp },
  };
}
