import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

// Intentionally not wrapped in StrictMode: its development double-invoke would
// start, tear down and restart getUserMedia and the WebGL context on every
// mount, which real cameras do not enjoy.
createRoot(container).render(<App />);
