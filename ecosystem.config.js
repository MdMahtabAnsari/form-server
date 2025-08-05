module.exports = {
  apps: [
    {
      name: "form-application",
      script: "./server.js",
      exec_mode: "cluster",
      instances: "max",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
// This configuration file is for PM2, a process manager for Node.js applications.
// It defines an application named "form-application" that runs the script "server.js".