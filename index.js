const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const cors = require("cors");
const dns = require("dns");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

// Enable CORS for all connections
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins (use frontend URL in production)
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.static("public"));

// Store conversation history for each socket connection
const conversationHistory = new Map();

// Configure axios with better defaults
const apiClient = axios.create({
  timeout: 30000, // 30 second timeout
  headers: {
    'User-Agent': 'Thinkbot/1.0',
  },
});

// Add request interceptor for logging
apiClient.interceptors.request.use(
  (config) => {
    console.log(`Making API request to: ${config.url}`);
    return config;
  },
  (error) => {
    console.error('Request interceptor error:', error);
    return Promise.reject(error);
  }
);

// Test DNS resolution on startup
const testDNSResolution = () => {
  console.log('Testing DNS resolution...');
  dns.lookup('generativelanguage.googleapis.com', (err, address, family) => {
    if (err) {
      console.error('❌ DNS lookup failed for Gemini API:', err.message);
      console.error('This might cause API connectivity issues');
    } else {
      console.log(`✅ DNS resolved generativelanguage.googleapis.com to: ${address} (IPv${family})`);
    }
  });
  
  // Also test Google DNS as baseline
  dns.lookup('google.com', (err, address) => {
    if (err) {
      console.error('❌ Basic internet connectivity issue - can\'t resolve google.com');
    } else {
      console.log(`✅ Basic internet connectivity OK - resolved google.com to: ${address}`);
    }
  });
};

// Function to manage conversation history
const addToHistory = (socketId, role, content) => {
  if (!conversationHistory.has(socketId)) {
    conversationHistory.set(socketId, []);
  }
  
  const history = conversationHistory.get(socketId);
  history.push({ role, content });
  
  // Keep only last 10 messages (5 user + 5 assistant pairs max)
  if (history.length > 10) {
    history.splice(0, history.length - 10);
  }
  
  conversationHistory.set(socketId, history);
};

// Function to get conversation history for Gemini format
const getGeminiHistory = (socketId) => {
  const history = conversationHistory.get(socketId) || [];
  
  // Convert to Gemini format - exclude the current message as it will be added separately
  return history.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }]
  }));
};

// Enhanced API request function for Gemini
const makeGeminiRequest = async (message, socket, socketId, retryCount = 0) => {
  const maxRetries = 3;
  const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 10000); // Max 10 seconds
  
  try {
    console.log(`Attempt ${retryCount + 1}/${maxRetries + 1} - Making Gemini API request`);
    
    // Get conversation history
    const history = getGeminiHistory(socketId);
    
    // Prepare the request payload
    const requestData = {
      contents: [
        ...history,
        {
          role: "user",
          parts: [{ text: message }]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 2048,
      },
      safetySettings: [
        {
          category: "HARM_CATEGORY_HARASSMENT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE"
        },
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: "BLOCK_MEDIUM_AND_ABOVE"
        },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE"
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE"
        }
      ]
    };

    console.log(`📊 Sending request with ${history.length} historical messages`);
    
    const response = await apiClient.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      requestData,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    console.log('✅ Gemini API request successful');
    
    if (response.data?.candidates?.length > 0 && response.data.candidates[0].content?.parts?.length > 0) {
      const text = response.data.candidates[0].content.parts[0].text;
      
      // Add both user message and bot response to history
      addToHistory(socketId, 'user', message);
      addToHistory(socketId, 'assistant', text);
      
      // Stream the response (simulate streaming by sending chunks)
      const words = text.split(' ');
      let currentChunk = '';
      
      for (let i = 0; i < words.length; i++) {
        currentChunk += (i > 0 ? ' ' : '') + words[i];
        
        // Send chunk every 3-5 words to simulate streaming
        if (i % 4 === 0 || i === words.length - 1) {
          socket.emit("bot_message_chunk", currentChunk);
          currentChunk = '';
          
          // Small delay to make streaming visible
          if (i < words.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      }
      
      socket.emit("bot_message_done");
      return true;
    } else {
      console.warn('⚠️ No candidates in Gemini API response');
      socket.emit("bot_message_chunk", "I received an empty response. Please try again.");
      socket.emit("bot_message_done");
      return true;
    }
    
  } catch (error) {
    console.error(`❌ Attempt ${retryCount + 1} failed:`, {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data
    });
    
    // Check if this is a DNS resolution error
    if (error.code === 'ENOTFOUND' || error.code === 'EAI_NODATA') {
      console.error('🔍 DNS Resolution Error - Unable to resolve generativelanguage.googleapis.com');
      
      if (retryCount < maxRetries) {
        console.log(`⏳ Retrying in ${backoffDelay}ms... (${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        return makeGeminiRequest(message, socket, socketId, retryCount + 1);
      } else {
        console.error('💔 All retry attempts exhausted - DNS resolution failed');
        socket.emit("bot_message_chunk", "I'm having trouble connecting to my AI service. This appears to be a network connectivity issue. Please try again in a few moments.");
        socket.emit("bot_message_done");
        return false;
      }
    }
    
    // Handle other types of errors
    if (error.response?.status === 400) {
      console.error('🔐 Bad Request - Check API key or request format');
      const errorMessage = error.response?.data?.error?.message || "Bad request to AI service.";
      socket.emit("bot_message_chunk", `Request error: ${errorMessage}`);
    } else if (error.response?.status === 403) {
      console.error('🚫 Forbidden - API key might be invalid or quota exceeded');
      socket.emit("bot_message_chunk", "Access denied. Please check the API configuration.");
    } else if (error.response?.status === 429) {
      console.error('🚦 Rate limit exceeded');
      socket.emit("bot_message_chunk", "I'm receiving too many requests. Please wait a moment and try again.");
    } else if (error.response?.status >= 500) {
      console.error('🔥 Server error from Gemini API');
      socket.emit("bot_message_chunk", "The AI service is experiencing issues. Please try again later.");
    } else if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
      console.error('🔌 Connection error');
      if (retryCount < maxRetries) {
        console.log(`⏳ Retrying connection in ${backoffDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        return makeGeminiRequest(message, socket, socketId, retryCount + 1);
      } else {
        socket.emit("bot_message_chunk", "Connection failed after multiple attempts. Please try again later.");
      }
    } else {
      console.error('❓ Unknown error:', error.message);
      socket.emit("bot_message_chunk", "An unexpected error occurred. Please try again.");
    }
    
    socket.emit("bot_message_done");
    return false;
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: {
      hasApiKey: !!process.env.GEMINI_API_KEY,
      apiKeyPrefix: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.substring(0, 10) + '...' : 'missing'
    },
    activeConversations: conversationHistory.size
  });
});

// Test endpoint for API connectivity
app.get('/test-api', async (req, res) => {
  try {
    console.log('Testing Gemini API connectivity...');
    const response = await apiClient.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello! Please respond with 'API test successful'" }]
          }
        ]
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
    
    const responseText = response.data.candidates[0].content.parts[0].text;
    
    res.json({ 
      success: true, 
      message: 'Gemini API connectivity test passed',
      response: responseText
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message,
      code: error.code,
      details: error.response?.data 
    });
  }
});

// Endpoint to check conversation history
app.get('/history/:socketId', (req, res) => {
  const { socketId } = req.params;
  const history = conversationHistory.get(socketId) || [];
  res.json({
    socketId,
    messageCount: history.length,
    history: history
  });
});

// Endpoint to clear conversation history
app.post('/clear-history/:socketId', (req, res) => {
  const { socketId } = req.params;
  conversationHistory.delete(socketId);
  res.json({
    success: true,
    message: `Conversation history cleared for socket ${socketId}`
  });
});

io.on("connection", (socket) => {
  console.log(`👤 A user connected - Socket ID: ${socket.id}`);
  
  // Initialize empty conversation history for new connection
  conversationHistory.set(socket.id, []);
  
  socket.on("user_message", async (message) => {
    console.log(`📨 Received message from ${socket.id}: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`);
    
    // Validate message
    if (!message || message.trim().length === 0) {
      socket.emit("bot_message_chunk", "Please send a valid message.");
      socket.emit("bot_message_done");
      return;
    }
    
    // Check if API key is configured
    if (!process.env.GEMINI_API_KEY) {
      console.error('❌ GEMINI_API_KEY not configured');
      socket.emit("bot_message_chunk", "Server configuration error: Gemini API key not found.");
      socket.emit("bot_message_done");
      return;
    }
    
    // Make the API request
    await makeGeminiRequest(message.trim(), socket, socket.id);
  });
  
  // Handle request to clear conversation history
  socket.on("clear_history", () => {
    conversationHistory.delete(socket.id);
    console.log(`🗑️ Cleared conversation history for ${socket.id}`);
    socket.emit("history_cleared", "Conversation history has been cleared.");
  });
  
  // Handle request to get conversation summary
  socket.on("get_history_summary", () => {
    const history = conversationHistory.get(socket.id) || [];
    socket.emit("history_summary", {
      messageCount: history.length,
      lastMessages: history.slice(-4) // Send last 4 messages as preview
    });
  });
  
  socket.on("disconnect", () => {
    console.log(`👋 User disconnected - Socket ID: ${socket.id}`);
    // Optional: Keep history for a while in case user reconnects
    // conversationHistory.delete(socket.id);
  });
});

// Clean up old conversation histories periodically (every hour)
setInterval(() => {
  const currentTime = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  for (const [socketId, history] of conversationHistory.entries()) {
    // This is a simple cleanup - in production, you'd want to track timestamps
    if (history.length === 0) {
      conversationHistory.delete(socketId);
    }
  }
  
  console.log(`🧹 Cleanup complete. Active conversations: ${conversationHistory.size}`);
}, 60 * 60 * 1000); // Run every hour

// Test DNS resolution on startup
testDNSResolution();

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 Health check available at: http://localhost:${PORT}/health`);
  console.log(`🧪 API test available at: http://localhost:${PORT}/test-api`);
  console.log(`📊 Using Google Gemini 1.5 Flash model`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
