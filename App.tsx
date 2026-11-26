/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveView } from './components/ArchiveView.tsx';
import { CreateStoryModal, type CreateRoomPayload } from './components/CreateStoryModal.tsx';
import { GameTableView } from './components/GameTableView.tsx';
import { Header, type AppView } from './components/Header.tsx';
import { ProjectZipView } from './components/ProjectZipView.tsx';
import { RulesView } from './components/RulesView.tsx';
import { TitleLobbyView } from './components/TitleLobbyView.tsx';
import type {
  ClientMessage,
  GenreId,
  RoomSummary,
  ServerMessage,
  StoryRoom,
} from './shared/types.ts';
import { playChime } from './utils/sound.ts';

export default function App() {
  const [activeView, setActiveView] = useState<AppView>('lobby');
  const [createOpen, setCreateOpen] = useState(false);
  const [presetGenre, setPresetGenre] = useState<GenreId>('clockwork_mystery');

  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [archive, setArchive] = useState<StoryRoom[]>([]);
  const [loadingArchive, setLoadingArchive] = useState(false);

  const [activeRoom, setActiveRoom] = useState<StoryRoom | null>(null);
  const [selfId, setSelfId] = useState<string>('');
  const [penName, setPenName] = useState('Maya');
  const [wsConnected, setWsConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<ClientMessage[]>([]);
  const activeRoomRef = useRef<StoryRoom | null>(null);
  const selfIdRef = useRef<string>('');
  const mutedRef = useRef<boolean>(false);
  const penNameRef = useRef<string>('Maya');

  activeRoomRef.current = activeRoom;
  selfIdRef.current = selfId;
  mutedRef.current = muted;
  penNameRef.current = penName;

  const fetchRooms = useCallback(async () => {
    setLoadingRooms(true);
    try {
      const res = await fetch('/api/rooms');
      if (res.ok) {
        const data = (await res.json()) as RoomSummary[];
        setRooms(data);
      }
    } catch {
      // Transient fetch failure ignored
    } finally {
      setLoadingRooms(false);
    }
  }, []);

  const fetchArchive = useCallback(async () => {
    setLoadingArchive(true);
    try {
      const res = await fetch('/api/archive');
      if (res.ok) {
        const data = (await res.json()) as StoryRoom[];
        setArchive(data);
      }
    } catch {
      // Transient fetch failure ignored
    } finally {
      setLoadingArchive(false);
    }
  }, []);

  const sendWs = useCallback((msg: ClientMessage) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    } else {
      queueRef.current.push(msg);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        setWsConnected(true);
        // Re-join active room after reconnect
        if (activeRoomRef.current && selfIdRef.current) {
          socket.send(
            JSON.stringify({
              type: 'room:join',
              payload: {
                code: activeRoomRef.current.code,
                playerName: penNameRef.current,
                playerId: selfIdRef.current,
              },
            } satisfies ClientMessage)
          );
        }
        while (queueRef.current.length > 0) {
          const pending = queueRef.current.shift();
          if (pending) socket.send(JSON.stringify(pending));
        }
      };

      socket.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data as string) as ServerMessage;
        } catch {
          return;
        }

        if (msg.type === 'room:joined') {
          setErrorBanner(null);
          setSelfId(msg.payload.selfId);
          setActiveRoom(msg.payload.room);
          setActiveView('game');
          const nextUrl = new URL(window.location.href);
          nextUrl.searchParams.set('room', msg.payload.room.code);
          window.history.replaceState({}, '', nextUrl.toString());
        } else if (msg.type === 'room:state') {
          const prev = activeRoomRef.current;
          const next = msg.payload.room;
          if (prev && prev.code === next.code) {
            if (next.phase === 'COMPLETE' && prev.phase !== 'COMPLETE') {
              playChime('complete', mutedRef.current);
              void fetchArchive();
            } else if (next.passages.length > prev.passages.length) {
              playChime('submit', mutedRef.current);
            } else if (next.phase === 'VOTING' && prev.phase !== 'VOTING') {
              playChime('vote', mutedRef.current);
            }
          }
          setActiveRoom(next);
        } else if (msg.type === 'room:error') {
          setErrorBanner(msg.payload.message);
        }
      };

      socket.onclose = () => {
        if (disposed) return;
        setWsConnected(false);
        reconnectTimer = window.setTimeout(connect, 1800);
      };
    };

    connect();
    void fetchRooms();
    void fetchArchive();

    // Support ?room=CODE deep-link
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam && /^[A-Z0-9]{4,8}$/i.test(roomParam.trim())) {
      sendWs({
        type: 'room:join',
        payload: {
          code: roomParam.trim().toUpperCase(),
          playerName: 'Guest Writer',
        },
      });
    }

    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [fetchArchive, fetchRooms, sendWs]);

  const handleOpenCreate = (genre?: GenreId) => {
    if (genre) setPresetGenre(genre);
    setCreateOpen(true);
  };

  const handleCreateRoom = (payload: CreateRoomPayload) => {
    setPenName(payload.playerName);
    setCreateOpen(false);
    setErrorBanner(null);
    sendWs({
      type: 'room:create',
      payload,
    });
  };

  const handleJoinRoom = (code: string, playerName: string) => {
    setPenName(playerName);
    setErrorBanner(null);
    sendWs({
      type: 'room:join',
      payload: { code, playerName },
    });
  };

  const handleLeaveRoom = () => {
    if (activeRoom && selfId) {
      sendWs({
        type: 'room:leave',
        payload: { code: activeRoom.code, playerId: selfId },
      });
    }
    setActiveRoom(null);
    setSelfId('');
    setActiveView('lobby');
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('room');
    window.history.replaceState({}, '', nextUrl.toString());
    void fetchRooms();
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#FAF9F6] text-zinc-900">
      <Header
        activeView={activeView}
        hasActiveRoom={Boolean(activeRoom)}
        onNavigate={(view) => {
          setActiveView(view);
          if (view === 'lobby') void fetchRooms();
          if (view === 'archive') void fetchArchive();
        }}
        onOpenCreate={() => handleOpenCreate()}
      />

      {errorBanner && activeView !== 'game' && (
        <div className="mx-auto mt-6 w-full max-w-[1280px] px-6">
          <div
            role="alert"
            className="flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
          >
            <span>{errorBanner}</span>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="text-xs font-semibold underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="flex-1">
        {activeView === 'game' && activeRoom ? (
          <GameTableView
            room={activeRoom}
            selfId={selfId}
            wsConnected={wsConnected}
            muted={muted}
            errorBanner={errorBanner}
            onDismissError={() => setErrorBanner(null)}
            onToggleMute={() => setMuted((m) => !m)}
            onLeaveRoom={handleLeaveRoom}
            onStartGame={() =>
              sendWs({
                type: 'game:start',
                payload: { code: activeRoom.code, playerId: selfId },
              })
            }
            onAddLocalSeat={(seatName) =>
              sendWs({
                type: 'seat:add',
                payload: { code: activeRoom.code, playerId: selfId, seatName },
              })
            }
            onRerollConstraint={(seatId) => {
              playChime('card', muted);
              sendWs({
                type: 'turn:reroll_constraint',
                payload: { code: activeRoom.code, playerId: selfId, seatId },
              });
            }}
            onTyping={(isTyping) =>
              sendWs({
                type: 'turn:typing',
                payload: { code: activeRoom.code, playerId: selfId, isTyping },
              })
            }
            onSubmitPassage={(text, claimedConstraint, seatId) =>
              sendWs({
                type: 'turn:submit',
                payload: {
                  code: activeRoom.code,
                  playerId: selfId,
                  seatId,
                  text,
                  claimedConstraint,
                },
              })
            }
            onCastVote={(submissionId, voterSeatId) =>
              sendWs({
                type: 'branch:vote',
                payload: {
                  code: activeRoom.code,
                  playerId: selfId,
                  voterSeatId,
                  submissionId,
                },
              })
            }
            onReactPassage={(passageId, kind) =>
              sendWs({
                type: 'passage:react',
                payload: {
                  code: activeRoom.code,
                  playerId: selfId,
                  passageId,
                  kind,
                },
              })
            }
            onFinishEarly={() =>
              sendWs({
                type: 'game:finish',
                payload: { code: activeRoom.code, playerId: selfId },
              })
            }
            onRestartGame={(newPremise) =>
              sendWs({
                type: 'game:restart',
                payload: { code: activeRoom.code, playerId: selfId, newPremise },
              })
            }
          />
        ) : activeView === 'archive' ? (
          <ArchiveView
            stories={archive}
            loading={loadingArchive}
            onRefresh={() => void fetchArchive()}
            onStartStory={() => handleOpenCreate()}
          />
        ) : activeView === 'rules' ? (
          <RulesView onOpenCreate={() => handleOpenCreate()} />
        ) : activeView === 'zip' ? (
          <ProjectZipView />
        ) : (
          <TitleLobbyView
            rooms={rooms}
            loadingRooms={loadingRooms}
            onRefreshRooms={() => void fetchRooms()}
            onOpenCreate={handleOpenCreate}
            onJoinRoom={handleJoinRoom}
            defaultPlayerName={penName}
          />
        )}
      </div>

      <footer className="mt-16 border-t border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4 px-6 py-6 text-xs text-zinc-500">
          <span>Chaptercraft · Collaborative Fiction Tabletop</span>
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => setActiveView('archive')}
              className="hover:text-zinc-900 cursor-pointer"
            >
              Story Archive
            </button>
            <button
              type="button"
              onClick={() => setActiveView('rules')}
              className="hover:text-zinc-900 cursor-pointer"
            >
              Game Rules
            </button>
            <button
              type="button"
              onClick={() => setActiveView('zip')}
              className="hover:text-zinc-900 cursor-pointer"
            >
              Download Project Zip
            </button>
          </div>
        </div>
      </footer>

      <CreateStoryModal
        open={createOpen}
        initialGenre={presetGenre}
        defaultPlayerName={penName}
        onClose={() => setCreateOpen(false)}
        onCreate={handleCreateRoom}
      />
    </div>
  );
}
