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
  dns.lookup('api.openrouter.ai', (err, address, family) => {
    if (err) {
      console.error('❌ DNS lookup failed:', err.message);
      console.error('This might cause API connectivity issues');
    } else {
      console.log(`✅ DNS resolved api.openrouter.ai to: ${address} (IPv${family})`);
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

// Enhanced API request function
const makeOpenRouterRequest = async (message, socket, retryCount = 0) => {
  const maxRetries = 3;
  const backoffDelay = Math.min(1000 * Math.pow(2, retryCount), 10000); // Max 10 seconds
  
  try {
    console.log(`Attempt ${retryCount + 1}/${maxRetries + 1} - Making API request`);
    
    const response = await apiClient.post(
      "https://api.openrouter.ai/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: message,
          },
        ],
        stream: false, // Disable streaming for now to simplify debugging
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://thinkbot-backend.onrender.com",
          "X-Title": "Thinkbot",
        },
      }
    );

    console.log('✅ API request successful');
    
    if (response.data?.choices?.length > 0) {
      const text = response.data.choices[0].message.content;
      socket.emit("bot_message_chunk", text);
      socket.emit("bot_message_done");
      return true;
    } else {
      console.warn('⚠️ No choices in API response');
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
    });
    
    // Check if this is a DNS resolution error
    if (error.code === 'ENOTFOUND' || error.code === 'EAI_NODATA') {
      console.error('🔍 DNS Resolution Error - Unable to resolve api.openrouter.ai');
      
      if (retryCount < maxRetries) {
        console.log(`⏳ Retrying in ${backoffDelay}ms... (${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        return makeOpenRouterRequest(message, socket, retryCount + 1);
      } else {
        console.error('💔 All retry attempts exhausted - DNS resolution failed');
        socket.emit("bot_message_chunk", "I'm having trouble connecting to my AI service. This appears to be a network connectivity issue. Please try again in a few moments.");
        socket.emit("bot_message_done");
        return false;
      }
    }
    
    // Handle other types of errors
    if (error.response?.status === 401) {
      console.error('🔐 Authentication Error - Check API key');
      socket.emit("bot_message_chunk", "Authentication error. Please check the API configuration.");
    } else if (error.response?.status === 429) {
      console.error('🚦 Rate limit exceeded');
      socket.emit("bot_message_chunk", "I'm receiving too many requests. Please wait a moment and try again.");
    } else if (error.response?.status >= 500) {
      console.error('🔥 Server error from OpenRouter');
      socket.emit("bot_message_chunk", "The AI service is experiencing issues. Please try again later.");
    } else if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
      console.error('🔌 Connection error');
      if (retryCount < maxRetries) {
        console.log(`⏳ Retrying connection in ${backoffDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        return makeOpenRouterRequest(message, socket, retryCount + 1);
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
      hasApiKey: !!process.env.OPENROUTER_API_KEY,
      apiKeyPrefix: process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.substring(0, 10) + '...' : 'missing'
    }
  });
});

// Test endpoint for API connectivity
app.get('/test-api', async (req, res) => {
  try {
    console.log('Testing API connectivity...');
    const response = await apiClient.post(
      "https://api.openrouter.ai/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    
    res.json({ 
      success: true, 
      message: 'API connectivity test passed',
      response: response.data.choices[0].message.content 
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

io.on("connection", (socket) => {
  console.log("👤 A user connected");
  
  socket.on("user_message", async (message) => {
    console.log(`📨 Received message: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`);
    
    // Validate message
    if (!message || message.trim().length === 0) {
      socket.emit("bot_message_chunk", "Please send a valid message.");
      socket.emit("bot_message_done");
      return;
    }
    
    // Check if API key is configured
    if (!process.env.OPENROUTER_API_KEY) {
      console.error('❌ OPENROUTER_API_KEY not configured');
      socket.emit("bot_message_chunk", "Server configuration error: API key not found.");
      socket.emit("bot_message_done");
      return;
    }
    
    // Make the API request
    await makeOpenRouterRequest(message.trim(), socket);
  });
  
  socket.on("disconnect", () => {
    console.log("👋 User disconnected");
  });
});

// Test DNS resolution on startup
testDNSResolution();

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔗 Health check available at: http://localhost:${PORT}/health`);
  console.log(`🧪 API test available at: http://localhost:${PORT}/test-api`);
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
