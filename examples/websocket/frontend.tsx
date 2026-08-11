'use client';

import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';

type User = {
  id: string;
  username: string;
}

type Message = {
  id: string;
  username: string;
  content: string;
  timestamp: Date | string;
  type: 'user' | 'system';
}

type JoinAck = {
  ok: boolean;
  user?: User;
  users?: User[];
  error?: string;
}

export default function SocketDemo() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [username, setUsername] = useState('');
  const [isUsernameSet, setIsUsernameSet] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [users, setUsers] = useState<User[]>([]);

  useEffect(() => {
    // Connect to websocket server
    // Never use PORT in the URL, alyways use XTransformPort
    // DO NOT change the path, it is used by Caddy to forward the request to the correct port
    const socketInstance = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 10000
    })

    setSocket(socketInstance);

    socketInstance.on('connect', () => {
      setIsConnected(true);
    });

    socketInstance.on('disconnect', () => {
      setIsConnected(false);
      // Server drops the user on disconnect — require an explicit re-join
      setIsUsernameSet(false);
      setIsJoining(false);
      setUsers([]);
    });

    socketInstance.on('message', (msg: Message) => {
      setMessages(prev => [...prev, msg]);
    });

    socketInstance.on('user-joined', (data: { user: User; message: Message }) => {
      setMessages(prev => [...prev, data.message]);
      setUsers(prev => {
        if (!prev.find(u => u.id === data.user.id)) {
          return [...prev, data.user];
        }
        return prev;
      });
    });

    socketInstance.on('user-left', (data: { user: User; message: Message }) => {
      setMessages(prev => [...prev, data.message]);
      setUsers(prev => prev.filter(u => u.id !== data.user.id));
    });

    socketInstance.on('users-list', (data: { users: User[] }) => {
      setUsers(data.users);
    });

    // Server confirmation that this client is registered in users map
    socketInstance.on('join-success', (data: { user: User; users: User[] }) => {
      setUsers(data.users);
      setIsUsernameSet(true);
      setIsJoining(false);
      setJoinError(null);
    });

    return () => {
      socketInstance.disconnect();
    };
  }, []);

  const handleJoin = () => {
    if (!socket || !username.trim() || !isConnected || isJoining) return;

    setIsJoining(true);
    setJoinError(null);

    socket.timeout(8000).emit(
      'join',
      { username: username.trim() },
      (err: Error | null, res?: JoinAck) => {
        if (err) {
          setIsJoining(false);
          setJoinError(err.message || 'Join timed out — try again');
          return;
        }
        if (!res?.ok) {
          setIsJoining(false);
          setJoinError(res?.error || 'Join rejected by server');
          return;
        }
        // Prefer ack for confirmation; join-success listener is a backup
        if (res.users) setUsers(res.users);
        setIsUsernameSet(true);
        setIsJoining(false);
        setJoinError(null);
      },
    );
  };

  const sendMessage = () => {
    if (!socket || !isConnected || !isUsernameSet) return;
    if (!inputMessage.trim() || !username.trim()) return;

    socket.emit('message', {
      content: inputMessage.trim(),
      username: username.trim()
    });
    setInputMessage('');
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      sendMessage();
    }
  };

  return (
    <div className="container mx-auto p-4 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            WebSocket Demo
            <span className={`text-sm px-2 py-1 rounded ${isConnected ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isUsernameSet ? (
            <div className="space-y-2">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter') {
                    handleJoin();
                  }
                }}
                placeholder="Enter your username..."
                disabled={!isConnected || isJoining}
                className="flex-1"
              />
              <Button
                onClick={handleJoin}
                disabled={!isConnected || !username.trim() || isJoining}
                className="w-full"
              >
                {isJoining ? 'Joining…' : 'Join Chat'}
              </Button>
              {joinError && (
                <p className="text-sm text-red-600">{joinError}</p>
              )}
            </div>
          ) : (
            <>
              <ScrollArea className="h-80 w-full border rounded-md p-4">
                <div className="space-y-2">
                  {messages.length === 0 ? (
                    <p className="text-gray-500 text-center">No messages yet</p>
                  ) : (
                    messages.map((msg) => (
                      <div key={msg.id} className="border-b pb-2 last:border-b-0">
                        <div className="flex justify-between items-start">
                          <div className="flex-1">
                            <p className={`text-sm font-medium ${msg.type === 'system'
                                ? 'text-blue-600 italic'
                                : 'text-gray-700'
                              }`}>
                              {msg.username}
                            </p>
                            <p className={`${msg.type === 'system'
                                ? 'text-blue-500 italic'
                                : 'text-gray-900'
                              }`}>
                              {msg.content}
                            </p>
                          </div>
                          <span className="text-xs text-gray-500">
                            {new Date(msg.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>

              <div className="flex space-x-2">
                <Input
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Type a message..."
                  disabled={!isConnected || !isUsernameSet}
                  className="flex-1"
                />
                <Button
                  onClick={sendMessage}
                  disabled={!isConnected || !isUsernameSet || !inputMessage.trim()}
                >
                  Send
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
