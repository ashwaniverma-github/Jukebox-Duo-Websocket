# Jukebox Duo WebSocket Server

A TypeScript-based WebSocket server for real-time synchronization of music playback in the Jukebox Duo application.

## Features

- 🎵 Real-time audio synchronization
- 👥 Room-based user management
- 📝 Queue management with real-time updates
- 🔄 Video/song change synchronization
- 🛡️ Type-safe Socket.IO events
- ⚡ High-performance WebSocket connections

## Tech Stack

- **TypeScript** - Type-safe development
- **Socket.IO** - Real-time bidirectional communication
- **Node.js** - Server runtime
- **CORS** - Cross-origin resource sharing

## Project Structure

```
websocket-server/
├── src/
│   ├── config/
│   │   └── index.ts          # Configuration management
│   ├── services/
│   │   └── socketService.ts  # Socket.IO event handlers
│   ├── types/
│   │   └── index.ts          # TypeScript type definitions
│   └── index.ts              # Main server entry point
├── package.json
├── tsconfig.json
├── env.example
└── README.md
```

## Installation

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   cp env.example .env
   # Edit .env with your configuration
   ```

3. **Build the project:**
   ```bash
   npm run build
   ```

## Development

**Start development server:**
```bash
npm run dev
```

This will start the server with hot reload using `ts-node-dev`.

## Production

**Build and start production server:**
```bash
npm run build
npm start
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3001` |
| `NODE_ENV` | Environment mode | `development` |
| `FRONTEND_URL` | Frontend URL for CORS | `http://localhost:3000` |

## Socket.IO Events

### Client to Server Events

- `join-room` - Join a music room
- `sync-ping` - Synchronization ping
- `sync-command` - Play/pause commands
- `change-video` - Change current video/song
- `queue-updated` - Add item to queue
- `queue-removed` - Remove item from queue

### Server to Client Events

- `sync-pong` - Synchronization response
- `sync-command` - Broadcast play/pause commands
- `video-changed` - Notify video change
- `queue-updated` - Notify queue updates
- `queue-removed` - Notify queue removals

## Deployment

### Railway
1. Connect your repository to Railway
2. Set environment variables in Railway dashboard
3. Deploy automatically

### Render
1. Create a new Web Service
2. Connect your repository
3. Set build command: `npm run build`
4. Set start command: `npm start`
5. Configure environment variables

### DigitalOcean App Platform
1. Create a new app
2. Connect your repository
3. Set build command: `npm run build`
4. Set run command: `npm start`
5. Configure environment variables

## API Reference

### SocketService Class

```typescript
class SocketService {
  // Get room statistics
  getRoomStats(roomId: string): { roomSize: number; connectedClients: number }
  
  // Broadcast to all clients
  broadcastToAll(event: keyof ServerToClientEvents, data: any): void
  
  // Broadcast to specific room
  broadcastToRoom(roomId: string, event: keyof ServerToClientEvents, data: any): void
}
```

## Error Handling

The server includes comprehensive error handling:
- Graceful shutdown on SIGTERM/SIGINT
- Uncaught exception handling
- Unhandled rejection handling
- Connection error logging

## Logging

The server provides detailed logging for:
- Client connections/disconnections
- Room join/leave events
- Command synchronization
- Queue updates
- Error conditions

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License
## Shared realtime mode (opt-in)

The updated frontend and this server must be released together; refresh existing room tabs after rollout. Queue notifications only invalidate cached state. The frontend reads authoritative queue snapshots through its authenticated HTTP API.

By default, state remains process-local and deployment must use one WebSocket worker. For multiple workers, configure:

- `REALTIME_SHARED_ENABLED=true` on both frontend and WebSocket deployments.
- `SOCKET_REDIS_URL` on this server, pointing to the same trusted TLS Redis database used by the frontend's existing `REDIS_URL`.
- The existing matching `SOCKET_JWT_SECRET` and frontend origin configuration.

No schema/migration changes are required. Redis stores playback/settings with 24-hour TTLs, distributes room events, and enforces shared user limits. Playback has atomic revisions and generations; presence is aggregated across workers. Room/account deletion and entitlement changes revoke affected sockets after the database transaction commits. Revocation messages are backed by short-lived cutoff records and periodic checks; five-minute token expiry remains a fallback.

Shared mode fails startup if its explicit Redis URL is missing. It does not silently fall back to independent playback writes during a Redis outage. Rollout/configuration has not been performed by this change; validate provider connectivity and capacity in staging before enabling shared mode or scaling workers.

Tests: `npm test` runs the single-worker suite. `npm run test:shared` runs two workers against an automatically removed Docker Redis container, plus the sibling frontend's shared limiter tests. The sibling `music-duo` dependencies and Docker must be available. See `music-duo/ROBUSTNESS_PROGRESS.md` for the complete validation and rollout status.
