// src/config/index.ts
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export const config = {
  port: process.env['PORT'] || 3001,
  frontendUrl: process.env['FRONTEND_URL'] || 'http://localhost:3000',
  nodeEnv: process.env['NODE_ENV'] || 'development',
  cors: {
    origin: process.env['FRONTEND_URL'] || 'http://localhost:3000',
    methods: ['GET', 'POST'] as string[],
    credentials: true,
  },
  socket: {
    path: '/api/socket',
    transports: ['websocket'] as const,
  },
} as const;

export type Config = typeof config; 