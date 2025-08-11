import { createServer } from 'http';
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
    this.server = createServer();
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
    this.server.listen(config.port, () => {
      console.log('WebSocket server started successfully!');
      console.log(`Server URL: http://localhost:${config.port}`);
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