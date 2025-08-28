const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const cors = require("cors");
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

io.on("connection", (socket) => {
  console.log("A user connected");

  socket.on("user_message", async (message) => {
    try {
      // OpenRouter API request
      const maxRetries = 5;

      for (let i = 0; i < maxRetries; i++) {
        try {
          const response = await axios.post(
            "https://api.openrouter.ai/v1/chat/completions",
            {
              model: "gpt-4o-mini", // You can use any OpenRouter-supported model
              messages: [
                {
                  role: "user",
                  content: message,
                },
              ],
            },
            {
              headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
              },
            }
          );

          const data = response.data;
          if (data?.choices?.length > 0) {
            const text = data.choices.map(c => c.message.content).join("\n");
            socket.emit("bot_message_chunk", text);
          } else {
            socket.emit("bot_message_chunk", "No response from model.");
          }
          break; // Exit retry loop on success

        } catch (error) {
          console.error(error);
          console.error(`Retrying... (${i + 1}/${maxRetries})`);
          if (i === maxRetries - 1) {
            socket.emit(
              "bot_message_chunk",
              "Error: Unable to fetch response after multiple attempts."
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      socket.emit("bot_message_done");

    } catch (error) {
      console.error(
        "Error fetching from OpenRouter API:",
        error.response?.data || error.message
      );
      socket.emit(
        "bot_message_chunk",
        "Error: Unable to fetch response from OpenRouter API."
      );
      socket.emit("bot_message_done");
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

server.listen(5000, "0.0.0.0", () => {
  console.log("Server running on render");
});

