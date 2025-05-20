'use client';

import { useState } from 'react';
import { DynamicReactRenderer } from './DynamicReactRenderer';

interface DynamicReactExampleProps {
  defaultCode?: string;
}

const DEFAULT_CODE = `
function Component() {
  const [count, setCount] = useState(0);
  
  return (
    <div className="p-4 border rounded">
      <h2 className="text-lg font-bold mb-2">Dynamic Counter</h2>
      <p className="mb-4">Count: {count}</p>
      <button 
        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        onClick={() => setCount(count + 1)}
      >
        Increment
      </button>
    </div>
  );
}
`;

export function DynamicReactExample({ defaultCode = DEFAULT_CODE }: DynamicReactExampleProps) {
  const [code, setCode] = useState(defaultCode);
  const [error, setError] = useState<Error | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-col space-y-2">
        <label htmlFor="code" className="font-medium">
          Edit React Code:
        </label>
        <textarea
          id="code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-full h-48 p-2 font-mono text-sm border rounded"
        />
      </div>

      <div className="border rounded p-4">
        <h3 className="font-medium mb-2">Rendered Output:</h3>
        <DynamicReactRenderer
          code={code}
          onError={setError}
          scope={{
            useState,
            // Add any other dependencies your dynamic component needs
          }}
        />
      </div>

      {error && (
        <div className="p-4 border border-red-500 rounded bg-red-50 text-red-700">
          <p className="font-bold">Error:</p>
          <pre className="mt-2 text-sm whitespace-pre-wrap">{error.message}</pre>
        </div>
      )}
    </div>
  );
} 