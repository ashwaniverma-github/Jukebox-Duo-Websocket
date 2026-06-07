# Testing the realtime auth + sync

This covers the WebSocket server's auth/authorization and the playback-sync behavior
(including reconnect recovery). It spans both repos: `music-duo-websocket` (this one) and
the `music-duo` frontend.

## 1. Automated server tests (`npm test`)

```bash
npm test            # builds, then runs test/ws-integration.cjs
```

This boots the compiled server with a throwaway `SOCKET_JWT_SECRET` and drives it with a
real `socket.io-client`, asserting:

**Auth gate**
- connection rejected with: no token, malformed token, wrong-secret token, expired token
- connection accepted with a valid token

**Authorization**
- sync-eligible room (host premium): `sync-command` is broadcast to the other member
- ineligible room (free host): `sync-command` is dropped (paywall enforced server-side)
- a token is bound to one room: it can't join or emit into a different room
- presence identity comes from the verified token, not the client payload (no impersonation)

**Sync replay (reconnect recovery)**
- `sync-request` replays the room's live position to a (re)joiner, advancing a *playing*
  track by the elapsed time
- replay is skipped when the joiner is on a different video (no wrong-song seek)
- replay is delivered when the video matches

The test uses a node client, so it validates **server** behavior. The React wiring is
covered by the manual checklist below.

## 2. Local run requirements

Both services must share the **same** `SOCKET_JWT_SECRET` or sync fails closed (the server
rejects every connection without a valid token).

**`music-duo-websocket/.env`**
```
PORT=3001
FRONTEND_URL=http://localhost:3000
SOCKET_JWT_SECRET=<same value as the frontend>
```

**`music-duo/.env` (or `.env.local`)** - in addition to the existing keys:
```
SOCKET_JWT_SECRET=<same value as the websocket server>
NEXT_PUBLIC_SOCKET_URL=http://localhost:3001
# plus the usual app secrets to actually log in / load a room:
# NEXTAUTH_SECRET, NEXTAUTH_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, DATABASE_URL, ...
```

Generate a secret (any one works):
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 3. Manual frontend checklist

Use two browsers/profiles. The **host account must be premium** for sync to be available.

1. **Happy path** - host enables sync, then play/pause/seek/skip/add/remove. The guest
   mirrors within ~1s, and both members can drive playback.
2. **Reconnect resync** - while playing, drop the guest's network ~15s, then restore it.
   Expect a "Reconnecting..." pill that clears, and the guest snaps to the host's *current*
   position (not where it froze).
3. **Screen-off resync** - guest (phone) locks the screen ~20s mid-playback, then unlocks.
   Expect: back on the right song AND re-aligned to the live position.
4. **Free host = no sync** - with a non-premium host, the guest's "Enable sync" shows the
   upgrade modal and no sync channel opens.
5. **Session-expired banner** - force the login session to expire (e.g. a short test
   session) then trigger a reconnect. Expect the red "Your session expired - Sign in"
   banner instead of a silent failure.
6. **Tab refocus (regression)** - switch tabs and back during playback. It must NOT
   reconnect, tear down, or jump (guards the `sessionRef`/`status` effect-deps fix).

## 4. Rollout note

The server requires a valid token on every connection - there is no unauthenticated path.
Set `SOCKET_JWT_SECRET` (identical) in both deployments before/at deploy, or sync won't
connect.
