/**
 * Media Capture Demo Application
 */

import {
  MediaCapture,
  MediaCaptureConfig,
  CaptureState,
  WebSocketCaptureSink,
  MoQCaptureSink,
  ICaptureSink,
  CodecType,
} from '../../index';

// DOM Elements - Preview
const previewVideo = document.getElementById('previewVideo') as HTMLVideoElement;
const statusIndicator = document.getElementById('statusIndicator')!;
const statusText = document.getElementById('statusText')!;
const vuMeter = document.getElementById('vuMeter')!;
const codecInfo = document.getElementById('codecInfo')!;
const videoCodecBadge = document.getElementById('videoCodecBadge')!;
const audioCodecBadge = document.getElementById('audioCodecBadge')!;
const logContainer = document.getElementById('logContainer')!;

// Stats elements
const statState = document.getElementById('statState')!;
const statDuration = document.getElementById('statDuration')!;
const statResolution = document.getElementById('statResolution')!;
const statVideoFrames = document.getElementById('statVideoFrames')!;
const statAudioFrames = document.getElementById('statAudioFrames')!;
const statVideoBitrate = document.getElementById('statVideoBitrate')!;
const statAudioBitrate = document.getElementById('statAudioBitrate')!;
const statBytesSent = document.getElementById('statBytesSent')!;

// Controls
const btnStartCapture = document.getElementById('btnStartCapture')!;
const btnStopCapture = document.getElementById('btnStopCapture')!;
const btnRefreshDevices = document.getElementById('btnRefreshDevices')!;

// Device selectors
const videoDeviceSelect = document.getElementById('videoDeviceSelect') as HTMLSelectElement;
const audioDeviceSelect = document.getElementById('audioDeviceSelect') as HTMLSelectElement;

// Encoder settings
const videoCodecSelect = document.getElementById('videoCodecSelect') as HTMLSelectElement;
const resolutionSelect = document.getElementById('resolutionSelect') as HTMLSelectElement;
const videoBitrateInput = document.getElementById('videoBitrateInput') as HTMLInputElement;
const frameRateSelect = document.getElementById('frameRateSelect') as HTMLSelectElement;
const keyframeIntervalInput = document.getElementById('keyframeIntervalInput') as HTMLInputElement;
const audioCodecSelect = document.getElementById('audioCodecSelect') as HTMLSelectElement;
const audioBitrateInput = document.getElementById('audioBitrateInput') as HTMLInputElement;

// Transport settings - MoQ
const moqRelayUrlInput = document.getElementById('moqRelayUrl') as HTMLInputElement;
const moqNamespaceInput = document.getElementById('moqNamespace') as HTMLInputElement;
const moqVideoTrackInput = document.getElementById('moqVideoTrack') as HTMLInputElement;
const moqAudioTrackInput = document.getElementById('moqAudioTrack') as HTMLInputElement;

// Transport settings - WebSocket
const wsUrlInput = document.getElementById('wsUrl') as HTMLInputElement;
const wsStreamIdInput = document.getElementById('wsStreamId') as HTMLInputElement;

// Tab handling
const tabs = document.querySelectorAll('.tab');
const tabContents = document.querySelectorAll('.tab-content');
let activeTransport: 'moq' | 'ws' = 'moq';

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const tabId = tab.getAttribute('data-tab') as 'moq' | 'ws';
    
    tabs.forEach(t => t.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    
    tab.classList.add('active');
    document.getElementById(`tab-${tabId}`)?.classList.add('active');
    activeTransport = tabId;
  });
});

// State
let capture: MediaCapture | null = null;
let sink: ICaptureSink | null = null;
let startTime: number = 0;
let statsInterval: number | null = null;

// Logging utility
function log(message: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
  
  console[level](`[CaptureDemo] ${message}`);
}

// Status update
function setStatus(status: 'streaming' | 'ready' | 'idle' | 'error', text: string) {
  statusIndicator.className = `status-indicator ${status}`;
  statusText.textContent = text;
}

// Format bytes
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Format duration
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// Get video codec type
function getVideoCodecType(): CodecType {
  switch (videoCodecSelect.value) {
    case 'vp8': return CodecType.VIDEO_VP8;
    case 'vp9': return CodecType.VIDEO_VP9;
    case 'avc':
    default: return CodecType.VIDEO_AVC;
  }
}

// Get audio codec type
function getAudioCodecType(): CodecType {
  switch (audioCodecSelect.value) {
    case 'aac': return CodecType.AUDIO_AAC;
    case 'opus':
    default: return CodecType.AUDIO_OPUS;
  }
}

// Get codec string for WebCodecs
function getVideoCodecString(): string {
  switch (videoCodecSelect.value) {
    case 'vp8': return 'vp8';
    case 'vp9': return 'vp09.00.10.08';
    case 'avc':
    default: return 'avc1.42E01F';
  }
}

function getAudioCodecString(): string {
  switch (audioCodecSelect.value) {
    case 'aac': return 'mp4a.40.2';
    case 'opus':
    default: return 'opus';
  }
}

// Enumerate media devices
async function enumerateDevices() {
  try {
    // Request permission first
    await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(stream => stream.getTracks().forEach(t => t.stop()));
    
    const devices = await navigator.mediaDevices.enumerateDevices();
    
    // Clear existing options
    videoDeviceSelect.innerHTML = '<option value="">Default camera</option>';
    audioDeviceSelect.innerHTML = '<option value="">Default microphone</option>';
    
    devices.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `${device.kind} (${device.deviceId.slice(0, 8)}...)`;
      
      if (device.kind === 'videoinput') {
        videoDeviceSelect.appendChild(option);
      } else if (device.kind === 'audioinput') {
        audioDeviceSelect.appendChild(option);
      }
    });
    
    log(`Found ${devices.filter(d => d.kind === 'videoinput').length} cameras and ${devices.filter(d => d.kind === 'audioinput').length} microphones`);
  } catch (err) {
    log(`Failed to enumerate devices: ${err}`, 'error');
  }
}

// Create the capture sink based on selected transport
function createSink(): ICaptureSink {
  if (activeTransport === 'moq') {
    return new MoQCaptureSink({
      relayUrl: moqRelayUrlInput.value,
      namespace: moqNamespaceInput.value,
      videoTrack: { trackName: moqVideoTrackInput.value },
      audioTrack: { trackName: moqAudioTrackInput.value },
      reconnectionDelay: 3000,
    });
  } else {
    return new WebSocketCaptureSink({
      url: wsUrlInput.value,
      streamId: wsStreamIdInput.value,
      autoReconnect: true,
      reconnectDelay: 3000,
    });
  }
}

// Start capture
async function startCapture() {
  try {
    log('Starting capture...');
    setStatus('idle', 'Initializing...');
    
    // Parse resolution
    const [width, height] = resolutionSelect.value.split('x').map(Number);
    
    // Create sink
    sink = createSink();
    
    // Build capture config
    const config: MediaCaptureConfig = {
      sink,
      video: {
        codec: getVideoCodecString(),
        codecType: getVideoCodecType(),
        width,
        height,
        frameRate: parseInt(frameRateSelect.value),
        bitrate: parseInt(videoBitrateInput.value) * 1000,
        keyframeInterval: parseInt(keyframeIntervalInput.value),
        deviceId: videoDeviceSelect.value || undefined,
      },
      audio: {
        codec: getAudioCodecString(),
        codecType: getAudioCodecType(),
        sampleRate: 48000,
        channels: 2,
        bitrate: parseInt(audioBitrateInput.value) * 1000,
        deviceId: audioDeviceSelect.value || undefined,
      },
    };
    
    // Create capture instance
    capture = new MediaCapture(config);
    
    // Setup event handlers
    capture.on('stateChange', (state: CaptureState) => {
      log(`State: ${state}`);
      statState.textContent = state;
      
      switch (state) {
        case 'capturing':
          setStatus('streaming', 'Streaming');
          break;
        case 'ready':
          setStatus('ready', 'Ready');
          break;
        case 'error':
          setStatus('error', 'Error');
          break;
        default:
          setStatus('idle', state);
      }
    });
    
    capture.on('audioLevel', (level: number) => {
      // Update VU meter (level is 0-1)
      vuMeter.style.width = `${Math.min(level * 100, 100)}%`;
    });
    
    capture.on('error', (error: Error) => {
      log(`Error: ${error.message}`, 'error');
    });
    
    // Start capturing
    await capture.start();
    
    // Attach preview
    const stream = capture.getMediaStream();
    if (stream) {
      previewVideo.srcObject = stream;
    }
    
    // Show codec info
    codecInfo.style.display = 'flex';
    videoCodecBadge.textContent = `Video: ${videoCodecSelect.options[videoCodecSelect.selectedIndex].text}`;
    audioCodecBadge.textContent = `Audio: ${audioCodecSelect.options[audioCodecSelect.selectedIndex].text}`;
    
    // Update UI
    btnStartCapture.disabled = true;
    btnStopCapture.disabled = false;
    startTime = Date.now();
    
    // Start stats update
    statsInterval = window.setInterval(updateStats, 500);
    
    log(`Capture started - ${width}x${height}@${frameRateSelect.value}fps via ${activeTransport.toUpperCase()}`);
    setStatus('streaming', 'Streaming');
    
  } catch (err) {
    log(`Failed to start capture: ${err}`, 'error');
    setStatus('error', 'Failed to start');
    await stopCapture();
  }
}

// Stop capture
async function stopCapture() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
  
  if (capture) {
    await capture.stop();
    capture = null;
  }
  
  if (sink) {
    await sink.disconnect();
    sink = null;
  }
  
  previewVideo.srcObject = null;
  codecInfo.style.display = 'none';
  vuMeter.style.width = '0%';
  
  btnStartCapture.disabled = false;
  btnStopCapture.disabled = true;
  
  setStatus('idle', 'Idle');
  log('Capture stopped');
}

// Update statistics display
function updateStats() {
  if (!capture) return;
  
  const stats = capture.getStats();
  
  // Duration
  statDuration.textContent = formatDuration(Date.now() - startTime);
  
  // Resolution
  if (stats.videoWidth && stats.videoHeight) {
    statResolution.textContent = `${stats.videoWidth}x${stats.videoHeight}`;
  }
  
  // Frame counts
  statVideoFrames.textContent = stats.videoFramesSent?.toString() ?? '0';
  statAudioFrames.textContent = stats.audioFramesSent?.toString() ?? '0';
  
  // Bitrates
  if (stats.videoBytesPerSecond) {
    statVideoBitrate.textContent = `${((stats.videoBytesPerSecond * 8) / 1000).toFixed(0)} kbps`;
  }
  if (stats.audioBytesPerSecond) {
    statAudioBitrate.textContent = `${((stats.audioBytesPerSecond * 8) / 1000).toFixed(0)} kbps`;
  }
  
  // Total bytes sent
  const totalBytes = (stats.videoBytesSent ?? 0) + (stats.audioBytesSent ?? 0);
  statBytesSent.textContent = formatBytes(totalBytes);
}

// Event listeners
btnStartCapture.addEventListener('click', startCapture);
btnStopCapture.addEventListener('click', stopCapture);
btnRefreshDevices.addEventListener('click', enumerateDevices);

// Initialize
async function init() {
  log('Media Capture Demo initialized');
  await enumerateDevices();
  setStatus('idle', 'Ready to capture');
}

init();
