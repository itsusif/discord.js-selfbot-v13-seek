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
  '-vsync', 'drop',
  '-async', '1'
];

const FFMPEG_INPUT_PREFIX = [
  '-reconnect', '1',
  '-reconnect_at_eof', '1',
  '-reconnect_streamed', '1',
  '-reconnect_delay_max', '4294'
];

const FFMPEG_PCM_ARGUMENTS = ['-f', 's16le', '-ar', '48000', '-ac', '2'];

const FFMPEG_VP8_ARGUMENTS = [
  '-f', 'ivf',
  '-deadline', 'realtime',
  '-c:v', 'libvpx',
  '-cpu-used', '5',
  '-lag-in-frames', '0'
];

const FFMPEG_H264_ARGUMENTS = options => [
  '-c:v', 'libx264',
  '-f', 'h264',
  '-tune', 'zerolatency',
  '-preset', options?.presetH26x || 'faster',
  '-profile:v', 'baseline',
  '-bf', '0',
  '-g', `${options?.fps || 30}`,
  '-keyint_min', `${options?.fps || 30}`,
  '-bsf:v', 'h264_metadata=aud=insert'
];

/**
 * Custom transform stream for handling media seeking
 */
class SeekTransform extends Transform {
  constructor(options = {}) {
    super(options);
    this.seekTime = 0;
    this.seeking = false;
    this.bytesSkipped = 0;
    this.frameSize = options.frameSize || 960;
    this.sampleRate = options.sampleRate || 48000;
    this.bytesPerSample = options.bytesPerSample || 4;
    this.bufferSize = options.bufferSize || 1024 * 1024; // 1MB buffer
    this.buffer = Buffer.alloc(0);
    this.keyframes = new Map();
  }

  _transform(chunk, encoding, callback) {
    try {
      if (this.seeking) {
        // Calculate frames to skip
        const framesToSkip = Math.floor((this.seekTime * this.sampleRate) / this.frameSize);
        const bytesToSkip = framesToSkip * this.frameSize * this.bytesPerSample;
        
        this.bytesSkipped += chunk.length;
        
        if (this.bytesSkipped >= bytesToSkip) {
          // We've skipped enough, start pushing data
          const excess = this.bytesSkipped - bytesToSkip;
          if (excess > 0) {
            this.push(chunk.slice(chunk.length - excess));
          }
          this.seeking = false;
        }
      } else {
        // Normal operation - buffer management
        this.buffer = Buffer.concat([this.buffer, chunk]);
        
        while (this.buffer.length > this.frameSize * this.bytesPerSample) {
          const frame = this.buffer.slice(0, this.frameSize * this.bytesPerSample);
          this.push(frame);
          this.buffer = this.buffer.slice(this.frameSize * this.bytesPerSample);
        }
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    if (this.buffer.length > 0) {
      this.push(this.buffer);
    }
    callback();
  }

  seek(time) {
    this.seekTime = time;
    this.seeking = true;
    this.bytesSkipped = 0;
    this.buffer = Buffer.alloc(0);
  }

  addKeyframe(timestamp, position) {
    this.keyframes.set(timestamp, position);
  }

  getClosestKeyframe(timestamp) {
    let closest = 0;
    for (const [time, position] of this.keyframes.entries()) {
      if (time <= timestamp && time > closest) {
        closest = time;
      }
    }
    return this.keyframes.get(closest);
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
    this.seekTransform = null;
    this.ffmpegProcess = null;
    this.currentTime = 0;
    this.startTime = Date.now();
    this.paused = false;
    this.volume = 1.0;
    this.streams = new Map();
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

  async playUnknown(input, options = {}) {
    const isStream = input instanceof ReadableStream;
    const args = [
      ...FFMPEG_OUTPUT_PREFIX,
      '-enable_seek', '1'
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

    // Add format-specific arguments
    args.push(...FFMPEG_PCM_ARGUMENTS);

    const ffmpeg = new prism.FFmpeg({ args });
    this.ffmpegProcess = ffmpeg.process;

    this.emit('debug', `[ffmpeg-process] Spawn process with args:\n${args.join(' ')}`);

    ffmpeg.process.stderr.on('data', data => {
      this.emit('debug', `[ffmpeg-process]: ${data.toString()}`);
    });

    // Create seek transform
    this.seekTransform = new SeekTransform({
      frameSize: 960,
      sampleRate: 48000,
      bytesPerSample: 4,
      bufferSize: 1024 * 1024
    });

    // Set up stream pipeline
    if (isStream) {
      input.pipe(ffmpeg);
    }

    // Volume transformer
    const volume = new prism.VolumeTransformer({ 
      type: 's16le',
      volume: this.volume 
    });
    this.streams.set('volume', volume);

    // Opus encoder
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

    // Create dispatcher
    const dispatcher = this.createDispatcher(options, {
      ffmpeg,
      volume,
      opus,
      seekTransform: this.seekTransform
    });

    opus.pipe(dispatcher);

    this.currentTime = options.seek || 0;
    this.startTime = Date.now() - (this.currentTime * 1000);

    return dispatcher;
  }

  /**
   * Play video with seeking support
   */
  async playUnknownVideo(input, options = {}) {
    const isStream = input instanceof ReadableStream;
    if (!options?.fps) options.fps = 30;

    const args = [
      ...FFMPEG_OUTPUT_PREFIX,
      '-enable_seek', '1',
      '-i', isStream ? '-' : input,
      '-flags', 'low_delay',
      '-r', `${options?.fps}`
    ];

    if (options?.bitrate) {
      args.push('-b:v', `${options?.bitrate}K`);
    }

    if (options?.hwAccel) {
      args.unshift('-hwaccel', 'auto');
    }

    if (options?.seek) {
      args.unshift('-ss', String(options.seek));
    }

    if (typeof input === 'string' && input.startsWith('http')) {
      args.unshift(...FFMPEG_INPUT_PREFIX);
    }

    // Add codec-specific arguments
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

    ffmpeg.process.stderr.on('data', data => {
      this.emit('debug', `[ffmpeg-video]: ${data.toString()}`);
    });

    // Set up stream pipeline
    if (isStream) {
      input.pipe(ffmpeg);
    }

    let dispatcher;
    if (this.voiceConnection.videoCodec === 'VP8') {
      const videoStream = new IvfTransformer();
      ffmpeg.pipe(videoStream);
      dispatcher = new VP8Dispatcher(this, options?.highWaterMark, {
        ffmpeg,
        video: videoStream
      }, options?.fps);
      videoStream.pipe(dispatcher);
    } else {
      const videoStream = new H264NalSplitter();
      ffmpeg.pipe(videoStream);
      dispatcher = new H264Dispatcher(this, options?.highWaterMark, {
        ffmpeg,
        video: videoStream
      }, options?.fps);
      videoStream.pipe(dispatcher);
    }

    this.videoDispatcher = dispatcher;
    this.currentTime = options.seek || 0;
    this.startTime = Date.now() - (this.currentTime * 1000);

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

  /**
   * Clean up resources
   */
  destroy() {
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill();
      this.ffmpegProcess = null;
    }

    if (this.seekTransform) {
      this.seekTransform.destroy();
      this.seekTransform = null;
    }

    for (const stream of this.streams.values()) {
      stream.destroy();
    }
    this.streams.clear();

    if (this.dispatcher) {
      this.dispatcher.destroy();
      this.dispatcher = null;
    }

    if (this.videoDispatcher) {
      this.videoDispatcher.destroy();
      this.videoDispatcher = null;
    }
  }

  /**
   * Create audio dispatcher
   */
  createDispatcher(options, streams) {
    if (this.dispatcher) {
      this.dispatcher.destroy();
    }
    const dispatcher = new AudioDispatcher(this, options, streams);
    this.dispatcher = dispatcher;
    return dispatcher;
  }
}

module.exports = MediaPlayer;