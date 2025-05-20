import { tool } from 'ai';
import { z } from 'zod';

export const renderReact = tool({
  description: 'Render a React component with the provided code. The code should be a complete React component named "Component".',
  parameters: z.object({
    code: z.string().describe('The React component code to render. Must export a component named "Component".'),
    scope: z.record(z.any()).optional().describe('Additional dependencies to inject into the component scope'),
  }),
  execute: async ({ code, scope = {} }) => {
    // We just pass through the code and scope - actual rendering happens in the UI
    return {
      code,
      scope
    };
  },
}); 