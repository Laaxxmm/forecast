FROM node:20-bookworm

# Install Chromium via apt (includes all shared library dependencies)
RUN apt-get update && apt-get install -y \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Skip Playwright's own browser download — we use system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy everything (respects .dockerignore)
COPY . .

# Verify project structure
RUN ls -la && echo "---" && ls server/ && echo "---" && ls client/

# Install dependencies (all in one RUN to preserve cd context)
RUN npm install --legacy-peer-deps \
    && cd server && npm install --legacy-peer-deps \
    && cd ../client && npm install --legacy-peer-deps \
    && cd ../Vcfo-app/TallyVision_2.0 && npm install --omit=dev --legacy-peer-deps

# Build client
RUN cd client && npm run build

EXPOSE 3000
ENV NODE_ENV=production
# TallyVision writable data dir — lives on the same Railway /data volume as Magna_Tracker.
# Layout on the volume:
#   /data/platform.db            ← Magna_Tracker platform DB
#   /data/clients/<slug>.db      ← Magna_Tracker per-client DBs
#   /data/vcfo/master.db         ← TallyVision master (users, settings)
#   /data/vcfo/clients/*.db      ← TallyVision per-company group DBs
ENV TALLYVISION_DATA=/data/vcfo
CMD ["npm", "start"]
