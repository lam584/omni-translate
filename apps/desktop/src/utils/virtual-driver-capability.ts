import type { BridgeRuntimeSnapshot } from '../schema/runtime-core';

export const VIRTUAL_DRIVER_MINIMUM_WINDOWS_BUILD = 19041;
export const VIRTUAL_MIC_PCM_FORMAT = '48000Hz/mono/pcm16';

export type VirtualDriverCapability = {
  minimumWindowsBuild: number;
  windowsBuildNumber: number | null;
  windowsBuildKnown: boolean;
  windowsBuildSupported: boolean;
  virtualMicOutputReady: boolean;
};

export function isVirtualDriverWindowsBuildSupported(windowsBuildNumber: number | null | undefined) {
  return windowsBuildNumber == null || windowsBuildNumber >= VIRTUAL_DRIVER_MINIMUM_WINDOWS_BUILD;
}

export function resolveVirtualDriverCapability(bridge: BridgeRuntimeSnapshot): VirtualDriverCapability {
  const windowsBuildNumber = bridge.windowsBuildNumber;
  const windowsBuildSupported = isVirtualDriverWindowsBuildSupported(windowsBuildNumber);
  const virtualMicOutputReady = windowsBuildSupported
    && bridge.virtualMicOutputSupported
    && bridge.virtualMicOutputStatus === 'ready'
    && Boolean(bridge.captureEndpointName?.trim())
    && bridge.virtualMicFormat === VIRTUAL_MIC_PCM_FORMAT;

  return {
    minimumWindowsBuild: VIRTUAL_DRIVER_MINIMUM_WINDOWS_BUILD,
    windowsBuildNumber,
    windowsBuildKnown: windowsBuildNumber != null,
    windowsBuildSupported,
    virtualMicOutputReady,
  };
}
