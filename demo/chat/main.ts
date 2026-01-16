/**
 * Chat Demo Application
 * 
 * Multi-user video chat using MoQ for transport.
 * Namespace structure: {room}/user/{userId}
 * Each user publishes: video, audio, and chat tracks
 * 
 * Uses the library's LiveVideoPlayer for playback and MediaCapture for capture.
 */

import type {
  MoqSessionBroadcaster,
  MoqSessionSubscriber,
  MoQSessionConfig,
  BroadcastConfig,
  SubscriptionConfig,
} from 'stinky-moq-js';

import {
  MediaCapture,
  MediaCaptureConfig,
  CodecType,
  SesameBinaryProtocol,
  LiveVideoPlayer,
  BaseStreamSource,
  type StreamDataEvent,
} from '../../index';

// BroadcastAnnouncement type (from stinky-moq-js)
interface BroadcastAnnouncement {
  path: string;
  active: boolean;
}

// ============================================================================
// Types
// ============================================================================

interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
}

interface RemoteUser {
  userId: string;
  userName: string;
  namespace: string;
  canvas?: HTMLCanvasElement;
  ctx?: CanvasRenderingContext2D;
  subscriber?: MoqSessionSubscriber;
  player?: LiveVideoPlayer;
  streamSource?: MoqSubscriberSource;
}

interface LocalState {
  userId: string;
  userName: string;
  roomName: string;
  relayUrl: string;
  namespace: string;
  videoMuted: boolean;
  audioMuted: boolean;
}

// ============================================================================
// MoqSubscriberSource - Adapter to connect MoqSessionSubscriber to LiveVideoPlayer
// ============================================================================

/**
 * Adapts MoqSessionSubscriber to IStreamSource interface for use with LiveVideoPlayer.
 * Handles video and audio tracks; chat messages are handled separately.
 */
class MoqSubscriberSource extends BaseStreamSource {
  private subscriber: MoqSessionSubscriber;
  private chatHandler?: (data: Uint8Array) => void;
  
  constructor(subscriber: MoqSessionSubscriber, chatHandler?: (data: Uint8Array) => void) {
    super();
    this.subscriber = subscriber;
    this.chatHandler = chatHandler;
    
    // Forward data events from subscriber to stream source events
    this.subscriber.on('data', (trackName: string, data: Uint8Array) => {
      if (trackName === 'chat') {
        // Chat messages are handled separately
        this.chatHandler?.(data);
        return;
      }
      
      // Parse the binary protocol for video/audio
      const parsed = SesameBinaryProtocol.parseData(data);
      if (!parsed.valid) return;
      
      const streamType = trackName === 'video' ? 'video' : 
                         trackName === 'audio' ? 'audio' : 'data';
      
      const event: StreamDataEvent = {
        trackName,
        streamType: streamType as 'video' | 'audio' | 'data',
        data: parsed,
      };
      
      this.emit('data', event);
    });
    
    this.subscriber.on('error', (error: Error) => {
      this.emit('error', error);
    });
    
    this._connected = true;
    this.emit('connected');
  }
  
  override dispose(): void {
    this.subscriber.dispose();
    super.dispose();
  }
}

// ============================================================================
// DOM Elements
// ============================================================================

const joinModal = document.getElementById('joinModal')!;
const mainHeader = document.getElementById('mainHeader')!;
const mainContainer = document.getElementById('mainContainer')!;

const relayUrlInput = document.getElementById('relayUrl') as HTMLInputElement;
const roomNameInput = document.getElementById('roomName') as HTMLInputElement;
const userNameInput = document.getElementById('userName') as HTMLInputElement;
const btnJoin = document.getElementById('btnJoin') as HTMLButtonElement;

const displayRoomName = document.getElementById('displayRoomName')!;
const userCount = document.getElementById('userCount')!;
const videoGrid = document.getElementById('videoGrid')!;
const chatMessages = document.getElementById('chatMessages')!;
const chatInput = document.getElementById('chatInput') as HTMLInputElement;
const btnSendChat = document.getElementById('btnSendChat') as HTMLButtonElement;
const btnToggleVideo = document.getElementById('btnToggleVideo') as HTMLButtonElement;
const btnToggleMic = document.getElementById('btnToggleMic') as HTMLButtonElement;
const btnLeave = document.getElementById('btnLeave') as HTMLButtonElement;

// ============================================================================
// State
// ============================================================================

let localState: LocalState | null = null;
let broadcaster: MoqSessionBroadcaster | null = null;
let discoverySubscriber: MoqSessionSubscriber | null = null;
let capture: MediaCapture | null = null;
let localVideoElement: HTMLVideoElement | null = null;
let renderLoopId: number | null = null;

const remoteUsers = new Map<string, RemoteUser>();
const chatHistory: ChatMessage[] = [];

// ============================================================================
// Utility Functions
// ============================================================================

function generateUserId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function parseNamespace(path: string): { room: string; userId: string } | null {
  // Expected format: {room}/user/{userId}
  const match = path.match(/^([^/]+)\/user\/([^/]+)$/);
  if (match) {
    return { room: match[1], userId: match[2] };
  }
  return null;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addSystemMessage(text: string) {
  const div = document.createElement('div');
  div.className = 'system-message';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addChatMessage(message: ChatMessage, isOwn: boolean) {
  const div = document.createElement('div');
  div.className = `chat-message${isOwn ? ' own' : ''}`;
  div.innerHTML = `
    <div class="sender">${isOwn ? 'You' : message.userName}</div>
    <div class="text">${escapeHtml(message.text)}</div>
    <div class="time">${formatTime(message.timestamp)}</div>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateUserCount() {
  const count = remoteUsers.size + 1; // +1 for local user
  userCount.textContent = `${count} user${count !== 1 ? 's' : ''}`;
}

// ============================================================================
// Video Tile Management
// ============================================================================

function createVideoTileForLocal(userId: string, userName: string): HTMLVideoElement {
  const tile = document.createElement('div');
  tile.className = 'video-tile local';
  tile.id = `tile-${userId}`;
  
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true; // Mute local video to prevent echo
  
  const label = document.createElement('div');
  label.className = 'user-label local';
  label.textContent = `${userName} (You)`;
  
  tile.appendChild(video);
  tile.appendChild(label);
  videoGrid.appendChild(tile);
  
  return video;
}

function createVideoTileForRemote(userId: string, userName: string): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${userId}`;
  
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.objectFit = 'cover';
  
  const label = document.createElement('div');
  label.className = 'user-label';
  label.textContent = userName;
  
  tile.appendChild(canvas);
  tile.appendChild(label);
  videoGrid.appendChild(tile);
  
  const ctx = canvas.getContext('2d')!;
  return { canvas, ctx };
}

function removeVideoTile(userId: string) {
  const tile = document.getElementById(`tile-${userId}`);
  if (tile) {
    tile.remove();
  }
}

// ============================================================================
// Chat Data Encoding/Decoding
// ============================================================================

function encodeChatMessage(message: ChatMessage): Uint8Array {
  const json = JSON.stringify(message);
  const encoder = new TextEncoder();
  return encoder.encode(json);
}

function decodeChatMessage(data: Uint8Array): ChatMessage | null {
  try {
    const decoder = new TextDecoder();
    const json = decoder.decode(data);
    return JSON.parse(json) as ChatMessage;
  } catch {
    return null;
  }
}

// ============================================================================
// MoQ Broadcasting (Publishing)
// ============================================================================

async function startBroadcasting() {
  if (!localState) return;
  
  const { MoqSessionBroadcaster } = await import('stinky-moq-js');
  
  const sessionConfig: MoQSessionConfig = {
    relayUrl: localState.relayUrl,
    namespace: localState.namespace,
    reconnection: { delay: 3000 },
  };
  
  const broadcasts: BroadcastConfig[] = [
    { trackName: 'video', priority: 1, type: 'video' },
    { trackName: 'audio', priority: 2, type: 'audio' },
    { trackName: 'chat', priority: 3, type: 'data' },
  ];
  
  broadcaster = new MoqSessionBroadcaster(sessionConfig, broadcasts);
  
  broadcaster.on('stateChange', (status: any) => {
    console.log('[Broadcast] State:', status.state);
  });
  
  broadcaster.on('error', (error: Error) => {
    console.error('[Broadcast] Error:', error);
  });
  
  await broadcaster.connect();
  console.log('[Broadcast] Connected, namespace:', localState.namespace);
}

async function startCapturing() {
  if (!localState || !broadcaster) return;
  
  // Create a custom sink that sends to our broadcaster
  const captureSink = {
    connected: true,
    connect: async () => {},
    disconnect: async () => {},
    send: (packet: any) => {
      if (!broadcaster) return;
      const trackName = packet.type === 'video' ? 'video' : 'audio';
      const newGroup = packet.type === 'video' ? packet.isKeyframe : true;
      broadcaster.send(trackName, new Uint8Array(packet.data), newGroup);
    },
    dispose: () => {},
    onKeyframeRequest: () => {},
    requestKeyframe: () => { capture?.requestKeyframe(); },
  };
  
  const config: MediaCaptureConfig = {
    sink: captureSink as any,
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 24 },
    },
    audio: {
      sampleRate: { ideal: 48000 },
      channelCount: { ideal: 1 },
    },
    videoEncoder: {
      codec: CodecType.VIDEO_VP8,
      width: 640,
      height: 480,
      frameRate: 24,
      bitrate: 800_000,
      keyFrameInterval: 48,
      latencyMode: 'realtime',
    },
    audioEncoder: {
      codec: CodecType.AUDIO_OPUS,
      sampleRate: 48000,
      channels: 1,
      bitrate: 64_000,
      latencyMode: 'realtime',
    },
  };
  
  capture = new MediaCapture(config);
  
  capture.on('error', (error: Error) => {
    console.error('[Capture] Error:', error);
  });
  
  await capture.start();
  
  // Show local preview
  const stream = capture.getMediaStream();
  if (stream && localVideoElement) {
    localVideoElement.srcObject = stream;
  }
  
  console.log('[Capture] Started');
}

function sendChatMessage(text: string) {
  if (!localState || !broadcaster) return;
  
  const message: ChatMessage = {
    id: generateUserId(),
    userId: localState.userId,
    userName: localState.userName,
    text,
    timestamp: Date.now(),
  };
  
  const encoded = encodeChatMessage(message);
  broadcaster.send('chat', encoded, true);
  
  // Add to local chat
  chatHistory.push(message);
  addChatMessage(message, true);
}

// ============================================================================
// MoQ Discovery & Subscription
// ============================================================================

async function startDiscovery() {
  if (!localState) return;
  
  const { MoqSessionSubscriber } = await import('stinky-moq-js');
  
  // Create a discovery-only subscriber with the room namespace
  // discoveryOnly: true means we just listen for announcements without subscribing to any tracks
  const sessionConfig: MoQSessionConfig = {
    relayUrl: localState.relayUrl,
    namespace: localState.roomName, // Use room name as namespace to get all announcements under it
    reconnection: { delay: 3000 },
    discoveryOnly: true, // Only discover broadcasts, don't auto-subscribe
  };
  
  // Empty subscriptions - we just want to listen for announcements
  discoverySubscriber = new MoqSessionSubscriber(sessionConfig, []);
  
  discoverySubscriber.on('broadcastAnnounced', (announcement: BroadcastAnnouncement) => {
    console.log('[Discovery] Announcement:', announcement);
    handleBroadcastAnnouncement(announcement);
  });
  
  discoverySubscriber.on('error', (error: Error) => {
    console.error('[Discovery] Error:', error);
  });
  
  await discoverySubscriber.connect();
  console.log('[Discovery] Listening for users in room:', localState.roomName);
}

async function handleBroadcastAnnouncement(announcement: BroadcastAnnouncement) {
  if (!localState) return;
  
  const parsed = parseNamespace(announcement.path);
  if (!parsed) return;
  
  // Ignore our own announcements
  if (parsed.userId === localState.userId) return;
  
  // Only care about our room
  if (parsed.room !== localState.roomName) return;
  
  if (announcement.active) {
    // New user joined
    if (!remoteUsers.has(parsed.userId)) {
      await subscribeToUser(parsed.userId, announcement.path);
    }
  } else {
    // User left
    removeRemoteUser(parsed.userId);
  }
}

async function subscribeToUser(userId: string, namespace: string) {
  if (!localState) return;
  
  console.log('[Subscribe] Subscribing to user:', userId);
  
  const { MoqSessionSubscriber } = await import('stinky-moq-js');
  
  const sessionConfig: MoQSessionConfig = {
    relayUrl: localState.relayUrl,
    namespace,
    reconnection: { delay: 3000 },
  };
  
  const subscriptions: SubscriptionConfig[] = [
    { trackName: 'video', priority: 1 },
    { trackName: 'audio', priority: 2 },
    { trackName: 'chat', priority: 3 },
  ];
  
  const subscriber = new MoqSessionSubscriber(sessionConfig, subscriptions);
  
  // Create canvas tile for this user
  const { canvas, ctx } = createVideoTileForRemote(userId, userId);
  
  // Chat message handler - called by the stream source when chat data arrives
  const handleChatData = (data: Uint8Array) => {
    const message = decodeChatMessage(data);
    if (message) {
      // Update username if we see it
      const user = remoteUsers.get(userId);
      if (user && message.userName && user.userName !== message.userName) {
        user.userName = message.userName;
        const label = document.querySelector(`#tile-${userId} .user-label`);
        if (label) label.textContent = message.userName;
      }
      
      chatHistory.push(message);
      addChatMessage(message, false);
    }
  };
  
  // Create stream source adapter
  const streamSource = new MoqSubscriberSource(subscriber, handleChatData);
  
  // Create player using the library's LiveVideoPlayer
  const player = new LiveVideoPlayer({
    enableAudio: true,
    videoTrackName: 'video',
    audioTrackName: 'audio',
    bufferDelayMs: 100,
  });
  
  // Connect player to stream source
  player.setStreamSource(streamSource);
  
  const remoteUser: RemoteUser = {
    userId,
    userName: userId, // Will be updated from chat messages
    namespace,
    canvas,
    ctx,
    subscriber,
    player,
    streamSource,
  };
  
  remoteUsers.set(userId, remoteUser);
  updateUserCount();
  addSystemMessage(`${userId} joined the room`);
  
  // Start playback
  player.play();
  
  // Connect subscriber
  await subscriber.connect();
}

function removeRemoteUser(userId: string) {
  const user = remoteUsers.get(userId);
  if (!user) return;
  
  console.log('[Unsubscribe] Removing user:', userId);
  
  // Dispose player and source (handles all cleanup)
  user.player?.dispose();
  user.streamSource?.dispose();
  
  removeVideoTile(userId);
  remoteUsers.delete(userId);
  updateUserCount();
  addSystemMessage(`${user.userName || userId} left the room`);
}

// ============================================================================
// Render Loop - Renders video frames from all remote players
// ============================================================================

function renderLoop(timestamp: number) {
  // Render frames for each remote user
  for (const user of remoteUsers.values()) {
    if (user.player && user.canvas && user.ctx) {
      const frame = user.player.getVideoFrame(timestamp);
      if (frame) {
        // Resize canvas if needed
        const frameWidth = (frame as any).displayWidth || (frame as any).width;
        const frameHeight = (frame as any).displayHeight || (frame as any).height;
        
        if (user.canvas.width !== frameWidth || user.canvas.height !== frameHeight) {
          user.canvas.width = frameWidth;
          user.canvas.height = frameHeight;
        }
        
        user.ctx.drawImage(frame, 0, 0);
        
        // NOTE: Do NOT close the frame here!
        // The player manages frame lifecycle - it will close the frame
        // when a new one arrives. Closing here would cause "VideoFrame has been closed"
        // errors on subsequent draws since getVideoFrame() returns the same frame.
      }
    }
  }
  
  renderLoopId = requestAnimationFrame(renderLoop);
}

function startRenderLoop() {
  if (renderLoopId === null) {
    renderLoopId = requestAnimationFrame(renderLoop);
  }
}

function stopRenderLoop() {
  if (renderLoopId !== null) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }
}

// ============================================================================
// Join/Leave
// ============================================================================

async function joinRoom() {
  const relayUrl = relayUrlInput.value.trim();
  const roomName = roomNameInput.value.trim() || 'lobby';
  const userName = userNameInput.value.trim() || 'Anonymous';
  
  if (!relayUrl) {
    alert('Please enter a relay URL');
    return;
  }
  
  const userId = generateUserId();
  const namespace = `${roomName}/user/${userId}`;
  
  localState = {
    userId,
    userName,
    roomName,
    relayUrl,
    namespace,
    videoMuted: false,
    audioMuted: false,
  };
  
  // Hide modal, show main UI
  joinModal.style.display = 'none';
  mainHeader.style.display = 'flex';
  mainContainer.style.display = 'flex';
  displayRoomName.textContent = roomName;
  
  // Create local video tile
  localVideoElement = createVideoTileForLocal(userId, userName);
  updateUserCount();
  
  // Start render loop for remote users
  startRenderLoop();
  
  // Enable chat
  chatInput.disabled = false;
  btnSendChat.disabled = false;
  
  addSystemMessage(`You joined room "${roomName}" as ${userName}`);
  
  try {
    // Start broadcasting our streams
    await startBroadcasting();
    
    // Start discovering other users
    await startDiscovery();
    
    await startCapturing();
    
  } catch (error) {
    console.error('Failed to join:', error);
    addSystemMessage(`Error: ${error}`);
  }
}

async function leaveRoom() {
  // Stop render loop
  stopRenderLoop();
  
  // Stop capture
  if (capture) {
    await capture.stop();
    capture = null;
  }
  
  // Disconnect broadcaster
  if (broadcaster) {
    broadcaster.dispose();
    broadcaster = null;
  }
  
  // Disconnect discovery subscriber
  if (discoverySubscriber) {
    discoverySubscriber.dispose();
    discoverySubscriber = null;
  }
  
  // Remove all remote users
  for (const userId of remoteUsers.keys()) {
    removeRemoteUser(userId);
  }
  
  // Clear local video
  if (localVideoElement) {
    localVideoElement.srcObject = null;
  }
  videoGrid.innerHTML = '';
  
  // Clear chat
  chatMessages.innerHTML = '';
  chatHistory.length = 0;
  
  // Reset state
  localState = null;
  
  // Show modal again
  mainHeader.style.display = 'none';
  mainContainer.style.display = 'none';
  joinModal.style.display = 'flex';
}

// ============================================================================
// UI Controls
// ============================================================================

function toggleVideo() {
  if (!localState || !capture) return;
  
  localState.videoMuted = !localState.videoMuted;
  
  const stream = capture.getMediaStream();
  if (stream) {
    stream.getVideoTracks().forEach(track => {
      track.enabled = !localState!.videoMuted;
    });
  }
  
  btnToggleVideo.classList.toggle('muted', localState.videoMuted);
  btnToggleVideo.textContent = localState.videoMuted ? '📹 Video Off' : '📹 Video';
}

function toggleMic() {
  if (!localState || !capture) return;
  
  localState.audioMuted = !localState.audioMuted;
  
  const stream = capture.getMediaStream();
  if (stream) {
    stream.getAudioTracks().forEach(track => {
      track.enabled = !localState!.audioMuted;
    });
  }
  
  btnToggleMic.classList.toggle('muted', localState.audioMuted);
  btnToggleMic.textContent = localState.audioMuted ? '🎤 Muted' : '🎤 Mic';
}

function handleChatSubmit() {
  const text = chatInput.value.trim();
  if (text && localState) {
    sendChatMessage(text);
    chatInput.value = '';
  }
}

// ============================================================================
// Event Listeners
// ============================================================================

btnJoin.addEventListener('click', joinRoom);
btnLeave.addEventListener('click', leaveRoom);
btnToggleVideo.addEventListener('click', toggleVideo);
btnToggleMic.addEventListener('click', toggleMic);
btnSendChat.addEventListener('click', handleChatSubmit);

chatInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    handleChatSubmit();
  }
});

// Allow joining with Enter key
userNameInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    joinRoom();
  }
});

// Generate random username on load
userNameInput.value = `User_${generateUserId().substring(0, 4)}`;

console.log('[Chat Demo] Initialized');
