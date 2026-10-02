import React from 'react';
import ReactDOM from 'react-dom/client';
import { App, DesktopClient } from '@plain-agent/web';
import './styles.css';

const client = new DesktopClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App client={client} />
  </React.StrictMode>
);
