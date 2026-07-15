import { useCallback, useEffect, useRef, useState } from 'react';

type DeviceTestKind = 'microphone' | 'speaker';

type DeviceTestState = {
  testing: boolean;
  result: string | null;
  energyDb: number;
};

const IDLE_ENERGY: Record<DeviceTestKind, number> = {
  microphone: -54,
  speaker: -90,
};

const ACTIVE_ENERGY: Record<DeviceTestKind, number> = {
  microphone: -32,
  speaker: -18,
};

export function useAudioDeviceTestController(resolvePassedLabel: (kind: DeviceTestKind) => string) {
  const [microphone, setMicrophone] = useState<DeviceTestState>({
    testing: false,
    result: null,
    energyDb: IDLE_ENERGY.microphone,
  });
  const [speaker, setSpeaker] = useState<DeviceTestState>({
    testing: false,
    result: null,
    energyDb: IDLE_ENERGY.speaker,
  });
  const timers = useRef<Partial<Record<DeviceTestKind, number>>>({});

  useEffect(() => () => {
    Object.values(timers.current).forEach((timer) => window.clearTimeout(timer));
  }, []);

  const start = useCallback((kind: DeviceTestKind) => {
    const update = kind === 'microphone' ? setMicrophone : setSpeaker;
    const activeTimer = timers.current[kind];
    if (activeTimer !== undefined) window.clearTimeout(activeTimer);
    update({ testing: true, result: null, energyDb: ACTIVE_ENERGY[kind] });
    timers.current[kind] = window.setTimeout(() => {
      update({ testing: false, result: resolvePassedLabel(kind), energyDb: IDLE_ENERGY[kind] });
      delete timers.current[kind];
    }, 900);
  }, [resolvePassedLabel]);

  return {
    microphone,
    speaker,
    testMicrophone: useCallback(() => start('microphone'), [start]),
    testSpeaker: useCallback(() => start('speaker'), [start]),
  };
}
