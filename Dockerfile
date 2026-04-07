FROM node:20-bookworm

# Install Chromium directly via apt (includes ALL dependencies)
RUN apt-get update && apt-get install -y \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Verify Chromium is installed
RUN which chromium && chromium --version

# Skip Playwright browser download - we use system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Create directories first
RUN mkdir -p server client

# Copy package files
COPY package.json ./
COPY package-lock.json* ./
COPY server/package.json server/
COPY client/package.json client/

# Install root dependencies
RUN npm install --legacy-peer-deps

# Install server dependencies (skip postinstall playwright download)
RUN cd server && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --legacy-peer-deps

# Install client dependencies
RUN cd client && npm install --legacy-peer-deps

# Copy all source code
COPY . .

# Build client
RUN cd client && npm run build

# Expose port
EXPOSE 3000

ENV NODE_ENV=production

# Start server
CMD ["npm", "start"]
