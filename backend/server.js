const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bodyParser = require("body-parser");
const Docker = require("dockerode");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const docker = new Docker();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
const userContainers = {};
// Object to store references to Python processes for each user
const pythonProcesses = {};
// Define the folder path where user directories will be created
const userDirectoryPath = path.join(__dirname, "user_directories");

// Create the user directories folder if it doesn't exist
if (!fs.existsSync(userDirectoryPath)) {
  fs.mkdirSync(userDirectoryPath);
}
const upload = multer({ dest: userDirectoryPath });

app.get("/execute/:userId", async (req, res) => {
  const userId = req.params.userId;
  const container = userContainers[userId];
  if (!container) {
    return res.status(404).json({ error: "User not found" });
  }
  res.sendFile(path.join(__dirname, "public", "execute.html"));
});
app.post("/upload/:userId", upload.single("file"), async (req, res) => {
  const userId = req.params.userId;

  const container = userContainers[userId];
  if (!container) {
    return res.status(404).json({ error: "User not found" });
  }

  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    // Save the uploaded file to the user's directory
    const filePath = path.join(userDirectoryPath, userId, file.originalname);
    fs.renameSync(file.path, filePath); // Move the file to the desired location

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error handling file upload:", error);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

app.post("/login", async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Name is required" });
  }

  // Check if user already has a container
  const existingContainer = Object.values(userContainers).find(
    (container) => container.data.username === name
  );

  let userId;
  if (existingContainer) {
    userId = existingContainer.data.userId;
  } else {
    userId = uuidv4();
    const containerName = `user-${userId}`;
    try {
      // Create user-specific directory with appropriate permissions
      const userDirectory = path.join(userDirectoryPath, userId);
      fs.mkdirSync(userDirectory, { recursive: true, mode: 0o777 }); // Set permissions to 777 (read/write/execute for all)

      // Create a Docker container for the user
      const container = await docker.createContainer({
        name: containerName,
        Image: "jupyter/datascience-notebook:latest",
        Tty: true,
        Cmd: ["/bin/bash"],
        HostConfig: {
          Resources: {
            Memory: 512 * 1024 * 1024, // 512 MB in bytes
          },
          // Mount user-specific volume
          Binds: [`${userDirectory}:/home/jovyan`],
        },
      });
      await container.start();
      userContainers[userId] = container;
      container.data = { username: name, userId };
    } catch (error) {
      console.error("Error creating container:", error);
      return res.status(500).json({ error: "Failed to create container" });
    }
  }

  // Create WebSocket connection for the user
  userWebSockets[userId] = new WebSocket("ws://localhost:" + PORT);
  userWebSockets[userId].on("open", () => {
    console.log("WebSocket connection opened for user:", userId);
  });

  res.redirect(`/execute/${userId}`);
});

app.post("/execute/:userId", async (req, res) => {
  const userId = req.params.userId;
  const { code } = req.body;

  const container = userContainers[userId];
  if (!container) {
    return res.status(404).json({ error: "User not found" });
  }

  try {
    let output = "";
    if (code.startsWith("!")) {
      // If the code starts with "!", treat it as a shell command
      const exec = await container.exec({
        Cmd: ["bash", "-c", code.slice(1)], // Remove "!" and execute the command
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start();
      await new Promise((resolve, reject) => {
        stream.on("data", (chunk) => {
          output += chunk.toString();
        });
        stream.on("end", resolve);
        stream.on("error", reject);
      });
    } else {
      // Otherwise, treat it as Python code and execute it
      const exec = await container.exec({
        Cmd: ["python", "-c", code],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start();
      await new Promise((resolve, reject) => {
        stream.on("data", (chunk) => {
          output += chunk.toString();
        });
        stream.on("end", resolve);
        stream.on("error", reject);
      });
    }

    // Clean up the output (remove non-printable characters)
    output = output.replace(/[^ -~]/g, "");
    console.log(output);
    console.log("AAAAAA");
    res.status(200).json({ output });
  } catch (error) {
    console.error("Error executing code:", error);
    res.status(500).json({ error: "Failed to execute code" });
  }
});
const userWebSockets = {};

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    console.log(`Received message: ${message}`);
  });

  ws.on("close", () => {
    console.log("Client disconnected");
  });
});
app.post("/deploy-model/:userId", async (req, res) => {
  const userId = req.params.userId;
  const serveModelCode = req.body.serveModelCode;

  try {
    const userDirectory = path.join(__dirname, "user_directories", userId);
    const serveModelFilePath = path.join(userDirectory, "serve_model.py");
    fs.writeFileSync(serveModelFilePath, serveModelCode);

    if (pythonProcesses[userId]) {
      pythonProcesses[userId].kill("SIGTERM");
      delete pythonProcesses[userId];
    }

    const pythonProcess = spawn("python", [serveModelFilePath], {
      detached: true,
      stdio: "pipe", // Change stdio to pipe to capture output
      cwd: userDirectory,
    });

    pythonProcesses[userId] = pythonProcess;

    // Send logs to client over WebSocket
    pythonProcess.stdout.on("data", (data) => {
      if (
        userWebSockets[userId] &&
        userWebSockets[userId].readyState === WebSocket.OPEN
      ) {
        userWebSockets[userId].send(data.toString());
      }
    });

    res.status(200).json({ message: "Model deployed successfully" });
  } catch (error) {
    console.error("Error deploying model:", error);
    res.status(500).json({ error: "Failed to deploy model" });
  }
});
// Function to periodically check for updated output and send it to the user
function checkAndUpdateOutput(userId) {
  const pythonProcess = pythonProcesses[userId];
  if (
    pythonProcess &&
    userWebSockets[userId] &&
    userWebSockets[userId].readyState === WebSocket.OPEN
  ) {
    const currentOutput = pythonProcess.currentOutput || "";
    const newOutput = pythonProcess.output || "";

    // If output has been updated, send it to the user
    console.log(newOutput);
    if (newOutput !== currentOutput) {
      pythonProcess.currentOutput = newOutput;
      userWebSockets[userId].send(newOutput);
    }
  }
}

// Check and update output for each user every 2 seconds (adjust interval as needed)
setInterval(() => {
  Object.keys(userWebSockets).forEach((userId) => {
    checkAndUpdateOutput(userId);
  });
}, 2000); // Interval in milliseconds
// Define the threshold for inactivity (30 minutes)
const INACTIVITY_THRESHOLD = 30 * 60 * 1000; // 30 minutes in milliseconds

// Function to check for inactive users and delete their folders and containers
// Function to check for inactive users and delete their folders, containers, and Python processes
async function checkInactiveUsers() {
  const currentTime = new Date().getTime();

  for (const [userId, container] of Object.entries(userContainers)) {
    if (container.data.lastActivityTime && 
        (currentTime - container.data.lastActivityTime) > INACTIVITY_THRESHOLD) {
      try {
        // Kill the Python process if it exists
        if (pythonProcesses[userId]) {
          pythonProcesses[userId].kill("SIGTERM");
          delete pythonProcesses[userId];
        }

        // Stop the container
        await container.stop();

        // Remove the container
        await container.remove();

        // Delete the user directory
        const userDirectory = path.join(userDirectoryPath, userId);
        fs.rmdirSync(userDirectory, { recursive: true });

        // Remove the user entry from the userContainers object
        delete userContainers[userId];
        console.log(`User ${userId} has been inactive and their container, directory, and Python process have been removed.`);
      } catch (error) {
        console.error(`Error cleaning up resources for user ${userId}:`, error);
      }
    }
  }
}

// Schedule the checkInactiveUsers function to run periodically (every 10 minutes)
setInterval(checkInactiveUsers, 10 * 60 * 1000); // 10 minutes in milliseconds

// Serve static files for frontend
app.use(express.static("public"));

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});