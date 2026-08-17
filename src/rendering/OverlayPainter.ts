/**
 * The fingertip markers, polygon guides and centre label.
 *
 * Painted on a 2D canvas stacked ABOVE the WebGL canvas. Keeping them off the
 * GL canvas is what lets `captureStream()` record a clean composite — the
 * guides are interface, not footage.
 */

import type { Quad, Vec2 } from '../utils/geometry';
import { centroid } from '../utils/geometry';

export interface OverlayState {
  quad: Quad | null;
  /** 0 = invisible, 1 = fully drawn. */
  alpha: number;
  /** Dimmer, dashed treatment while the gesture is still being confirmed. */
  confirming: boolean;
  label: string;
  accent: [string, string];
  showLabel: boolean;
  dpr: number;
}

export class OverlayPainter {
  private ctx: CanvasRenderingContext2D | null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d');
  }

  clear(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(state: OverlayState): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);

    const { quad, alpha } = state;
    if (!quad || alpha <= 0.01) return;

    const s = Math.max(1, state.dpr);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    this.drawEdges(ctx, quad, state, s);
    this.drawCorners(ctx, quad, state, s);
    if (state.showLabel && !state.confirming) this.drawLabel(ctx, quad, state, s);

    ctx.restore();
  }

  private drawEdges(
    ctx: CanvasRenderingContext2D,
    quad: Quad,
    state: OverlayState,
    s: number,
  ): void {
    const path = new Path2D();
    path.moveTo(quad[0].x, quad[0].y);
    for (let i = 1; i < quad.length; i++) path.lineTo(quad[i].x, quad[i].y);
    path.closePath();

    // Wide, very soft pass first: reads as glow rather than as a wireframe.
    ctx.save();
    ctx.strokeStyle = state.accent[0];
    ctx.globalAlpha *= 0.20;
    ctx.lineWidth = 6 * s;
    ctx.filter = 'blur(0px)';
    ctx.shadowColor = state.accent[0];
    ctx.shadowBlur = 16 * s;
    ctx.stroke(path);
    ctx.restore();

    // Dark under-stroke, so the hairline stays visible against a bright frame.
    ctx.save();
    if (state.confirming) ctx.setLineDash([6 * s, 7 * s]);
    ctx.strokeStyle = 'rgba(0,0,0,0.42)';
    ctx.lineWidth = 3.2 * s;
    ctx.stroke(path);
    ctx.restore();

    ctx.save();
    if (state.confirming) {
      ctx.setLineDash([6 * s, 7 * s]);
      ctx.globalAlpha *= 0.7;
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.78)';
    ctx.lineWidth = 1.4 * s;
    ctx.stroke(path);
    ctx.restore();
  }

  private drawCorners(
    ctx: CanvasRenderingContext2D,
    quad: Quad,
    state: OverlayState,
    s: number,
  ): void {
    quad.forEach((p, i) => {
      const accent = i % 2 === 0 ? state.accent[0] : state.accent[1];

      // Soft halo.
      const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 17 * s);
      halo.addColorStop(0, withAlpha(accent, 0.55));
      halo.addColorStop(0.55, withAlpha(accent, 0.16));
      halo.addColorStop(1, withAlpha(accent, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 17 * s, 0, Math.PI * 2);
      ctx.fill();

      // Thin ring, over a dark keyline for contrast.
      ctx.strokeStyle = 'rgba(0,0,0,0.38)';
      ctx.lineWidth = 3 * s;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8.5 * s, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = 1.3 * s;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8.5 * s, 0, Math.PI * 2);
      ctx.stroke();

      // Core.
      ctx.fillStyle = '#fff';
      ctx.shadowColor = accent;
      ctx.shadowBlur = 10 * s;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    });
  }

  private drawLabel(
    ctx: CanvasRenderingContext2D,
    quad: Quad,
    state: OverlayState,
    s: number,
  ): void {
    const c = centroid(quad);
    const text = state.label.toUpperCase();

    ctx.save();
    ctx.font = `600 ${12 * s}px ui-sans-serif, -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = `${2.4 * s}px`;

    const metrics = ctx.measureText(text);
    const padX = 11 * s;
    const padY = 6 * s;
    const w = metrics.width + padX * 2;
    const h = 12 * s + padY * 2;

    ctx.globalAlpha *= 0.92;
    roundRect(ctx, c.x - w / 2, c.y - h / 2, w, h, 999);
    ctx.fillStyle = 'rgba(8,8,12,0.34)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1 * s;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 6 * s;
    ctx.fillText(text, c.x, c.y + 0.5 * s);
    ctx.restore();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** #rrggbb -> rgba(). Accepts the hex colours used in the filter registry. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export type { Vec2 };
