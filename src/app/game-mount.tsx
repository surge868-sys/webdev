'use client';
import { useEffect, useRef } from 'react';

/** Mounts the three.js game via dynamic import so `three` never enters the shared bundle. */
export default function GameMount() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    import('@/game3d/game').then((mod) => {
      if (cancelled || !ref.current) return;
      cleanup = mod.startGame(ref.current);
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
  return <div ref={ref} className="fixed inset-0 bg-[#6ea7dd]" aria-label="CLEARANCE 3D game" />;
}
