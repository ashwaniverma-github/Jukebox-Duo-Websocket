import { createServer } from 'http';
import express from 'express';
import { Server } from 'socket.io';
import { config } from './config';
import { SocketService } from './services/socketService';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
} from './types';

class WebSocketServer {
  private server!: ReturnType<typeof createServer>;
  private io!: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
  private isShuttingDown = false;

  constructor() {
    this.initializeServer();
    this.setupSocketIO();
    this.setupSocketService();
    this.startServer();
  }

  private initializeServer(): void {
    // Create a minimal Express app to satisfy Cloud Run health checks
    const app = express();
    app.get('/healthz', (_req, res) => res.status(200).send('ok'));
    // Ensure the server listens on Cloud Run's PORT (defaults handled in startServer)
    this.server = createServer(app);
  }

  private setupSocketIO(): void {
    this.io = new Server(this.server, {
      path: config.socket.path,
      cors: config.cors,
      transports: [...config.socket.transports],
    });
  }

  private setupSocketService(): void {
    new SocketService(this.io);
  }

  private startServer(): void {
    // Respect Cloud Run's PORT env var override
    const port = Number(process.env['PORT'] || config.port);
    this.server.listen(port, () => {
      console.log('WebSocket server started successfully!');
      console.log(`Server URL: http://0.0.0.0:${port}`);
      console.log(`Socket.IO path: ${config.socket.path}`);
      console.log(`CORS origin: ${config.cors.origin}`);
      console.log(`Environment: ${config.nodeEnv}`);
      console.log('Ready to handle real-time connections');
    });
  }

  // Graceful shutdown
  public shutdown(): void {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;
    console.log('Shutting down WebSocket server...');

    // First close Socket.IO (disconnects clients)
    if (this.io) {
      this.io.close(() => {
        // Then close the underlying HTTP server
        this.server.close(() => {
          console.log('Server closed successfully');
          process.exit(0);
        });
      });
    } else {
      // Fallback: close server directly
      this.server.close(() => {
        console.log('Server closed successfully');
        process.exit(0);
      });
    }

    // Force-exit safety timeout in case close callbacks never fire
    setTimeout(() => {
      console.warn('Force exiting process after timeout');
      process.exit(0);
    }, 5000).unref();
  }
}

// Create and start the server
const webSocketServer = new WebSocketServer();

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('📡 SIGTERM received');
  webSocketServer.shutdown();
});

process.on('SIGINT', () => {
  console.log('📡 SIGINT received');
  webSocketServer.shutdown();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  webSocketServer.shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  webSocketServer.shutdown();
});

export default webSocketServer; 