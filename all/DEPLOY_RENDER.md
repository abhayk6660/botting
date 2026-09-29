# Deploying GW Join Bot to Render.com

This guide provides instructions for deploying and running your Discord bot on **[Render.com](https://render.com/)**.

---

## 📁 Files Provided for Render

| File | Purpose |
| :--- | :--- |
| **`render.yaml`** | Render Blueprint configuration. Allows automatic 1-click deployment on Render. |
| **`.env.example`** | Template showing all environment variables to configure in the Render dashboard. |
| **`.gitignore`** | Safeguards sensitive bot tokens (`.env`, `env`) and prevents uploading `node_modules` to GitHub. |
| **`Dockerfile`** | Docker container build configuration for containerized deployment on Render. |
| **`.dockerignore`** | Excludes unneeded files from Docker builds. |
| **`package.json`** | Configured with `node >= 18.0.0` engine and `npm start` script. |
| **`gwjoinbot.js`** | Integrated with an automatic HTTP health-check server (`PORT 10000`) required for Render Web Services. |

---

## 🚀 Step 1: Push Project to GitHub

> [!IMPORTANT]
> Never commit your real `.env` or `env` file to a public GitHub repository. Your tokens should only be entered in Render's private Environment Variables tab.

Run the following commands in your project terminal:

```bash
# 1. Initialize git (if not already done)
git init

# 2. Add files (protected by .gitignore)
git add .

# 3. Commit your changes
git commit -m "Configure bot for Render deployment"

# 4. Link to your GitHub repository
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git

# 5. Push to GitHub
git push -u origin main
```

---

## 🌐 Step 2: Deploy on Render

### Option A: Using Render Blueprints (Recommended - Fastest)

1. Log into **[Render Dashboard](https://dashboard.render.com/)**.
2. Click **New +** in the top right corner and select **Blueprint**.
3. Connect your GitHub repository.
4. Render will automatically read `render.yaml` and set up the **Web Service**.
5. Click **Apply**.
6. Go to the service's **Environment** tab and add your `DISCORD_TOKENS` (and optional `ALERT_WEBHOOK_URL`).

---

### Option B: Manual Web Service Setup

If you prefer setting it up manually without Blueprints:

1. In Render Dashboard, click **New +** > **Web Service**.
2. Connect your GitHub repository.
3. Configure the following settings:
   - **Name**: `gw-join-bot`
   - **Region**: Any (e.g., `Oregon (US West)` or `Frankfurt (EU)`)
   - **Branch**: `main`
   - **Root Directory**: `all` *(Leave blank if you pushed files directly from the root)*
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
4. Expand **Advanced** and add the following **Environment Variables**:
   - `DISCORD_TOKENS`: *your Discord token(s) (comma-separated if multiple)*
   - `ALERT_WEBHOOK_URL`: *(optional) your Discord webhook for alerts*
   - `TRIVIA_MODE`: `s` *(s = natural human delay, y = fast, n = disabled)*
   - `MIN_TRIVIA_DELAY`: `3500`
   - `MAX_TRIVIA_DELAY`: `6500`
   - `MINIGAME_ONLY`: `y`
   - `CHAT_MODE`: `s`
   - `NODE_VERSION`: `20`
5. Click **Deploy Web Service**.

---

## 🩺 Health Check & Monitoring

Render will assign you a public URL (e.g. `https://gw-join-bot.onrender.com`).
The bot now has a built-in health-check server:
- Visiting `https://gw-join-bot.onrender.com/health` returns JSON status:
  ```json
  {
    "status": "online",
    "bot": "gw-join-bot",
    "accountsConfigured": 1,
    "accountsConnected": 1,
    "uptimeSeconds": 1420
  }
  ```

---

## ⚡ Keeping Free Tier Bot Alive (24/7)

> [!NOTE]
> Render Free Web Services spin down after 15 minutes of inactivity if no HTTP requests are received.

To keep your bot active 24/7 on the Free tier:
1. Go to **[cron-job.org](https://cron-job.org/)** or **[UptimeRobot](https://uptimerobot.com/)** (both 100% free).
2. Create a new HTTP monitor pointing to your Render URL:
   `https://YOUR-APP-NAME.onrender.com/health`
3. Set the schedule to run every **5 to 10 minutes**.
4. This keeps the web service active and running continuously!
