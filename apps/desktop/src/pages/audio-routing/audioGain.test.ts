import { describe, expect, it } from 'vitest';

import defaultConfig from '../../../src-tauri/defaults/app-config.default.json';
import { appConfigDraftMock } from '../../mocks/app-config';
import {
  gainDbToVolumePercent,
  MAX_TRANSLATED_VOLUME_PERCENT,
  MIN_AUDIO_GAIN_DB,
  volumePercentToGainDb,
} from './audioGain';

describe('audio route gain conversion', () => {
  it('shows dB gains as bounded linear volume percentages', () => {
    expect(gainDbToVolumePercent(-4)).toBe(63);
    expect(gainDbToVolumePercent(-1)).toBe(89);
    expect(gainDbToVolumePercent(0)).toBe(100);
    expect(gainDbToVolumePercent(6)).toBe(100);
    expect(gainDbToVolumePercent(6.0206, MAX_TRANSLATED_VOLUME_PERCENT)).toBe(200);
    expect(gainDbToVolumePercent(Number.NaN)).toBe(0);
  });

  it('persists percentages as finite dB values', () => {
    expect(volumePercentToGainDb(50)).toBeCloseTo(-6.0206, 4);
    expect(volumePercentToGainDb(75)).toBeCloseTo(-2.4988, 4);
    expect(volumePercentToGainDb(100)).toBe(0);
    expect(volumePercentToGainDb(200, MAX_TRANSLATED_VOLUME_PERCENT)).toBeCloseTo(6.0206, 4);
    expect(volumePercentToGainDb(0)).toBe(MIN_AUDIO_GAIN_DB);
    expect(Number.isFinite(volumePercentToGainDb(0))).toBe(true);
  });

  it('round-trips every non-muted integer slider value', () => {
    for (const volumePercent of [1, 25, 50, 63, 75, 89, 100]) {
      expect(gainDbToVolumePercent(volumePercentToGainDb(volumePercent))).toBe(volumePercent);
    }
  });
});

describe('inbound audio mix defaults', () => {
  it('keeps production and frontend defaults aligned', () => {
    expect(defaultConfig.devices.feedbackLoopPrevention).toBe('echo-cancel');
    expect(appConfigDraftMock.devices.feedbackLoopPrevention).toBe('echo-cancel');

    for (const mixControl of [
      defaultConfig.devices.inboundRoute.mixControl,
      appConfigDraftMock.devices.inboundRoute.mixControl,
    ]) {
      expect(mixControl.translatedAudioEnabled).toBe(true);
      expect(mixControl.originalAudioGainDb).toBe(-4);
      expect(mixControl.translatedAudioGainDb).toBe(0);
      expect(mixControl.translatedAudioAutoGainEnabled).toBe(true);
    }
  });
});
