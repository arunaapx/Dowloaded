import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Admin from './Admin.jsx';
import './styles.css';
// After styles.css: it re-tunes the shared tokens for the public site and
// adds the landing-page classes. The admin keeps the same token names.
import './landing.css';

// One page, two surfaces. /Admin (any casing) is the locked editor; everything
// else is the public site. Kept to a path check so the bundle carries no router.
const isAdmin = /^\/admin\/?$/i.test(window.location.pathname);

createRoot(document.getElementById('root')).render(
  <React.StrictMode>{isAdmin ? <Admin /> : <App />}</React.StrictMode>
);
