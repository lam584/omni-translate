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
const MICROPHONE_SIGNAL_THRESHOLD_DB = -42;
const SPEAKER_TEST_TIMEOUT_MS = TEST_DURATION_MS + 1500;

function errorMessage(error: unknown) {
  if (error instanceof DOMException) {
    const chinese = i18n.language.toLowerCase().startsWith('zh');
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return chinese ? '麦克风权限被拒绝，请在 Windows 隐私设置中允许本应用访问麦克风后重试。' : 'Microphone permission was denied. Allow microphone access in Windows privacy settings and retry.';
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return chinese ? '所选麦克风已断开或不可用，请重新选择设备。' : 'The selected microphone is disconnected or unavailable. Choose another device.';
    }
    if (error.name === 'NotReadableError' || error.name === 'AbortError') {
      return chinese ? '麦克风可能正被其他程序独占，请关闭占用程序后重试。' : 'The microphone may be in exclusive use by another app. Close that app and retry.';
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error || 'Audio device test failed');
}

function energyDbFromAnalyser(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(samples);
  const meanSquare = samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length;
  return meanSquare > 0 ? Math.max(-90, 20 * Math.log10(Math.sqrt(meanSquare))) : IDLE_ENERGY;
}

function microphoneNoSignalMessage(peakDb: number) {
  const peak = `${peakDb.toFixed(1)} dB`;
  return i18n.language.toLowerCase().startsWith('zh')
    ? `未采集到声音（峰值 ${peak}）。请检查所选麦克风是否被 Windows 静音、被其他程序独占，或换一个设备后重试。`
    : `No microphone signal was detected (peak ${peak}). Check whether the selected microphone is muted or in exclusive use, or choose another device and retry.`;
}

function speakerTimeoutMessage() {
  return i18n.language.toLowerCase().startsWith('zh')
    ? '扬声器测试未能完成（音频输出未启动）。请确认系统有可用的播放设备后重试。'
    : 'The speaker test did not complete because audio output did not start. Confirm that an output device is available and retry.';
}

function waitForOscillatorEnd(oscillator: OscillatorNode) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(speakerTimeoutMessage())), SPEAKER_TEST_TIMEOUT_MS);
    oscillator.addEventListener('ended', () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export function useAudioDeviceTestController(
  resolvePassedLabel: (kind: DeviceTestKind) => string,
  selectedInputDeviceId?: string,
) {
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
      stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedInputDeviceId ? { deviceId: { exact: selectedInputDeviceId } } : true,
      });
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
        const result = peakDb >= MICROPHONE_SIGNAL_THRESHOLD_DB
          ? `${resolvePassedLabel('microphone')} (${peakDb.toFixed(1)} dB)`
          : microphoneNoSignalMessage(peakDb);
        setMicrophone({ testing: false, result, energyDb: peakDb });
      }
    } catch (error) {
      if (currentRun === runId.current) {
        setMicrophone({ testing: false, result: errorMessage(error), energyDb: IDLE_ENERGY });
      }
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      await context?.close().catch(() => undefined);
    }
  }, [resolvePassedLabel, selectedInputDeviceId]);

  const testSpeaker = useCallback(async () => {
    const currentRun = ++runId.current;
    setSpeaker({ testing: true, result: null, energyDb: -18 });
    let context: AudioContext | undefined;
    try {
      context = new AudioContext();
      if (context.state === 'suspended') {
        await context.resume();
      }
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 660;
      gain.gain.value = 0.08;
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + TEST_DURATION_MS / 1000);
      await waitForOscillatorEnd(oscillator);
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
