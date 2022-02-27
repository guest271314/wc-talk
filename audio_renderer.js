const DATA_BUFFER_DECODE_TARGET_DURATION = 0.3;
const DATA_BUFFER_DURATION = 0.6;
const DECODER_QUEUE_SIZE_MAX = 5;
const ENABLE_DEBUG_LOGGING = false;

import { MP4PullDemuxer } from "./mp4_pull_demuxer.js";
import { RingBuffer } from "./ringbuf.js";

function debugLog(msg) {
  if (!ENABLE_DEBUG_LOGGING) {
    return;
  }

  console.debug(msg);
}

function URLFromFiles(files) {
  const promises = files.map(file =>
    fetch(file).then(response => response.text())
  );

  return Promise.all(promises).then(texts => {
    const text = texts.join("");
    const blob = new Blob([text], { type: "application/javascript" });

    return URL.createObjectURL(blob);
  });
}

export class AudioRenderer {
  async initialize(fileUri) {
    this.fillInProgress = false;
    this.playing = false;

    this.demuxer = new MP4PullDemuxer(fileUri);

    let trackInfo = await this.demuxer.getAudioTrackInfo();
    this.demuxer.selectAudio();

    this.decoder = new AudioDecoder({
      output: this.bufferAudioData.bind(this),
      error: e => console.error(e)
    });
    const config = {
      codec: trackInfo.codec,
      sampleRate: trackInfo.sampleRate,
      numberOfChannels: trackInfo.numberOfChannels,
      description: trackInfo.extradata
    };
    this.sampleRate = trackInfo.sampleRate;
    this.channelCount = trackInfo.numberOfChannels;

    debugLog(config);
    console.log(config, AudioDecoder.isConfigSupported(config));
    console.assert(AudioDecoder.isConfigSupported(config));
    this.decoder.configure(config);

    // Initialize the AudioWorkletProcessor
    this.audioContext = new AudioContext({ sampleRate: trackInfo.sampleRate, latencyHint: "playback" });
    this.audioContext.suspend();
    // Initialize the ring buffer between the decoder and the real-time audio
    // rendering thread. The AudioRenderer has buffer space for approximately
    // 500ms of decoded audio ahead.
    let sampleCountIn500ms =
      DATA_BUFFER_DURATION * this.audioContext.sampleRate * trackInfo.numberOfChannels;
    let sab = RingBuffer.getStorageForCapacity(
      sampleCountIn500ms,
      Float32Array
    );
    this.ringbuffer = new RingBuffer(sab, Float32Array);
    this.interleavingBuffers = [];
    // Get an instance of the AudioSink worklet, passing it the memory for a
    // ringbuffer, connect it to a GainNode for volume. This GainNode is in
    // turn connected to the destination.
    var workletSource = await URLFromFiles(["ringbuf.js", "audiosink.js"]);
    await this.audioContext.audioWorklet.addModule(workletSource);
    this.audioSink = new AudioWorkletNode(this.audioContext, "AudioSink", {
      processorOptions: { sab: sab, mediaChannelCount: this.channelCount },
      outputChannelCount: [trackInfo.numberOfChannels]
    });
    this.volume = new GainNode(this.audioContext);
    this.audioSink.connect(this.volume).connect(this.audioContext.destination);

    this.init_resolver = null;
    let promise = new Promise(resolver => (this.init_resolver = resolver));

    this.fillDataBuffer();
    return promise;
  }

  setVolume(volume) {
    if (volume < 0.0 && volume > 1.0) {
      return;
    }
    // Smooth exponential volume ramps on change
    this.volume.gain.setTargetAtTime(
      volume,
      this.audioContext.currentTime,
      0.3
    );
  }

  play() {
    // resolves when audio has effectively started: this can take some time if using
    // bluetooth, for example.
    debugLog("playback start");
    this.playing = true;
    this.fillDataBuffer();
    return this.audioContext.resume();
  }

  pause() {
    // resolves when audio has effectively stopped, this can take some time if using
    // bluetooth, for example.
    debugLog("playback stop");
    this.playing = false;
    return this.audioContext.suspend();
  }

  getMediaTime() {
    let totalOutputLatency = 0.0;
    if (this.audioContext.outputLatency == undefined) {
      // Put appropriate values for Chromium here, not sure what latencies are
      // used. Likely OS-dependent, certainly hardware dependant. Assume 40ms.
      totalOutputLatency += 0.04;
    } else {
      totalOutputLatency += this.audioContext.outputLatency;
    }
    // This looks supported by Chromium, always 128 / samplerate.
    totalOutputLatency += this.audioContext.baseLatency;
    // The currently rendered audio sample is the current time of the
    // AudioContext, offset by the total output latency, that is composed of
    // the internal buffering of the AudioContext (e.g., double buffering), and
    // the inherent latency of the audio playback system: OS buffering,
    // hardware buffering, etc. This starts out negative, because it takes some
    // time to buffer, and crosses zero as the first audio sample is produced
    // by the audio output device.
    let time = Math.max(
      this.audioContext.currentTime - totalOutputLatency,
      0.0
    );
    return time * 1000 * 1000; // microseconds
  }

  makeChunk(sample) {
    const type = sample.is_sync ? "key" : "delta";
    const pts_us = (sample.cts * 1000000) / sample.timescale;
    const duration_us = (sample.duration * 1000000) / sample.timescale;
    return new EncodedAudioChunk({
      type: type,
      timestamp: pts_us,
      duration: duration_us,
      data: sample.data
    });
  }

  async fillDataBuffer() {
    // This method is called from multiple places to ensure the buffer stays
    // healthy. Sometimes these calls may overlap, but at any given point only
    // one call is desired.
    if (this.fillInProgress)
      return;

    this.fillInProgress = true;
    // This should be this file's ONLY call to the *Internal() variant of this method.
    await this.fillDataBufferInternal();
    this.fillInProgress = false;
  }

  async fillDataBufferInternal() {
    debugLog(`fillDataBufferInternal()`);

    if (this.decoder.decodeQueueSize >= DECODER_QUEUE_SIZE_MAX) {
      debugLog('\tdecoder saturated');
      // Some audio decoders are known to delay output until the next input.
      // Make sure the DECODER_QUEUE_SIZE is big enough to avoid stalling on the
      // return below. We're relying on decoder output callback to trigger
      // another call to fillDataBuffer().
      console.assert(DECODER_QUEUE_SIZE_MAX >= 2);
      return;
    }

    let usedBufferElements = this.ringbuffer.capacity() - this.ringbuffer.available_write();
    let usedBufferSecs = usedBufferElements / (this.channelCount * this.sampleRate);
    let pcntOfTarget = 100 * usedBufferSecs / DATA_BUFFER_DECODE_TARGET_DURATION;
    if (usedBufferSecs >= DATA_BUFFER_DECODE_TARGET_DURATION) {
      debugLog(`\taudio buffer full usedBufferSecs: ${usedBufferSecs} pcntOfTarget: ${pcntOfTarget}`);

      // When playing, schedule timeout to periodically refill buffer. Don't
      // bother scheduling timeout if decoder already saturated. The output
      // callback will call us back to keep filling.
      if (this.playing)
        // Timeout to arrive when buffer is half empty.
        window.setTimeout(this.fillDataBuffer.bind(this), 1000 * usedBufferSecs / 2);

      // Initialize() is done when the buffer fills for the first time.
      if (this.init_resolver) {
        this.init_resolver();
        this.init_resolver = null;
      }

      // Buffer full, so no further work to do now.
      return;
    }

    // Decode up to the buffering target or until decoder is saturated.
    while (usedBufferSecs < DATA_BUFFER_DECODE_TARGET_DURATION &&
      this.decoder.decodeQueueSize < DECODER_QUEUE_SIZE_MAX) {
      debugLog(`\tmoar samples. usedBufferSecs:${usedBufferSecs} < target:${DATA_BUFFER_DECODE_TARGET_DURATION}.`);
      let sample = await this.demuxer.readSample();
      this.decoder.decode(this.makeChunk(sample));

      // NOTE: awaiting the demuxer.readSample() above will also give the
      // decoder output callbacka a chance to run, so we may see usedBufferSecs
      // increase.
      usedBufferElements = this.ringbuffer.capacity() - this.ringbuffer.available_write();
      usedBufferSecs = usedBufferElements / (this.channelCount * this.sampleRate);
    }

    if (ENABLE_DEBUG_LOGGING) {
      let logPrefix = usedBufferSecs >= DATA_BUFFER_DECODE_TARGET_DURATION ?
          '\tbuffered enough' : '\tdecoder saturated';
      pcntOfTarget = 100 * usedBufferSecs / DATA_BUFFER_DECODE_TARGET_DURATION;
      debugLog(logPrefix + `; bufferedSecs:${usedBufferSecs} pcntOfTarget: ${pcntOfTarget}`);
    }
  }

  bufferHealth() {
    return (1 - this.ringbuffer.available_write() / this.ringbuffer.capacity()) * 100;
  }

  // From a array of Float32Array containing planar audio data `input`, writes
  // interleaved audio data to `output`. Start the copy at sample
  // `inputOffset`: index of the sample to start the copy from
  // `inputSamplesToCopy`: number of input samples to copy
  // `output`: a Float32Array to write the samples to
  // `outputSampleOffset`: an offset in `output` to start writing
  interleave(inputs, inputOffset, inputSamplesToCopy, output, outputSampleOffset) {
    if (inputs.length * inputs[0].length < output.length) {
      throw `not enough space in destination (${inputs.length * inputs[0].length} < ${output.length}})`
    }
    let channelCount = inputs.length;
    let outIdx = outputSampleOffset;
    let inputIdx = Math.floor(inputOffset / channelCount);
    var channel = inputOffset % channelCount;
    for (var i = 0; i < inputSamplesToCopy; i++) {
      output[outIdx++] = inputs[channel][inputIdx];
      if (++channel == inputs.length) {
        channel = 0;
        inputIdx++;
      }
    }
  }

  bufferAudioData(data) {
    if (this.interleavingBuffers.length != data.numberOfChannels) {
      this.interleavingBuffers = new Array(this.channelCount);
      for (var i = 0; i < this.interleavingBuffers.length; i++) {
        this.interleavingBuffers[i] = new Float32Array(data.numberOfFrames);
      }
    }

    debugLog(`bufferAudioData() ts:${data.timestamp} durationSec:${data.duration / 1000000}`);
    // Write to temporary planar arrays, and interleave into the ring buffer.
    for (var i = 0; i < this.channelCount; i++) {
      data.copyTo(this.interleavingBuffers[i], { planeIndex: i });
    }
    // Write the data to the ring buffer. Because it wraps around, there is
    // potentially two copyTo to do.
    let wrote = this.ringbuffer.writeCallback(
      data.numberOfFrames * data.numberOfChannels,
      (first_part, second_part) => {
        this.interleave(this.interleavingBuffers, 0, first_part.length, first_part, 0);
        this.interleave(this.interleavingBuffers, first_part.length, second_part.length, second_part, 0);
      }
    );

    // FIXME - this could theoretically happen since we're pretty agressive
    // about saturating the decoder without knowing the size of the
    // AudioData.duration vs ring buffer capacity.
    console.assert(wrote == data.numberOfChannels * data.numberOfFrames, 'Buffer full, dropping data!')

    // Logging maxBufferHealth below shows we currently max around 73%, so we're
    // safe from the assert above *for now*. We should add an overflow buffer
    // just to be safe.
    // let bufferHealth = this.bufferHealth();
    // if (!('maxBufferHealth' in this))
    //   this.maxBufferHealth = 0;
    // if (bufferHealth > this.maxBufferHealth) {
    //   this.maxBufferHealth = bufferHealth;
    //   console.log(`new maxBufferHealth:${this.maxBufferHealth}`);
    // }

    // fillDataBuffer() gives up if too much decode work is queued. Keep trying
    // now that we've finished some.
    this.fillDataBuffer();
  }
}
