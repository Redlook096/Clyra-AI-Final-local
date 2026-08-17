export type SmartCameraObservation = {
  x: number;
  y: number;
  zoom: number;
  confidence: number;
  timestampMs: number;
  shotId?: string | number;
};

export type SmartCameraPoint = Omit<SmartCameraObservation, "timestampMs" | "shotId"> & {
  velocityX: number;
  velocityY: number;
};

export type SmartCameraOptions = {
  deadZoneX: number;
  deadZoneY: number;
  predictionMs: number;
  response: number;
  maxVelocity: number;
  maxAcceleration: number;
  zoomDeadZone: number;
};

const DEFAULTS: SmartCameraOptions = {
  deadZoneX: 4.8,
  deadZoneY: 3.6,
  predictionMs: 78,
  response: 11.5,
  maxVelocity: 46,
  maxAcceleration: 240,
  zoomDeadZone: 0.07,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function moveToward(value: number, target: number, maxDelta: number) {
  if (Math.abs(target - value) <= maxDelta) return target;
  return value + Math.sign(target - value) * maxDelta;
}

/**
 * Converts detector observations into a deliberate virtual-camera path.
 * Subject motion and camera motion are separate: small face movement remains
 * inside a composition dead zone while larger movement is predicted and
 * followed by an acceleration-limited, critically damped camera.
 */
export class SmartCameraSolver {
  private options: SmartCameraOptions;
  private point: SmartCameraPoint | null = null;
  private lastObservation: SmartCameraObservation | null = null;
  private lastUpdateMs = 0;
  private shotId: string | number | undefined;

  constructor(options?: Partial<SmartCameraOptions>) {
    this.options = { ...DEFAULTS, ...options };
  }

  reset(observation?: SmartCameraObservation) {
    this.lastObservation = observation || null;
    this.lastUpdateMs = observation?.timestampMs || 0;
    this.shotId = observation?.shotId;
    this.point = observation ? {
      x: observation.x,
      y: observation.y,
      zoom: observation.zoom,
      confidence: observation.confidence,
      velocityX: 0,
      velocityY: 0,
    } : null;
    return this.point;
  }

  update(observation: SmartCameraObservation): SmartCameraPoint {
    if (!this.point || (observation.shotId != null && this.shotId != null && observation.shotId !== this.shotId)) {
      return this.reset(observation)!;
    }

    const elapsedMs = clamp(observation.timestampMs - (this.lastObservation?.timestampMs ?? observation.timestampMs - 16), 8, 250);
    const dt = elapsedMs / 1000;
    const detectorVx = this.lastObservation ? (observation.x - this.lastObservation.x) / dt : 0;
    const detectorVy = this.lastObservation ? (observation.y - this.lastObservation.y) / dt : 0;
    const confidence = clamp(observation.confidence, 0, 1);
    const prediction = (this.options.predictionMs / 1000) * confidence;
    const predictedX = clamp(observation.x + detectorVx * prediction, 0, 100);
    const predictedY = clamp(observation.y + detectorVy * prediction, 0, 100);

    const deltaX = predictedX - this.point.x;
    const deltaY = predictedY - this.point.y;
    const targetX = Math.abs(deltaX) <= this.options.deadZoneX
      ? this.point.x
      : predictedX - Math.sign(deltaX) * this.options.deadZoneX;
    const targetY = Math.abs(deltaY) <= this.options.deadZoneY
      ? this.point.y
      : predictedY - Math.sign(deltaY) * this.options.deadZoneY;

    const elapsedCameraMs = clamp(observation.timestampMs - (this.lastUpdateMs || (this.lastUpdateMs === 0 && this.lastObservation ? 0 : observation.timestampMs - 16)), 8, 250);
    const cameraDt = elapsedCameraMs / 1000;
    const desiredVx = clamp((targetX - this.point.x) * this.options.response, -this.options.maxVelocity, this.options.maxVelocity);
    const desiredVy = clamp((targetY - this.point.y) * this.options.response, -this.options.maxVelocity, this.options.maxVelocity);
    const maxVelocityDelta = this.options.maxAcceleration * cameraDt;
    const velocityX = moveToward(this.point.velocityX, desiredVx, maxVelocityDelta);
    const velocityY = moveToward(this.point.velocityY, desiredVy, maxVelocityDelta);

    const zoomDelta = observation.zoom - this.point.zoom;
    const zoomTarget = Math.abs(zoomDelta) < this.options.zoomDeadZone ? this.point.zoom : observation.zoom;
    const zoomAlpha = 1 - Math.exp(-4.8 * cameraDt);

    this.point = {
      x: clamp(this.point.x + velocityX * cameraDt, 0, 100),
      y: clamp(this.point.y + velocityY * cameraDt, 0, 100),
      zoom: this.point.zoom + (zoomTarget - this.point.zoom) * zoomAlpha,
      confidence,
      velocityX,
      velocityY,
    };
    this.lastObservation = observation;
    this.lastUpdateMs = observation.timestampMs;
    this.shotId = observation.shotId;
    return this.point;
  }
}

export function lowMemoryVideoMode() {
  const memory = typeof navigator !== "undefined" && "deviceMemory" in navigator
    ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory || 0)
    : 0;
  return memory > 0 && memory <= 8;
}
