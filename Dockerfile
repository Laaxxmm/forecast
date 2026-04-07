FROM node:20-bookworm

# Install Chromium directly via apt (includes ALL dependencies)
RUN apt-get update && apt-get install -y \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Skip Playwright browser download - we use system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy everything
COPY . .

# Install dependencies
RUN npm install --legacy-peer-deps
RUN cd server && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --legacy-peer-deps
RUN cd client && npm install --legacy-peer-deps

# Build client
RUN cd client && npm run build

EXPOSE 3000
ENV NODE_ENV=production
CMD ["npm", "start"]
