import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Admin from './Admin.jsx';
import HelpPage from './Help.jsx';
import './styles.css';
// After styles.css: it re-tunes the shared tokens for the public site and
// adds the landing-page classes. The admin keeps the same token names.
import './landing.css';

// One bundle, three surfaces. /Admin (any casing) is the locked editor, /help
// is the help centre the desktop app opens, and everything else is the public
// site. Still a path check rather than a router: three paths do not need one.
const path = window.location.pathname;
const isAdmin = /^\/admin\/?$/i.test(path);
const isHelp = /^\/help\/?$/i.test(path);

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isAdmin ? <Admin /> : isHelp ? <HelpPage /> : <App />}
  </React.StrictMode>
);
