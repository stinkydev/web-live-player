/**
 * Chat Demo - Showcasing web-live-player library
 * 
 * A simple multi-user video chat using MoQ transport.
 * Demonstrates: MediaCapture, MoQCaptureSink, LiveVideoPlayer, MoQSource
 */

import type { MoqSessionSubscriber, MoQSessionConfig } from 'stinky-moq-js';
import {
  MediaCapture,
  MoQCaptureSink,
  LiveVideoPlayer,
  MoQSource,
  CodecType,
  type MediaCaptureConfig,
  type StreamDataEvent,
} from '../../index';

// ============================================================================
// Types
// ============================================================================

interface ChatMessage {
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
}

interface RemoteUser {
  id: string;
  name: string;
  player: LiveVideoPlayer;
  source: MoQSource;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

// ============================================================================
// App State
// ============================================================================

let userId = crypto.randomUUID().slice(0, 8);
let userName = `User_${userId.slice(0, 4)}`;
let roomName = 'lobby';
let relayUrl = '';

let captureSink: MoQCaptureSink | null = null;
let capture: MediaCapture | null = null;
let discoverer: MoqSessionSubscriber | null = null;

const remoteUsers = new Map<string, RemoteUser>();
let animationId: number | null = null;

// ============================================================================
// DOM
// ============================================================================

const $ = (id: string) => document.getElementById(id)!;
const joinModal = $('joinModal');
const mainHeader = $('mainHeader');
const mainContainer = $('mainContainer');
const videoGrid = $('videoGrid');
const chatBox = $('chatMessages');
const chatInput = $('chatInput') as HTMLInputElement;

// ============================================================================
// UI Helpers
// ============================================================================

function showMain() {
  joinModal.style.display = 'none';
  mainHeader.style.display = 'flex';
  mainContainer.style.display = 'flex';
  $('displayRoomName').textContent = roomName;
  chatInput.disabled = false;
  ($('btnSendChat') as HTMLButtonElement).disabled = false;
}

function addChat(msg: ChatMessage, isOwn: boolean) {
  const div = document.createElement('div');
  div.className = `chat-message${isOwn ? ' own' : ''}`;
  div.innerHTML = `
    <b>${isOwn ? 'You' : msg.userName}:</b> ${msg.text}
    <small>${new Date(msg.timestamp).toLocaleTimeString()}</small>
  `;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function addSystem(text: string) {
  const div = document.createElement('div');
  div.className = 'system-message';
  div.textContent = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function createLocalVideo(): HTMLVideoElement {
  const tile = document.createElement('div');
  tile.className = 'video-tile local';
  
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  
  const label = document.createElement('div');
  label.className = 'user-label local';
  label.textContent = `${userName} (You)`;
  
  tile.append(video, label);
  videoGrid.appendChild(tile);
  return video;
}

function createRemoteCanvas(id: string, name: string): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${id}`;
  
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.objectFit = 'cover';
  
  const label = document.createElement('div');
  label.className = 'user-label';
  label.textContent = name;
  
  tile.append(canvas, label);
  videoGrid.appendChild(tile);
  
  return { canvas, ctx: canvas.getContext('2d')! };
}

// ============================================================================
// Core: Publishing with MoQCaptureSink + MediaCapture
// ============================================================================

async function startPublishing() {
  const namespace = `${roomName}/user/${userId}`;
  
  // Create MoQ sink using the library
  captureSink = new MoQCaptureSink({
    relayUrl,
    namespace,
    videoTrack: { trackName: 'video' },
    audioTrack: { trackName: 'audio' },
    dataTracks: [{ trackName: 'chat' }],
  });
  
  await captureSink.connect();
  console.log('Publishing to:', namespace);
  
  // Configure capture using the library
  const config: MediaCaptureConfig = {
    sink: captureSink,
    video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } },
    audio: { sampleRate: { ideal: 48000 }, channelCount: { ideal: 1 } },
    videoEncoder: {
      codec: CodecType.VIDEO_VP8,
      width: 320,
      height: 240,
      frameRate: 15,
      bitrate: 200_000,
      keyFrameInterval: 15,
      latencyMode: 'realtime',
    },
    audioEncoder: {
      codec: CodecType.AUDIO_OPUS,
      sampleRate: 48000,
      channels: 1,
      bitrate: 32_000,
      latencyMode: 'realtime',
    },
  };
  
  capture = new MediaCapture(config);
  await capture.start();
  
  // Show local preview
  const video = createLocalVideo();
  video.srcObject = capture.getMediaStream()!;
}

// ============================================================================
// Core: Discovery & Subscription with LiveVideoPlayer
// ============================================================================

async function startDiscovery() {
  const { MoqSessionSubscriber } = await import('stinky-moq-js');
  
  const config: MoQSessionConfig = {
    relayUrl,
    namespace: roomName,
    discoveryOnly: true,
    reconnection: { delay: 3000 },
  };
  
  discoverer = new MoqSessionSubscriber(config, []);
  
  discoverer.on('broadcastAnnounced', async (ann: { path: string; active: boolean }) => {
    const match = ann.path.match(/^([^/]+)\/user\/([^/]+)$/);
    if (!match || match[1] !== roomName || match[2] === userId) return;
    
    const remoteId = match[2];
    
    if (ann.active && !remoteUsers.has(remoteId)) {
      await subscribeToUser(remoteId, ann.path);
    } else if (!ann.active && remoteUsers.has(remoteId)) {
      removeUser(remoteId);
    }
  });
  
  await discoverer.connect();
  console.log('Discovering users in:', roomName);
}

async function subscribeToUser(id: string, namespace: string) {
  const { canvas, ctx } = createRemoteCanvas(id, id);
  
  // Use library's MoQSource with video, audio, and chat tracks
  const source = new MoQSource({
    relayUrl,
    namespace,
    subscriptions: [
      { trackName: 'video', streamType: 'video', priority: 1 },
      { trackName: 'audio', streamType: 'audio', priority: 2 },
      { trackName: 'chat', streamType: 'data', priority: 3 },
    ],
    reconnectionDelay: 3000,
  });
  
  // Listen for chat messages on the data track
  source.on('data', (event: StreamDataEvent) => {
    if (event.trackName === 'chat' && event.data.payload) {
      try {
        const msg = JSON.parse(new TextDecoder().decode(event.data.payload)) as ChatMessage;
        // Update name from chat
        const user = remoteUsers.get(id);
        if (user && msg.userName) {
          user.name = msg.userName;
          const label = document.querySelector(`#tile-${id} .user-label`);
          if (label) label.textContent = msg.userName;
        }
        addChat(msg, false);
      } catch {}
    }
  });
  
  await source.connect();
  
  // Create player using the library
  const player = new LiveVideoPlayer({
    enableAudio: true,
    videoTrackName: 'video',
    audioTrackName: 'audio',
    bufferDelayMs: 100,
  });
  
  player.setStreamSource(source);
  player.play();
  
  remoteUsers.set(id, { id, name: id, player, source, canvas, ctx });
  addSystem(`${id} joined`);
  updateUserCount();
}

function removeUser(id: string) {
  const user = remoteUsers.get(id);
  if (!user) return;
  
  user.player.dispose();
  user.source.dispose();
  document.getElementById(`tile-${id}`)?.remove();
  remoteUsers.delete(id);
  addSystem(`${user.name} left`);
  updateUserCount();
}

function updateUserCount() {
  $('userCount').textContent = `${remoteUsers.size + 1} user${remoteUsers.size !== 0 ? 's' : ''}`;
}

// ============================================================================
// Render Loop
// ============================================================================

function renderLoop(ts: number) {
  for (const user of remoteUsers.values()) {
    const frame = user.player.getVideoFrame(ts);
    if (frame) {
      const w = (frame as any).displayWidth || (frame as any).width;
      const h = (frame as any).displayHeight || (frame as any).height;
      if (user.canvas.width !== w || user.canvas.height !== h) {
        user.canvas.width = w;
        user.canvas.height = h;
      }
      user.ctx.drawImage(frame, 0, 0);
    }
  }
  animationId = requestAnimationFrame(renderLoop);
}

// ============================================================================
// Chat
// ============================================================================

function sendChat(text: string) {
  if (!captureSink || !text.trim()) return;
  
  const msg: ChatMessage = { userId, userName, text: text.trim(), timestamp: Date.now() };
  captureSink.sendData('chat', new TextEncoder().encode(JSON.stringify(msg)));
  addChat(msg, true);
}

// ============================================================================
// Join / Leave
// ============================================================================

async function join() {
  relayUrl = (document.getElementById('relayUrl') as HTMLInputElement).value.trim();
  roomName = (document.getElementById('roomName') as HTMLInputElement).value.trim() || 'lobby';
  userName = (document.getElementById('userName') as HTMLInputElement).value.trim() || `User_${userId.slice(0, 4)}`;
  
  if (!relayUrl) {
    alert('Please enter a relay URL');
    return;
  }
  
  showMain();
  addSystem(`Joined "${roomName}" as ${userName}`);
  updateUserCount();
  
  animationId = requestAnimationFrame(renderLoop);
  
  await startPublishing();
  await startDiscovery();
}

async function leave() {
  if (animationId) cancelAnimationFrame(animationId);
  
  for (const id of remoteUsers.keys()) removeUser(id);
  
  capture?.stop();
  captureSink?.dispose();
  discoverer?.dispose();
  
  capture = null;
  captureSink = null;
  discoverer = null;
  
  videoGrid.innerHTML = '';
  chatBox.innerHTML = '';
  
  mainHeader.style.display = 'none';
  mainContainer.style.display = 'none';
  joinModal.style.display = 'flex';
}

// ============================================================================
// Controls
// ============================================================================

function toggleVideo() {
  const stream = capture?.getMediaStream();
  stream?.getVideoTracks().forEach(t => t.enabled = !t.enabled);
  const btn = $('btnToggleVideo');
  btn.classList.toggle('muted');
  btn.textContent = btn.classList.contains('muted') ? '📹 Off' : '📹 Video';
}

function toggleMic() {
  const stream = capture?.getMediaStream();
  stream?.getAudioTracks().forEach(t => t.enabled = !t.enabled);
  const btn = $('btnToggleMic');
  btn.classList.toggle('muted');
  btn.textContent = btn.classList.contains('muted') ? '🎤 Muted' : '🎤 Mic';
}

// ============================================================================
// Event Listeners
// ============================================================================

$('btnJoin').addEventListener('click', join);
$('btnLeave').addEventListener('click', leave);
$('btnToggleVideo').addEventListener('click', toggleVideo);
$('btnToggleMic').addEventListener('click', toggleMic);
$('btnSendChat').addEventListener('click', () => {
  sendChat(chatInput.value);
  chatInput.value = '';
});

chatInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    sendChat(chatInput.value);
    chatInput.value = '';
  }
});

(document.getElementById('userName') as HTMLInputElement).value = userName;

console.log('Chat demo ready - Powered by web-live-player');
