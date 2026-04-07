FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

# Install all dependencies
RUN npm install --legacy-peer-deps
RUN cd server && npm install --legacy-peer-deps
RUN cd client && npm install --legacy-peer-deps

# CRITICAL: Re-install Playwright Chromium + deps matching the npm package version
# The Docker image has v1.52 browsers, but npm installs v1.59 which needs its own browser
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
