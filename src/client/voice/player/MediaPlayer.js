'use strict';

const EventEmitter = require('events');
const { Readable: ReadableStream, Transform } = require('stream');
const prism = require('prism-media');
const { H264NalSplitter } = require('./processing/AnnexBNalSplitter');
const { IvfTransformer } = require('./processing/IvfSplitter');
const { H264Dispatcher } = require('../dispatcher/AnnexBDispatcher');
const AudioDispatcher = require('../dispatcher/AudioDispatcher');
const { VP8Dispatcher } = require('../dispatcher/VPxDispatcher');

// FFMPEG configurations
const FFMPEG_OUTPUT_PREFIX = [
  '-use_wallclock_as_timestamps', '1',
  '-copyts',
  '-analyzeduration', '0',
  '-probesize', '32768',
  '-fflags', '+nobuffer+fastseek',
  '-vsync', 'cfr',
  '-max_delay', '0'
];

const FFMPEG_INPUT_PREFIX = [
  '-re',
  '-reconnect', '1',
  '-reconnect_at_eof', '1',
  '-reconnect_streamed', '1',
  '-reconnect_delay_max', '4294'
];

const FFMPEG_PCM_ARGUMENTS = ['-f', 's16le', '-ar', '48000', '-ac', '2'];

const FFMPEG_VP8_ARGUMENTS = [
  '-c:v', 'libvpx',
  '-f', 'ivf',
  '-deadline', 'realtime',
  '-cpu-used', '4',
  '-auto-alt-ref', '0',
  '-lag-in-frames', '0'
];

const FFMPEG_H264_ARGUMENTS = options => [
  '-c:v', 'libx264',
  '-preset', options?.presetH26x || 'ultrafast',
  '-tune', 'zerolatency',
  '-profile:v', 'baseline',
  '-f', 'h264'
];

class SeekTransform extends Transform {
  constructor(options = {}) {
    super(options);
    this.seekTime = 0;
    this.seeking = false;
    this.bytesSkipped = 0;
    this.frameSize = options.frameSize || 960;
    this.sampleRate = options.sampleRate || 48000;
    this.bytesPerSample = options.bytesPerSample || 4;
  }

  _transform(chunk, encoding, callback) {
    if (this.seeking) {
      const framesToSkip = Math.floor((this.seekTime * this.sampleRate) / this.frameSize);
      const bytesToSkip = framesToSkip * this.frameSize * this.bytesPerSample;

      this.bytesSkipped += chunk.length;

      if (this.bytesSkipped >= bytesToSkip) {
        const excess = this.bytesSkipped - bytesToSkip;
        if (excess > 0) {
          this.push(chunk.slice(chunk.length - excess));
        }
        this.seeking = false;
      }
    } else {
      this.push(chunk);
    }
    callback();
  }

  seek(time) {
    this.seekTime = time;
    this.seeking = true;
    this.bytesSkipped = 0;
  }
}

class FrameBuffer extends Transform {
  constructor(options = {}) {
    super(options);
    this.frameQueue = [];
    this.fps = options.fps || 30;
    this.interval = 1000 / this.fps;
    this.lastFrameTime = 0;
    this.active = true;
  }

  _transform(chunk, encoding, callback) {
    this.frameQueue.push(chunk);
    this._processQueue();
    callback();
  }

  _processQueue() {
    if (!this.active || this.frameQueue.length === 0) return;

    const now = Date.now();
    if (now - this.lastFrameTime >= this.interval) {
      const frame = this.frameQueue.shift();
      this.push(frame);
      this.lastFrameTime = now;
    }

    setTimeout(() => this._processQueue(),
      Math.max(0, this.interval - (Date.now() - this.lastFrameTime)));
  }

  start() {
    this.active = true;
    this._processQueue();
  }

  stop() {
    this.active = false;
  }
}

/**
 * Enhanced MediaPlayer with real-time seeking capabilities
 */
class MediaPlayer extends EventEmitter {

  constructor(voiceConnection, isScreenSharing) {
    super();
    this.dispatcher = null;
    this.videoDispatcher = null;
    this.voiceConnection = voiceConnection;
    this.isScreenSharing = isScreenSharing;
    this.frameBuffer = null;
    this.seekTransform = null;
    this.ffmpegProcess = null;
    this.streams = new Map();
    this.volume = 1.0;
  }
  /**
   * Real-time seek implementation
   */
  async seek(time, options = {}) {
    if (typeof time !== 'number' || time < 0) {
      throw new Error('Seek time must be a non-negative number');
    }

    try {
      this.emit('seeking', time);

      const wasPlaying = !this.paused;
      if (wasPlaying) {
        await this.pause();
      }

      if (this.isScreenSharing) {
        await this._videoSeek(time, options);
      } else {
        await this._audioSeek(time, options);
      }

      this.currentTime = time;
      this.startTime = Date.now() - (time * 1000);

      if (wasPlaying) {
        await this.resume();
      }

      this.emit('seeked', time);
      return true;
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Pause playback
   */
  async pause() {
    if (this.dispatcher) {
      this.dispatcher.pause();
    }
    if (this.videoDispatcher) {
      this.videoDispatcher.pause();
    }
    this.paused = true;
    this.emit('pause');
  }

  /**
   * Resume playback
   */
  async resume() {
    if (this.dispatcher) {
      this.dispatcher.resume();
    }
    if (this.videoDispatcher) {
      this.videoDispatcher.resume();
    }
    this.paused = false;
    this.emit('resume');
  }

  /**
   * Set volume (0.0 to 2.0)
   */
  setVolume(volume) {
    if (typeof volume !== 'number' || volume < 0 || volume > 2) {
      throw new Error('Volume must be between 0 and 2');
    }
    this.volume = volume;

    if (this.streams.has('volume')) {
      this.streams.get('volume').setVolume(volume);
    }
  }

  /**
   * Audio seeking implementation
   */
  async _audioSeek(time, options) {
    if (!this.seekTransform) {
      throw new Error('No active audio stream to seek');
    }

    const keyframePosition = this.seekTransform.getClosestKeyframe(time);
    if (keyframePosition !== undefined) {
      this.ffmpegProcess.stdin.write(`seek ${keyframePosition}\n`);
    }

    this.seekTransform.seek(time);

    return new Promise(resolve => {
      // Wait for buffer to clear
      setTimeout(resolve, 100);
    });
  }

  /**
   * Video seeking implementation
   */
  async _videoSeek(time, options) {
    if (!this.ffmpegProcess) {
      throw new Error('No active video stream to seek');
    }

    // Send seek command to FFmpeg
    this.ffmpegProcess.stdin.write(`seek ${time}\n`);

    return new Promise(resolve => {
      // Wait for next keyframe
      const frameTime = 1000 / (options?.fps || 30);
      setTimeout(resolve, frameTime * 2);
    });
  }

  /**
   * Play unknown format media
   */
  /**
   * Play PCM format stream
   */
  playPCMStream(stream, options = {}, streams = {}) {
    if (options?.volume === false) {
      const opus = new prism.opus.Encoder({ channels: 2, rate: 48000, frameSize: 960 });
      streams.opus = opus;
      stream.pipe(opus);
      return this.playOpusStream(opus, options, streams);
    }

    const volume = new prism.VolumeTransformer({
      type: 's16le',
      volume: options?.volume || this.volume
    });
    streams.volume = volume;

    const opus = new prism.opus.Encoder({
      channels: 2,
      rate: 48000,
      frameSize: 960
    });
    streams.opus = opus;

    stream
      .pipe(volume)
      .pipe(opus);

    return this.playOpusStream(opus, options, streams);
  }

  /**
   * Play Opus format stream
   */
  playOpusStream(stream, options = {}, streams = {}) {
    streams.opus = stream;

    if (options?.volume !== false && !streams.input) {
      streams.input = stream;
      const decoder = new prism.opus.Decoder({
        channels: 2,
        rate: 48000,
        frameSize: 960
      });

      const volume = new prism.VolumeTransformer({
        type: 's16le',
        volume: options?.volume || this.volume
      });
      streams.volume = volume;

      streams.opus = stream
        .pipe(decoder)
        .pipe(volume)
        .pipe(new prism.opus.Encoder({
          channels: 2,
          rate: 48000,
          frameSize: 960
        }));
    }

    const dispatcher = this.createDispatcher(options, streams);
    streams.opus.pipe(dispatcher);
    return dispatcher;
  }

  /**
   * Get accurate current playback time
   */
  getCurrentTime() {
    if (this.paused) {
      return this.currentTime;
    }
    return this.currentTime + ((Date.now() - this.startTime) / 1000);
  }


  destroyDispatcher() {
    if (this.dispatcher) {
      this.dispatcher.destroy();
      this.dispatcher = null;
    }
  }

  destroyVideoDispatcher() {
    if (this.videoDispatcher) {
      this.videoDispatcher.destroy();
      this.videoDispatcher = null;
    }
  }

  destroy() {
    if (this.frameBuffer) {
      this.frameBuffer.stop();
      this.frameBuffer = null;
    }

    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill();
      this.ffmpegProcess = null;
    }

    if (this.seekTransform) {
      this.seekTransform.destroy();
      this.seekTransform = null;
    }

    this.destroyDispatcher();
    this.destroyVideoDispatcher();

    for (const stream of this.streams.values()) {
      stream.destroy();
    }
    this.streams.clear();
  }

  async playUnknown(input, options = {}) {
    this.destroyDispatcher();

    const isStream = input instanceof ReadableStream;
    const args = [
      ...FFMPEG_OUTPUT_PREFIX,
      ...FFMPEG_PCM_ARGUMENTS
    ];

    if (!isStream) {
      args.unshift('-i', input);
    }

    if (options.seek) {
      args.unshift('-ss', String(options.seek));
    }

    if (typeof input === 'string' && input.startsWith('http')) {
      args.unshift(...FFMPEG_INPUT_PREFIX);
    }

    const ffmpeg = new prism.FFmpeg({ args });
    this.ffmpegProcess = ffmpeg.process;

    this.emit('debug', `[ffmpeg-audio] Spawn process with args:\n${args.join(' ')}`);

    if (isStream) {
      input.pipe(ffmpeg);
    }

    // Create seek transform
    this.seekTransform = new SeekTransform({
      frameSize: 960,
      sampleRate: 48000,
      bytesPerSample: 4
    });

    // Create audio pipeline
    const volume = new prism.VolumeTransformer({
      type: 's16le',
      volume: options?.volume || this.volume
    });
    this.streams.set('volume', volume);

    const opus = new prism.opus.Encoder({
      channels: 2,
      rate: 48000,
      frameSize: 960
    });
    this.streams.set('opus', opus);

    // Connect pipeline
    ffmpeg
      .pipe(this.seekTransform)
      .pipe(volume)
      .pipe(opus);

    const dispatcher = this.createDispatcher(options, {
      ffmpeg,
      volume,
      opus,
      seekTransform: this.seekTransform
    });

    opus.pipe(dispatcher);
    return dispatcher;
  }

  async playUnknownVideo(input, options = {}) {
    this.destroyVideoDispatcher();

    const isStream = input instanceof ReadableStream;
    if (!options?.fps) options.fps = 30;
    if (!options.bitrate || options.bitrate < 3000) {
      options.bitrate = 3000;
    }

    const args = [
      ...FFMPEG_OUTPUT_PREFIX,
      '-i', isStream ? '-' : input,
      '-r', `${options.fps}`,
      '-b:v', `${options.bitrate}k`
    ];

    if (options?.hwAccel) {
      args.unshift('-hwaccel', 'auto');
    }

    if (options?.seek) {
      args.unshift('-ss', String(options.seek));
    }

    if (typeof input === 'string' && input.startsWith('http')) {
      args.unshift(...FFMPEG_INPUT_PREFIX);
    }

    if (this.voiceConnection.videoCodec === 'VP8') {
      args.push(...FFMPEG_VP8_ARGUMENTS);
    } else if (this.voiceConnection.videoCodec === 'H264') {
      args.push(...FFMPEG_H264_ARGUMENTS(options));
    } else {
      throw new Error('Invalid codec (Supported: VP8, H264)');
    }

    const ffmpeg = new prism.FFmpeg({ args });
    this.ffmpegProcess = ffmpeg.process;

    this.emit('debug', `[ffmpeg-video] Spawn process with args:\n${args.join(' ')}`);

    if (isStream) {
      input.pipe(ffmpeg);
    }

    this.frameBuffer = new FrameBuffer({ fps: options.fps });

    let dispatcher;
    if (this.voiceConnection.videoCodec === 'VP8') {
      const videoStream = new IvfTransformer();
      ffmpeg.pipe(videoStream);

      dispatcher = new VP8Dispatcher(
        this,
        options?.highWaterMark || 32,
        { ffmpeg, video: videoStream },
        options.fps
      );

      videoStream
        .pipe(this.frameBuffer)
        .pipe(dispatcher);

    } else if (this.voiceConnection.videoCodec === 'H264') {
      const videoStream = new H264NalSplitter();
      ffmpeg.pipe(videoStream);

      dispatcher = new H264Dispatcher(
        this,
        options?.highWaterMark || 32,
        { ffmpeg, video: videoStream },
        options.fps
      );

      videoStream
        .pipe(this.frameBuffer)
        .pipe(dispatcher);
    }

    this.videoDispatcher = dispatcher;

    // Start frame delivery after initialization
    setTimeout(() => {
      if (this.frameBuffer) {
        this.frameBuffer.start();
      }
    }, 500);

    return dispatcher;
  }

  createDispatcher(options, streams) {
    const dispatcher = new AudioDispatcher(this, options, streams);
    this.dispatcher = dispatcher;
    return dispatcher;
  }
}

module.exports = MediaPlayer;