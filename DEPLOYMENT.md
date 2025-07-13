# Deployment Guide

This guide will help you deploy the Music Duo WebSocket server to various platforms.

## Prerequisites

1. **Node.js 18+** installed
2. **Git** repository set up
3. **Environment variables** configured

## Platform Options

### 1. Railway (Recommended - Easy)

**Pros:** Simple deployment, good free tier, automatic deployments
**Cons:** Limited free tier usage

#### Steps:
1. **Sign up** at [railway.app](https://railway.app)
2. **Connect your repository** or create a new one
3. **Add environment variables:**
   ```
   NODE_ENV=production
   FRONTEND_URL=https://your-vercel-app.vercel.app
   ```
4. **Deploy** - Railway will automatically detect Node.js and deploy

### 2. Render (Good Free Tier)

**Pros:** Generous free tier, easy setup
**Cons:** Free tier has limitations

#### Steps:
1. **Sign up** at [render.com](https://render.com)
2. **Create a new Web Service**
3. **Connect your repository**
4. **Configure settings:**
   - **Build Command:** `npm run build`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. **Add environment variables:**
   ```
   NODE_ENV=production
   FRONTEND_URL=https://your-vercel-app.vercel.app
   ```
6. **Deploy**

### 3. DigitalOcean App Platform

**Pros:** Reliable, good performance
**Cons:** Paid only

#### Steps:
1. **Sign up** at [digitalocean.com](https://digitalocean.com)
2. **Create a new app**
3. **Connect your repository**
4. **Configure build settings:**
   - **Build Command:** `npm run build`
   - **Run Command:** `npm start`
5. **Add environment variables**
6. **Deploy**

### 4. Heroku (Classic Choice)

**Pros:** Well-established, good documentation
**Cons:** No free tier anymore

#### Steps:
1. **Install Heroku CLI**
2. **Login:** `heroku login`
3. **Create app:** `heroku create your-app-name`
4. **Set environment variables:**
   ```bash
   heroku config:set NODE_ENV=production
   heroku config:set FRONTEND_URL=https://your-vercel-app.vercel.app
   ```
5. **Deploy:** `git push heroku main`

## Environment Variables

Set these in your deployment platform:

| Variable | Value | Description |
|----------|-------|-------------|
| `NODE_ENV` | `production` | Production environment |
| `FRONTEND_URL` | `https://your-vercel-app.vercel.app` | Your Vercel frontend URL |
| `PORT` | Auto-set | Server port (usually auto-configured) |

## Testing Deployment

1. **Check server logs** in your deployment platform
2. **Test WebSocket connection:**
   ```javascript
   // In browser console
   const socket = io('https://your-websocket-server.com', {
     path: '/api/socket',
     transports: ['websocket']
   });
   
   socket.on('connect', () => {
     console.log('Connected!', socket.id);
   });
   ```

## Update Frontend Configuration

After deploying, update your frontend's environment variable:

```bash
# In your Vercel dashboard or .env.local
NEXT_PUBLIC_SOCKET_URL=https://your-websocket-server.com
```

## Troubleshooting

### Common Issues:

1. **CORS Errors:**
   - Ensure `FRONTEND_URL` is set correctly
   - Check that the URL includes the protocol (https://)

2. **Connection Timeouts:**
   - Verify the server is running
   - Check firewall settings
   - Ensure WebSocket transport is enabled

3. **Build Failures:**
   - Check Node.js version (18+ required)
   - Verify all dependencies are installed
   - Check TypeScript compilation

### Debug Commands:

```bash
# Check server status
curl https://your-websocket-server.com

# Test WebSocket endpoint
wscat -c wss://your-websocket-server.com/api/socket

# Check logs
# Use your platform's log viewer
```

## Monitoring

### Health Check Endpoint

Add this to your server for monitoring:

```typescript
// In src/index.ts
this.server.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
  }
});
```

### Logging

The server includes comprehensive logging. Monitor these events:
- Client connections/disconnections
- Room join/leave events
- Error conditions

## Security Considerations

1. **CORS Configuration:** Only allow your frontend domain
2. **Rate Limiting:** Consider adding rate limiting for production
3. **Authentication:** Add user authentication if needed
4. **HTTPS:** Always use HTTPS in production

## Scaling

For high-traffic applications:

1. **Load Balancing:** Use multiple server instances
2. **Redis Adapter:** Add Redis for Socket.IO clustering
3. **Monitoring:** Set up proper monitoring and alerting
4. **CDN:** Use CDN for static assets

## Cost Optimization

1. **Free Tier Limits:** Be aware of platform limitations
2. **Auto-scaling:** Configure auto-scaling based on usage
3. **Resource Monitoring:** Monitor CPU/memory usage
4. **Cleanup:** Remove unused resources 