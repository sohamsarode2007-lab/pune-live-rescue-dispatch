import React from 'react';
import { createRoot } from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import Dispatcher from './pages/Dispatcher.jsx';
import SOS from './pages/SOS.jsx';
import Algorithms from './pages/Algorithms.jsx';
import Replay from './pages/Replay.jsx';
import Benchmarks from './pages/Benchmarks.jsx';

// Pages by path (the server and Vite both fall back to index.html).
const PAGES = { '/': Dispatcher, '/sos': SOS, '/algorithms': Algorithms, '/replay': Replay, '/benchmarks': Benchmarks };
const path = window.location.pathname.replace(/\/+$/, '') || '/';
const Page = PAGES[path] ?? Dispatcher;

createRoot(document.getElementById('root')).render(<Page />);
