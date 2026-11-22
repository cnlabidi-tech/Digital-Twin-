import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getJson } from './lib/api';
import { bootstrap, connect } from './lib/store';
import './styles.css';

connect();
void bootstrap(getJson);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
