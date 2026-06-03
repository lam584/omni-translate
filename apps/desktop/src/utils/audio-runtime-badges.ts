import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import type { StatusTone } from '../components/page/StatusBadge';

export type AudioRouteBadgeDescriptor = {
  label: string;
  tone: StatusTone;
  pulse: boolean;
};

export type AudioRuntimeBadgeSnapshot = {
  capture: AudioRouteBadgeDescriptor;
  output: AudioRouteBadgeDescriptor;
  inboundModels: AudioRouteBadgeDescriptor;
  outboundModels: AudioRouteBadgeDescriptor;
};

const idleTone: StatusTone = 'pending';
const liveTone: StatusTone = 'ready';
const errorTone: StatusTone = 'risk';
const warningTone: StatusTone = 'warning';
const previewTone: StatusTone = 'draft';
const unsupportedTone: StatusTone = 'unsupported';

function captureDescriptor(snapshot: AudioRuntimeSnapshot, labels: { ready: string; capturing: string; error: string; armed: string; idle: string; preview: string }): AudioRouteBadgeDescriptor {
  const route = snapshot.inbound;
  if (route.lastError) {
    return { label: labels.error, tone: errorTone, pulse: false };
  }
  if (route.captureState === 'capturing' && route.streamBound) {
    return { label: labels.capturing, tone: liveTone, pulse: true };
  }
  if (route.captureState === 'armed') {
    return { label: labels.armed, tone: warningTone, pulse: false };
  }
  if (snapshot.status === 'preview') {
    return { label: labels.preview, tone: previewTone, pulse: false };
  }
  if (route.captureState === 'idle') {
    return { label: labels.idle, tone: idleTone, pulse: false };
  }
  return { label: labels.ready, tone: liveTone, pulse: false };
}

function outputDescriptor(snapshot: AudioRuntimeSnapshot, labels: { ready: string; error: string; degraded: string; preview: string; missing: string }, hasPhysicalDevice: boolean): AudioRouteBadgeDescriptor {
  const route = snapshot.outbound;
  if (route.lastError) {
    return { label: labels.error, tone: errorTone, pulse: false };
  }
  if (!hasPhysicalDevice) {
    return { label: labels.missing, tone: warningTone, pulse: false };
  }
  if (snapshot.status === 'degraded') {
    return { label: labels.degraded, tone: warningTone, pulse: false };
  }
  if (snapshot.status === 'preview') {
    return { label: labels.preview, tone: previewTone, pulse: false };
  }
  if (route.streamBound) {
    return { label: labels.ready, tone: liveTone, pulse: true };
  }
  return { label: labels.ready, tone: liveTone, pulse: false };
}

function modelsDescriptor(snapshot: AudioRuntimeSnapshot, labels: { ready: string; degraded: string; preview: string; missing: string }, hasModel: boolean): AudioRouteBadgeDescriptor {
  if (snapshot.status === 'preview') {
    return { label: labels.preview, tone: previewTone, pulse: false };
  }
  if (snapshot.status === 'degraded' || !hasModel) {
    return { label: hasModel ? labels.degraded : labels.missing, tone: warningTone, pulse: false };
  }
  if (!snapshot.sttConnected) {
    return { label: labels.missing, tone: warningTone, pulse: false };
  }
  return { label: labels.ready, tone: liveTone, pulse: false };
}

export function buildAudioRuntimeBadges(
  snapshot: AudioRuntimeSnapshot,
  hasInboundModel: boolean,
  hasOutboundModel: boolean,
  labels: {
    capture: { ready: string; capturing: string; error: string; armed: string; idle: string; preview: string };
    output: { ready: string; error: string; degraded: string; preview: string; missing: string };
    inboundModels: { ready: string; degraded: string; preview: string; missing: string };
    outboundModels: { ready: string; degraded: string; preview: string; missing: string };
  },
): AudioRuntimeBadgeSnapshot {
  const hasPhysicalOutput = snapshot.renderDevices.some((device) => ![
    device.deviceId,
    device.label,
    device.interfaceName,
  ].some((value) => value.includes('Omni Translate Virtual Speaker')));

  return {
    capture: captureDescriptor(snapshot, labels.capture),
    output: outputDescriptor(snapshot, labels.output, hasPhysicalOutput),
    inboundModels: modelsDescriptor(snapshot, labels.inboundModels, hasInboundModel),
    outboundModels: modelsDescriptor(snapshot, labels.outboundModels, hasOutboundModel),
  };
}

export const UNSUPPORTED_BADGE_TONE = unsupportedTone;
