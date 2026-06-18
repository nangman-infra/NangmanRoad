import { useEffect, useRef } from "react";
import type { JourneyState, ThemeMode } from "./AppShell";

type NetworkMotionBackgroundProps = Readonly<{
  journeyState: JourneyState;
  theme: ThemeMode;
}>;

interface NetworkNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  phase: number;
  accent: number;
}

interface PointerPoint {
  x: number;
  y: number;
  active: boolean;
}

interface Point {
  x: number;
  y: number;
}

interface SpherePoint extends Point {
  depth: number;
  unitX: number;
  unitY: number;
  unitZ: number;
  longitude: number;
}

interface SphereRingPosition {
  ringIndex: number;
  ringCount: number;
  ringTotal: number;
  localIndex: number;
}

interface MotionState {
  speed: number;
  linkBoost: number;
  drift: number;
  sceneOpacity: number;
}

interface MotionPalette {
  glow: string;
  line: string;
  node: string;
  nodeSoft: string;
  violet: string;
}

interface AmbientConnectionSettings {
  baseAlpha: number;
  launchAlpha: number;
  maxDistance: number;
  palette: MotionPalette;
  revealHiddenNodes: number;
  theme: ThemeMode;
}

interface SphereMeshContext {
  alphaBase: number;
  centerX: number;
  centerY: number;
  ctx: CanvasRenderingContext2D;
  currentTheme: ThemeMode;
  drawnEdges: Set<string>;
  layouts: SpherePoint[];
  meshReveal: number;
  nodes: NetworkNode[];
  palette: MotionPalette;
  structureRadius: number;
}

interface NodeDrawContext {
  ctx: CanvasRenderingContext2D;
  formedNodeStyle: number;
  launchGlow: number;
  motion: MotionState;
  palette: MotionPalette;
  theme: ThemeMode;
  time: number;
  transitionRipple: number;
}

const desktopSphereRingCounts = [12, 12, 12, 12, 12, 12, 12, 12, 12, 12];
const wideSphereRingCounts = [13, 13, 13, 13, 13, 13, 13, 13, 13, 13, 13];
const ultraWideSphereRingCounts = [14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14];
const mobileSphereRingCounts = [9, 9, 9, 9, 9, 9, 9, 9];

function getSphereRingCounts(width: number, height: number) {
  if (width < 768) {
    return mobileSphereRingCounts;
  }

  if (width >= 1900 || height >= 1040) {
    return ultraWideSphereRingCounts;
  }

  if (width >= 1600 || height >= 940) {
    return wideSphereRingCounts;
  }

  return desktopSphereRingCounts;
}

function getSphereNodeCount(width: number, height: number) {
  return getSphereRingCounts(width, height).reduce((sum, count) => sum + count, 0);
}

function getSphereRingPosition(index: number, width: number, height: number): SphereRingPosition {
  const ringCounts = getSphereRingCounts(width, height);
  let ringStart = 0;

  for (let ringIndex = 0; ringIndex < ringCounts.length; ringIndex += 1) {
    const ringCount = ringCounts[ringIndex];

    if (index < ringStart + ringCount) {
      return {
        ringIndex,
        ringCount,
        ringTotal: ringCounts.length,
        localIndex: index - ringStart
      };
    }

    ringStart += ringCount;
  }

  return {
    ringIndex: ringCounts.length - 1,
    ringCount: ringCounts.at(-1) ?? 0,
    ringTotal: ringCounts.length,
    localIndex: 0
  };
}

function hash(index: number, salt: number) {
  return Math.abs(Math.sin(index * 127.1 + salt * 311.7) * 43758.5453) % 1;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function mix(current: number, target: number, amount: number) {
  return current + (target - current) * amount;
}

function smoothStep(value: number) {
  const t = clamp(value, 0, 1);

  return t * t * (3 - 2 * t);
}

function getIdlePresence(index: number) {
  return index % 2 === 0 || hash(index, 12) > 0.72;
}

function getMotionPalette(theme: ThemeMode): MotionPalette {
  return theme === "light"
    ? {
        node: "rgba(14, 165, 233, ",
        nodeSoft: "rgba(56, 189, 248, ",
        line: "rgba(14, 165, 233, ",
        violet: "rgba(99, 102, 241, ",
        glow: "rgba(56, 189, 248, "
      }
    : {
        node: "rgba(94, 231, 255, ",
        nodeSoft: "rgba(203, 213, 225, ",
        line: "rgba(94, 231, 255, ",
        violet: "rgba(139, 126, 246, ",
        glow: "rgba(94, 231, 255, "
      };
}

function ambientConnectionSettings(params: {
  height: number;
  motion: MotionState;
  theme: ThemeMode;
  width: number;
}): AmbientConnectionSettings {
  const viewportScale = clamp(Math.sqrt((params.width * params.height) / (1440 * 820)), 1, 1.8);
  const formationReach = params.motion.drift * (params.width < 768 ? 34 : 58) * viewportScale;

  return {
    baseAlpha: (params.theme === "light" ? 0.24 : 0.17) * params.motion.sceneOpacity,
    launchAlpha: params.motion.linkBoost * 0.1 * params.motion.sceneOpacity,
    maxDistance: (params.width < 768 ? 118 : 148) * viewportScale + formationReach,
    palette: getMotionPalette(params.theme),
    revealHiddenNodes: smoothStep(params.motion.drift / 0.34),
    theme: params.theme
  };
}

function idlePresence(index: number, revealHiddenNodes: number) {
  return getIdlePresence(index) ? 1 : revealHiddenNodes;
}

function drawAmbientEdge(params: {
  ctx: CanvasRenderingContext2D;
  from: NetworkNode;
  fromLayout: SpherePoint;
  fromPresence: number;
  opacity: number;
  settings: AmbientConnectionSettings;
  to: NetworkNode;
  toLayout: SpherePoint;
  toPresence: number;
}) {
  const distance = Math.hypot(params.fromLayout.x - params.toLayout.x, params.fromLayout.y - params.toLayout.y);

  if (distance > params.settings.maxDistance) {
    return;
  }

  const strength = 1 - distance / params.settings.maxDistance;
  const accent = params.from.accent > 0.88 || params.to.accent > 0.88;
  const color = accent ? params.settings.palette.violet : params.settings.palette.line;

  params.ctx.beginPath();
  params.ctx.moveTo(params.fromLayout.x, params.fromLayout.y);
  params.ctx.lineTo(params.toLayout.x, params.toLayout.y);
  params.ctx.strokeStyle = `${color}${(params.settings.baseAlpha + params.settings.launchAlpha) * strength * params.opacity * params.fromPresence * params.toPresence})`;
  params.ctx.lineWidth = params.settings.theme === "light" ? 0.58 + strength * 0.4 : 0.52 + strength * 0.34;
  params.ctx.stroke();
}

function sphereEdgeKey(fromIndex: number, toIndex: number) {
  return fromIndex < toIndex ? `${fromIndex}:${toIndex}` : `${toIndex}:${fromIndex}`;
}

function sphereRings(ringCounts: number[], layoutCount: number) {
  const rings: number[][] = [];
  let ringStart = 0;

  for (const ringCount of ringCounts) {
    const ring = Array.from({ length: ringCount }, (_value, offset) => ringStart + offset).filter(
      (index) => index < layoutCount
    );

    rings.push(ring);
    ringStart += ringCount;
  }

  return rings;
}

function drawSphereEdge(context: SphereMeshContext, fromIndex: number, toIndex: number, strength: number) {
  const from = context.nodes[fromIndex];
  const to = context.nodes[toIndex];
  const edgeKey = sphereEdgeKey(fromIndex, toIndex);

  if (!from || !to || context.drawnEdges.has(edgeKey)) {
    return;
  }

  context.drawnEdges.add(edgeKey);

  const fromLayout = context.layouts[fromIndex];
  const toLayout = context.layouts[toIndex];
  const depth = (fromLayout.depth + toLayout.depth) * 0.5;
  const depthPresence = Math.pow(clamp((depth + 1) / 2, 0, 1), 1.25);
  const frontBias = 0.16 + depthPresence * 0.84;
  const accent = from.accent > 0.9 || to.accent > 0.9;
  const color = accent ? context.palette.violet : context.palette.line;
  const midX = (fromLayout.x + toLayout.x) * 0.5;
  const midY = (fromLayout.y + toLayout.y) * 0.5;
  const radialX = midX - context.centerX;
  const radialY = midY - context.centerY;
  const radialLength = Math.hypot(radialX, radialY) || 1;
  const surfaceBias = clamp(radialLength / context.structureRadius, 0, 1);
  const edgeLength = Math.hypot(fromLayout.x - toLayout.x, fromLayout.y - toLayout.y);
  const bend = Math.min(16, edgeLength * 0.08) * surfaceBias * context.meshReveal;
  const controlX = midX + (radialX / radialLength) * bend;
  const controlY = midY + (radialY / radialLength) * bend;

  context.ctx.beginPath();
  context.ctx.moveTo(fromLayout.x, fromLayout.y);
  context.ctx.quadraticCurveTo(controlX, controlY, toLayout.x, toLayout.y);
  context.ctx.strokeStyle = `${color}${context.alphaBase * strength * frontBias})`;
  context.ctx.lineWidth = context.currentTheme === "light" ? 0.46 + strength * 0.3 : 0.46 + strength * 0.28;
  context.ctx.stroke();
}

function drawRingEdges(context: SphereMeshContext, ring: number[], ringIndex: number, ringCount: number) {
  if (ring.length < 2) {
    return;
  }

  const isPolarRing = ringIndex === 0 || ringIndex === ringCount - 1;

  for (let index = 0; index < ring.length; index += 1) {
    const toIndex = ring[index + 1] ?? (ring.length > 3 ? ring[0] : undefined);

    if (toIndex !== undefined) {
      drawSphereEdge(context, ring[index], toIndex, isPolarRing ? 0.4 : 0.54);
    }
  }
}

function drawInterRingEdges(context: SphereMeshContext, upperRing: number[], lowerRing: number[], ringIndex: number) {
  if (upperRing.length < 2 || lowerRing.length < 2) {
    return;
  }

  const cellCount = Math.min(upperRing.length, lowerRing.length);

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    const upperA = upperRing[cellIndex % upperRing.length];
    const upperB = upperRing[(cellIndex + 1) % upperRing.length];
    const lowerA = lowerRing[cellIndex % lowerRing.length];
    const lowerB = lowerRing[(cellIndex + 1) % lowerRing.length];
    const uniqueCellNodes = new Set([upperA, upperB, lowerA, lowerB]);

    if (uniqueCellNodes.size < 4) {
      continue;
    }

    drawSphereEdge(context, upperA, lowerA, 0.64);
    drawSphereEdge(context, upperB, lowerB, 0.64);
    drawSphereEdge(
      context,
      (cellIndex + ringIndex) % 2 === 0 ? upperA : upperB,
      (cellIndex + ringIndex) % 2 === 0 ? lowerB : lowerA,
      0.46
    );
  }
}

function nodeColor(node: NetworkNode, palette: MotionPalette) {
  if (node.accent > 0.92) {
    return palette.violet;
  }

  return palette.node;
}

function formedNodeAlpha(params: { accent: boolean; formedBoost: number; pulse: number; theme: ThemeMode }) {
  if (params.accent) {
    return params.theme === "light" ? 0.64 + params.pulse * 0.24 : 0.72 + params.pulse * 0.28;
  }

  return params.theme === "light"
    ? 0.44 + params.pulse * 0.24 + params.formedBoost * 0.14
    : 0.5 + params.pulse * 0.25 + params.formedBoost * 0.18;
}

function drawIdleNode(params: {
  accent: boolean;
  color: string;
  context: NodeDrawContext;
  idlePresence: number;
  idleRadius: number;
  layout: SpherePoint;
}) {
  const { ctx, motion, theme } = params.context;
  const idleGlowRadius = params.idleRadius * (params.accent ? 5.4 : 4.7);
  const idleGlow = ctx.createRadialGradient(params.layout.x, params.layout.y, 0, params.layout.x, params.layout.y, idleGlowRadius);

  idleGlow.addColorStop(0, `${params.color}${(theme === "light" ? 0.14 : 0.2) * params.idlePresence * motion.sceneOpacity})`);
  idleGlow.addColorStop(1, `${params.color}0)`);
  ctx.fillStyle = idleGlow;
  ctx.beginPath();
  ctx.arc(params.layout.x, params.layout.y, idleGlowRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(params.layout.x, params.layout.y, params.idleRadius, 0, Math.PI * 2);
  ctx.fillStyle = `${params.color}${(theme === "light" ? 0.5 : 0.44) * motion.sceneOpacity * params.idlePresence})`;
  ctx.fill();
}

function drawFormedGlow(params: {
  accent: boolean;
  color: string;
  context: NodeDrawContext;
  layout: SpherePoint;
  radius: number;
  visibleAlpha: number;
}) {
  if (params.context.launchGlow <= 0.08) {
    return;
  }

  const { ctx, launchGlow, theme } = params.context;
  const glowRadius = params.radius * (params.accent ? 8.2 : 6.8);
  const glow = ctx.createRadialGradient(params.layout.x, params.layout.y, 0, params.layout.x, params.layout.y, glowRadius);

  glow.addColorStop(0, `${params.color}${(theme === "light" ? launchGlow * 0.42 : launchGlow * 0.54) * params.visibleAlpha})`);
  glow.addColorStop(0.34, `${params.color}${(theme === "light" ? launchGlow * 0.14 : launchGlow * 0.2) * params.visibleAlpha})`);
  glow.addColorStop(1, `${params.color}0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(params.layout.x, params.layout.y, glowRadius, 0, Math.PI * 2);
  ctx.fill();
}

function drawTransitionRipple(params: {
  color: string;
  context: NodeDrawContext;
  layout: SpherePoint;
  node: NetworkNode;
  radius: number;
  visibleAlpha: number;
}) {
  if (params.context.transitionRipple <= 0.02) {
    return;
  }

  const { ctx, theme, time, transitionRipple } = params.context;
  const ripplePhase = (time * 1.05 + params.node.phase) % 1;
  const rippleRadius = params.radius * (2.25 + ripplePhase * 2.55);
  const rippleAlpha = (1 - ripplePhase) * transitionRipple * (theme === "light" ? 0.24 : 0.3) * params.visibleAlpha;

  ctx.beginPath();
  ctx.arc(params.layout.x, params.layout.y, rippleRadius, 0, Math.PI * 2);
  ctx.strokeStyle = `${params.color}${rippleAlpha})`;
  ctx.lineWidth = 0.75;
  ctx.stroke();
}

function drawFormedNode(params: {
  alpha: number;
  color: string;
  context: NodeDrawContext;
  layout: SpherePoint;
  radius: number;
  visibleAlpha: number;
}) {
  const { ctx, formedNodeStyle, theme } = params.context;

  ctx.beginPath();
  ctx.arc(params.layout.x, params.layout.y, params.radius * 1.9, 0, Math.PI * 2);
  ctx.strokeStyle = `${params.color}${(theme === "light" ? 0.48 : 0.62) * params.visibleAlpha * formedNodeStyle})`;
  ctx.lineWidth = 0.9;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(params.layout.x, params.layout.y, params.radius, 0, Math.PI * 2);
  ctx.fillStyle = `${params.color}${params.alpha * 0.78 * params.visibleAlpha * formedNodeStyle})`;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(params.layout.x, params.layout.y, Math.max(0.82, params.radius * 0.42), 0, Math.PI * 2);
  ctx.fillStyle = `rgba(248, 251, 255, ${(theme === "light" ? 0.64 : 0.78) * params.visibleAlpha * formedNodeStyle})`;
  ctx.fill();
}

function buildNodes(width: number, height: number) {
  const count = getSphereNodeCount(width, height);

  return Array.from({ length: count }, (_value, index): NetworkNode => {
    const angle = hash(index, 4) * Math.PI * 2;
    const speed = 0.12 + hash(index, 5) * 0.18;

    return {
      x: hash(index, 1) * width,
      y: hash(index, 2) * height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 1.18 + hash(index, 3) * 1.35,
      phase: hash(index, 6) * Math.PI * 2,
      accent: hash(index, 7)
    };
  });
}

function wrapNode(node: NetworkNode, width: number, height: number) {
  const padding = 32;

  if (node.x < -padding) node.x = width + padding;
  if (node.x > width + padding) node.x = -padding;
  if (node.y < -padding) node.y = height + padding;
  if (node.y > height + padding) node.y = -padding;
}

function formationPoint(index: number, width: number, height: number, time: number): SpherePoint {
  const centerX = width * 0.5;
  const centerY = height * 0.48;
  const shortSide = Math.min(width, height);
  const structureRadius = shortSide * (width < 768 ? 0.34 : 0.38);
  const ringPosition = getSphereRingPosition(index, width, height);
  const normalized = (ringPosition.ringIndex + 0.5) / ringPosition.ringTotal;
  const y3d = 1 - normalized * 2;
  const latitudeRadius = Math.sqrt(Math.max(0, 1 - y3d * y3d));
  const longitude = (ringPosition.localIndex / ringPosition.ringCount) * Math.PI * 2 + time * 0.058;
  const radialJitter = 1;
  const x3d = Math.cos(longitude) * latitudeRadius * radialJitter;
  const z3d = Math.sin(longitude) * latitudeRadius * radialJitter;
  const perspective = 0.94 + z3d * 0.065;

  return {
    x: centerX + x3d * structureRadius * perspective,
    y: centerY + y3d * structureRadius * 0.98 * perspective,
    depth: z3d,
    unitX: x3d,
    unitY: y3d,
    unitZ: z3d,
    longitude
  };
}

function targetMotion(state: JourneyState): MotionState {
  if (state === "launch") {
    return {
      speed: 0.94,
      linkBoost: 1,
      drift: 1,
      sceneOpacity: 1
    };
  }

  if (state === "settled") {
    return {
      speed: 0.78,
      linkBoost: 0.28,
      drift: 1,
      sceneOpacity: 0.1
    };
  }

  return {
    speed: 1,
    linkBoost: 0,
    drift: 0,
    sceneOpacity: 1
  };
}

export function NetworkMotionBackground({ journeyState, theme }: NetworkMotionBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const journeyStateRef = useRef<JourneyState>(journeyState);
  const themeRef = useRef<ThemeMode>(theme);
  const pointerRef = useRef<PointerPoint>({ x: 0, y: 0, active: false });

  useEffect(() => {
    journeyStateRef.current = journeyState;
  }, [journeyState]);

  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    const canvasElement = canvas;
    const ctx = context;
    let width = 0;
    let height = 0;
    let nodes: NetworkNode[] = [];
    let rafId = 0;
    let lastTimeStamp = 0;
    let initialized = false;
    let motion = {
      speed: 1,
      linkBoost: 0,
      drift: 0,
      sceneOpacity: 1
    };

    function resize() {
      const bounds = canvasElement.getBoundingClientRect();
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      const previousWidth = width;
      const previousHeight = height;
      const nextWidth = bounds.width;
      const nextHeight = bounds.height;

      width = nextWidth;
      height = nextHeight;
      canvasElement.width = Math.floor(width * dpr);
      canvasElement.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (
        !initialized ||
        nodes.length !== getSphereNodeCount(width, height) ||
        previousWidth === 0 ||
        previousHeight === 0
      ) {
        nodes = buildNodes(width, height);
        initialized = true;
        return;
      }

      if (Math.abs(previousWidth - width) > 0.5 || Math.abs(previousHeight - height) > 0.5) {
        const xScale = width / previousWidth;
        const yScale = height / previousHeight;

        nodes.forEach((node) => {
          node.x *= xScale;
          node.y *= yScale;
          wrapNode(node, width, height);
        });
      }
    }

    function updatePointer(event: MouseEvent) {
      const bounds = canvasElement.getBoundingClientRect();

      pointerRef.current = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
        active: true
      };
    }

    function leavePointer() {
      pointerRef.current.active = false;
    }

    function drawBackground() {
      const currentTheme = themeRef.current;
      const palette = getMotionPalette(currentTheme);
      const centerX = width * 0.5;
      const centerY = height * 0.48;
      const radius = Math.max(width, height) * 0.62;
      const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);

      glow.addColorStop(
        0,
        `${palette.glow}${(currentTheme === "light" ? 0.12 + motion.linkBoost * 0.055 : 0.12 + motion.linkBoost * 0.08) * motion.sceneOpacity})`
      );
      glow.addColorStop(0.36, `${palette.glow}${(currentTheme === "light" ? 0.045 : 0.052) * motion.sceneOpacity})`);
      glow.addColorStop(1, `${palette.glow}0)`);

      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
    }

    function getRenderPoint(node: NetworkNode, index: number, time: number): SpherePoint {
      const target = formationPoint(index, width, height, time);
      const entryProgress = smoothStep((motion.drift - 0.02) / 0.66);
      const formationProgress = smoothStep((motion.drift - 0.06) / 0.94);
      const centerX = width * 0.5;
      const centerY = height * 0.48;
      const shortSide = Math.min(width, height);
      const sphereScale = 0.62 + formationProgress * 0.38;
      const swirlRadius = shortSide * (0.045 + hash(index, 8) * 0.06) * (1 - formationProgress);
      const swirlAngle = node.phase + hash(index, 9) * Math.PI * 2 + time * 0.16;
      const structuredX = centerX + (target.x - centerX) * sphereScale + Math.cos(swirlAngle) * swirlRadius;
      const structuredY = centerY + (target.y - centerY) * sphereScale + Math.sin(swirlAngle) * swirlRadius * 0.82;

      return {
        ...target,
        x: mix(node.x, structuredX, entryProgress),
        y: mix(node.y, structuredY, entryProgress)
      };
    }

    function drawConnections(time: number) {
      const ambientFade = 1 - smoothStep((motion.drift - 0.1) / 0.38);

      drawAmbientConnections(time, ambientFade);

      if (motion.drift > 0.12) {
        drawSphereConnections(time);
      }
    }

    function drawAmbientConnections(time: number, opacity: number) {
      if (opacity <= 0) {
        return;
      }

      const settings = ambientConnectionSettings({
        height,
        motion,
        theme: themeRef.current,
        width
      });

      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const nodeLayout = getRenderPoint(node, index, time);
        const nodePresence = idlePresence(index, settings.revealHiddenNodes);

        if (nodePresence <= 0.02) {
          continue;
        }

        for (let nextIndex = index + 1; nextIndex < nodes.length; nextIndex += 1) {
          const next = nodes[nextIndex];
          const nextLayout = getRenderPoint(next, nextIndex, time);
          const nextPresence = idlePresence(nextIndex, settings.revealHiddenNodes);

          if (nextPresence <= 0.02) {
            continue;
          }

          drawAmbientEdge({
            ctx,
            from: node,
            fromLayout: nodeLayout,
            fromPresence: nodePresence,
            opacity,
            settings,
            to: next,
            toLayout: nextLayout,
            toPresence: nextPresence
          });
        }
      }
    }

    function drawSphereConnections(time: number) {
      const meshReveal = smoothStep((motion.drift - 0.32) / 0.52);

      if (meshReveal <= 0) {
        return;
      }

      const currentTheme = themeRef.current;
      const palette = getMotionPalette(currentTheme);
      const alphaBase = meshReveal * (currentTheme === "light" ? 0.62 : 0.58) * motion.sceneOpacity;
      const centerX = width * 0.5;
      const centerY = height * 0.48;
      const structureRadius = Math.min(width, height) * (width < 768 ? 0.34 : 0.38);
      const layouts = nodes.map((node, index) => getRenderPoint(node, index, time));
      const rings = sphereRings(getSphereRingCounts(width, height), layouts.length);
      const meshContext: SphereMeshContext = {
        alphaBase,
        centerX,
        centerY,
        ctx,
        currentTheme,
        drawnEdges: new Set<string>(),
        layouts,
        meshReveal,
        nodes,
        palette,
        structureRadius
      };

      rings.forEach((ring, ringIndex) => drawRingEdges(meshContext, ring, ringIndex, rings.length));

      for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex += 1) {
        drawInterRingEdges(meshContext, rings[ringIndex], rings[ringIndex + 1], ringIndex);
      }
    }

    function updateNodes(delta: number, time: number) {
      const pointer = pointerRef.current;
      const formationStrength = motion.drift;

      nodes.forEach((node, index) => {
        let driftX = 0;
        let driftY = 0;

        if (formationStrength > 0.01) {
          const target = formationPoint(index, width, height, time);

          driftX = clamp((target.x - node.x) * 0.016, -0.92, 0.92) * formationStrength;
          driftY = clamp((target.y - node.y) * 0.016, -0.92, 0.92) * formationStrength;
        }

        node.x += (node.vx + driftX) * delta * motion.speed;
        node.y += (node.vy + driftY) * delta * motion.speed;

        if (pointer.active) {
          const dx = pointer.x - node.x;
          const dy = pointer.y - node.y;
          const distance = Math.hypot(dx, dy);

          if (distance > 0 && distance < 180) {
            const pressure = ((180 - distance) / 180) * 0.42;

            node.x -= (dx / distance) * pressure * delta;
            node.y -= (dy / distance) * pressure * delta;
          }
        }

        wrapNode(node, width, height);
      });
    }

    function drawNodes(time: number) {
      const currentTheme = themeRef.current;
      const palette = getMotionPalette(currentTheme);
      const launchGlow = motion.drift;
      const transitionRipple = smoothStep(motion.drift / 0.24) * (1 - smoothStep((motion.drift - 0.88) / 0.12));
      const formedNodeStyle = smoothStep((motion.drift - 0.04) / 0.42);
      const nodeContext: NodeDrawContext = {
        ctx,
        formedNodeStyle,
        launchGlow,
        motion,
        palette,
        theme: currentTheme,
        time,
        transitionRipple
      };

      nodes.forEach((node, index) => {
        const idlePresence = getIdlePresence(index) ? 1 : formedNodeStyle;

        if (idlePresence <= 0.02) {
          return;
        }

        const pulse = Math.sin(time * 1.1 + node.phase) * 0.5 + 0.5;
        const layout = getRenderPoint(node, index, time);
        const depthScale = motion.drift > 0.08 ? 0.84 + (layout.depth + 1) * 0.2 : 1;

        const accent = node.accent > 0.92;
        const color = nodeColor(node, palette);
        const formedBoost = smoothStep((motion.drift - 0.3) / 0.7);
        const alpha = formedNodeAlpha({
          accent,
          formedBoost,
          pulse,
          theme: currentTheme
        });
        const radius = (node.radius + pulse * 0.4 + launchGlow * (accent ? 1.28 : 0.82)) * depthScale;
        const depthAlpha = motion.drift > 0.08 ? 0.64 + Math.max(0, layout.depth) * 0.42 : 1;
        const visibleAlpha = motion.sceneOpacity * depthAlpha * idlePresence;
        const idleRadius = (node.radius * 0.66 + pulse * 0.22) * (accent ? 1.25 : 1);

        ctx.save();
        ctx.globalCompositeOperation = "lighter";

        if (formedNodeStyle < 0.06) {
          drawIdleNode({
            accent,
            color,
            context: nodeContext,
            idlePresence,
            idleRadius,
            layout
          });
          ctx.restore();
          return;
        }

        drawFormedGlow({ accent, color, context: nodeContext, layout, radius, visibleAlpha });
        drawTransitionRipple({ color, context: nodeContext, layout, node, radius, visibleAlpha });
        drawFormedNode({ alpha, color, context: nodeContext, layout, radius, visibleAlpha });

        ctx.restore();
      });
    }

    function draw(timeStamp: number) {
      const currentTime = timeStamp * 0.001;
      const deltaSeconds = lastTimeStamp === 0 ? 0.016 : Math.min(currentTime - lastTimeStamp, 0.05);
      const delta = deltaSeconds * 60;
      const state = journeyStateRef.current;
      const target = targetMotion(state);

      lastTimeStamp = currentTime;
      motion.speed = mix(motion.speed, target.speed, Math.min(1, deltaSeconds * 3.2));
      motion.linkBoost = mix(motion.linkBoost, target.linkBoost, Math.min(1, deltaSeconds * 3.4));
      motion.drift = mix(motion.drift, target.drift, Math.min(1, deltaSeconds * 0.62));
      motion.sceneOpacity = mix(motion.sceneOpacity, target.sceneOpacity, Math.min(1, deltaSeconds * 4.2));

      ctx.clearRect(0, 0, width, height);
      drawBackground();
      updateNodes(delta, currentTime);
      drawConnections(currentTime);
      drawNodes(currentTime);

      rafId = requestAnimationFrame(draw);
    }

    resize();
    rafId = requestAnimationFrame(draw);
    globalThis.addEventListener("resize", resize);
    globalThis.addEventListener("mousemove", updatePointer);
    globalThis.addEventListener("mouseleave", leavePointer);

    return () => {
      cancelAnimationFrame(rafId);
      globalThis.removeEventListener("resize", resize);
      globalThis.removeEventListener("mousemove", updatePointer);
      globalThis.removeEventListener("mouseleave", leavePointer);
    };
  }, []);

  return <canvas ref={canvasRef} className="network-motion-canvas pointer-events-none absolute inset-0" />;
}
