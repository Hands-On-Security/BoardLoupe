import type { BoardModel } from '../model/types';
import type { Scene } from '../scene/scene';
import type { View } from './camera';
import type { Palette } from './palette';
import type { Colors, RenderOptions } from './style';

export interface Hover {
  pin: number;
  part: number;
  via: number;
}

export interface FrameInput {
  view: View;
  opts: RenderOptions;
  hover: Hover;
  palette: Palette;
  /** Highlighted part (for drawing its body on top). */
  selPart: number;
}

export interface Renderer {
  readonly kind: 'webgl2' | 'canvas2d';
  setScene(model: BoardModel, scene: Scene): void;
  setColors(colors: Colors): void;
  /** Air-wire segments (world coords, flat x1,y1,x2,y2) or null. */
  setRatsnest(segs: Float64Array | null): void;
  resize(cssW: number, cssH: number, dpr: number): void;
  render(f: FrameInput): void;
  dispose(): void;
}
