FROM node:20-bookworm

# Install Chromium directly via apt (comes with ALL its dependencies)
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Skip Playwright browser download - we'll use system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

# Install all dependencies
RUN npm install --legacy-peer-deps
RUN cd server && npm install --legacy-peer-deps
RUN cd client && npm install --legacy-peer-deps

# Copy source code
COPY . .

# Build client
RUN cd client && npm run build

# Expose port
EXPOSE 3000

ENV NODE_ENV=production

# Start server
CMD ["npm", "start"]
