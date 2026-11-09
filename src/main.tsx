/** Browser/native entry point with explicit demo selection and a closed read-only Tauri boundary. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LocaleProvider } from './i18n';
import './app.css';

/** Required mount point supplied by the repository's index.html. */
const root = document.getElementById('root');
if (!root) throw new Error('Agent Hub mount point is missing');
createRoot(root).render(<StrictMode><LocaleProvider><App /></LocaleProvider></StrictMode>);
