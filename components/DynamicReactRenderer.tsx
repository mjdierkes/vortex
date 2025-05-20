'use client';

import React, { useState, useEffect } from 'react';
import * as ReactComponents from 'react';
import { transform } from '@babel/standalone';

interface DynamicReactRendererProps {
  code: string;
  scope?: Record<string, unknown>;
  onError?: (error: Error) => void;
}

function DynamicReactSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-8 bg-gray-200 rounded w-3/4"></div>
      <div className="space-y-2">
        <div className="h-4 bg-gray-200 rounded w-1/2"></div>
        <div className="h-4 bg-gray-200 rounded w-2/3"></div>
      </div>
      <div className="h-10 bg-gray-200 rounded w-1/4"></div>
    </div>
  );
}

export function DynamicReactRenderer({
  code,
  scope = {},
  onError = console.error,
}: DynamicReactRendererProps) {
  const [Component, setComponent] = useState<React.ComponentType | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
    try {
      // Remove export statements before transformation
      const codeWithoutExports = code.replace(/export\s+(default\s+)?/g, '');
      
      // Transform JSX to JavaScript
      const transformedCode = transform(codeWithoutExports, {
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
      const error = err instanceof Error ? err : new Error('Failed to render component');
      setError(error);
      onError(error);
    } finally {
      setIsLoading(false);
    }
  }, [code, scope, onError]);

  if (error) {
    return (
      <div className="p-4 border border-red-500 rounded bg-red-50 text-red-700">
        <p className="font-bold">Error:</p>
        <pre className="mt-2 text-sm whitespace-pre-wrap">{error.message}</pre>
      </div>
    );
  }

  if (isLoading || !Component) {
    return <DynamicReactSkeleton />;
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