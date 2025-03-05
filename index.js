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
    origin: "*", // Allow all origins (consider setting this to your frontend URL in production)
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.static("public"));

io.on("connection", (socket) => {
  console.log("A user connected");

  socket.on("user_message", async (message) => {
    try {
      // Check if the model is available
      const modelCheck = await axios.get(
        "https://api-inference.huggingface.co/models/gpt2",
        {
          headers: {
            Authorization: `Bearer ${process.env.HUGGING_FACE_API_TOKEN}`,
          },
        }
      );

      if (modelCheck.data?.error) {
        console.error("Model loading error:", modelCheck.data.error);
        socket.emit(
          "bot_message_chunk",
          "Model is currently loading. Please try again."
        );
        socket.emit("bot_message_done");
        return;
      }

      // Retry mechanism in case of 503 errors
      const maxRetries = 5;
      for (let i = 0; i < maxRetries; i++) {
        try {
          const response = await axios.post(
            "https://api-inference.huggingface.co/models/gpt2",
            { inputs: message },
            {
              headers: {
                Authorization: `Bearer ${process.env.HUGGING_FACE_API_TOKEN}`,
              },
            }
          );

          const data = response.data;
          if (data?.generated_text) {
            socket.emit("bot_message_chunk", data.generated_text);
          } else {
            socket.emit("bot_message_chunk", "No response from model.");
          }
          break; // Exit retry loop on success

        } catch (error) {
          console.error(`Retrying... (${i + 1}/${maxRetries})`);
          if (i === maxRetries - 1) {
            socket.emit(
              "bot_message_chunk",
              "Error: Unable to fetch response after multiple attempts."
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
        }
      }
      
      socket.emit("bot_message_done");

    } catch (error) {
      console.error(
        "Error fetching from Hugging Face API:",
        error.response?.data || error.message
      );
      socket.emit(
        "bot_message_chunk",
        "Error: Unable to fetch response from Hugging Face API."
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
