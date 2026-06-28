import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { Toaster } from 'sonner';
import setupLocatorUI from '@locator/runtime';
import { router } from './router';
import '../index.css';

if (import.meta.env.DEV) {
  setupLocatorUI();
}

const root = document.querySelector('#root');
if (!root) {
  throw new Error('root element #root not found');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <RouterProvider router={router} />
    <Toaster position="top-right" richColors closeButton />
  </React.StrictMode>,
);
