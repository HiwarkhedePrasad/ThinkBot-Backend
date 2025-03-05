const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
require('dotenv').config();

// Enable CORS for all connections
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.static("public"));

io.on("connection", (socket) => {
  console.log("A user connected");

  socket.on("user_message", async (message) => {
   const response = await axios.post(
    "https://api-inference.huggingface.co/models/gpt2",
    { inputs: message },
    {
        headers: {
            Authorization: `Bearer ${process.env.HUGGING_FACE_API_TOKEN}`,
        },
        responseType: "stream",
    }
);

      );

      response.data.on("data", (chunk) => {
        try {
          const data = JSON.parse(chunk.toString());
          if (data?.generated_text) {
            socket.emit("bot_message_chunk", data.generated_text);
          }
        } catch (err) {
          console.error("Error parsing chunk:", err);
        }
      });

      response.data.on("end", () => {
        socket.emit("bot_message_done");
      });
    } catch (error) {
      console.error("Error fetching from Hugging Face API:", error.message);
      socket.emit("bot_message_chunk", "Error: Unable to fetch response.");
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
