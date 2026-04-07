FROM node:20-slim

# Install base utilities needed by Playwright's install-deps
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    procps \
    --no-install-recommends

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

# Install all dependencies
RUN npm install --legacy-peer-deps
RUN cd server && npm install --legacy-peer-deps
RUN cd client && npm install --legacy-peer-deps

# Install Playwright Chromium WITH all system dependencies
# --with-deps automatically installs every required shared library
RUN cd server && npx playwright install --with-deps chromium

# Copy source code
COPY . .

# Build client
RUN cd client && npm run build

# Expose port
EXPOSE 3000

ENV NODE_ENV=production

# Start server
CMD ["npm", "start"]
