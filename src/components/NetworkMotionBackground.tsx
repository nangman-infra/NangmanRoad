import { useEffect, useRef } from "react";
import type { JourneyState, ThemeMode } from "./AppShell";

interface NetworkMotionBackgroundProps {
  journeyState: JourneyState;
  theme: ThemeMode;
}

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
    ringCount: ringCounts[ringCounts.length - 1],
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

function getMotionPalette(theme: ThemeMode) {
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
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
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

      const currentTheme = themeRef.current;
      const palette = getMotionPalette(currentTheme);
      const revealHiddenNodes = smoothStep(motion.drift / 0.34);
      const viewportScale = clamp(Math.sqrt((width * height) / (1440 * 820)), 1, 1.8);
      const formationReach = motion.drift * (width < 768 ? 34 : 58) * viewportScale;
      const maxDistance = (width < 768 ? 118 : 148) * viewportScale + formationReach;
      const baseAlpha = (currentTheme === "light" ? 0.24 : 0.17) * motion.sceneOpacity;
      const launchAlpha = motion.linkBoost * (currentTheme === "light" ? 0.1 : 0.1) * motion.sceneOpacity;

      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const nodeLayout = getRenderPoint(node, index, time);
        const nodePresence = getIdlePresence(index) ? 1 : revealHiddenNodes;

        if (nodePresence <= 0.02) {
          continue;
        }

        for (let nextIndex = index + 1; nextIndex < nodes.length; nextIndex += 1) {
          const next = nodes[nextIndex];
          const nextLayout = getRenderPoint(next, nextIndex, time);
          const nextPresence = getIdlePresence(nextIndex) ? 1 : revealHiddenNodes;

          if (nextPresence <= 0.02) {
            continue;
          }

          const distance = Math.hypot(nodeLayout.x - nextLayout.x, nodeLayout.y - nextLayout.y);

          if (distance > maxDistance) {
            continue;
          }

          const strength = 1 - distance / maxDistance;
          const accent = node.accent > 0.88 || next.accent > 0.88;
          const color = accent ? palette.violet : palette.line;

          ctx.beginPath();
          ctx.moveTo(nodeLayout.x, nodeLayout.y);
          ctx.lineTo(nextLayout.x, nextLayout.y);
          ctx.strokeStyle = `${color}${(baseAlpha + launchAlpha) * strength * opacity * nodePresence * nextPresence})`;
          ctx.lineWidth = currentTheme === "light" ? 0.58 + strength * 0.4 : 0.52 + strength * 0.34;
          ctx.stroke();
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
      const drawnEdges = new Set<string>();

      function drawEdge(fromIndex: number, toIndex: number, strength: number) {
        const from = nodes[fromIndex];
        const to = nodes[toIndex];
        const edgeKey = fromIndex < toIndex ? `${fromIndex}:${toIndex}` : `${toIndex}:${fromIndex}`;

        if (!from || !to || drawnEdges.has(edgeKey)) {
          return;
        }

        drawnEdges.add(edgeKey);

        const fromLayout = layouts[fromIndex];
        const toLayout = layouts[toIndex];
        const depth = (fromLayout.depth + toLayout.depth) * 0.5;
        const depthPresence = Math.pow(clamp((depth + 1) / 2, 0, 1), 1.25);
        const frontBias = 0.16 + depthPresence * 0.84;
        const accent = from.accent > 0.9 || to.accent > 0.9;
        const color = accent ? palette.violet : palette.line;
        const midX = (fromLayout.x + toLayout.x) * 0.5;
        const midY = (fromLayout.y + toLayout.y) * 0.5;
        const radialX = midX - centerX;
        const radialY = midY - centerY;
        const radialLength = Math.hypot(radialX, radialY) || 1;
        const surfaceBias = clamp(radialLength / structureRadius, 0, 1);
        const edgeLength = Math.hypot(fromLayout.x - toLayout.x, fromLayout.y - toLayout.y);
        const bend = Math.min(16, edgeLength * 0.08) * surfaceBias * meshReveal;
        const controlX = midX + (radialX / radialLength) * bend;
        const controlY = midY + (radialY / radialLength) * bend;

        ctx.beginPath();
        ctx.moveTo(fromLayout.x, fromLayout.y);
        ctx.quadraticCurveTo(controlX, controlY, toLayout.x, toLayout.y);
        ctx.strokeStyle = `${color}${alphaBase * strength * frontBias})`;
        ctx.lineWidth = currentTheme === "light" ? 0.46 + strength * 0.3 : 0.46 + strength * 0.28;
        ctx.stroke();
      }

      const ringCounts = getSphereRingCounts(width, height);
      const rings: number[][] = [];
      let ringStart = 0;

      ringCounts.forEach((ringCount) => {
        const ring = Array.from({ length: ringCount }, (_value, offset) => ringStart + offset).filter(
          (index) => index < layouts.length
        );

        rings.push(ring);
        ringStart += ringCount;
      });

      rings.forEach((ring, ringIndex) => {
        const isPolarRing = ringIndex === 0 || ringIndex === rings.length - 1;

        if (ring.length < 2) {
          return;
        }

        ring.forEach((fromIndex, sortedIndex) => {
          const toIndex = ring[sortedIndex + 1] ?? (ring.length > 3 ? ring[0] : undefined);

          if (toIndex === undefined) {
            return;
          }

          drawEdge(fromIndex, toIndex, isPolarRing ? 0.4 : 0.54);
        });
      });

      for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex += 1) {
        const upperRing = rings[ringIndex];
        const lowerRing = rings[ringIndex + 1];

        if (upperRing.length < 2 || lowerRing.length < 2) {
          continue;
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

          drawEdge(upperA, lowerA, 0.64);
          drawEdge(upperB, lowerB, 0.64);

          if ((cellIndex + ringIndex) % 2 === 0) {
            drawEdge(upperA, lowerB, 0.46);
          } else {
            drawEdge(upperB, lowerA, 0.46);
          }
        }
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

      nodes.forEach((node, index) => {
        const idlePresence = getIdlePresence(index) ? 1 : formedNodeStyle;

        if (idlePresence <= 0.02) {
          return;
        }

        const pulse = Math.sin(time * 1.1 + node.phase) * 0.5 + 0.5;
        const layout = getRenderPoint(node, index, time);
        const depthScale = motion.drift > 0.08 ? 0.84 + (layout.depth + 1) * 0.2 : 1;

        const accent = node.accent > 0.92;
        const color = accent ? palette.violet : node.accent > 0.72 ? palette.node : palette.line;
        const formedBoost = smoothStep((motion.drift - 0.3) / 0.7);
        const alpha =
          accent
            ? currentTheme === "light"
              ? 0.64 + pulse * 0.24
              : 0.72 + pulse * 0.28
            : currentTheme === "light"
              ? 0.44 + pulse * 0.24 + formedBoost * 0.14
              : 0.5 + pulse * 0.25 + formedBoost * 0.18;
        const radius = (node.radius + pulse * 0.4 + launchGlow * (accent ? 1.28 : 0.82)) * depthScale;
        const depthAlpha = motion.drift > 0.08 ? 0.64 + Math.max(0, layout.depth) * 0.42 : 1;
        const visibleAlpha = motion.sceneOpacity * depthAlpha * idlePresence;
        const idleAlpha = (currentTheme === "light" ? 0.5 : 0.44) * motion.sceneOpacity * idlePresence;
        const idleRadius = (node.radius * 0.66 + pulse * 0.22) * (accent ? 1.25 : 1);

        ctx.save();
        ctx.globalCompositeOperation = "lighter";

        if (formedNodeStyle < 0.06) {
          const idleGlowRadius = idleRadius * (accent ? 5.4 : 4.7);
          const idleGlow = ctx.createRadialGradient(layout.x, layout.y, 0, layout.x, layout.y, idleGlowRadius);

          idleGlow.addColorStop(0, `${color}${(currentTheme === "light" ? 0.14 : 0.2) * idlePresence * motion.sceneOpacity})`);
          idleGlow.addColorStop(1, `${color}0)`);
          ctx.fillStyle = idleGlow;
          ctx.beginPath();
          ctx.arc(layout.x, layout.y, idleGlowRadius, 0, Math.PI * 2);
          ctx.fill();

          ctx.beginPath();
          ctx.arc(layout.x, layout.y, idleRadius, 0, Math.PI * 2);
          ctx.fillStyle = `${color}${idleAlpha})`;
          ctx.fill();
          ctx.restore();
          return;
        }

        if (launchGlow > 0.08) {
          const glowRadius = radius * (accent ? 8.2 : 6.8);
          const glow = ctx.createRadialGradient(layout.x, layout.y, 0, layout.x, layout.y, glowRadius);

          glow.addColorStop(0, `${color}${(currentTheme === "light" ? launchGlow * 0.42 : launchGlow * 0.54) * visibleAlpha})`);
          glow.addColorStop(0.34, `${color}${(currentTheme === "light" ? launchGlow * 0.14 : launchGlow * 0.2) * visibleAlpha})`);
          glow.addColorStop(1, `${color}0)`);
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(layout.x, layout.y, glowRadius, 0, Math.PI * 2);
          ctx.fill();
        }

        if (transitionRipple > 0.02) {
          const ripplePhase = (time * 1.05 + node.phase) % 1;
          const rippleRadius = radius * (2.25 + ripplePhase * 2.55);
          const rippleAlpha = (1 - ripplePhase) * transitionRipple * (currentTheme === "light" ? 0.24 : 0.3) * visibleAlpha;

          ctx.beginPath();
          ctx.arc(layout.x, layout.y, rippleRadius, 0, Math.PI * 2);
          ctx.strokeStyle = `${color}${rippleAlpha})`;
          ctx.lineWidth = 0.75;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(layout.x, layout.y, radius * 1.9, 0, Math.PI * 2);
        ctx.strokeStyle = `${color}${(currentTheme === "light" ? 0.48 : 0.62) * visibleAlpha * formedNodeStyle})`;
        ctx.lineWidth = 0.9;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(layout.x, layout.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = `${color}${alpha * 0.78 * visibleAlpha * formedNodeStyle})`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(layout.x, layout.y, Math.max(0.82, radius * 0.42), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(248, 251, 255, ${(currentTheme === "light" ? 0.64 : 0.78) * visibleAlpha * formedNodeStyle})`;
        ctx.fill();

        ctx.restore();
      });
    }

    function draw(timeStamp: number) {
      const currentTime = timeStamp * 0.001;
      const deltaSeconds = lastTimeStamp === 0 ? 0.016 : Math.min(currentTime - lastTimeStamp, 0.05);
      const delta = deltaSeconds * 60;
      const state = journeyStateRef.current;
      const targetSpeed = state === "launch" ? 0.94 : state === "settled" ? 0.78 : 1;
      const targetLinkBoost = state === "launch" ? 1 : state === "settled" ? 0.28 : 0;
      const targetDrift = state === "idle" ? 0 : 1;
      const targetSceneOpacity = state === "settled" ? 0.1 : 1;

      lastTimeStamp = currentTime;
      motion.speed = mix(motion.speed, targetSpeed, Math.min(1, deltaSeconds * 3.2));
      motion.linkBoost = mix(motion.linkBoost, targetLinkBoost, Math.min(1, deltaSeconds * 3.4));
      motion.drift = mix(motion.drift, targetDrift, Math.min(1, deltaSeconds * 0.62));
      motion.sceneOpacity = mix(motion.sceneOpacity, targetSceneOpacity, Math.min(1, deltaSeconds * 4.2));

      ctx.clearRect(0, 0, width, height);
      drawBackground();
      updateNodes(delta, currentTime);
      drawConnections(currentTime);
      drawNodes(currentTime);

      rafId = requestAnimationFrame(draw);
    }

    resize();
    rafId = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", updatePointer);
    window.addEventListener("mouseleave", leavePointer);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", updatePointer);
      window.removeEventListener("mouseleave", leavePointer);
    };
  }, []);

  return <canvas ref={canvasRef} className="network-motion-canvas pointer-events-none absolute inset-0" />;
}
