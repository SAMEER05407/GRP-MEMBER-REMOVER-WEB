
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs-extra');
const http = require('http');
const socketIo = require('socket.io');
const WhatsAppHandler = require('./whatsapp');

const app = express();

// Add error handling for route parsing issues
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit the process, just log the error
});

const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Session configuration
app.use(session({
  secret: 'whatsapp-remover-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true
  }
}));

// Ensure directories exist
fs.ensureDirSync('./sessions');
fs.ensureDirSync('./views');
fs.ensureDirSync('./public');

// Create admins.json if it doesn't exist
if (!fs.existsSync('./admins.json')) {
  fs.writeJsonSync('./admins.json', {
    "admins": ["9209778319"],
    "superAdmin": "9209778319"
  });
}

// Store active WhatsApp handlers
const whatsappHandlers = new Map();

// Load admin data
function loadAdmins() {
  try {
    const data = fs.readJsonSync('./admins.json');
    return {
      admins: data.admins || [],
      superAdmin: data.superAdmin || "9209778319"
    };
  } catch (error) {
    console.error('Error loading admins:', error);
    return {
      admins: ["9209778319"],
      superAdmin: "9209778319"
    };
  }
}

// Save admin data
function saveAdmins(adminData) {
  try {
    fs.writeJsonSync('./admins.json', adminData);
    return true;
  } catch (error) {
    console.error('Error saving admins:', error);
    return false;
  }
}

// Routes
app.get('/', (req, res) => {
  try {
    if (req.session.userId) {
      return res.redirect('/dashboard');
    }
    res.render('login', { error: null });
  } catch (error) {
    console.error('Error in / route:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/login', (req, res) => {
  try {
    const { userId } = req.body;
    const adminData = loadAdmins();
    
    if (!userId || userId.length !== 10 || !/^\d{10}$/.test(userId)) {
      return res.render('login', { error: 'Please enter a valid 10-digit numeric ID' });
    }
    
    if (!adminData.admins.includes(userId)) {
      return res.render('login', { 
        error: 'Unauthorized access. Please contact @Reemasilhen to request access.',
        redirectToTelegram: true 
      });
    }
    
    req.session.userId = userId;
    req.session.isSuperAdmin = userId === adminData.superAdmin;
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Error in login route:', error);
    res.render('login', { error: 'An error occurred during login. Please try again.' });
  }
});

app.get('/dashboard', (req, res) => {
  try {
    if (!req.session.userId) {
      return res.redirect('/');
    }
    
    const handler = whatsappHandlers.get(req.session.userId);
    const isConnected = handler ? handler.isConnected() : false;
    const adminData = loadAdmins();
    
    res.render('dashboard', { 
      userId: req.session.userId,
      isConnected: isConnected,
      isSuperAdmin: req.session.isSuperAdmin,
      admins: req.session.isSuperAdmin ? adminData.admins : []
    });
  } catch (error) {
    console.error('Error in dashboard route:', error);
    res.redirect('/');
  }
});

app.post('/connect-whatsapp', async (req, res) => {
  // Set proper JSON headers first
  res.setHeader('Content-Type', 'application/json');
  
  if (!req.session.userId) {
    console.log('Connect attempt without valid session');
    return res.status(401).json({ success: false, error: 'Unauthorized - No session found' });
  }
  
  const userId = req.session.userId;
  console.log(`🔗 Starting connection process for user ${userId}`);
  
  try {
    let handler = whatsappHandlers.get(userId);
    
    // Remove existing handler if present to force fresh connection
    if (handler) {
      console.log(`🧹 Removing existing handler for user ${userId} to create fresh connection`);
      try {
        await handler.disconnect();
      } catch (disconnectError) {
        console.error('Error during existing handler cleanup:', disconnectError);
      }
      whatsappHandlers.delete(userId);
      console.log(`♻️ Existing handler cleaned up for user ${userId}`);
    }
    
    console.log(`🆕 Creating new WhatsApp handler for user ${userId}`);
    handler = new WhatsAppHandler(userId, io);
    whatsappHandlers.set(userId, handler);
    
    await handler.initialize();
    console.log(`✅ WhatsApp connection initiated for user ${userId}`);
    res.json({ success: true, message: 'WhatsApp connection initiated successfully' });
  } catch (error) {
    console.error(`❌ Error connecting WhatsApp for user ${userId}:`, error);
    whatsappHandlers.delete(userId); // Clean up on error
    res.status(500).json({ success: false, error: error.message || 'Failed to connect WhatsApp' });
  }
});

app.post('/disconnect-whatsapp', async (req, res) => {
  // Set proper JSON headers first
  res.setHeader('Content-Type', 'application/json');
  
  if (!req.session.userId) {
    console.log('Disconnect attempt without valid session');
    return res.status(401).json({ success: false, error: 'Unauthorized - No session found' });
  }
  
  const userId = req.session.userId;
  console.log(`🔌 Starting disconnect process for user ${userId}`);
  
  try {
    const handler = whatsappHandlers.get(userId);
    if (handler) {
      console.log(`📱 Disconnecting WhatsApp handler for user ${userId}`);
      await handler.disconnect();
      whatsappHandlers.delete(userId);
      console.log(`✅ WhatsApp handler removed and session cleared for user ${userId}`);
    } else {
      console.log(`ℹ️ No active handler found for user ${userId} - already disconnected`);
    }
    
    // Emit disconnect status to client
    io.to(`user-${userId}`).emit('connection-status', { connected: false });
    io.to(`user-${userId}`).emit('qr-code', null);
    
    console.log(`🎯 Disconnect successful for user ${userId}`);
    res.json({ success: true, message: 'WhatsApp disconnected and session cleared successfully' });
  } catch (error) {
    console.error(`❌ Error disconnecting WhatsApp for user ${userId}:`, error);
    res.status(500).json({ success: false, error: error.message || 'Failed to disconnect WhatsApp' });
  }
});

app.post('/remove-members', async (req, res) => {
  // Set proper JSON headers first
  res.setHeader('Content-Type', 'application/json');
  
  if (!req.session.userId) {
    return res.status(401).json({ success: false, error: 'Unauthorized - No session found' });
  }
  
  const { groupLink } = req.body;
  
  if (!groupLink) {
    return res.status(400).json({ success: false, error: 'Group link is required' });
  }
  
  try {
    const handler = whatsappHandlers.get(req.session.userId);
    if (!handler || !handler.isConnected()) {
      return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }
    
    const result = await handler.removeAllMembers(groupLink);
    res.json(result);
  } catch (error) {
    console.error('Error removing members:', error);
    res.status(500).json({ success: false, error: error.message || 'Unknown error occurred' });
  }
});

app.post('/bulk-remove-members', async (req, res) => {
  // Set proper JSON headers first
  res.setHeader('Content-Type', 'application/json');
  
  if (!req.session.userId) {
    return res.status(401).json({ success: false, error: 'Unauthorized - No session found' });
  }
  
  const { groupLinksText } = req.body;
  
  if (!groupLinksText || typeof groupLinksText !== 'string') {
    return res.status(400).json({ success: false, error: 'Group links are required' });
  }
  
  // Parse group links from textarea (comma or newline separated)
  const groupLinks = groupLinksText
    .split(/[,\n\r]+/)
    .map(link => link.trim())
    .filter(link => link.length > 0);
  
  if (groupLinks.length === 0) {
    return res.status(400).json({ success: false, error: 'Please provide at least one group link' });
  }
  
  if (groupLinks.length > 20) {
    return res.status(400).json({ success: false, error: 'Maximum 20 group links allowed' });
  }
  
  try {
    const handler = whatsappHandlers.get(req.session.userId);
    if (!handler || !handler.isConnected()) {
      return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
    }
    
    const result = await handler.bulkRemoveMembers(groupLinks);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error in bulk removal:', error);
    res.status(500).json({ success: false, error: error.message || 'Unknown error occurred' });
  }
});

// Admin management routes
app.post('/admin/add-user', (req, res) => {
  // Set proper JSON headers first
  res.setHeader('Content-Type', 'application/json');
  
  if (!req.session.isSuperAdmin) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }
  
  const { newUserId } = req.body;
  
  if (!newUserId || newUserId.length !== 10 || !/^\d{10}$/.test(newUserId)) {
    return res.status(400).json({ success: false, error: 'Please enter a valid 10-digit numeric ID' });
  }
  
  const adminData = loadAdmins();
  
  if (adminData.admins.includes(newUserId)) {
    return res.status(400).json({ success: false, error: 'User ID already exists' });
  }
  
  adminData.admins.push(newUserId);
  
  if (saveAdmins(adminData)) {
    res.json({ success: true, message: 'User added successfully' });
  } else {
    res.status(500).json({ success: false, error: 'Failed to save changes' });
  }
});

app.post('/admin/remove-user', (req, res) => {
  // Set proper JSON headers first
  res.setHeader('Content-Type', 'application/json');
  
  if (!req.session.isSuperAdmin) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }
  
  const { removeUserId } = req.body;
  const adminData = loadAdmins();
  
  if (removeUserId === adminData.superAdmin) {
    return res.status(400).json({ success: false, error: 'Cannot remove super admin' });
  }
  
  const index = adminData.admins.indexOf(removeUserId);
  if (index === -1) {
    return res.status(404).json({ success: false, error: 'User ID not found' });
  }
  
  adminData.admins.splice(index, 1);
  
  if (saveAdmins(adminData)) {
    res.json({ success: true, message: 'User removed successfully' });
  } else {
    res.status(500).json({ success: false, error: 'Failed to save changes' });
  }
});

app.get('/logout', (req, res) => {
  try {
    const userId = req.session.userId;
    
    // Disconnect WhatsApp if connected
    const handler = whatsappHandlers.get(userId);
    if (handler) {
      handler.disconnect().catch(console.error);
      whatsappHandlers.delete(userId);
    }
    
    req.session.destroy((err) => {
      if (err) {
        console.error('Error destroying session:', err);
      }
      res.redirect('/');
    });
  } catch (error) {
    console.error('Error in logout route:', error);
    res.redirect('/');
  }
});

// Keep-alive mechanism for Replit
app.get('/ping', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('join-session', (userId) => {
    socket.join(`user-${userId}`);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Global error handler for all routes
app.use((error, req, res, next) => {
  console.error('Global error handler:', error);
  
  // Check if response already sent
  if (res.headersSent) {
    return next(error);
  }
  
  // For POST requests that expect JSON responses
  if (req.method === 'POST' && req.path !== '/login') {
    res.setHeader('Content-Type', 'application/json');
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Internal server error' 
    });
  } else if (req.method === 'GET') {
    // For GET requests, redirect to home or show error page
    if (req.path === '/' || req.path === '/dashboard') {
      res.status(500).send('Internal Server Error');
    } else {
      res.redirect('/');
    }
  } else {
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// Handle 404 errors
app.use((req, res) => {
  if (req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.status(404).json({ 
      success: false, 
      error: 'Route not found' 
    });
  } else {
    res.redirect('/');
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit the process unless it's critical
  if (error.code === 'EADDRINUSE' || error.message.includes('listen EADDRINUSE')) {
    console.error('Critical error - exiting');
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
    process.exit(0);
  });
});

// Keep-alive ping every 5 minutes
setInterval(() => {
  console.log('Keep-alive ping:', new Date().toISOString());
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 5000;

// Add server error handling
server.on('error', (error) => {
  console.error('Server error:', error);
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
    process.exit(1);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log('WhatsApp Group Member Remover Tool started successfully!');
}).on('error', (error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
