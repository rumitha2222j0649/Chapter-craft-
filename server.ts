import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import JSZip from 'jszip';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CONSTRAINT_DECK,
  type AlternateDraft,
  type BranchSubmission,
  type ClientMessage,
  type ConstraintCard,
  type GameMode,
  type GenreId,
  type Passage,
  type Player,
  type RoomSummary,
  type ServerMessage,
  type StoryRoom,
} from './src/shared/types.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname);
const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
const ARCHIVE_FILE = path.resolve(DATA_DIR, 'archive.json');
const PORT = Number(process.env.PORT) || 3000;

const VALID_GENRES: GenreId[] = [
  'clockwork_mystery',
  'starlight_odyssey',
  'verdant_folklore',
  'coastal_noir',
];

const VALID_MODES: GameMode[] = ['relay', 'branch'];
const VALID_TIMERS = new Set([0, 60, 90, 120, 180]);

const rooms = new Map<string, StoryRoom>();
const roomSubscribers = new Map<string, Set<WebSocket>>();
const socketIdentity = new WeakMap<WebSocket, { roomCode: string; playerId: string }>();

async function ensureDataDir(): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function loadArchive(): Promise<StoryRoom[]> {
  try {
    const raw = await fsp.readFile(ARCHIVE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoryRoom[]) : [];
  } catch {
    return [];
  }
}

async function saveToArchive(room: StoryRoom): Promise<void> {
  await ensureDataDir();
  const existing = await loadArchive();
  const filtered = existing.filter((item) => item.code !== room.code);
  const snapshot: StoryRoom = structuredClone(room);
  const next = [snapshot, ...filtered].slice(0, 50);
  await fsp.writeFile(ARCHIVE_FILE, JSON.stringify(next, null, 2), 'utf8');
}

function generateRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function pickConstraint(excludeId?: string): ConstraintCard {
  const pool = excludeId
    ? CONSTRAINT_DECK.filter((c) => c.id !== excludeId)
    : CONSTRAINT_DECK;
  return pool[crypto.randomInt(0, pool.length)];
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function sanitizeText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').trim().slice(0, maxLen);
}

function sendSocket(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastRoom(room: StoryRoom): void {
  const subs = roomSubscribers.get(room.code);
  if (!subs) return;
  const payload = JSON.stringify({
    type: 'room:state',
    payload: { room },
  } satisfies ServerMessage);

  for (const client of subs) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function dealTurnConstraints(room: StoryRoom): void {
  if (room.mode === 'relay') {
    const activePlayer = room.players[room.currentTurnIndex % room.players.length];
    if (activePlayer) {
      room.activeConstraints = {
        [activePlayer.id]: pickConstraint(),
      };
      room.constraintRerollsUsed = {
        [activePlayer.id]: false,
      };
    }
  } else {
    const nextConstraints: Record<string, ConstraintCard> = {};
    const nextRerolls: Record<string, boolean> = {};
    for (const p of room.players) {
      nextConstraints[p.id] = pickConstraint();
      nextRerolls[p.id] = false;
    }
    room.activeConstraints = nextConstraints;
    room.constraintRerollsUsed = nextRerolls;
  }
}

function resolveVotingRound(room: StoryRoom): void {
  if (room.phase !== 'VOTING' || room.submissions.length === 0) return;

  const sorted = [...room.submissions].sort((a, b) => {
    if (b.voterIds.length !== a.voterIds.length) {
      return b.voterIds.length - a.voterIds.length;
    }
    return a.submittedAt.localeCompare(b.submittedAt);
  });

  const winner = sorted[0];
  const alternates: AlternateDraft[] = sorted.slice(1).map((sub) => ({
    id: sub.id,
    authorId: sub.authorId,
    authorName: sub.authorName,
    text: sub.text,
    wordCount: sub.wordCount,
    votes: sub.voterIds.length,
    constraintUsed: sub.constraintUsed,
  }));

  const chapterNumber = room.passages.length + 1;
  const constraintCard = room.activeConstraints[winner.authorId];
  const constraintBonus = winner.constraintUsed && constraintCard ? constraintCard.bonusPoints : 0;

  const passage: Passage = {
    id: crypto.randomUUID(),
    chapterNumber,
    authorId: winner.authorId,
    authorName: winner.authorName,
    text: winner.text,
    wordCount: winner.wordCount,
    createdAt: new Date().toISOString(),
    constraintUsed: winner.constraintUsed,
    constraintBonus,
    votes: winner.voterIds.length,
    reactions: { applause: 0, bookmark: 0 },
    alternates,
  };

  room.passages.push(passage);

  for (const sub of room.submissions) {
    const player = room.players.find((p) => p.id === sub.authorId);
    if (!player) continue;
    player.wordsWritten += sub.wordCount;
    player.score += sub.voterIds.length * 15;
    if (sub.id === winner.id) {
      player.score += 25 + constraintBonus;
      if (constraintBonus > 0) player.constraintsMet += 1;
    }
  }

  room.submissions = [];
  room.typingPlayerIds = [];
  room.updatedAt = new Date().toISOString();

  if (room.passages.length >= room.maxChapters) {
    room.phase = 'COMPLETE';
    room.turnDeadline = null;
    void saveToArchive(room);
  } else {
    room.phase = 'WRITING';
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
    room.turnDeadline = room.turnSeconds > 0 ? Date.now() + room.turnSeconds * 1000 : null;
    dealTurnConstraints(room);
  }
}

function advanceTimedOutRelay(room: StoryRoom): void {
  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
  room.turnDeadline = room.turnSeconds > 0 ? Date.now() + room.turnSeconds * 1000 : null;
  room.typingPlayerIds = [];
  room.updatedAt = new Date().toISOString();
  dealTurnConstraints(room);
}

// Server-authoritative deadline sweep every second
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (!room.turnDeadline) continue;
    if (now < room.turnDeadline) continue;

    if (room.phase === 'WRITING' && room.mode === 'relay') {
      advanceTimedOutRelay(room);
      broadcastRoom(room);
    } else if (room.phase === 'WRITING' && room.mode === 'branch') {
      if (room.submissions.length > 0) {
        room.phase = 'VOTING';
        room.turnDeadline = room.turnSeconds > 0 ? now + 60 * 1000 : null;
        broadcastRoom(room);
      } else {
        room.turnDeadline = room.turnSeconds > 0 ? now + room.turnSeconds * 1000 : null;
        broadcastRoom(room);
      }
    } else if (room.phase === 'VOTING') {
      resolveVotingRound(room);
      broadcastRoom(room);
    }
  }
}, 1000);

function handleSocketMessage(ws: WebSocket, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    sendSocket(ws, { type: 'room:error', payload: { message: 'Invalid message format.' } });
    return;
  }

  if (!msg || typeof msg !== 'object' || !('type' in msg)) return;

  switch (msg.type) {
    case 'room:create': {
      const playerName = sanitizeText(msg.payload.playerName, 32) || 'Host Writer';
      const title = sanitizeText(msg.payload.title, 80) || 'Untitled Chronicle';
      const genre = VALID_GENRES.includes(msg.payload.genre)
        ? msg.payload.genre
        : 'clockwork_mystery';
      const mode = VALID_MODES.includes(msg.payload.mode) ? msg.payload.mode : 'relay';
      const maxChapters = Math.min(20, Math.max(2, Number(msg.payload.maxChapters) || 6));
      const turnSeconds = VALID_TIMERS.has(Number(msg.payload.turnSeconds))
        ? Number(msg.payload.turnSeconds)
        : 90;
      const premise =
        sanitizeText(msg.payload.premise, 500) ||
        'A locked study, a warm teacup, and a map whose ink is still drying.';
      const localPassAndPlay = Boolean(msg.payload.localPassAndPlay);

      const code = generateRoomCode();
      const hostId = crypto.randomUUID();
      const nowIso = new Date().toISOString();

      const players: Player[] = [
        {
          id: hostId,
          name: playerName,
          seatOrder: 0,
          score: 0,
          wordsWritten: 0,
          constraintsMet: 0,
          connected: true,
          isHost: true,
        },
      ];

      if (localPassAndPlay && Array.isArray(msg.payload.localSeats)) {
        const extraSeats = msg.payload.localSeats
          .map((s) => sanitizeText(s, 32))
          .filter(Boolean)
          .slice(0, 5);
        extraSeats.forEach((seatName, idx) => {
          players.push({
            id: crypto.randomUUID(),
            name: seatName,
            seatOrder: idx + 1,
            score: 0,
            wordsWritten: 0,
            constraintsMet: 0,
            connected: true,
            isHost: false,
            isLocalSeat: true,
          });
        });
      }

      const room: StoryRoom = {
        code,
        title,
        genre,
        mode,
        maxChapters,
        turnSeconds,
        premise,
        phase: 'LOBBY',
        players,
        hostId,
        currentTurnIndex: 0,
        turnDeadline: null,
        activeConstraints: {},
        constraintRerollsUsed: {},
        passages: [],
        submissions: [],
        typingPlayerIds: [],
        localPassAndPlay,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      rooms.set(code, room);
      if (!roomSubscribers.has(code)) roomSubscribers.set(code, new Set());
      roomSubscribers.get(code)!.add(ws);
      socketIdentity.set(ws, { roomCode: code, playerId: hostId });

      sendSocket(ws, {
        type: 'room:joined',
        payload: { room, selfId: hostId },
      });
      break;
    }

    case 'room:join': {
      const code = sanitizeText(msg.payload.code, 10).toUpperCase();
      const playerName = sanitizeText(msg.payload.playerName, 32) || 'Guest Writer';
      const room = rooms.get(code);
      if (!room) {
        sendSocket(ws, {
          type: 'room:error',
          payload: { message: `Room ${code} was not found or has ended.` },
        });
        return;
      }

      // Check reconnection by existing playerId
      let player = msg.payload.playerId
        ? room.players.find((p) => p.id === msg.payload.playerId)
        : undefined;

      if (player) {
        player.connected = true;
      } else {
        if (room.players.length >= 8) {
          sendSocket(ws, {
            type: 'room:error',
            payload: { message: 'This writing table is full (maximum 8 writers).' },
          });
          return;
        }
        const playerId = crypto.randomUUID();
        player = {
          id: playerId,
          name: playerName,
          seatOrder: room.players.length,
          score: 0,
          wordsWritten: 0,
          constraintsMet: 0,
          connected: true,
          isHost: false,
        };
        room.players.push(player);
        if (room.phase === 'WRITING' && room.mode === 'branch') {
          room.activeConstraints[player.id] = pickConstraint();
          room.constraintRerollsUsed[player.id] = false;
        }
      }

      room.updatedAt = new Date().toISOString();
      if (!roomSubscribers.has(code)) roomSubscribers.set(code, new Set());
      roomSubscribers.get(code)!.add(ws);
      socketIdentity.set(ws, { roomCode: code, playerId: player.id });

      sendSocket(ws, {
        type: 'room:joined',
        payload: { room, selfId: player.id },
      });
      broadcastRoom(room);
      break;
    }

    case 'room:leave': {
      const code = sanitizeText(msg.payload.code, 10).toUpperCase();
      const room = rooms.get(code);
      if (!room) return;
      const player = room.players.find((p) => p.id === msg.payload.playerId);
      if (player) {
        player.connected = false;
      }
      room.typingPlayerIds = room.typingPlayerIds.filter((id) => id !== msg.payload.playerId);
      roomSubscribers.get(code)?.delete(ws);
      socketIdentity.delete(ws);
      broadcastRoom(room);
      break;
    }

    case 'seat:add': {
      const code = sanitizeText(msg.payload.code, 10).toUpperCase();
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostId !== msg.payload.playerId) {
        sendSocket(ws, { type: 'room:error', payload: { message: 'Only the host can add table seats.' } });
        return;
      }
      if (room.players.length >= 8) {
        sendSocket(ws, { type: 'room:error', payload: { message: 'Maximum 8 writers per story.' } });
        return;
      }
      const seatName = sanitizeText(msg.payload.seatName, 32);
      if (!seatName) return;
      const seatId = crypto.randomUUID();
      room.players.push({
        id: seatId,
        name: seatName,
        seatOrder: room.players.length,
        score: 0,
        wordsWritten: 0,
        constraintsMet: 0,
        connected: true,
        isHost: false,
        isLocalSeat: true,
      });
      room.localPassAndPlay = true;
      if (room.phase === 'WRITING' && room.mode === 'branch') {
        room.activeConstraints[seatId] = pickConstraint();
        room.constraintRerollsUsed[seatId] = false;
      }
      room.updatedAt = new Date().toISOString();
      broadcastRoom(room);
      break;
    }

    case 'game:start': {
      const code = sanitizeText(msg.payload.code, 10).toUpperCase();
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostId !== msg.payload.playerId) {
        sendSocket(ws, { type: 'room:error', payload: { message: 'Only the host can start the story.' } });
        return;
      }
      if (room.phase !== 'LOBBY') return;

      room.phase = 'WRITING';
      room.currentTurnIndex = 0;
      room.turnDeadline = room.turnSeconds > 0 ? Date.now() + room.turnSeconds * 1000 : null;
      room.updatedAt = new Date().toISOString();
      dealTurnConstraints(room);
      broadcastRoom(room);
      break;
    }

    case 'turn:reroll_constraint': {
      const code = sanitizeText(msg.payload.code, 10).toUpperCase();
      const room = rooms.get(code);
      if (!room || room.phase !== 'WRITING') return;
      const actorId =
        room.localPassAndPlay && msg.payload.seatId && room.hostId === msg.payload.playerId
          ? msg.payload.seatId
          : msg.payload.playerId;

      if (room.constraintRerollsUsed[actorId]) {
        sendSocket(ws, {
          type: 'room:error',
          payload: { message: 'You already drew a replacement card this turn.' },
        });
        return;
      }
      const current = room.activeConstraints[actorId];
      if (!current) return;
      room.activeConstraints[actorId] = pickConstraint(current.id);
      room.constraintRerollsUsed[actorId] = true;
      room.updatedAt = new Date().toISOString();
      broadcastRoom(room);
      break;
    }

    case 'turn:typing': {
      const code = sanitizeText(msg.payload.code, 10).toUpperCase();
      const room = rooms.get(code);
      if (!room || room.phase !== 'WRITING') return;
      const pid = msg.payload.playerId;
      if (msg.payload.isTyping) {
        if (!room.typingPlayerIds.includes(pid)) {
          room.typingPlayerIds.push(pid);
          broadcastRoom(room);
        }
      } else if (room.typingPlayerIds.includes(pid)) {
        room.typingPlayerIds = room.typingPlayerIds.filter((id) => id !== pid);
        broadcastRoom(room);
      }
      break;
    }

    case 'turn:submit': {
      const code = sanitizeText(msg.payload.code, 10).toUpperCase();
      const room = rooms.get(code);
      if (!room || room.phase !== 'WRITING') return;

      const text = sanitizeText(msg.payload.text, 2200);
      if (text.length < 10) {
        sendSocket(ws, {
          type: 'room:error',
          payload: { message: 'Please write at least a couple of sentences (10+ characters).' },
        });
        return;
      }

      const actorId =
        room.localPassAndPlay && msg.payload.seatId && room.hostId === msg.payload.playerId
          ? msg.payload.seatId
          : msg.payload.playerId;

      const actor = room.players.find((p) => p.id === actorId);
      if (!actor) return;

      const wordCount = countWords(text);
      const card = room.activeConstraints[actorId];
      const constraintUsed = msg.payload.claimedConstraint && card ? card.text : undefined;
      const constraintBonus = msg.payload.claimedConstraint && card ? card.bonusPoints : 0;

      if (room.mode === 'relay') {
        const expectedAuthor = room.players[room.currentTurnIndex % room.players.length];
        if (!expectedAuthor || expectedAuthor.id !== actorId) {
          sendSocket(ws, {
            type: 'room:error',
            payload: { message: `It is currently ${expectedAuthor?.name ?? 'another writer'}'s turn.` },
          });
          return;
        }

        const chapterNumber = room.passages.length + 1;
        room.passages.push({
          id: crypto.randomUUID(),
          chapterNumber,
          authorId: actor.id,
          authorName: actor.name,
          text,
          wordCount,
          createdAt: new Date().toISOString(),
          constraintUsed,
          constraintBonus,
          votes: 0,
          reactions: { applause: 0, bookmark: 0 },
        });

        actor.wordsWritten += wordCount;
        actor.score += 20 + constraintBonus;
        if (constraintBonus > 0) actor.constraintsMet += 1;

        room.typingPlayerIds = [];
        room.updatedAt = new Date().toISOString();

        if (room.passages.length >= room.maxChapters) {
          room.phase = 'COMPLETE';
          room.turnDeadline = null;
          void saveToArchive(room);
        } else {
          room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
          room.turnDeadline = room.turnSeconds > 0 ? Date.now() + room.turnSeconds * 1000 : null;
          dealTurnConstraints(room);
        }

        broadcastRoom(room);
      } else {
        // Forking Paths (simultaneous branch drafting)
        const alreadySubmitted = room.submissions.some((s) => s.authorId === actorId);
        if (alreadySubmitted) {
          sendSocket(ws, {
            type: 'room:error',
            payload: { message: 'You have already locked in a draft for this round.' },
          });
          return;
        }

        room.submissions.push({
          id: crypto.randomUUID(),
          authorId: actor.id,
          authorName: actor.name,
          text,
          wordCount,
          constraintUsed,
          voterIds: [],
          submittedAt: new Date().toISOString(),
        });

        room.typingPlayerIds = room.typingPlayerIds.filter((id) => id !== actorId);
        room.updatedAt = new Date().toISOString();

        const activeWriters = room.players.filter((p) => p.connected || p.isLocalSeat);
        if (room.submissions.length >= Math.max(1, activeWriters.length)) {
          if (room.submissions.length === 1) {
            // Single writer: auto-promote immediately
            room.phase = 'VOTING';
            room.submissions[0].voterIds.push(actor.id);
            resolveVotingRound(room);
          } else {
            room.phase = 'VOTING';
            room.turnDeadline = room.turnSeconds > 0 ? Date.now() + 60 * 1000 : null;
          }
        }

        broadcastRoom(room);
      }
      break;
    }

    case 'branch:vote': {
      const code = sanitizeText(msg.payload.code, 10).toUpperCase();
      const room = rooms.get(code);
      if (!room || room.phase !== 'VOTING') return;

      const voterId =
        room.localPassAndPlay && msg.payload.voterSeatId && room.hostId === msg.payload.playerId
          ? msg.payload.voterSeatId
          : msg.payload.playerId;

      const target = room.submissions.find((s) => s.id === msg.payload.submissionId);
      if (!target) return;

      // Remove prior vote by this voter in the round
      for (const sub of room.submissions) {
        sub.voterIds = sub.voterIds.filter((id) => id !== voterId);
      }
      target.voterIds.push(voterId);
      room.updatedAt = new Date().toISOString();

      const totalVotes = room.submissions.reduce((acc, s) => acc + s.voterIds.length, 0);
      const activeVoters = room.players.filter((p) => p.connected || p.isLocalSeat).length;
      if (totalVotes >= Math.max(1, activeVoters)) {
        resolveVotingRound(room);
      }

      broadcastRoom(room);
      break;
    }

    case 'passage:react': {
      const code = sanitizeText(msg.payload.code, 10).toUpperCase();
      const room = rooms.get(code);
      if (!room) return;
      const passage = room.passages.find((p) => p.id === msg.payload.passageId);
      if (!passage) return;
      if (msg.payload.kind === 'applause') {
        passage.reactions.applause += 1;
      } else if (msg.payload.kind === 'bookmark') {
        passage.reactions.bookmark += 1;
      }
      room.updatedAt = new Date().toISOString();
      broadcastRoom(room);
      break;
    }

    case 'game:finish': {
      const code = sanitizeText(msg.payload.code, 10).toUpperCase();
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostId !== msg.payload.playerId) return;
      room.phase = 'COMPLETE';
      room.turnDeadline = null;
      room.typingPlayerIds = [];
      room.updatedAt = new Date().toISOString();
      if (room.passages.length > 0) {
        void saveToArchive(room);
      }
      broadcastRoom(room);
      break;
    }

    case 'game:restart': {
      const code = sanitizeText(msg.payload.code, 10).toUpperCase();
      const room = rooms.get(code);
      if (!room) return;
      if (room.hostId !== msg.payload.playerId) return;

      if (msg.payload.newPremise) {
        room.premise = sanitizeText(msg.payload.newPremise, 500) || room.premise;
      }
      room.phase = 'WRITING';
      room.passages = [];
      room.submissions = [];
      room.typingPlayerIds = [];
      room.currentTurnIndex = 0;
      room.turnDeadline = room.turnSeconds > 0 ? Date.now() + room.turnSeconds * 1000 : null;
      for (const p of room.players) {
        p.score = 0;
        p.wordsWritten = 0;
        p.constraintsMet = 0;
      }
      room.updatedAt = new Date().toISOString();
      dealTurnConstraints(room);
      broadcastRoom(room);
      break;
    }
  }
}

async function addDirectoryToZip(zip: JSZip, dirPath: string, zipBase: string): Promise<void> {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === '.env' ||
      entry.name.startsWith('.env.local') ||
      entry.name === 'data' ||
      entry.name.endsWith('.zip')
    ) {
      continue;
    }
    const fullPath = path.resolve(dirPath, entry.name);
    if (!fullPath.startsWith(PROJECT_ROOT + path.sep)) continue;

    const relZipPath = zipBase ? `${zipBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, fullPath, relZipPath);
    } else if (entry.isFile()) {
      const content = await fsp.readFile(fullPath);
      zip.file(relZipPath, content);
    }
  }
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, activeRooms: rooms.size });
  });

  app.get('/api/rooms', (_req, res) => {
    const summaries: RoomSummary[] = [];
    for (const room of rooms.values()) {
      if (room.localPassAndPlay && room.phase !== 'COMPLETE') continue;
      summaries.push({
        code: room.code,
        title: room.title,
        genre: room.genre,
        mode: room.mode,
        phase: room.phase,
        playerCount: room.players.length,
        chapterCount: room.passages.length,
        maxChapters: room.maxChapters,
        localPassAndPlay: room.localPassAndPlay,
        updatedAt: room.updatedAt,
      });
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json(summaries);
  });

  app.get('/api/archive', async (_req, res) => {
    const archive = await loadArchive();
    res.json(archive);
  });

  app.get('/api/archive/:code', async (req, res) => {
    const code = sanitizeText(req.params.code, 10).toUpperCase();
    const live = rooms.get(code);
    if (live) {
      res.json(live);
      return;
    }
    const archive = await loadArchive();
    const found = archive.find((item) => item.code === code);
    if (!found) {
      res.status(404).json({ error: 'Story not found' });
      return;
    }
    res.json(found);
  });

  app.get('/api/project-zip', async (_req, res) => {
    try {
      const zip = new JSZip();
      await addDirectoryToZip(zip, PROJECT_ROOT, 'chaptercraft');
      const buffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="chaptercraft-project-build.zip"'
      );
      res.send(buffer);
    } catch (err) {
      console.error('Failed to build project zip:', err);
      res.status(500).json({ error: 'Could not generate project archive' });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      handleSocketMessage(ws, data.toString());
    });

    ws.on('close', () => {
      const identity = socketIdentity.get(ws);
      if (!identity) return;
      const room = rooms.get(identity.roomCode);
      if (room) {
        const player = room.players.find((p) => p.id === identity.playerId);
        if (player) {
          player.connected = false;
        }
        room.typingPlayerIds = room.typingPlayerIds.filter((id) => id !== identity.playerId);
        broadcastRoom(room);
      }
      roomSubscribers.get(identity.roomCode)?.delete(ws);
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(PROJECT_ROOT, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.resolve(distDir, 'index.html'));
      });
    }
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Chaptercraft server listening on http://localhost:${PORT}`);
  });
}

void startServer();
