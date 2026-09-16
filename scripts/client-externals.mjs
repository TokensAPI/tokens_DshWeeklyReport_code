// DSH's web module loader provides one shared React renderer. Never bundle a
// private react-dom against the host's React: even minor versions can diverge.
export const clientExternals = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
];
