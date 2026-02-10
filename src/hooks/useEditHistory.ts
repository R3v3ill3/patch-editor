'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { Geometry } from 'geojson';

export type GeometrySnapshot = Map<string, Geometry>;

function cloneSnapshot(snapshot: GeometrySnapshot): GeometrySnapshot {
  return new Map(
    Array.from(snapshot.entries()).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])
  );
}

function snapshotsEqual(a: GeometrySnapshot, b: GeometrySnapshot): boolean {
  if (a.size !== b.size) return false;
  for (const [key, val] of a) {
    const other = b.get(key);
    if (!other) return false;
    if (JSON.stringify(val) !== JSON.stringify(other)) return false;
  }
  return true;
}

const MAX_HISTORY = 50;

export function useEditHistory() {
  const [past, setPast] = useState<GeometrySnapshot[]>([]);
  const [present, setPresent] = useState<GeometrySnapshot>(new Map());
  const [future, setFuture] = useState<GeometrySnapshot[]>([]);
  const initialized = useRef(false);

  const initialize = useCallback((snapshot: GeometrySnapshot) => {
    setPresent(cloneSnapshot(snapshot));
    setPast([]);
    setFuture([]);
    initialized.current = true;
  }, []);

  const pushState = useCallback((snapshot: GeometrySnapshot) => {
    if (!initialized.current) {
      initialize(snapshot);
      return;
    }
    // Don't push if identical to current
    if (snapshotsEqual(snapshot, present)) return;

    setPast(prev => {
      const next = [...prev, cloneSnapshot(present)];
      if (next.length > MAX_HISTORY) next.shift();
      return next;
    });
    setPresent(cloneSnapshot(snapshot));
    setFuture([]);
  }, [present, initialize]);

  const undo = useCallback((): GeometrySnapshot | null => {
    if (past.length === 0) return null;

    const previous = past[past.length - 1];
    setPast(prev => prev.slice(0, -1));
    setFuture(prev => [cloneSnapshot(present), ...prev]);
    setPresent(previous);
    return previous;
  }, [past, present]);

  const redo = useCallback((): GeometrySnapshot | null => {
    if (future.length === 0) return null;

    const next = future[0];
    setFuture(prev => prev.slice(1));
    setPast(prev => [...prev, cloneSnapshot(present)]);
    setPresent(next);
    return next;
  }, [future, present]);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if (mod && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        redo();
      }
      // Also support Ctrl+Y on non-Mac
      if (!isMac && e.ctrlKey && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  return {
    present,
    canUndo,
    canRedo,
    initialize,
    pushState,
    undo,
    redo,
  };
}
