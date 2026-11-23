/** Browser entry point for the same-origin Agent Hub web application. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './web/App';
import { LocaleProvider } from './i18n';
import './app.css';
import './web/web.css';

// Older iOS releases expose Home Screen launch through navigator.standalone.
if ((navigator as Navigator & { standalone?: boolean }).standalone) {
  document.documentElement.classList.add('web-standalone');
}

/** Required mount point supplied by the repository's index.html. */
const root = document.getElementById('root');
if (!root) throw new Error('Agent Hub mount point is missing');
createRoot(root).render(<StrictMode><LocaleProvider><App /></LocaleProvider></StrictMode>);
