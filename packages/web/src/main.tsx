import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Self-hosted fonts (PRD-090). Page renders without network calls for fonts.
import '@fontsource/fraunces/400.css';
import '@fontsource/fraunces/600.css';
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist/600.css';
import '@fontsource/jetbrains-mono/400.css';

import { App } from './App.js';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
