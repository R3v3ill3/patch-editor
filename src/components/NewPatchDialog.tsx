'use client';

import { useState, type FormEvent } from 'react';

interface NewPatchDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (code: string, name: string) => void;
}

export default function NewPatchDialog({ isOpen, onClose, onConfirm }: NewPatchDialogProps) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  if (!isOpen) return null;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    onConfirm(code.trim(), name.trim());
    setCode('');
    setName('');
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">New Patch</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="patch-code" className="block text-sm font-medium text-gray-700 mb-1">
              Code *
            </label>
            <input
              id="patch-code"
              type="text"
              required
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder="e.g. P042"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="patch-name" className="block text-sm font-medium text-gray-700 mb-1">
              Name
            </label>
            <input
              id="patch-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Inner West"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => { setCode(''); setName(''); onClose(); }}
              className="text-sm px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="text-sm px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
