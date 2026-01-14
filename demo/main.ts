/**
 * Web Live Player - Demo Application
 */

import { 
  createPlayer, 
  LiveVideoPlayer,
  IStreamSource,
  createStandaloneMoQSource,
  createWebSocketSource,
  createFilePlayer,
  FileVideoPlayer,
} from '../index';

// DOM Elements
const videoCanvas = document.getElementById('videoCanvas') as HTMLCanvasElement;
const ctx = videoCanvas.getContext('2d')!;
const statusIndicator = document.getElementById('statusIndicator')!;
const statusText = document.getElementById('statusText')!;
const logContainer = document.getElementById('logContainer')!;

// Stats elements
const statBuffer = document.getElementById('statBuffer')!;
const statLatency = document.getElementById('statLatency')!;
const statResolution = document.getElementById('statResolution')!;
const statFrameRate = document.getElementById('statFrameRate')!;
const statDropped = document.getElementById('statDropped')!;
const statDecoder = document.getElementById('statDecoder')!;
const statTotal = document.getElementById('statTotal')!;
const statRenderFps = document.getElementById('statRenderFps')!;

// Controls
const btnPlay = document.getElementById('btnPlay')!;
const btnPause = document.getElementById('btnPause')!;
const btnDisconnect = document.getElementById('btnDisconnect')!;
const btnConnectMoq = document.getElementById('btnConnectMoq')!;
const btnConnectWs = document.getElementById('btnConnectWs')!;
const btnConnectMock = document.getElementById('btnConnectMock')!;

// Settings inputs
const bufferDelayInput = document.getElementById('bufferDelay') as HTMLInputElement;
const decoderPreferenceInput = document.getElementById('decoderPreference') as HTMLSelectElement;
const debugLoggingInput = document.getElementById('debugLogging') as HTMLInputElement;

// MoQ inputs
const moqRelayUrlInput = document.getElementById('moqRelayUrl') as HTMLInputElement;
const moqNamespaceInput = document.getElementById('moqNamespace') as HTMLInputElement;
const moqVideoTrackInput = document.getElementById('moqVideoTrack') as HTMLInputElement;
const moqAudioTrackInput = document.getElementById('moqAudioTrack') as HTMLInputElement;

// WebSocket inputs
const wsUrlInput = document.getElementById('wsUrl') as HTMLInputElement;
const wsStreamIdInput = document.getElementById('wsStreamId') as HTMLInputElement;
const wsAutoReconnectInput = document.getElementById('wsAutoReconnect') as HTMLInputElement;

// Mock inputs
const mockResolutionInput = document.getElementById('mockResolution') as HTMLSelectElement;
const mockFrameRateInput = document.getElementById('mockFrameRate') as HTMLSelectElement;

// File inputs
const fileUrlInput = document.getElementById('fileUrl') as HTMLInputElement;
const fileInput = document.getElementById('fileInput') as HTMLInputElement;
const fileLoopInput = document.getElementById('fileLoop') as HTMLInputElement;
const fileSeekBar = document.getElementById('fileSeekBar') as HTMLInputElement;
const filePositionSpan = document.getElementById('filePosition')!;
const fileDurationSpan = document.getElementById('fileDuration')!;
const btnLoadFile = document.getElementById('btnLoadFile')!;

// Tab handling
const tabs = document.querySelectorAll('.tab');
const tabContents = document.querySelectorAll('.tab-content');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const tabId = tab.getAttribute('data-tab');
    
    tabs.forEach(t => t.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    
    tab.classList.add('active');
    document.getElementById(`tab-${tabId}`)?.classList.add('active');
  });
});

// Player instance
let player: LiveVideoPlayer | null = null;
let filePlayer: FileVideoPlayer | null = null;
let currentSource: IStreamSource | null = null;
let animationFrameId: number | null = null;
let isFileMode: boolean = false;

// FPS tracking
let frameCount = 0;
let lastFpsUpdate = 0;
let currentFps = 0;
let mockStreamInterval: number | null = null;
let lastStatsUpdate = 0;

// Logging utility
function log(message: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
  
  // Also log to console
  console[level](`[Demo] ${message}`);
}

// Status update
function setStatus(status: 'connected' | 'disconnected' | 'connecting', text: string) {
  statusIndicator.className = `status-indicator ${status}`;
  statusText.textContent = text;
}

// Stats update
function updateStats() {
  if (!player) return;
  
  const stats = player.getStats();
  statBuffer.textContent = `${stats.avgBufferMs}ms/${stats.targetBufferMs}ms`;
  statResolution.textContent = stats.streamWidth > 0 ? `${stats.streamWidth}x${stats.streamHeight}` : '-';
  statFrameRate.textContent = stats.frameRate > 0 ? `${stats.frameRate.toFixed(1)} fps` : '-';
  statDropped.textContent = stats.droppedFrames.toString();
  statDecoder.textContent = stats.decoderState;
  statTotal.textContent = stats.totalFrames.toString();
  
  // Display latency
  if (stats.latency) {
    statLatency.textContent = `${stats.latency.avgDecodeLatency}/${stats.latency.avgBufferLatency}/${stats.latency.avgTotalLatency}ms`;
  } else {
    statLatency.textContent = '-';
  }
}

// Create player with current settings
function createPlayerInstance(): LiveVideoPlayer {
  const config = {
    bufferDelayMs: parseInt(bufferDelayInput.value, 10),
    preferredDecoder: decoderPreferenceInput.value as 'webcodecs-hw' | 'webcodecs-sw' | 'wasm',
    debugLogging: debugLoggingInput.checked,
  };
  
  const newPlayer = createPlayer(config);
  
  // Event handlers
  newPlayer.on('statechange', (state) => {
    log(`Player state: ${state}`);
  });
  
  newPlayer.on('metadata', (metadata) => {
    log(`Stream metadata: ${metadata.width}x${metadata.height}, codec: ${metadata.codec}`);
  });
  
  newPlayer.on('error', (error) => {
    log(`Error: ${error.message}`, 'error');
  });
  
  return newPlayer;
}

// Render loop
function renderLoop(timestamp: number) {
  // Track FPS
  frameCount++;
  if (timestamp - lastFpsUpdate >= 1000) {
    currentFps = frameCount * 1000 / (timestamp - lastFpsUpdate);
    frameCount = 0;
    lastFpsUpdate = timestamp;
    statRenderFps.textContent = `${currentFps.toFixed(1)} fps`;
  }
  
  // Handle file playback
  if (isFileMode && filePlayer) {
    const frame = filePlayer.getVideoFrame();
    
    if (frame) {
      // Scale canvas to fill container while maintaining aspect ratio
      const container = videoCanvas.parentElement;
      if (container) {
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        
        // Only update canvas size if container size changed
        if (videoCanvas.width !== containerWidth || videoCanvas.height !== containerHeight) {
          videoCanvas.width = containerWidth;
          videoCanvas.height = containerHeight;
        }
      }
      
      // Draw the frame scaled to fill the canvas
      ctx.drawImage(frame, 0, 0, videoCanvas.width, videoCanvas.height);
    }
    
    // Update stats and seek bar every 500ms
    if (timestamp - lastStatsUpdate >= 500) {
      updateFileStats();
      lastStatsUpdate = timestamp;
    }
  }
  // Handle live streaming
  else if (player) {
    const frame = player.getVideoFrame(timestamp);
    
    if (frame) {
      // Scale canvas to fill container while maintaining aspect ratio
      const container = videoCanvas.parentElement;
      if (container) {
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        
        // Only update canvas size if container size changed
        if (videoCanvas.width !== containerWidth || videoCanvas.height !== containerHeight) {
          videoCanvas.width = containerWidth;
          videoCanvas.height = containerHeight;
        }
      }
      
      // Draw the frame scaled to fill the canvas
      ctx.drawImage(frame, 0, 0, videoCanvas.width, videoCanvas.height);
    }
    
    // Update stats every 500ms
    if (timestamp - lastStatsUpdate >= 500) {
      updateStats();
      lastStatsUpdate = timestamp;
    }
  }
  
  animationFrameId = requestAnimationFrame(renderLoop);
}

// Start render loop
function startRenderLoop() {
  if (animationFrameId === null) {
    animationFrameId = requestAnimationFrame(renderLoop);
  }
}

// Stop render loop
function stopRenderLoop() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

// Disconnect and cleanup
function disconnect() {
  stopRenderLoop();
  
  if (mockStreamInterval !== null) {
    clearInterval(mockStreamInterval);
    mockStreamInterval = null;
  }
  
  if (currentSource?.dispose) {
    currentSource.dispose();
  }
  currentSource = null;
  
  if (player) {
    player.dispose();
    player = null;
  }
  
  if (filePlayer) {
    filePlayer.dispose();
    filePlayer = null;
  }
  
  isFileMode = false;
  
  // Clear canvas
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, videoCanvas.width, videoCanvas.height);
  
  // Reset file UI
  fileSeekBar.value = '0';
  filePositionSpan.textContent = '0:00';
  fileDurationSpan.textContent = '0:00';
  
  setStatus('disconnected', 'Disconnected');
  log('Disconnected');
}

// Format time as M:SS
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Update file player stats
function updateFileStats() {
  if (!filePlayer) return;
  
  const stats = filePlayer.getStats();
  const position = filePlayer.getPosition();
  const duration = filePlayer.getDuration();
  
  statBuffer.textContent = `${stats.bufferSize} frames`;
  statResolution.textContent = stats.width > 0 ? `${stats.width}x${stats.height}` : '-';
  statFrameRate.textContent = stats.frameRate > 0 ? `${stats.frameRate.toFixed(1)} fps` : '-';
  statDropped.textContent = '0';
  statDecoder.textContent = stats.state;
  statTotal.textContent = '-';
  statLatency.textContent = '-';
  
  // Update seek bar and position display
  if (duration > 0) {
    const progress = (position / duration) * 100;
    fileSeekBar.value = progress.toString();
    filePositionSpan.textContent = formatTime(position);
    fileDurationSpan.textContent = formatTime(duration);
  }
}

// Load MP4 file
async function loadFile() {
  disconnect();
  
  const url = fileUrlInput.value.trim();
  const file = fileInput.files?.[0];
  
  if (!url && !file) {
    log('Please enter a file URL or select a local file', 'error');
    return;
  }
  
  isFileMode = true;
  setStatus('connecting', 'Loading file...');
  log('Loading file...');
  
  try {
    filePlayer = createFilePlayer({
      preferredDecoder: decoderPreferenceInput.value as 'webcodecs-hw' | 'webcodecs-sw' | 'wasm',
      debugLogging: debugLoggingInput.checked,
      loop: fileLoopInput.checked,
    });
    
    filePlayer.on('statechange', (state) => {
      log(`File player state: ${state}`);
      if (state === 'ended') {
        setStatus('connected', 'Playback ended');
      }
    });
    
    filePlayer.on('error', (error) => {
      log(`Error: ${error.message}`, 'error');
      setStatus('disconnected', 'Error');
    });
    
    filePlayer.on('ready', (info) => {
      log(`File ready: ${info.width}x${info.height}, ${info.videoCodec}, ${formatTime(info.duration)}`);
      fileDurationSpan.textContent = formatTime(info.duration);
    });
    
    if (file) {
      await filePlayer.loadFromFile(file);
      log(`Loaded local file: ${file.name}`);
    } else {
      await filePlayer.loadFromUrl(url);
      log(`Loaded file from URL: ${url}`);
    }
    
    setStatus('connected', 'File loaded');
    startRenderLoop();
    
  } catch (error) {
    log(`Failed to load file: ${error}`, 'error');
    setStatus('disconnected', 'Failed to load');
    isFileMode = false;
  }
}

// Connect to MoQ relay
async function connectMoQ() {
  disconnect();
  
  const relayUrl = moqRelayUrlInput.value;
  const namespace = moqNamespaceInput.value;
  const videoTrack = moqVideoTrackInput.value;
  const audioTrack = moqAudioTrackInput.value;
  
  if (!relayUrl || !namespace || !videoTrack || !audioTrack) {
    log('Please fill in all MoQ connection fields', 'warn');
    return;
  }
  
  setStatus('connecting', 'Connecting to MoQ...');
  log(`Connecting to MoQ relay: ${relayUrl}/${namespace}`);
  
  try {
    // Create player
    player = createPlayerInstance();
    
    // Create MoQ source with both video and audio tracks
    const moqSource = createStandaloneMoQSource({
      relayUrl,
      namespace,
      subscriptions: [
        { trackName: videoTrack, streamType: 'video', priority: 0 },
        { trackName: audioTrack, streamType: 'audio', priority: 0 },
      ],
    });
    
    // Handle source events
    moqSource.on('connected', () => {
      setStatus('connected', `Connected to ${namespace}`);
      log('MoQ session connected');
    });
    
    moqSource.on('disconnected', () => {
      setStatus('disconnected', 'Disconnected');
      log('MoQ session disconnected');
    });
    
    moqSource.on('error', (error) => {
      log(`MoQ error: ${error.message}`, 'error');
    });
    
    // Connect
    await moqSource.connect();
    
    // Set up player
    currentSource = moqSource;
    player.setStreamSource(moqSource);
    player.setTrackFilter(videoTrack);
    player.play();
    
    // Update stats immediately
    updateStats();
    
    startRenderLoop();
    
  } catch (error) {
    log(`Failed to connect: ${error}`, 'error');
    setStatus('disconnected', 'Connection failed');
    disconnect();
  }
}

// Connect to WebSocket backend
async function connectWebSocket() {
  disconnect();
  
  const wsUrl = wsUrlInput.value;
  const streamId = wsStreamIdInput.value;
  const autoReconnect = wsAutoReconnectInput.checked;
  
  if (!wsUrl) {
    log('Please provide a WebSocket URL', 'warn');
    return;
  }
  
  if (!streamId) {
    log('Please provide a stream ID', 'warn');
    return;
  }
  
  setStatus('connecting', 'Connecting to WebSocket...');
  log(`Connecting to WebSocket: ${wsUrl}`);
  
  try {
    // Create player
    player = createPlayerInstance();
    
    // Create WebSocket source
    const wsSource = createWebSocketSource({
      url: wsUrl,
      useCurrentHost: false,
      autoReconnect,
      reconnectDelay: 3000,
    });
    
    // Handle source events
    wsSource.on('connected', () => {
      setStatus('connected', `Connected (WS)`);
      log('WebSocket connected');
    });
    
    wsSource.on('disconnected', () => {
      setStatus('disconnected', 'Disconnected');
      log('WebSocket disconnected');
    });
    
    wsSource.on('error', (error) => {
      log(`WebSocket error: ${error.message}`, 'error');
    });
    
    // Connect to WebSocket
    await wsSource.connect();
    
    // Load the live stream
    log(`Loading live stream: ${streamId}`);
    const metadata = await wsSource.loadLive(streamId);
    log(`Stream metadata: ${metadata.width}x${metadata.height}`);
    
    // Request keyframe to start receiving video data
    log('Requesting keyframe to start video...');
    wsSource.requestKeyframe();
    
    // Set up player
    currentSource = wsSource;
    player.setStreamSource(wsSource);
    player.setTrackFilter(streamId);
    player.play();
    
    // Update stats immediately
    updateStats();
    
    startRenderLoop();
    
  } catch (error) {
    log(`Failed to connect: ${error}`, 'error');
    setStatus('disconnected', 'Connection failed');
    disconnect();
  }
}

// Mock stream source for testing
class MockStreamSource implements IStreamSource {
  private handlers: Map<string, Set<Function>> = new Map();
  private _connected = false;
  
  get connected() { return this._connected; }
  
  on(event: string, handler: Function): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }
  
  off(event: string, handler: Function): void {
    this.handlers.get(event)?.delete(handler);
  }
  
  emit(event: string, ...args: any[]): void {
    this.handlers.get(event)?.forEach(h => h(...args));
  }
  
  connect() {
    this._connected = true;
    this.emit('connected');
  }
  
  disconnect() {
    this._connected = false;
    this.emit('disconnected');
  }
  
  dispose() {
    this.disconnect();
    this.handlers.clear();
  }
}

// Start mock stream
function startMockStream() {
  disconnect();
  
  const [width, height] = mockResolutionInput.value.split('x').map(Number);
  const frameRate = parseInt(mockFrameRateInput.value, 10);
  
  setStatus('connecting', 'Starting mock stream...');
  log(`Starting mock stream: ${width}x${height} @ ${frameRate}fps`);
  
  try {
    // Create player
    player = createPlayerInstance();
    
    // Create mock source
    const mockSource = new MockStreamSource();
    mockSource.connect();
    
    currentSource = mockSource;
    player.setStreamSource(mockSource);
    player.setTrackFilter('video');
    
    // Create mock canvas for generating frames
    const mockCanvas = document.createElement('canvas');
    mockCanvas.width = width;
    mockCanvas.height = height;
    const mockCtx = mockCanvas.getContext('2d')!;
    
    let frameCount = 0;
    const startTime = Date.now();
    
    // Generate mock frames
    mockStreamInterval = window.setInterval(() => {
      frameCount++;
      const elapsed = (Date.now() - startTime) / 1000;
      
      // Draw test pattern
      mockCtx.fillStyle = '#1a1a2e';
      mockCtx.fillRect(0, 0, width, height);
      
      // Animated gradient
      const hue = (frameCount * 2) % 360;
      mockCtx.fillStyle = `hsl(${hue}, 70%, 50%)`;
      mockCtx.beginPath();
      mockCtx.arc(
        width / 2 + Math.sin(frameCount * 0.05) * 100,
        height / 2 + Math.cos(frameCount * 0.05) * 50,
        80,
        0,
        Math.PI * 2
      );
      mockCtx.fill();
      
      // Text overlay
      mockCtx.fillStyle = '#fff';
      mockCtx.font = '24px monospace';
      mockCtx.fillText(`Frame: ${frameCount}`, 20, 40);
      mockCtx.fillText(`Time: ${elapsed.toFixed(1)}s`, 20, 70);
      mockCtx.fillText(`${width}x${height} @ ${frameRate}fps`, 20, 100);
      mockCtx.fillText('Mock Stream - Web Live Player', 20, height - 20);
      
      // Grid pattern
      mockCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      mockCtx.lineWidth = 1;
      for (let x = 0; x < width; x += 50) {
        mockCtx.beginPath();
        mockCtx.moveTo(x, 0);
        mockCtx.lineTo(x, height);
        mockCtx.stroke();
      }
      for (let y = 0; y < height; y += 50) {
        mockCtx.beginPath();
        mockCtx.moveTo(0, y);
        mockCtx.lineTo(width, y);
        mockCtx.stroke();
      }
      
      // Create VideoFrame from canvas
      const videoFrame = new VideoFrame(mockCanvas, {
        timestamp: frameCount * (1000000 / frameRate), // microseconds
      });
      
      // Directly add to player's frame scheduler via a hack
      // In real use, this would come through the stream source
      if ((player as any).frameScheduler) {
        const now = performance.now();
        const timing = {
          arrivalTime: now,
          decodeTime: now, // Mock frames are already "decoded"
        };
        (player as any).frameScheduler.enqueue(videoFrame, videoFrame.timestamp, timing);
        
        // Update metadata
        if (frameCount === 1) {
          (player as any).streamWidth = width;
          (player as any).streamHeight = height;
          (player as any).estimatedFrameRate = frameRate;
        }
      }
      
    }, 1000 / frameRate);
    
    player.play();
    
    // Update stats immediately
    updateStats();
    
    startRenderLoop();
    
    setStatus('connected', 'Mock stream active');
    log('Mock stream started');
    
  } catch (error) {
    log(`Failed to start mock stream: ${error}`, 'error');
    setStatus('disconnected', 'Failed');
    disconnect();
  }
}

// Event listeners
btnPlay.addEventListener('click', () => {
  if (isFileMode && filePlayer) {
    filePlayer.play();
    log('Playback resumed');
  } else if (player) {
    player.play();
    log('Playback resumed');
  }
});

btnPause.addEventListener('click', () => {
  if (isFileMode && filePlayer) {
    filePlayer.pause();
    log('Playback paused');
  } else if (player) {
    player.pause();
    log('Playback paused');
  }
});

btnDisconnect.addEventListener('click', disconnect);

btnConnectMoq.addEventListener('click', connectMoQ);
btnConnectWs.addEventListener('click', connectWebSocket);
btnConnectMock.addEventListener('click', startMockStream);
btnLoadFile.addEventListener('click', loadFile);

// File seek bar - use 'change' event so seek happens when user releases slider
fileSeekBar.addEventListener('change', () => {
  if (filePlayer) {
    const duration = filePlayer.getDuration();
    const seekTime = (parseFloat(fileSeekBar.value) / 100) * duration;
    filePlayer.seek(seekTime);
  }
});

// Settings changes
bufferDelayInput.addEventListener('change', () => {
  if (player) {
    player.setBufferDelay(parseInt(bufferDelayInput.value, 10));
    log(`Buffer delay changed to ${bufferDelayInput.value}ms`);
  }
});

decoderPreferenceInput.addEventListener('change', () => {
  if (player) {
    player.setPreferredDecoder(decoderPreferenceInput.value as 'webcodecs-hw' | 'webcodecs-sw' | 'wasm');
    log(`Decoder preference changed to ${decoderPreferenceInput.value}`);
  }
});

debugLoggingInput.addEventListener('change', () => {
  if (player) {
    player.setDebugLogging(debugLoggingInput.checked);
    log(`Debug logging ${debugLoggingInput.checked ? 'enabled' : 'disabled'}`);
  }
});

// File loop toggle
fileLoopInput.addEventListener('change', () => {
  if (filePlayer) {
    filePlayer.setPlayMode(fileLoopInput.checked ? 'loop' : 'once');
    log(`Loop ${fileLoopInput.checked ? 'enabled' : 'disabled'}`);
  }
});

// Initialize
log('Web Live Player Demo initialized');
log('Select a connection method and click Connect');

// Set initial canvas size
videoCanvas.width = 1280;
videoCanvas.height = 720;
ctx.fillStyle = '#000';
ctx.fillRect(0, 0, videoCanvas.width, videoCanvas.height);
ctx.fillStyle = '#4ecdc4';
ctx.font = '24px sans-serif';
ctx.textAlign = 'center';
ctx.fillText('Connect to a stream to start', videoCanvas.width / 2, videoCanvas.height / 2);
