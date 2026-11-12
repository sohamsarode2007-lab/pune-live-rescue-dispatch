import React from 'react';
import { createRoot } from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import Dispatcher from './pages/Dispatcher.jsx';

// Pages by path. Phase 2 adds /sos, Phase 7 adds /benchmarks.
const PAGES = { '/': Dispatcher };
const Page = PAGES[window.location.pathname] ?? Dispatcher;

createRoot(document.getElementById('root')).render(<Page />);
