'use client';

import type { OverlapWarning } from '@/types';

interface ValidationBarProps {
  overlaps: OverlapWarning[];
  onDismiss: () => void;
}

export default function ValidationBar({ overlaps, onDismiss }: ValidationBarProps) {
  if (overlaps.length === 0) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-amber-50 border-t border-amber-300 px-4 py-2 flex items-center justify-between z-20 shadow-lg">
      <div className="flex items-center gap-2">
        <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <span className="text-sm font-medium text-amber-800">
          {overlaps.length} overlap{overlaps.length !== 1 ? 's' : ''} detected
        </span>
        <span className="text-xs text-amber-600">
          {overlaps.map(o => `${o.patchACode} / ${o.patchBCode}`).join(', ')}
        </span>
      </div>
      <button
        onClick={onDismiss}
        className="text-xs px-3 py-1 bg-amber-200 text-amber-800 rounded hover:bg-amber-300 transition-colors"
      >
        Dismiss
      </button>
    </div>
  );
}
