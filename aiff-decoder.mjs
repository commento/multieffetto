const readFourCC = (view, offset) => String.fromCharCode(
  view.getUint8(offset),
  view.getUint8(offset + 1),
  view.getUint8(offset + 2),
  view.getUint8(offset + 3)
);

function readExtended80(view, offset) {
  const exponentAndSign = view.getUint16(offset, false);
  const exponent = exponentAndSign & 0x7fff;
  const sign = exponentAndSign & 0x8000 ? -1 : 1;
  const high = view.getUint32(offset + 2, false);
  const low = view.getUint32(offset + 6, false);
  if (exponent === 0 && high === 0 && low === 0) return 0;
  if (exponent === 0x7fff) return Infinity;
  const mantissa = high * 0x100000000 + low;
  return sign * mantissa * Math.pow(2, exponent - 16383 - 63);
}

function readIntegerSample(view, offset, bits, littleEndian) {
  if (bits === 8) return view.getInt8(offset) / 128;
  if (bits === 16) return view.getInt16(offset, littleEndian) / 32768;
  if (bits === 24) {
    let value;
    if (littleEndian) {
      value = view.getUint8(offset) |
        (view.getUint8(offset + 1) << 8) |
        (view.getUint8(offset + 2) << 16);
    } else {
      value = (view.getUint8(offset) << 16) |
        (view.getUint8(offset + 1) << 8) |
        view.getUint8(offset + 2);
    }
    if (value & 0x800000) value -= 0x1000000;
    return value / 8388608;
  }
  if (bits === 32) return view.getInt32(offset, littleEndian) / 2147483648;
  throw new Error(`Profondita AIFF non supportata: ${bits} bit`);
}

export function decodeAiff(arrayBuffer, audioContext) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 12 || readFourCC(view, 0) !== 'FORM') {
    throw new Error('Il file non e un AIFF valido');
  }

  const formType = readFourCC(view, 8);
  if (formType !== 'AIFF' && formType !== 'AIFC') {
    throw new Error('Il file non e un AIFF valido');
  }

  let format = null;
  let sound = null;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const chunkId = readFourCC(view, offset);
    const chunkSize = view.getUint32(offset + 4, false);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkSize;
    if (dataEnd > view.byteLength) throw new Error('Chunk AIFF incompleto');

    if (chunkId === 'COMM') {
      if (chunkSize < 18) throw new Error('Chunk COMM AIFF non valido');
      format = {
        channels: view.getUint16(dataOffset, false),
        frames: view.getUint32(dataOffset + 2, false),
        bits: view.getUint16(dataOffset + 6, false),
        sampleRate: readExtended80(view, dataOffset + 8),
        compression: formType === 'AIFC' && chunkSize >= 22
          ? readFourCC(view, dataOffset + 18)
          : 'NONE'
      };
    } else if (chunkId === 'SSND') {
      if (chunkSize < 8) throw new Error('Chunk SSND AIFF non valido');
      sound = {
        offset: dataOffset + 8 + view.getUint32(dataOffset, false),
        end: dataEnd
      };
    }

    offset = dataEnd + (chunkSize & 1);
  }

  if (!format || !sound) throw new Error('Dati audio AIFF mancanti');
  if (!format.channels || format.channels > 32) throw new Error('Numero di canali AIFF non valido');
  if (!Number.isFinite(format.sampleRate) || format.sampleRate < 1000 || format.sampleRate > 768000) {
    throw new Error('Frequenza di campionamento AIFF non valida');
  }

  const integerCodecs = new Set(['NONE', 'twos', 'sowt', 'in24', 'in32']);
  const floatCodecs = new Set(['fl32', 'FL32', 'fl64', 'FL64']);
  if (!integerCodecs.has(format.compression) && !floatCodecs.has(format.compression)) {
    throw new Error(`Compressione AIFC non supportata: ${format.compression}`);
  }

  const isFloat = floatCodecs.has(format.compression);
  const bits = isFloat ? (format.compression.toLowerCase() === 'fl64' ? 64 : 32) : format.bits;
  if (!isFloat && ![8, 16, 24, 32].includes(bits)) {
    throw new Error(`Profondita AIFF non supportata: ${bits} bit`);
  }
  const bytesPerSample = bits / 8;
  const bytesPerFrame = bytesPerSample * format.channels;
  if (sound.offset > sound.end || bytesPerFrame <= 0) throw new Error('Dati audio AIFF non validi');
  const availableFrames = Math.floor((sound.end - sound.offset) / bytesPerFrame);
  const frameCount = Math.min(format.frames, availableFrames);
  if (!frameCount) throw new Error('Il file AIFF non contiene campioni audio');

  const littleEndian = format.compression === 'sowt';
  const audioBuffer = audioContext.createBuffer(format.channels, frameCount, format.sampleRate);
  const outputs = Array.from({ length: format.channels }, (_, channel) => audioBuffer.getChannelData(channel));
  let cursor = sound.offset;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < format.channels; channel++) {
      let sample;
      if (isFloat) {
        sample = bits === 32
          ? view.getFloat32(cursor, false)
          : view.getFloat64(cursor, false);
      } else {
        sample = readIntegerSample(view, cursor, bits, littleEndian);
      }
      outputs[channel][frame] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      cursor += bytesPerSample;
    }
  }

  return audioBuffer;
}
