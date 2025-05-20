'use client';

import React, { useState, useEffect } from 'react';
import * as ReactComponents from 'react';
import { transform } from '@babel/standalone';

interface DynamicReactRendererProps {
  code: string;
  scope?: Record<string, unknown>;
  onError?: (error: Error) => void;
}

export function DynamicReactRenderer({
  code,
  scope = {},
  onError = console.error,
}: DynamicReactRendererProps) {
  const [Component, setComponent] = useState<React.ComponentType | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    try {
      // Transform JSX to JavaScript
      const transformedCode = transform(code, {
        presets: ['react'],
      }).code;

      // Create a function factory with React in scope
      const scopeKeys = Object.keys(scope);
      const scopeValues = scopeKeys.map(key => scope[key]);
      
      // Create the component factory function
      const factoryCode = `
        return function createComponent() {
          const React = arguments[0];
          ${scopeKeys.map((key, i) => `const ${key} = arguments[${i + 1}];`).join('\n')}
          
          ${transformedCode}
          
          return Component;
        }
      `;

      // Execute the factory with React and scope variables
      const factory = new Function(factoryCode);
      const componentFn = factory();
      const DynamicComponent = componentFn(React, ...scopeValues);

      setComponent(() => DynamicComponent);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to render component'));
      onError(err instanceof Error ? err : new Error('Failed to render component'));
    }
  }, [code, scope, onError]);

  if (error) {
    return (
      <div className="p-4 border border-red-500 rounded bg-red-50 text-red-700">
        <p className="font-bold">Error rendering component:</p>
        <pre className="mt-2 text-sm whitespace-pre-wrap">{error.message}</pre>
      </div>
    );
  }

  if (!Component) {
    return null;
  }

  try {
    return <Component />;
  } catch (err) {
    const renderError = err instanceof Error ? err : new Error('Failed to render component');
    return (
      <div className="p-4 border border-red-500 rounded bg-red-50 text-red-700">
        <p className="font-bold">Runtime error:</p>
        <pre className="mt-2 text-sm whitespace-pre-wrap">{renderError.message}</pre>
      </div>
    );
  }
} 