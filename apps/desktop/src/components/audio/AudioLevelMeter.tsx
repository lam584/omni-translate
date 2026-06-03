import { useEffect, useRef, useState } from 'react';

type AudioLevelMeterProps = {
  energyDb: number;
  vadState: string;
  label: string;
  captureActive?: boolean;
};

const DB_MIN = -90;
const DB_MAX = 0;
const ATTACK_COEFF = 0.85;
const RELEASE_COEFF = 0.15;
const PEAK_HOLD_MS = 2000;
const BAR_COUNT = 32;

function dbToLevel(db: number): number {
  const clamped = Math.min(DB_MAX, Math.max(DB_MIN, db));
  return (clamped - DB_MIN) / (DB_MAX - DB_MIN);
}

function levelToColor(level: number): string {
  if (level <= 0.2) {
    return 'var(--audio-meter-low, #22c55e)';
  }
  if (level <= 0.533) {
    return 'var(--audio-meter-mid, #eab308)';
  }
  return 'var(--audio-meter-high, #ef4444)';
}

function AudioLevelMeter({ energyDb, label, vadState, captureActive = false }: AudioLevelMeterProps) {
  const [smoothedDb, setSmoothedDb] = useState(DB_MIN);
  const [peakDb, setPeakDb] = useState(DB_MIN);
  const peakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const smoothedRef = useRef(DB_MIN);
  const peakRef = useRef(DB_MIN);

  useEffect(() => {
    const rising = energyDb > smoothedRef.current;
    const coeff = rising ? ATTACK_COEFF : RELEASE_COEFF;
    const nextSmoothed = coeff * energyDb + (1 - coeff) * smoothedRef.current;
    smoothedRef.current = nextSmoothed;
    setSmoothedDb(nextSmoothed);

    if (nextSmoothed > peakRef.current) {
      peakRef.current = nextSmoothed;
      setPeakDb(nextSmoothed);
      if (peakTimerRef.current) {
        clearTimeout(peakTimerRef.current);
      }
      peakTimerRef.current = setTimeout(() => {
        peakRef.current = DB_MIN;
        setPeakDb(DB_MIN);
      }, PEAK_HOLD_MS);
    }

  }, [energyDb]);

  useEffect(() => {
    return () => {
      if (peakTimerRef.current) {
        clearTimeout(peakTimerRef.current);
      }
    };
  }, []);

  const level = dbToLevel(smoothedDb);
  const peakLevel = dbToLevel(peakDb);
  const thresholdLevel = dbToLevel(-42);
  const isSpeech = vadState === 'speech';

  const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
    const barThreshold = (i + 1) / BAR_COUNT;
    const active = barThreshold <= level;
    const isPeak = !active && barThreshold <= peakLevel && (i === 0 || (i) / BAR_COUNT >= peakLevel - 1 / BAR_COUNT);
    return { active, isPeak, color: levelToColor(barThreshold) };
  });

  return (
    <div className={['audio-level-meter', captureActive ? 'audio-level-meter-active' : ''].filter(Boolean).join(' ')}>
      <div className="audio-level-meter-header">
        <span className="audio-level-meter-label">{label}</span>
        <span className={`audio-level-meter-vad ${isSpeech ? 'audio-level-meter-vad-speech' : 'audio-level-meter-vad-silence'}`}>
          {isSpeech ? '语音' : '静音'}
        </span>
        <span className="audio-level-meter-db">{smoothedDb.toFixed(1)} dB</span>
      </div>
      <div className="audio-level-meter-track">
        {bars.map((bar, i) => (
          <div
            key={i}
            className={`audio-level-meter-bar ${bar.active ? 'audio-level-meter-bar-active' : ''} ${bar.isPeak ? 'audio-level-meter-bar-peak' : ''}`}
            style={{
              backgroundColor: bar.active ? bar.color : undefined,
            }}
          />
        ))}
        <div
          className="audio-level-meter-threshold"
          style={{ left: `${thresholdLevel * 100}%` }}
          title="VAD 阈值 -42 dB"
        />
      </div>
    </div>
  );
}

export default AudioLevelMeter;
