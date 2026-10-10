import { render } from 'preact';
import { viewer } from './app/actions';
import { App } from './app/App';
import { BRAND_MARK_URI } from './app/brand';
import { store } from './app/store';
import { worldToScreen } from './render/camera';
import './styles/app.css';

document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute('href', BRAND_MARK_URI);

// Debug/automation handle (local only; used by the end-to-end tests).
(window as unknown as { boardloupe: unknown }).boardloupe = {
  viewer,
  store,
  /** Screen position (CSS px, relative to the board canvas) of a world point. */
  toScreen: (x: number, y: number) => worldToScreen(viewer.view, x, y),
};

render(<App />, document.getElementById('app')!);
