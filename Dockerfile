FROM node:20-bookworm

# node:20-bookworm is Debian full image with proper apt sources
# --with-deps works reliably on Debian Bookworm

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

# Install all dependencies
RUN npm install --legacy-peer-deps
RUN cd server && npm install --legacy-peer-deps
RUN cd client && npm install --legacy-peer-deps

# Install Playwright Chromium + ALL system dependencies
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
