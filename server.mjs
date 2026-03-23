import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import process from 'node:process';
import path from 'path';
import { createServer } from 'http';

// Core & Services
import { setupGlobalErrorHandlers } from './core/errors.mjs';
import { setupWebSocket } from './core/websocket.mjs';
import { bootstrapSystem } from './core/bootstrapper.mjs';
import { startGarbageCollector } from './services/garbage_collector.service.mjs';

// --- MODULAR ROUTERS ---
import rpcRoutes from './routes/rpc.routes.mjs';
import authRoutes from './routes/auth.routes.mjs';
import inboxRoutes from './routes/inbox.routes.mjs';
import adminRoutes from './routes/admin.routes.mjs';
import mediaRoutes from './routes/media.routes.mjs';
import graphRoutes from './routes/graph.routes.mjs';
import mainRoutes from './routes/main.routes.mjs';
import internalRoutes from './routes/internal.routes.mjs';

// 1. Setup Global Error Handlers
setupGlobalErrorHandlers();

const app = express();
const httpServer = createServer(app);

// 2. Setup WebSocket
setupWebSocket(httpServer);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads'))); 

// --- MOUNT ROUTERS ---
app.use('/rpc', rpcRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/admin', adminRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/graph', graphRoutes);
app.use('/', mainRoutes);
app.use('/internal', internalRoutes);

// Static Graph Viewer
app.get('/graph/:clientId', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'graph_viewer.html'));
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, '0.0.0.0', async () => {
    // 3. Initialize System Services (Config preload, WhatsApp Reconnect, Heartbeat)
    await bootstrapSystem();
    
    startGarbageCollector();

    console.log(`🚀 SaaS Bridge listening on http://0.0.0.0:${PORT}`);
});
