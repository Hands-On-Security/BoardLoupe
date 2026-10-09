import { render } from 'preact';
import { viewer } from './app/actions';
import { App } from './app/App';
import { store } from './app/store';
import { worldToScreen } from './render/camera';
import './styles/app.css';

// Debug/automation handle (local only; used by the end-to-end tests).
(window as unknown as { boardscope: unknown }).boardscope = {
  viewer,
  store,
  /** Screen position (CSS px, relative to the board canvas) of a world point. */
  toScreen: (x: number, y: number) => worldToScreen(viewer.view, x, y),
};

render(<App />, document.getElementById('app')!);
