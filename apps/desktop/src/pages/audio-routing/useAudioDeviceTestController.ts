import { useCallback, useEffect, useRef, useState } from 'react';
import i18n from '../../i18n/config';

type DeviceTestKind = 'microphone' | 'speaker';

type DeviceTestState = {
  testing: boolean;
  result: string | null;
  energyDb: number;
};

const IDLE_ENERGY = -90;
const TEST_DURATION_MS = 900;

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error || 'Audio device test failed');
}

function energyDbFromAnalyser(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(samples);
  const meanSquare = samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length;
  return meanSquare > 0 ? Math.max(-90, 20 * Math.log10(Math.sqrt(meanSquare))) : IDLE_ENERGY;
}

export function useAudioDeviceTestController(resolvePassedLabel: (kind: DeviceTestKind) => string) {
  const [microphone, setMicrophone] = useState<DeviceTestState>({ testing: false, result: null, energyDb: IDLE_ENERGY });
  const [speaker, setSpeaker] = useState<DeviceTestState>({ testing: false, result: null, energyDb: IDLE_ENERGY });
  const runId = useRef(0);

  useEffect(() => () => {
    runId.current += 1;
  }, []);

  const testMicrophone = useCallback(async () => {
    const currentRun = ++runId.current;
    setMicrophone({ testing: true, result: null, energyDb: IDLE_ENERGY });
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(i18n.t('audioRouting.micTestUnsupported'));
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const deadline = performance.now() + TEST_DURATION_MS;
      let peakDb = IDLE_ENERGY;
      while (performance.now() < deadline && currentRun === runId.current) {
        peakDb = Math.max(peakDb, energyDbFromAnalyser(analyser, samples));
        setMicrophone({ testing: true, result: null, energyDb: peakDb });
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      if (currentRun === runId.current) {
        setMicrophone({ testing: false, result: resolvePassedLabel('microphone'), energyDb: peakDb });
      }
    } catch (error) {
      if (currentRun === runId.current) {
        setMicrophone({ testing: false, result: errorMessage(error), energyDb: IDLE_ENERGY });
      }
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      await context?.close().catch(() => undefined);
    }
  }, [resolvePassedLabel]);

  const testSpeaker = useCallback(async () => {
    const currentRun = ++runId.current;
    setSpeaker({ testing: true, result: null, energyDb: -18 });
    let context: AudioContext | undefined;
    try {
      context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 660;
      gain.gain.value = 0.08;
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + TEST_DURATION_MS / 1000);
      await new Promise((resolve) => oscillator.addEventListener('ended', resolve, { once: true }));
      if (currentRun === runId.current) {
        setSpeaker({ testing: false, result: resolvePassedLabel('speaker'), energyDb: IDLE_ENERGY });
      }
    } catch (error) {
      if (currentRun === runId.current) {
        setSpeaker({ testing: false, result: errorMessage(error), energyDb: IDLE_ENERGY });
      }
    } finally {
      await context?.close().catch(() => undefined);
    }
  }, [resolvePassedLabel]);

  return { microphone, speaker, testMicrophone, testSpeaker };
}
