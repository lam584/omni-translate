const RIFF_HEADER_BYTES = 12;
const PCM_WAV_HEADER_BYTES = 44;

function parsePcm16MonoWav(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('WAV input must be a Buffer.');
  if (
    buffer.length < PCM_WAV_HEADER_BYTES
    || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) throw new Error('WAV input must be a RIFF/WAVE file.');

  const declaredBytes = buffer.readUInt32LE(4) + 8;
  if (declaredBytes !== buffer.length) throw new Error('WAV RIFF length does not match the payload.');

  let format = null;
  let data = null;
  let offset = RIFF_HEADER_BYTES;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkBytes = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkBytes;
    if (chunkEnd > buffer.length) throw new Error(`WAV ${chunkId} chunk exceeds the payload.`);
    if (chunkId === 'fmt ') format = { start: chunkStart, bytes: chunkBytes };
    if (chunkId === 'data') data = { start: chunkStart, bytes: chunkBytes };
    offset = chunkEnd + (chunkBytes % 2);
  }
  if (!format || format.bytes !== 16 || !data || data.bytes === 0) {
    throw new Error('WAV input must contain one non-empty 16-byte PCM format and data chunk.');
  }

  const audioFormat = buffer.readUInt16LE(format.start);
  const channels = buffer.readUInt16LE(format.start + 2);
  const sampleRate = buffer.readUInt32LE(format.start + 4);
  const byteRate = buffer.readUInt32LE(format.start + 8);
  const blockAlign = buffer.readUInt16LE(format.start + 12);
  const bitsPerSample = buffer.readUInt16LE(format.start + 14);
  if (
    audioFormat !== 1
    || channels !== 1
    || bitsPerSample !== 16
    || blockAlign !== 2
    || byteRate !== sampleRate * blockAlign
    || data.bytes % blockAlign !== 0
  ) throw new Error('WAV input must be 16-bit mono integer PCM with a consistent byte rate.');

  return {
    sampleRate,
    channels,
    bitsPerSample,
    frames: data.bytes / blockAlign,
    dataStart: data.start,
    dataBytes: data.bytes,
  };
}

function sinc(value) {
  if (Math.abs(value) < Number.EPSILON) return 1;
  const radians = Math.PI * value;
  return Math.sin(radians) / radians;
}

function blackmanWindow(distance, radius) {
  if (Math.abs(distance) >= radius) return 0;
  return 0.42
    + 0.5 * Math.cos((Math.PI * distance) / radius)
    + 0.08 * Math.cos((2 * Math.PI * distance) / radius);
}

function createPcm16MonoWav(samples, sampleRate) {
  const output = Buffer.allocUnsafe(PCM_WAV_HEADER_BYTES + samples.length * 2);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVE', 8, 'ascii');
  output.write('fmt ', 12, 'ascii');
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36, 'ascii');
  output.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index += 1) {
    output.writeInt16LE(samples[index], PCM_WAV_HEADER_BYTES + index * 2);
  }
  return output;
}

export function normalizeStreamingWavHeader(buffer) {
  if (
    !Buffer.isBuffer(buffer)
    || buffer.length < PCM_WAV_HEADER_BYTES
    || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) return buffer;
  buffer.writeUInt32LE(buffer.length - 8, 4);
  let offset = RIFF_HEADER_BYTES;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const declaredBytes = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === 'data') {
      const actualBytes = buffer.length - chunkStart;
      if (declaredBytes > actualBytes) buffer.writeUInt32LE(actualBytes, offset + 4);
      return buffer;
    }
    if (chunkStart + declaredBytes > buffer.length) return buffer;
    offset = chunkStart + declaredBytes + (declaredBytes % 2);
  }
  return buffer;
}

export function inspectPcm16MonoWav(buffer) {
  const wav = parsePcm16MonoWav(buffer);
  return {
    durationSeconds: Number((wav.frames / wav.sampleRate).toFixed(3)),
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    bitsPerSample: wav.bitsPerSample,
  };
}

/**
 * Deterministically resample a provider-generated PCM WAV before it is kept as
 * a fixture. A windowed-sinc low-pass prevents the 24 kHz source from aliasing
 * when reduced to the repository's 16 kHz speech-test format.
 */
export function resamplePcm16MonoWav(buffer, targetSampleRate = 16_000) {
  const source = parsePcm16MonoWav(buffer);
  if (!Number.isInteger(targetSampleRate) || targetSampleRate <= 0 || targetSampleRate > source.sampleRate) {
    throw new Error('Target sample rate must be a positive integer no greater than the source rate.');
  }
  if (targetSampleRate === source.sampleRate) return Buffer.from(buffer);

  const targetFrames = Math.floor((source.frames * targetSampleRate) / source.sampleRate);
  const samples = new Int16Array(targetFrames);
  const ratio = source.sampleRate / targetSampleRate;
  const cutoff = (targetSampleRate / source.sampleRate) * 0.94;
  const radius = 24;
  for (let targetIndex = 0; targetIndex < targetFrames; targetIndex += 1) {
    const sourcePosition = targetIndex * ratio;
    const firstSourceIndex = Math.ceil(sourcePosition - radius);
    const lastSourceIndex = Math.floor(sourcePosition + radius);
    let weighted = 0;
    let weightSum = 0;
    for (let sourceIndex = firstSourceIndex; sourceIndex <= lastSourceIndex; sourceIndex += 1) {
      if (sourceIndex < 0 || sourceIndex >= source.frames) continue;
      const distance = sourceIndex - sourcePosition;
      const weight = cutoff * sinc(cutoff * distance) * blackmanWindow(distance, radius);
      weighted += buffer.readInt16LE(source.dataStart + sourceIndex * 2) * weight;
      weightSum += weight;
    }
    const value = weightSum === 0 ? 0 : Math.round(weighted / weightSum);
    samples[targetIndex] = Math.max(-32_768, Math.min(32_767, value));
  }
  return createPcm16MonoWav(samples, targetSampleRate);
}
