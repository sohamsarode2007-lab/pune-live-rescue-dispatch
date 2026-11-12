import React from 'react';
import { createRoot } from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import Dispatcher from './pages/Dispatcher.jsx';
import SOS from './pages/SOS.jsx';
import Algorithms from './pages/Algorithms.jsx';

// Pages by path (the server and Vite both fall back to index.html). Phase 7 adds /benchmarks.
const PAGES = { '/': Dispatcher, '/sos': SOS, '/algorithms': Algorithms };
const path = window.location.pathname.replace(/\/+$/, '') || '/';
const Page = PAGES[path] ?? Dispatcher;

createRoot(document.getElementById('root')).render(<Page />);
